const assert = require("node:assert/strict");
const test = require("node:test");

function valueAt(document, path) {
  return path.split(".").reduce((value, key) => value?.[key], document);
}

function matches(document, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === "$or") return expected.some((item) => matches(document, item));
    const actual = valueAt(document, key);
    if (expected && typeof expected === "object" && "$in" in expected) {
      return expected.$in.includes(actual);
    }
    if (expected && typeof expected === "object" && "$ne" in expected) {
      return actual !== expected.$ne;
    }
    if (expected && typeof expected === "object" && "$lte" in expected) {
      return actual <= expected.$lte;
    }
    if (expected && typeof expected === "object" && "$gte" in expected) {
      return actual >= expected.$gte;
    }
    if (expected && typeof expected === "object" && "$lt" in expected) {
      return actual < expected.$lt;
    }
    if (expected && typeof expected === "object" && "$exists" in expected) {
      return (actual !== undefined) === expected.$exists;
    }
    return actual === expected;
  });
}

class MemoryCollection {
  constructor(documents = []) {
    this.documents = documents;
  }

  async findOne(filter) {
    return this.documents.find((document) => matches(document, filter)) ?? null;
  }

  find(filter) {
    let sortOptions = null;
    const cursor = {
      sort(options) {
        sortOptions = options;
        return cursor;
      },
      limit() {
        return cursor;
      },
      toArray: async () => {
        const rows = this.documents.filter((document) =>
          matches(document, filter),
        );
        if (sortOptions) {
          const [[field, direction]] = Object.entries(sortOptions);
          rows.sort((left, right) => {
            const a = valueAt(left, field);
            const b = valueAt(right, field);
            return (a > b ? 1 : a < b ? -1 : 0) * direction;
          });
        }
        return rows;
      },
    };
    return cursor;
  }

  async insertOne(document) {
    if (this.documents.some((item) => item._id === document._id)) {
      const error = new Error("duplicate key");
      error.code = 11000;
      throw error;
    }
    this.documents.push(document);
  }

  async updateOne(filter, update) {
    const document = this.documents.find((item) => matches(item, filter));
    if (!document) return { matchedCount: 0 };
    Object.assign(document, update.$set ?? {});
    for (const field of Object.keys(update.$unset ?? {})) {
      delete document[field];
    }
    return { matchedCount: 1 };
  }

  async deleteOne(filter) {
    const index = this.documents.findIndex((document) =>
      matches(document, filter),
    );
    if (index >= 0) this.documents.splice(index, 1);
  }

  aggregate(pipeline) {
    const filter = pipeline.find((stage) => stage.$match)?.$match ?? {};
    return {
      toArray: async () => {
        const counts = new Map();
        for (const document of this.documents.filter((item) =>
          matches(item, filter),
        )) {
          const key = document.assignedToId;
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        return [...counts].map(([_id, count]) => ({ _id, count }));
      },
    };
  }
}

const dbModule = require("../src/db");
let currentDb;
let sequence = 100;
dbModule.getDb = () => currentDb;
dbModule.nextId = async () => ++sequence;
dbModule.runTransaction = async (operation) => operation(undefined, currentDb);
const leaveService = require("../src/services/leave.service");

function setup(collections) {
  currentDb = {
    collection(name) {
      if (!collections[name]) collections[name] = new MemoryCollection();
      return collections[name];
    },
  };
  return collections;
}

test("leave activation covers tickets with the least-loaded available resolver and returns them", async () => {
  const startDate = new Date().toISOString().slice(0, 10);
  const nextDate = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const collections = setup({
    users: new MemoryCollection([
      { _id: 1, role: "admin", name: "Administrator", empId: "ADM-1" },
      { _id: 2, role: "user", name: "Requester", empId: "USR-2" },
      {
        _id: 3,
        role: "agent",
        departmentId: 7,
        name: "Away resolver",
        empId: "AGT-3",
      },
      {
        _id: 4,
        role: "agent",
        departmentId: 7,
        name: "Available resolver",
        empId: "AGT-4",
      },
      {
        _id: 5,
        role: "agent",
        departmentId: 7,
        name: "Busy resolver",
        empId: "AGT-5",
      },
    ]),
    leaves: new MemoryCollection([
      {
        _id: 20,
        agentId: 3,
        agent: { id: 3, name: "Away resolver", empId: "AGT-3" },
        startDate,
        endDate: startDate,
        status: "scheduled",
        createdAt: new Date(),
      },
      {
        _id: 21,
        agentId: 3,
        agent: { id: 3, name: "Away resolver", empId: "AGT-3" },
        startDate: nextDate,
        endDate: nextDate,
        status: "scheduled",
        createdAt: new Date(),
      },
    ]),
    tickets: new MemoryCollection([
      {
        _id: 30,
        code: "TKT-30",
        status: "in_progress",
        departmentId: 7,
        createdById: 2,
        assignedToId: 3,
        assignedTo: { id: 3, name: "Away resolver", empId: "AGT-3" },
        createdAt: new Date(),
      },
      {
        _id: 31,
        status: "in_progress",
        departmentId: 7,
        assignedToId: 5,
      },
      {
        _id: 32,
        code: "TKT-32",
        status: "in_progress",
        departmentId: 7,
        createdById: 2,
        assignedToId: 6,
        assignedTo: { id: 6, name: "Admin-selected resolver", empId: "AGT-6" },
        resolverOnLeave: {
          id: 3,
          name: "Away resolver",
          empId: "AGT-3",
          endDate: startDate,
        },
        leaveAssignment: {
          leaveId: 20,
          originalResolverId: 3,
          coverResolverId: 4,
        },
      },
    ]),
    activities: new MemoryCollection(),
    notifications: new MemoryCollection(),
  });

  await leaveService.processLeaveSchedules(new Date(`${startDate}T12:00:00Z`));
  const ticket = collections.tickets.documents.find(({ _id }) => _id === 30);
  assert.equal(ticket.assignedToId, 4);
  assert.equal(ticket.resolverOnLeave.name, "Away resolver");
  assert.equal(ticket.leaveAssignment.coverResolverId, 4);
  assert.equal(
    collections.notifications.documents.some(
      (item) => item.title === "Resolver is on leave" && item.userId === 2,
    ),
    true,
  );
  assert.equal(collections.leaves.documents[0].status, "active");

  await leaveService.processLeaveSchedules(new Date(`${nextDate}T12:00:00Z`));
  assert.equal(ticket.assignedToId, 4);
  assert.equal(ticket.resolverOnLeave.endDate, nextDate);
  assert.equal(ticket.leaveAssignment.leaveId, 21);
  assert.equal(collections.leaves.documents[0].status, "completed");

  const followingDate = new Date(Date.parse(`${nextDate}T00:00:00Z`) + 86_400_000)
    .toISOString()
    .slice(0, 10);
  await leaveService.processLeaveSchedules(
    new Date(`${followingDate}T12:00:00Z`),
  );
  assert.equal(ticket.assignedToId, 3);
  assert.equal(ticket.resolverOnLeave, undefined);
  assert.equal(ticket.leaveAssignment, undefined);
  assert.equal(collections.leaves.documents[1].status, "completed");
  const manuallyReassigned = collections.tickets.documents.find(
    ({ _id }) => _id === 32,
  );
  assert.equal(manuallyReassigned.assignedToId, 6);
  assert.equal(manuallyReassigned.resolverOnLeave, undefined);
});

test("agents cannot schedule overlapping leave periods", async () => {
  const startDate = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const endDate = new Date(Date.now() + 172_800_000).toISOString().slice(0, 10);
  setup({
    users: new MemoryCollection([
      { _id: 1, role: "admin", name: "Administrator", empId: "ADM-1" },
    ]),
    leaves: new MemoryCollection(),
    notifications: new MemoryCollection(),
  });
  const agent = {
    _id: 2,
    role: "agent",
    departmentId: 7,
    name: "Resolver",
    empId: "AGT-2",
  };
  await leaveService.createLeave(agent, { startDate, endDate });
  await assert.rejects(
    leaveService.createLeave(agent, { startDate, endDate }),
    /overlaps another scheduled or active leave/,
  );
});

test("concurrent leave requests for one resolver are serialized", async () => {
  const startDate = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const endDate = new Date(Date.now() + 172_800_000).toISOString().slice(0, 10);
  setup({
    users: new MemoryCollection([]),
    leaves: new MemoryCollection(),
    leaveLocks: new MemoryCollection(),
    notifications: new MemoryCollection(),
  });
  const agent = {
    _id: 3,
    role: "agent",
    departmentId: 7,
    name: "Resolver",
    empId: "AGT-3",
  };

  const results = await Promise.allSettled([
    leaveService.createLeave(agent, { startDate, endDate }),
    leaveService.createLeave(agent, { startDate, endDate }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal(currentDb.collection("leaves").documents.length, 1);
});
