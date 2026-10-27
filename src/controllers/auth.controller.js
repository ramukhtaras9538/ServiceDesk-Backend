const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { z } = require("zod");
const env = require("../config/env");
const { getDb, nextId } = require("../db");
const { unauthorized } = require("../utils/errors");

const loginSchema = z.object({
  empId: z.string().trim().min(1, "Enter your employee ID"),
  password: z.string().min(1, "Enter your password"),
});

const forgotPasswordSchema = z.object({
  empId: z.string().trim().min(1).max(32),
});

async function publicUser(user) {
  const department = user.departmentId
    ? await getDb()
        .collection("departments")
        .findOne({ _id: user.departmentId })
    : null;
  return {
    id: user._id,
    empId: user.empId,
    name: user.name,
    email: user.email ?? null,
    role: user.role,
    departmentId: user.departmentId ?? null,
    department: department?.name ?? null,
  };
}

async function login(req, res) {
  const { empId, password } = req.body;
  const user = await getDb().collection("users").findOne({
    empIdNormalized: empId.toLowerCase(),
  });
  if (!user || !(await bcrypt.compare(password, user.passwordHash)))
    throw unauthorized("Employee ID or password is incorrect");

  const token = jwt.sign(
    {
      sub: String(user._id),
      role: user.role,
      tokenVersion: user.tokenVersion ?? 0,
    },
    env.JWT_SECRET,
    { expiresIn: env.JWT_EXPIRES_IN },
  );
  res.json({ token, user: await publicUser(user) });
}

async function requestPasswordReset(req, res) {
  const empIdNormalized = req.body.empId.trim().toLowerCase();
  const user = await getDb().collection("users").findOne({ empIdNormalized });
  if (user) {
    const requests = getDb().collection("passwordResetRequests");
    const pending = await requests.findOne({
      empIdNormalized,
      status: "pending",
    });
    if (pending) {
      await requests.updateOne(
        { _id: pending._id },
        { $set: { createdAt: new Date() } },
      );
    } else {
      await requests.insertOne({
        _id: await nextId("passwordResetRequests"),
        empIdNormalized,
        status: "pending",
        createdAt: new Date(),
      });
    }
  }
  res.status(202).json({
    message:
      "If the account exists, a reset request has been sent to an administrator. Contact your service desk administrator to verify your identity.",
  });
}

const me = async (req, res) => res.json({ user: await publicUser(req.user) });

module.exports = {
  loginSchema,
  forgotPasswordSchema,
  login,
  requestPasswordReset,
  me,
};
