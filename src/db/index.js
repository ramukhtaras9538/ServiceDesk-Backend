const { MongoClient } = require("mongodb");
const env = require("../config/env");

const client = new MongoClient(env.MONGODB_URI, { promoteBuffers: true });
let database;
let transactionsSupported = false;

function supportsTransactions(hello) {
  return Boolean(hello.setName || hello.msg === "isdbgrid");
}

function isUnsupportedTransactionError(error) {
  return (
    error?.code === 20 &&
    error.codeName === "IllegalOperation" &&
    /Transaction numbers are only allowed on a replica set member or mongos/.test(
      error.message,
    )
  );
}

async function connectDb() {
  if (database) return database;
  await client.connect();
  database = client.db(env.MONGODB_DB);
  let hello;
  try {
    hello = await client.db("admin").command({ hello: 1 });
  } catch (error) {
    if (error.code !== 59) throw error;
    hello = await client.db("admin").command({ isMaster: 1 });
  }
  transactionsSupported = supportsTransactions(hello);
  if (!transactionsSupported) {
    console.warn(
      "Standalone MongoDB detected; multi-document writes will run without transactions. Use a replica set for atomic writes.",
    );
  }

  await Promise.all([
    database
      .collection("departments")
      .createIndex({ name: 1 }, { unique: true }),
    database
      .collection("categories")
      .createIndex({ name: 1 }, { unique: true }),
    database
      .collection("users")
      .createIndex(
        { empIdNormalized: 1 },
        { partialFilterExpression: { empIdNormalized: { $exists: true } } },
      ),
    database
      .collection("passwordResetRequests")
      .createIndex({ status: 1, createdAt: 1 }),
    database.collection("services").createIndex({ categoryId: 1, name: 1 }),
    database.collection("tickets").createIndex({ code: 1 }, { unique: true }),
    database
      .collection("tickets")
      .createIndex({ createdById: 1, createdAt: -1 }),
    database.collection("tickets").createIndex({ assignedToId: 1, status: 1 }),
    database.collection("tickets").createIndex({ departmentId: 1, status: 1 }),
    database
      .collection("tickets")
      .createIndex({ "parentTicket.id": 1, updatedAt: -1 }),
    database
      .collection("ticketLinks")
      .createIndex({ sourceTicketId: 1, createdAt: 1 }),
    database
      .collection("ticketLinks")
      .createIndex({ linkedTicketId: 1, createdAt: 1 }),
    database
      .collection("notifications")
      .createIndex({ userId: 1, createdAt: -1 }),
    database
      .collection("activities")
      .createIndex({ ticketId: 1, createdAt: 1 }),
    database
      .collection("activities")
      .createIndex({ createdById: 1, createdAt: -1 }),
    database
      .collection("activities")
      .createIndex({ assignedToId: 1, createdAt: -1 }),
    database
      .collection("activities")
      .createIndex({ departmentId: 1, createdAt: -1 }),
    database
      .collection("activities")
      .createIndex({ participantIds: 1, createdAt: -1 }),
    database.collection("comments").createIndex({ ticketId: 1, createdAt: 1 }),
    database
      .collection("workSessions")
      .createIndex({ userId: 1, startedAt: -1 }),
    database
      .collection("workSessions")
      .createIndex(
        { userId: 1 },
        { unique: true, partialFilterExpression: { status: "active" } },
      ),
    database
      .collection("leaves")
      .createIndex({ agentId: 1, startDate: 1, endDate: 1 }),
    database
      .collection("leaves")
      .createIndex({ status: 1, startDate: 1, endDate: 1 }),
  ]);

  return database;
}

function getDb() {
  if (!database) throw new Error("MongoDB has not been connected");
  return database;
}

async function nextId(name, session) {
  const result = await getDb()
    .collection("counters")
    .findOneAndUpdate(
      { _id: name },
      { $inc: { value: 1 } },
      { upsert: true, returnDocument: "after", session },
    );
  const counter =
    result && Object.hasOwn(result, "_id") ? result : result?.value;
  return counter.value;
}

async function runTransaction(operation) {
  if (!transactionsSupported) return operation(undefined, getDb());

  return runTransactionWithFallback(
    operation,
    () => client.startSession(),
    getDb,
    () => {
      transactionsSupported = false;
    },
  );
}

async function runTransactionWithFallback(
  operation,
  startSession,
  getDatabase,
  disableTransactions,
) {
  const session = startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      result = await operation(session, getDatabase());
    });
    return result;
  } catch (error) {
    if (!isUnsupportedTransactionError(error)) throw error;
    disableTransactions();
    console.warn(
      "MongoDB rejected a transaction; retrying this and future multi-document writes without transactions.",
    );
    return await operation(undefined, getDatabase());
  } finally {
    await session.endSession();
  }
}

async function closeDb() {
  database = undefined;
  await client.close();
}

module.exports = {
  connectDb,
  getDb,
  nextId,
  runTransaction,
  runTransactionWithFallback,
  supportsTransactions,
  closeDb,
};
