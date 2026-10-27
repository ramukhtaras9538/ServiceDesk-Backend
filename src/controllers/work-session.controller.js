const { getDb, nextId } = require("../db");
const { AppError, notFound } = require("../utils/errors");

const toSession = (session, now = new Date()) => ({
  id: session._id,
  startedAt: session.startedAt.toISOString(),
  stoppedAt: session.stoppedAt?.toISOString() ?? null,
  status: session.status,
  durationSeconds: Math.max(
    0,
    Math.floor(
      ((session.stoppedAt ?? now).getTime() - session.startedAt.getTime()) /
        1000,
    ),
  ),
});

async function list(req, res) {
  const db = getDb();
  const now = new Date();
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const [sessions, activeSession, totals] = await Promise.all([
    db
      .collection("workSessions")
      .find({ userId: req.user._id })
      .sort({ startedAt: -1 })
      .limit(100)
      .toArray(),
    db
      .collection("workSessions")
      .findOne({ userId: req.user._id, status: "active" }),
    db
      .collection("workSessions")
      .aggregate([
        {
          $match: {
            userId: req.user._id,
            startedAt: { $lt: tomorrow },
            $or: [{ stoppedAt: { $gte: today } }, { stoppedAt: null }],
          },
        },
        {
          $project: {
            started: { $max: ["$startedAt", today] },
            stopped: { $min: [{ $ifNull: ["$stoppedAt", now] }, tomorrow] },
          },
        },
        {
          $group: {
            _id: null,
            trackedSeconds: {
              $sum: {
                $max: [
                  0,
                  { $divide: [{ $subtract: ["$stopped", "$started"] }, 1000] },
                ],
              },
            },
          },
        },
      ])
      .toArray(),
  ]);

  res.json({
    sessions: sessions.map((session) => toSession(session, now)),
    activeSession: activeSession ? toSession(activeSession, now) : null,
    trackedSecondsToday: Math.floor(totals[0]?.trackedSeconds ?? 0),
    sessionsToday: await db.collection("workSessions").countDocuments({
      userId: req.user._id,
      startedAt: { $gte: today, $lt: tomorrow },
    }),
  });
}

async function start(req, res) {
  const now = new Date();
  const session = {
    _id: await nextId("workSessions"),
    userId: req.user._id,
    startedAt: now,
    stoppedAt: null,
    status: "active",
  };

  try {
    await getDb().collection("workSessions").insertOne(session);
  } catch (error) {
    if (error.code === 11000) {
      throw new AppError(
        409,
        "You already have an active work session",
        "SESSION_ACTIVE",
      );
    }
    throw error;
  }

  res.status(201).json({ session: toSession(session, now) });
}

async function stop(req, res) {
  const now = new Date();
  const result = await getDb()
    .collection("workSessions")
    .findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id, status: "active" },
      { $set: { status: "completed", stoppedAt: now } },
      { returnDocument: "after" },
    );
  if (!result) throw notFound("Active work session not found");
  res.json({ session: toSession(result, now) });
}

module.exports = { list, start, stop };
