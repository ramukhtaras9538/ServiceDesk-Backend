const assert = require("node:assert/strict");
const test = require("node:test");

function matches(document, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === "$or") return expected.some((condition) => matches(document, condition));
    if (key === "$and") return expected.every((condition) => matches(document, condition));
    const actual = document[key];
    if (expected && typeof expected === "object" && "$exists" in expected) {
      return (actual !== undefined) === expected.$exists;
    }
    if (expected && typeof expected === "object" && "$ne" in expected) {
      return actual !== expected.$ne;
    }
    if (expected && typeof expected === "object" && "$in" in expected) {
      return Array.isArray(actual)
        ? actual.some((value) => expected.$in.includes(value))
        : expected.$in.includes(actual);
    }
    if (expected && typeof expected === "object" && "$lte" in expected) {
      return actual <= expected.$lte;
    }
    if (expected && typeof expected === "object" && "$gte" in expected) {
      return actual >= expected.$gte;
    }
    if (Array.isArray(actual)) return actual.includes(expected);
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
    let skipCount = 0;
    let limitCount = Infinity;
    const cursor = {
      sort: (sort) => {
        const [[field, direction]] = Object.entries(sort);
        this.documents.sort(
          (left, right) =>
            ((left[field]?.getTime?.() ?? left[field] ?? 0) -
              (right[field]?.getTime?.() ?? right[field] ?? 0)) *
            direction,
        );
        return cursor;
      },
      skip: (count) => {
        skipCount = count;
        return cursor;
      },
      limit: (count) => {
        limitCount = count;
        return cursor;
      },
      toArray: async () =>
        this.documents
          .filter((document) => matches(document, filter))
          .slice(skipCount, skipCount + limitCount),
    };
    return cursor;
  }

  async countDocuments(filter) {
    return this.documents.filter((document) => matches(document, filter)).length;
  }

  async insertOne(document) {
    this.documents.push(document);
  }

  async updateOne(filter, update) {
    const document = this.documents.find((item) => matches(item, filter));
    if (!document) return;
    Object.assign(document, update.$set ?? {});
    for (const field of Object.keys(update.$unset ?? {})) {
      delete document[field];
    }
    for (const [field, value] of Object.entries(update.$addToSet ?? {})) {
      const values = value.$each ?? [value];
      document[field] = [...new Set([...(document[field] ?? []), ...values])];
    }
  }

  aggregate(pipeline) {
    return {
      toArray: async () => {
        const match = pipeline.find((stage) => stage.$match)?.$match ?? {};
        const counts = new Map();
        for (const document of this.documents.filter((item) =>
          matches(item, match),
        )) {
          counts.set(document.status, (counts.get(document.status) ?? 0) + 1);
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
const ticketService = require("../src/services/ticket.service");

function setup(collections) {
  currentDb = {
    collection(name) {
      if (!collections[name]) collections[name] = new MemoryCollection();
      return collections[name];
    },
  };
}

test("reassignments require a note and notify both resolvers", async () => {
  const currentTicket = {
    _id: 10,
    code: "TKT-2026-0010",
    asset: "Printer",
    status: "in_progress",
    departmentId: 2,
    createdById: 1,
    assignedToId: 3,
    assignedTo: { id: 3, name: "Old resolver", empId: "AGT-3" },
    createdBy: { id: 1, name: "Requester", empId: "USR-1" },
  };
  const collections = {
    tickets: new MemoryCollection([currentTicket]),
    users: new MemoryCollection([
      {
        _id: 4,
        role: "agent",
        departmentId: 2,
        name: "New resolver",
        empId: "AGT-4",
      },
    ]),
    activities: new MemoryCollection(),
    notifications: new MemoryCollection(),
  };
  setup(collections);
  const admin = { _id: 9, role: "admin", name: "Admin", empId: "ADMIN" };

  await assert.rejects(
    ticketService.assign(admin, 10, 4),
    (error) => error.status === 400 && /note/.test(error.message),
  );
  assert.equal(currentTicket.assignedToId, 3);

  await ticketService.assign(admin, 10, 4, "Resolver coverage changed");
  assert.equal(currentTicket.assignedToId, 4);
  assert.match(collections.activities.documents[0].detail, /Old resolver to New resolver/);
  assert.match(collections.activities.documents[0].detail, /Resolver coverage changed/);
  assert.deepEqual(
    collections.notifications.documents.map((notification) => notification.userId),
    [4, 3],
  );
});

test("manual reassignment ends leave coverage so the ticket is not reassigned later", async () => {
  const currentTicket = {
    _id: 11,
    code: "TKT-2026-0011",
    asset: "Printer",
    status: "in_progress",
    departmentId: 2,
    createdById: 1,
    assignedToId: 4,
    assignedTo: { id: 4, name: "Cover resolver", empId: "AGT-4" },
    resolverOnLeave: {
      id: 3,
      name: "Original resolver",
      empId: "AGT-3",
      endDate: "2026-10-24",
    },
    leaveAssignment: {
      leaveId: 20,
      originalResolverId: 3,
      coverResolverId: 4,
    },
  };
  const collections = {
    tickets: new MemoryCollection([currentTicket]),
    users: new MemoryCollection([
      {
        _id: 5,
        role: "agent",
        departmentId: 2,
        name: "Admin-selected resolver",
        empId: "AGT-5",
      },
    ]),
    activities: new MemoryCollection(),
    notifications: new MemoryCollection(),
  };
  setup(collections);
  const admin = { _id: 9, role: "admin", name: "Admin", empId: "ADMIN" };

  await ticketService.assign(admin, 11, 5, "Balanced coverage");

  assert.equal(currentTicket.assignedToId, 5);
  assert.equal(currentTicket.leaveAssignment, undefined);
  assert.equal(currentTicket.resolverOnLeave, undefined);
});

test("agents on leave cannot receive manual ticket assignments", async () => {
  const currentTicket = {
    _id: 12,
    code: "TKT-2026-0012",
    asset: "Printer",
    status: "in_progress",
    departmentId: 2,
    createdById: 1,
    assignedToId: 3,
    assignedTo: { id: 3, name: "Current resolver", empId: "AGT-3" },
  };
  const collections = {
    tickets: new MemoryCollection([currentTicket]),
    users: new MemoryCollection([
      {
        _id: 4,
        role: "agent",
        departmentId: 2,
        name: "Away resolver",
        empId: "AGT-4",
      },
    ]),
    leaves: new MemoryCollection([
      {
        _id: 21,
        agentId: 4,
        status: "active",
        startDate: new Date().toISOString().slice(0, 10),
        endDate: new Date(Date.now() + 86_400_000)
          .toISOString()
          .slice(0, 10),
      },
    ]),
    activities: new MemoryCollection(),
    notifications: new MemoryCollection(),
  };
  setup(collections);
  const admin = { _id: 9, role: "admin", name: "Admin", empId: "ADMIN" };

  await assert.rejects(
    ticketService.assign(admin, 12, 4, "Assign to a resolver"),
    (error) =>
      error.status === 400 && /resolver on leave/.test(error.message),
  );
  assert.equal(currentTicket.assignedToId, 3);
});

test("cross-department links create auditable work and expose it to the admin list", async () => {
  const source = {
    _id: 20,
    code: "TKT-2026-0020",
    asset: "Leaking sink",
    priority: "high",
    status: "open",
    departmentId: 1,
    departmentName: "Facilities",
    categoryId: 2,
    serviceId: 3,
    createdById: 1,
    createdBy: { id: 1, name: "Requester", empId: "USR-1" },
    assignedToId: 2,
    assignedTo: { id: 2, name: "Resolver", empId: "AGT-2" },
  };
  const collections = {
    tickets: new MemoryCollection([source]),
    users: new MemoryCollection([
      { _id: 90, role: "admin", name: "Administrator", empId: "ADMIN" },
    ]),
    services: new MemoryCollection([
      { _id: 8, name: "Electrical repair", categoryId: 7, departmentId: 4 },
    ]),
    categories: new MemoryCollection([{ _id: 7, name: "Electrical" }]),
    departments: new MemoryCollection([{ _id: 4, name: "Electrical" }]),
    activities: new MemoryCollection(),
    notifications: new MemoryCollection(),
    ticketLinks: new MemoryCollection(),
  };
  setup(collections);
  const resolver = {
    _id: 2,
    role: "agent",
    departmentId: 1,
    name: "Resolver",
    empId: "AGT-2",
  };

  const linkedId = await ticketService.createLinkedTicket(resolver, 20, {
    categoryId: 7,
    serviceId: 8,
    departmentId: 4,
    asset: "Leaking sink",
    priority: "high",
    note: "Electrical inspection required",
  });

  const linked = collections.tickets.documents.find((ticket) => ticket._id === linkedId);
  assert.deepEqual(linked.parentTicket, { id: 20, code: source.code });
  assert.deepEqual(linked.participantIds, [1, 2]);
  assert.equal(linked.assignedToId, null);
  assert.ok(
    collections.activities.documents.some(
      (activity) =>
        activity.ticketId === source._id &&
        activity.action === "linked" &&
        activity.detail.includes("Electrical inspection required"),
    ),
  );
  assert.equal(collections.notifications.documents[0].userId, 1);
  assert.ok(
    collections.notifications.documents.some(
      (notification) => notification.userId === 90,
    ),
  );

  const adminLinks = await ticketService.listLinkedTickets();
  assert.equal(adminLinks.length, 1);
  assert.equal(adminLinks[0].sourceTicketCode, source.code);
  assert.equal(adminLinks[0].targetDepartment, "Electrical");
  assert.equal(adminLinks[0].note, "Electrical inspection required");
});

test("linked ticket status changes notify the source team and administrators", async () => {
  const linkedTicket = {
    _id: 30,
    code: "TKT-2026-0030",
    asset: "Electrical check",
    status: "open",
    departmentId: 4,
    createdById: 1,
    assignedToId: 2,
    parentTicket: { id: 20, code: "TKT-2026-0020" },
  };
  const sourceTicket = {
    _id: 20,
    createdById: 1,
    assignedToId: 3,
  };
  const collections = {
    tickets: new MemoryCollection([sourceTicket, linkedTicket]),
    users: new MemoryCollection([
      { _id: 90, role: "admin", name: "Administrator", empId: "ADMIN" },
    ]),
    ticketOptions: new MemoryCollection(),
    activities: new MemoryCollection(),
    notifications: new MemoryCollection(),
  };
  setup(collections);
  const resolver = {
    _id: 2,
    role: "agent",
    departmentId: 4,
    name: "Electrical resolver",
    empId: "AGT-4",
  };

  await ticketService.updateStatus(resolver, 30, "resolved");

  assert.equal(linkedTicket.status, "resolved");
  assert.deepEqual(
    collections.notifications.documents.map((notification) => notification.userId),
    [1, 3, 90],
  );
  assert.ok(
    collections.notifications.documents.every((notification) =>
      notification.body.includes("status changed to resolved"),
    ),
  );
});

test("dashboard ticket scopes include tickets shared through linked work", async () => {
  const linkedTicket = {
    _id: 31,
    code: "TKT-2026-0031",
    categoryName: "Electrical",
    categoryId: 7,
    serviceName: "Electrical check",
    serviceId: 8,
    departmentName: "Electrical",
    departmentId: 4,
    asset: "Electrical inspection",
    priority: "high",
    status: "open",
    createdById: 1,
    createdBy: { id: 1, name: "Requester", empId: "USR-1" },
    assignedToId: 4,
    assignedTo: { id: 4, name: "Electrical resolver", empId: "AGT-4" },
    participantIds: [1, 2, 4],
    parentTicket: { id: 20, code: "TKT-2026-0020" },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const regularTicket = {
    ...linkedTicket,
    _id: 32,
    code: "TKT-2026-0032",
    asset: "Regular service ticket",
    assignedToId: 2,
    assignedTo: { id: 2, name: "Resolver", empId: "AGT-2" },
    participantIds: [],
    parentTicket: undefined,
  };
  setup({ tickets: new MemoryCollection([linkedTicket, regularTicket]) });

  const resolverQueue = await ticketService.list(
    { _id: 2, role: "agent", departmentId: 1 },
    { scope: "assigned", page: 1, limit: 20, sort: "updated" },
  );
  assert.deepEqual(new Set(resolverQueue.data.map((ticket) => ticket.id)), new Set([31, 32]));
  assert.equal(resolverQueue.data[0].parentTicket.code, "TKT-2026-0020");

  const linkedQueue = await ticketService.list(
    { _id: 2, role: "agent", departmentId: 1 },
    {
      scope: "assigned",
      linkedOnly: true,
      page: 1,
      limit: 20,
      sort: "updated",
    },
  );
  assert.deepEqual(
    linkedQueue.data.map((ticket) => ticket.id),
    [linkedTicket._id],
  );

  const requesterQueue = await ticketService.list(
    { _id: 1, role: "user", departmentId: null },
    { scope: "raised", page: 1, limit: 20, sort: "updated" },
  );
  assert.deepEqual(
    requesterQueue.data.map((ticket) => ticket.id),
    [linkedTicket._id, regularTicket._id],
  );
});

test("ticket detail includes live status and context for related department tickets", async () => {
  const source = {
    _id: 40,
    code: "TKT-2026-0040",
    categoryName: "Facilities",
    categoryId: 2,
    serviceName: "Plumbing",
    serviceId: 3,
    departmentName: "Facilities",
    departmentId: 1,
    asset: "Sink leak",
    priority: "high",
    status: "in_progress",
    createdById: 1,
    createdBy: { id: 1, name: "Requester", empId: "USR-1" },
    assignedToId: 2,
    assignedTo: { id: 2, name: "Resolver", empId: "AGT-2" },
    participantIds: [3],
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const linked = {
    _id: 41,
    code: "TKT-2026-0041",
    departmentName: "Electrical",
    status: "resolved",
  };
  setup({
    tickets: new MemoryCollection([source, linked]),
    comments: new MemoryCollection(),
    activities: new MemoryCollection(),
    ticketLinks: new MemoryCollection([
      {
        _id: 50,
        sourceTicketId: source._id,
        sourceTicketCode: source.code,
        linkedTicketId: linked._id,
        linkedTicketCode: linked.code,
        targetDepartmentName: linked.departmentName,
        note: "Electrical inspection needed",
        createdBy: { id: 2, name: "Resolver", empId: "AGT-2" },
        createdAt: new Date(),
      },
    ]),
  });

  const detail = await ticketService.getById(
    { _id: 3, role: "agent", departmentId: 9 },
    source._id,
  );
  assert.deepEqual(detail.linkedTickets, [
    {
      id: linked._id,
      code: linked.code,
      department: linked.departmentName,
      status: linked.status,
      note: "Electrical inspection needed",
      createdAt: detail.linkedTickets[0].createdAt,
      createdBy: { id: 2, name: "Resolver", empId: "AGT-2" },
    },
  ]);
});

test("dashboard status groups count active and resolved tickets dynamically", async () => {
  const tickets = [
    { _id: 51, status: "open", createdById: 1, parentTicket: null },
    { _id: 52, status: "in_progress", createdById: 1 },
    { _id: 53, status: "waiting_for_parts", createdById: 1 },
    { _id: 54, status: "resolved", createdById: 1 },
  ];
  setup({ tickets: new MemoryCollection(tickets) });
  const user = { _id: 1, role: "user", departmentId: null };
  const query = { scope: "raised", page: 1, limit: 20, sort: "updated" };

  const open = await ticketService.list(user, {
    ...query,
    statusGroup: "open",
  });
  assert.deepEqual(
    new Set(open.data.map((ticket) => ticket.id)),
    new Set([51, 52, 53]),
  );
  assert.deepEqual(open.counts, {
    open: 1,
    in_progress: 1,
    waiting_for_parts: 1,
    resolved: 1,
  });

  const resolved = await ticketService.list(user, {
    ...query,
    statusGroup: "resolved",
  });
  assert.deepEqual(
    resolved.data.map((ticket) => ticket.id),
    [54],
  );
});

test("ticket list query accepts dynamic dashboard filters", () => {
  const { listQuery } = require("../src/controllers/ticket.controller");
  const parsed = listQuery.safeParse({
    scope: "raised",
    statusGroup: "open",
    linkedOnly: "true",
  });
  assert.equal(parsed.success, true);
  assert.equal(parsed.data.statusGroup, "open");
  assert.equal(parsed.data.linkedOnly, true);
  assert.equal(
    listQuery.safeParse({
      scope: "raised",
      statusGroup: "unknown",
    }).success,
    false,
  );
});
