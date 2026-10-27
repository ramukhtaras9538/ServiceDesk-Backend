const assert = require("node:assert/strict");
const test = require("node:test");

function matches(document, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    const actual = document[key];
    if (expected instanceof RegExp) return expected.test(actual ?? "");
    if (expected && typeof expected === "object" && "$ne" in expected) {
      return actual !== expected.$ne;
    }
    if (expected && typeof expected === "object" && "$regex" in expected) {
      return new RegExp(expected.$regex, expected.$options).test(actual ?? "");
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
    const cursor = {
      sort: () => cursor,
      limit: () => cursor,
      toArray: async () =>
        this.documents.filter((document) => matches(document, filter)),
    };
    return cursor;
  }

  async insertOne(document) {
    this.documents.push(document);
  }

  async updateOne(filter, update, options = {}) {
    let document = this.documents.find((item) => matches(item, filter));
    if (!document && options.upsert) {
      document = { ...filter };
      this.documents.push(document);
    }
    if (document) {
      Object.assign(document, update.$set);
      for (const [key, amount] of Object.entries(update.$inc ?? {})) {
        document[key] = (document[key] ?? 0) + amount;
      }
    }
  }

  async updateMany(filter, update) {
    for (const document of this.documents.filter((item) =>
      matches(item, filter),
    )) {
      Object.assign(document, update.$set);
    }
  }

  async deleteOne(filter) {
    const index = this.documents.findIndex((document) =>
      matches(document, filter),
    );
    if (index >= 0) this.documents.splice(index, 1);
  }
}

const collections = {
  departments: new MemoryCollection([{ _id: 1, name: "IT" }]),
  categories: new MemoryCollection([{ _id: 2, name: "Hardware" }]),
  services: new MemoryCollection([
    { _id: 3, name: "Repair", categoryId: 2, departmentId: 1 },
  ]),
  users: new MemoryCollection([]),
  tickets: new MemoryCollection([
    {
      _id: 10,
      serviceId: 3,
      categoryId: 2,
      categoryName: "Hardware",
      departmentId: 1,
      departmentName: "IT",
      serviceName: "Repair",
      priority: "medium",
      status: "in_progress",
    },
  ]),
  activities: new MemoryCollection([{ _id: 20, ticketStatus: "in_progress" }]),
  ticketOptions: new MemoryCollection([]),
};

const dbModule = require("../src/db");
test("MongoDB transaction support is detected from the server topology", () => {
  assert.equal(dbModule.supportsTransactions({ setName: "rs0" }), true);
  assert.equal(dbModule.supportsTransactions({ msg: "isdbgrid" }), true);
  assert.equal(dbModule.supportsTransactions({}), false);
});

test("unsupported runtime transactions retry the operation without a session", async () => {
  const unsupportedError = Object.assign(
    new Error(
      "Transaction numbers are only allowed on a replica set member or mongos",
    ),
    { code: 20, codeName: "IllegalOperation" },
  );
  let calls = 0;
  let transactionsDisabled = false;
  let sessionEnded = false;
  const result = await dbModule.runTransactionWithFallback(
    async (session) => {
      calls += 1;
      if (session) throw unsupportedError;
      return "completed";
    },
    () => ({
      withTransaction: async (callback) => callback(),
      endSession: async () => {
        sessionEnded = true;
      },
    }),
    () => ({}),
    () => {
      transactionsDisabled = true;
    },
  );

  assert.equal(result, "completed");
  assert.equal(calls, 2);
  assert.equal(transactionsDisabled, true);
  assert.equal(sessionEnded, true);
});

test("transaction fallback does not swallow unrelated errors", async () => {
  const failure = new Error("database unavailable");
  let calls = 0;
  const session = {
    withTransaction: async (callback) => callback(),
    endSession: async () => {},
  };
  await assert.rejects(
    dbModule.runTransactionWithFallback(
      async () => {
        calls += 1;
        throw failure;
      },
      () => session,
      () => ({}),
      () => assert.fail("must not disable transactions"),
    ),
    failure,
  );
  assert.equal(calls, 1);
});

dbModule.getDb = () => ({
  collection(name) {
    if (!collections[name]) collections[name] = new MemoryCollection([]);
    return collections[name];
  },
});
dbModule.runTransaction = async (operation) =>
  operation(undefined, dbModule.getDb());
let sequence = 100;
dbModule.nextId = async () => ++sequence;

const admin = require("../src/controllers/admin.controller");
const auth = require("../src/controllers/auth.controller");

function response() {
  return {
    statusCode: 200,
    body: null,
    ended: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
  };
}

test("catalog creation rejects duplicates and adds an available department", async () => {
  assert.equal(
    admin.catalogItemParamSchema.safeParse({
      kind: "departments",
      id: "bad-id",
    }).success,
    false,
  );
  assert.equal(
    admin.catalogItemParamSchema.safeParse({
      kind: "priorities",
      id: "urgent-plus",
    }).success,
    true,
  );

  const res = response();
  await admin.createCatalogItem(
    { params: { kind: "departments" }, body: { name: "Facilities" } },
    res,
  );
  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.body.item, { id: 101, name: "Facilities" });

  await assert.rejects(
    admin.createCatalogItem(
      { params: { kind: "departments" }, body: { name: "it" } },
      response(),
    ),
    (error) => error.status === 400,
  );
});

test("services require valid routing and cannot be deleted while used", async () => {
  await assert.rejects(
    admin.createCatalogItem(
      {
        params: { kind: "services" },
        body: { name: "New service", categoryId: 2 },
      },
      response(),
    ),
    (error) => error.status === 400,
  );

  await assert.rejects(
    admin.deleteCatalogItem(
      { params: { kind: "services", id: "3" } },
      response(),
    ),
    (error) => error.status === 400,
  );
});

test("priority and status edits update existing ticket data and deletion guards work", async () => {
  const priorityUpdate = response();
  await admin.updateCatalogItem(
    {
      params: { kind: "priorities", id: "medium" },
      body: { name: "standard" },
    },
    priorityUpdate,
  );
  assert.equal(priorityUpdate.body.item, "standard");
  assert.equal(collections.tickets.documents[0].priority, "standard");

  const statusUpdate = response();
  await admin.updateCatalogItem(
    {
      params: { kind: "statuses", id: "in_progress" },
      body: { name: "working" },
    },
    statusUpdate,
  );
  assert.equal(collections.tickets.documents[0].status, "working");
  assert.equal(collections.activities.documents[0].ticketStatus, "working");

  await assert.rejects(
    admin.deleteCatalogItem(
      { params: { kind: "priorities", id: "standard" } },
      response(),
    ),
    (error) => error.status === 400,
  );
  await assert.rejects(
    admin.deleteCatalogItem(
      { params: { kind: "statuses", id: "open" } },
      response(),
    ),
    (error) => error.status === 400,
  );
  collections.tickets.documents[0].status = "open";
  await assert.rejects(
    admin.deleteCatalogItem(
      { params: { kind: "statuses", id: "working" } },
      response(),
    ),
    (error) => error.status === 400,
    "historical activity entries keep the status in use",
  );
});

test("password reset requests avoid disclosing whether an employee ID exists", async () => {
  const user = {
    _id: 501,
    empId: "C6602",
    empIdNormalized: "c6602",
    name: "Test Employee",
    email: "employee@example.test",
    passwordHash: "old-hash",
    role: "user",
  };
  collections.users.documents.push(user);

  const existingResponse = response();
  await auth.requestPasswordReset(
    { body: { empId: " c6602 " } },
    existingResponse,
  );
  const unknownResponse = response();
  await auth.requestPasswordReset(
    { body: { empId: "unknown-id" } },
    unknownResponse,
  );

  assert.equal(existingResponse.statusCode, 202);
  assert.deepEqual(existingResponse.body, unknownResponse.body);
  assert.equal(collections.passwordResetRequests.documents.length, 1);
  assert.equal(
    collections.passwordResetRequests.documents[0].empIdNormalized,
    "c6602",
  );
});

test("admin can process a password reset request and update the password hash", async () => {
  const bcrypt = require("bcryptjs");
  const resetRequest = collections.passwordResetRequests.documents[0];
  const oldPasswordHash = await bcrypt.hash("old-password-123", 4);
  collections.users.documents[0].passwordHash = oldPasswordHash;
  const res = response();

  await admin.resetRequestedPassword(
    {
      params: { id: String(resetRequest._id) },
      body: { password: "temporary-password-123" },
      user: { _id: 900 },
    },
    res,
  );

  assert.equal(
    res.body.message,
    "The account password was reset successfully.",
  );
  assert.equal(
    await bcrypt.compare(
      "temporary-password-123",
      collections.users.documents[0].passwordHash,
    ),
    true,
  );
  assert.equal(resetRequest.status, "completed");
  assert.equal(resetRequest.completedById, 900);
  assert.equal(collections.users.documents[0].tokenVersion, 1);

  const jwt = require("jsonwebtoken");
  const { authenticate } = require("../src/middleware/auth");
  const token = jwt.sign(
    { sub: "501", tokenVersion: 0 },
    require("../src/config/env").JWT_SECRET,
  );
  let authError;
  await authenticate(
    { headers: { authorization: `Bearer ${token}` } },
    {},
    (error) => {
      authError = error;
    },
  );
  assert.equal(authError.status, 401);
});
