const { getDb } = require("../db");

const defaultOptions = {
  priorities: ["low", "medium", "high", "critical"],
  statuses: ["open", "in_progress", "resolved"],
};

async function getMeta(_req, res) {
  const db = getDb();
  const [departments, categories, services, priorities, statuses] =
    await Promise.all([
      db.collection("departments").find({}).sort({ name: 1 }).toArray(),
      db.collection("categories").find({}).sort({ name: 1 }).toArray(),
      db.collection("services").find({}).sort({ name: 1 }).toArray(),
      db.collection("ticketOptions").findOne({ _id: "priorities" }),
      db.collection("ticketOptions").findOne({ _id: "statuses" }),
    ]);
  res.json({
    departments: departments.map(({ _id, name }) => ({ id: _id, name })),
    categories: categories.map(({ _id, name }) => ({ id: _id, name })),
    services: services.map(({ _id, name, categoryId, departmentId }) => ({
      id: _id,
      name,
      categoryId,
      departmentId,
    })),
    priorities: priorities?.values ?? defaultOptions.priorities,
    statuses: statuses?.values ?? defaultOptions.statuses,
  });
}

async function getAgents(req, res) {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const leaveRecords = await db
    .collection("leaves")
    .find({
      status: { $in: ["scheduled", "active"] },
      startDate: { $lte: today },
      endDate: { $gte: today },
    })
    .toArray();
  const onLeaveIds = new Set(leaveRecords.map((leave) => leave.agentId));
  const filter = { role: "agent" };
  if (req.user.role !== "admin") filter.departmentId = req.user.departmentId;
  const users = await db
    .collection("users")
    .find(filter)
    .project({ empId: 1, name: 1, departmentId: 1 })
    .sort({ name: 1 })
    .toArray();
  const agents = await Promise.all(
    users.map(async (user) => ({
      id: user._id,
      name: user.name,
      empId: user.empId,
      departmentId: user.departmentId ?? null,
      onLeave: onLeaveIds.has(user._id),
      activeTicketCount: await db.collection("tickets").countDocuments({
        assignedToId: user._id,
        status: { $ne: "resolved" },
      }),
    })),
  );
  res.json({ agents });
}

module.exports = { getMeta, getAgents };
