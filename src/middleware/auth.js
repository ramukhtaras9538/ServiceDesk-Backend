const jwt = require("jsonwebtoken");
const env = require("../config/env");
const { getDb } = require("../db");
const { unauthorized, forbidden } = require("../utils/errors");

async function authenticate(req, _res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return next(unauthorized());

  let payload;
  try {
    payload = jwt.verify(token, env.JWT_SECRET);
  } catch {
    return next(unauthorized("Your session has expired. Sign in again."));
  }

  const userId = Number(payload.sub);
  if (!Number.isSafeInteger(userId) || userId < 1) {
    return next(unauthorized("Your session is invalid. Sign in again."));
  }
  const user = await getDb()
    .collection("users")
    .findOne({ _id: userId }, { projection: { passwordHash: 0 } });
  if (!user) return next(unauthorized("Account no longer exists"));
  if ((payload.tokenVersion ?? 0) !== (user.tokenVersion ?? 0)) {
    return next(unauthorized("Your session has expired. Sign in again."));
  }
  req.user = user;
  return next();
}

const requireRole =
  (...roles) =>
  (req, _res, next) =>
    roles.includes(req.user.role) ? next() : next(forbidden());

module.exports = { authenticate, requireRole };
