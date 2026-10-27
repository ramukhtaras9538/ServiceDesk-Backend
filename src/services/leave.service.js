const { randomUUID } = require("node:crypto");
const { getDb, nextId, runTransaction } = require("../db");
const {
  badRequest,
  conflict,
  forbidden,
  notFound,
} = require("../utils/errors");

const activeStatuses = ["scheduled", "active"];

function todayUtc(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function mapLeave(leave) {
  return {
    id: leave._id,
    agentId: leave.agentId,
    agent: leave.agent,
    departmentId: leave.departmentId,
    startDate: leave.startDate,
    endDate: leave.endDate,
    status: leave.status,
    createdAt: leave.createdAt.toISOString(),
  };
}

async function listLeaves(user) {
  const filter = user.role === "admin" ? {} : { agentId: user._id };
  const leaves = await getDb()
    .collection("leaves")
    .find(filter)
    .sort({ startDate: -1, _id: -1 })
    .limit(user.role === "admin" ? 500 : 100)
    .toArray();
  return leaves.map(mapLeave);
}

async function notifyUser(userId, title, body, session) {
  await getDb()
    .collection("notifications")
    .insertOne({
      _id: await nextId("notifications", session),
      userId,
      ticketId: null,
      ticketCode: null,
      title,
      body,
      createdAt: new Date(),
      readAt: null,
    }, { session });
}

async function notifyAdmins(title, body, session) {
  const admins = await getDb()
    .collection("users")
    .find({ role: "admin" }, { session })
    .toArray();
  for (const admin of admins) {
    await notifyUser(admin._id, title, body, session);
  }
}

async function notifyLeaveUser(leave, title, body, session) {
  const user = await getDb()
    .collection("users")
    .findOne({ _id: leave.agentId }, { session });
  if (user) await notifyUser(user._id, title, body, session);
}

async function acquireLeaveLock(agentId) {
  const locks = getDb().collection("leaveLocks");
  const now = new Date();
  const token = randomUUID();
  const existing = await locks.findOne({ _id: agentId });

  if (existing && existing.expiresAt > now) {
    throw conflict("Another leave update is in progress. Please try again.");
  }
  if (existing) {
    const result = await locks.updateOne(
      { _id: agentId, token: existing.token, expiresAt: existing.expiresAt },
      { $set: { token, expiresAt: new Date(now.getTime() + 5 * 60_000) } },
    );
    if (result.matchedCount === 0) {
      throw conflict("Another leave update is in progress. Please try again.");
    }
  } else {
    try {
      await locks.insertOne({
        _id: agentId,
        token,
        expiresAt: new Date(now.getTime() + 5 * 60_000),
      });
    } catch (error) {
      if (error.code === 11000) {
        throw conflict("Another leave update is in progress. Please try again.");
      }
      throw error;
    }
  }
  return token;
}

async function createLeave(user, input) {
  if (user.role !== "agent") throw forbidden("Only resolvers can add leave");
  if (!user.departmentId) {
    throw badRequest(
      "Your resolver account must have a department before scheduling leave",
    );
  }
  if (!validDate(input.startDate) || !validDate(input.endDate)) {
    throw badRequest("Leave dates must be valid calendar dates in YYYY-MM-DD format");
  }
  const today = todayUtc();
  if (input.startDate < today) {
    throw badRequest("Leave cannot start before today");
  }
  if (input.startDate > input.endDate) {
    throw badRequest("Leave end date must be on or after the start date");
  }

  const lockToken = await acquireLeaveLock(user._id);
  try {
    return await runTransaction(async (session, db) => {
      const overlapping = await db.collection("leaves").findOne({
        agentId: user._id,
        status: { $in: activeStatuses },
        startDate: { $lte: input.endDate },
        endDate: { $gte: input.startDate },
      }, { session });
      if (overlapping) {
        throw badRequest("This leave overlaps another scheduled or active leave");
      }

      const leave = {
        _id: await nextId("leaves", session),
        agentId: user._id,
        agent: { id: user._id, name: user.name, empId: user.empId },
        departmentId: user.departmentId,
        startDate: input.startDate,
        endDate: input.endDate,
        status: "scheduled",
        createdAt: new Date(),
      };
      await db.collection("leaves").insertOne(leave, { session });
      await notifyAdmins(
        "Resolver leave scheduled",
        `${user.name} will be on leave from ${leave.startDate} through ${leave.endDate}.`,
        session,
      );
      await notifyUser(
        user._id,
        "Leave scheduled",
        `Your leave is scheduled from ${leave.startDate} through ${leave.endDate}.`,
        session,
      );
      return mapLeave(leave);
    });
  } finally {
    await getDb()
      .collection("leaveLocks")
      .deleteOne({ _id: user._id, token: lockToken });
  }
}

async function writeTicketActivity(ticket, action, detail, session) {
  await getDb()
    .collection("activities")
    .insertOne({
      _id: await nextId("activities", session),
      ticketId: ticket._id,
      ticketCode: ticket.code,
      ticketStatus: ticket.status,
      createdById: ticket.createdById,
      assignedToId: ticket.assignedToId,
      departmentId: ticket.departmentId,
      participantIds: ticket.participantIds ?? [],
      userId: null,
      actor: { name: "Service Desk", empId: "SYSTEM" },
      action,
      detail,
      createdAt: new Date(),
    }, { session });
}

async function pickAvailableResolver(departmentId, excludedIds, session) {
  const db = getDb();
  const today = todayUtc();
  const leaves = await db
    .collection("leaves")
    .find({
      status: { $in: activeStatuses },
      startDate: { $lte: today },
      endDate: { $gte: today },
    }, { session })
    .toArray();
  const unavailable = new Set([
    ...excludedIds,
    ...leaves.map((leave) => leave.agentId),
  ]);
  const agents = await db
    .collection("users")
    .find({ role: "agent", departmentId }, { session })
    .sort({ _id: 1 })
    .toArray();
  const available = agents.filter((agent) => !unavailable.has(agent._id));
  if (!available.length) return null;

  const loads = await db
    .collection("tickets")
    .aggregate(
      [
        {
          $match: {
            assignedToId: { $in: available.map((agent) => agent._id) },
            status: { $ne: "resolved" },
          },
        },
        { $group: { _id: "$assignedToId", count: { $sum: 1 } } },
      ],
      { session },
    )
    .toArray();
  const counts = new Map(loads.map((item) => [item._id, item.count]));
  available.sort(
    (left, right) =>
      (counts.get(left._id) ?? 0) - (counts.get(right._id) ?? 0) ||
      left._id - right._id,
  );
  return available[0];
}

async function notifyTicketStakeholders(ticket, title, body, session) {
  const [admins, assignedAgent] = await Promise.all([
    getDb().collection("users").find({ role: "admin" }, { session }).toArray(),
    ticket.assignedToId
      ? getDb().collection("users").findOne({ _id: ticket.assignedToId }, { session })
      : null,
  ]);
  const recipientIds = new Set([
    ticket.createdById,
    ticket.leaveAssignment?.originalResolverId,
    ticket.leaveAssignment?.coverResolverId,
    assignedAgent?._id,
    ...admins.map((admin) => admin._id),
  ]);
  for (const recipientId of recipientIds) {
    if (recipientId !== undefined && recipientId !== null) {
      await getDb()
        .collection("notifications")
        .insertOne({
          _id: await nextId("notifications", session),
          userId: recipientId,
          ticketId: ticket._id,
          ticketCode: ticket.code,
          title,
          body,
          createdAt: new Date(),
          readAt: null,
        }, { session });
    }
  }
}

async function startLeave(leave, now) {
  return runTransaction(async (session, db) => {
    const currentLeave = await db.collection("leaves").findOne(
      { _id: leave._id, status: "scheduled" },
      { session },
    );
    if (!currentLeave) return;
    const original = await db.collection("users").findOne(
      { _id: currentLeave.agentId },
      { session },
    );
    if (!original) throw notFound("Resolver for scheduled leave no longer exists");
    const tickets = await db
      .collection("tickets")
      .find({
        assignedToId: original._id,
        status: { $ne: "resolved" },
        leaveAssignment: { $exists: false },
      }, { session })
      .toArray();

    for (const ticket of tickets) {
      const cover = await pickAvailableResolver(
        ticket.departmentId,
        [original._id],
        session,
      );
      const resolverOnLeave = {
        id: original._id,
        name: original.name,
        empId: original.empId,
        endDate: currentLeave.endDate,
      };
      const assignment = {
        leaveId: currentLeave._id,
        originalResolverId: original._id,
        originalResolver: resolverOnLeave,
        coverResolverId: cover?._id ?? null,
      };
      const updated = {
        ...ticket,
        ...(cover
          ? {
              assignedToId: cover._id,
              assignedTo: { id: cover._id, name: cover.name, empId: cover.empId },
            }
          : {}),
        leaveAssignment: assignment,
        resolverOnLeave,
        updatedAt: now,
      };
      const updateResult = await db.collection("tickets").updateOne(
        { _id: ticket._id, assignedToId: original._id, leaveAssignment: { $exists: false } },
        {
          $set: {
            assignedToId: updated.assignedToId,
            assignedTo: updated.assignedTo,
            leaveAssignment: assignment,
            resolverOnLeave,
            updatedAt: now,
          },
        },
        { session },
      );
      if (updateResult.matchedCount === 0) continue;
      await writeTicketActivity(
        updated,
        "assigned",
        cover
          ? `Reassigned to ${cover.name} while ${original.name} is on leave`
          : `${original.name} is on leave; no available resolver was found`,
        session,
      );
      await notifyTicketStakeholders(
        updated,
        cover ? "Resolver is on leave" : "Resolver leave needs attention",
        cover
          ? `${original.name} is on leave through ${currentLeave.endDate}. ${cover.name} is covering ticket ${ticket.code}.`
          : `${original.name} is on leave through ${currentLeave.endDate}; no available resolver could cover ticket ${ticket.code}.`,
        session,
      );
    }
    const updateResult = await db.collection("leaves").updateOne(
      { _id: currentLeave._id, status: "scheduled" },
      { $set: { status: "active", activatedAt: now } },
      { session },
    );
    if (updateResult.matchedCount === 0) return false;
    await notifyLeaveUser(
      currentLeave,
      "Leave started",
      `Your leave from ${currentLeave.startDate} through ${currentLeave.endDate} has started.`,
      session,
    );
    await notifyAdmins(
      "Resolver leave started",
      `${currentLeave.agent.name} is now on leave through ${currentLeave.endDate}.`,
      session,
    );
    return updateResult.matchedCount > 0;
  });
}

async function finishLeave(leave, status, now) {
  return runTransaction(async (session, db) => {
    const currentLeave = await db.collection("leaves").findOne(
      { _id: leave._id, status: { $in: activeStatuses } },
      { session },
    );
    if (!currentLeave) return;
    if (currentLeave.status === "active") {
      const tickets = await db
        .collection("tickets")
        .find({
          "leaveAssignment.leaveId": currentLeave._id,
        }, { session })
        .toArray();
      for (const ticket of tickets) {
        const isOpen = ticket.status !== "resolved";
        const original = await db.collection("users").findOne(
          { _id: ticket.leaveAssignment.originalResolverId, role: "agent" },
          { session },
        );
        const continuingLeave = original
          ? await db.collection("leaves").findOne({
              agentId: original._id,
              _id: { $ne: currentLeave._id },
              status: { $in: activeStatuses },
              startDate: { $lte: todayUtc(now) },
              endDate: { $gte: todayUtc(now) },
            }, { session })
          : null;
        const stillCovered =
          ticket.assignedToId === ticket.leaveAssignment.coverResolverId ||
          (ticket.leaveAssignment.coverResolverId === null &&
            ticket.assignedToId === ticket.leaveAssignment.originalResolverId);
        const shouldReturn =
          original && isOpen && stillCovered && !continuingLeave;
        const continuesCoverage = original && continuingLeave;
        const nextResolverOnLeave = continuesCoverage
          ? {
              id: original._id,
              name: original.name,
              empId: original.empId,
              endDate: continuingLeave.endDate,
            }
          : null;
        const nextAssignment = continuesCoverage
          ? { ...ticket.leaveAssignment, leaveId: continuingLeave._id }
          : null;
        const updated = {
          ...ticket,
          ...(shouldReturn
            ? {
                assignedToId: original._id,
                assignedTo: { id: original._id, name: original.name, empId: original.empId },
              }
            : {}),
          ...(continuesCoverage
            ? {
                resolverOnLeave: nextResolverOnLeave,
                leaveAssignment: nextAssignment,
              }
            : {}),
          updatedAt: now,
        };
        const updateResult = await db.collection("tickets").updateOne(
          { _id: ticket._id, "leaveAssignment.leaveId": currentLeave._id },
          {
            $set: {
              assignedToId: updated.assignedToId,
              assignedTo: updated.assignedTo,
              updatedAt: now,
              ...(continuesCoverage
                ? {
                    resolverOnLeave: nextResolverOnLeave,
                    leaveAssignment: nextAssignment,
                  }
                : {}),
            },
            ...(!continuesCoverage
              ? { $unset: { leaveAssignment: "", resolverOnLeave: "" } }
              : {}),
          },
          { session },
        );
        if (updateResult.matchedCount === 0) continue;
        await writeTicketActivity(
          updated,
          "assigned",
          shouldReturn
            ? `Returned to ${original.name} after leave`
            : continuesCoverage
              ? `Coverage continues while ${original.name} remains on leave`
              : "Leave coverage ended; current resolver retained",
          session,
        );
        await notifyTicketStakeholders(
          { ...updated, leaveAssignment: ticket.leaveAssignment },
          shouldReturn
            ? "Ticket returned after leave"
            : continuesCoverage
              ? "Leave coverage extended"
              : "Leave coverage ended",
          shouldReturn
            ? `Ticket ${ticket.code} was returned to ${original.name} after leave.`
            : continuesCoverage
              ? `Ticket ${ticket.code} remains with its covering resolver while ${original.name} is on leave through ${continuingLeave.endDate}.`
              : `Leave coverage for ticket ${ticket.code} ended; the current resolver remains assigned.`,
          session,
        );
      }
    }
    const updateResult = await db.collection("leaves").updateOne(
      { _id: currentLeave._id, status: { $in: activeStatuses } },
      { $set: { status, endedAt: now } },
      { session },
    );
    if (updateResult.matchedCount === 0) return false;
    if (status === "cancelled") {
      await notifyLeaveUser(
        currentLeave,
        "Leave cancelled",
        `Your leave from ${currentLeave.startDate} through ${currentLeave.endDate} was cancelled.`,
        session,
      );
      await notifyAdmins(
        "Resolver leave cancelled",
        `${currentLeave.agent.name}’s leave from ${currentLeave.startDate} through ${currentLeave.endDate} was cancelled.`,
        session,
      );
    } else {
      await notifyLeaveUser(
        currentLeave,
        "Leave completed",
        "Your leave has ended.",
        session,
      );
      await notifyAdmins(
        "Resolver returned from leave",
        `${currentLeave.agent.name} returned from leave. Unresolved covered tickets were returned where possible.`,
        session,
      );
    }
    return updateResult.matchedCount > 0;
  });
}

async function processLeaveSchedules(now = new Date()) {
  const today = todayUtc(now);
  const db = getDb();
  const starting = await db
    .collection("leaves")
    .find({ status: "scheduled", startDate: { $lte: today }, endDate: { $gte: today } })
    .toArray();
  for (const leave of starting) {
    await startLeave(leave, now);
  }

  const expired = await db
    .collection("leaves")
    .find({
      status: { $in: activeStatuses },
      endDate: { $lt: today },
    })
    .toArray();
  for (const leave of expired) {
    await finishLeave(leave, "completed", now);
  }
}

async function cancelLeave(user, id) {
  const db = getDb();
  const leave = await db.collection("leaves").findOne({ _id: id });
  if (!leave) throw notFound("Leave record not found");
  const isAdmin = user.role === "admin";
  if (!isAdmin && (user.role !== "agent" || leave.agentId !== user._id)) {
    throw forbidden();
  }
  if (leave.status === "completed" || leave.status === "cancelled") {
    throw badRequest("This leave can no longer be cancelled");
  }
  if (!isAdmin && leave.status !== "scheduled") {
    throw forbidden("Only an administrator can cancel active leave");
  }
  const cancelled = await finishLeave(leave, "cancelled", new Date());
  if (!cancelled) throw badRequest("This leave has already changed");
  return { ...mapLeave(leave), status: "cancelled" };
}

module.exports = { listLeaves, createLeave, cancelLeave, processLeaveSchedules };
