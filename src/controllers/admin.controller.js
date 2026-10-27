const bcrypt = require("bcryptjs");
const { z } = require("zod");

const { getDb, nextId, runTransaction } = require("../db");
const { badRequest, notFound } = require("../utils/errors");
const ticketService = require("../services/ticket.service");

async function listLinkedTickets(_req, res) {
  res.json({ links: await ticketService.listLinkedTickets() });
}

const createUserSchema = z
  .object({
    empId: z
      .string()
      .trim()
      .min(3)
      .max(32)
      .regex(
        /^[A-Za-z0-9._-]+$/,
        "use letters, numbers, dots, underscores, or hyphens",
      ),
    name: z.string().trim().min(2).max(100),
    email: z.preprocess(
      (value) => (value === "" || value === null ? undefined : value),
      z.string().trim().email().max(254).optional(),
    ),
    role: z.enum(["user", "agent"]),
    departmentId: z.preprocess(
      (value) => (value === "" || value === null ? undefined : value),
      z.coerce.number().int().positive().optional(),
    ),
    password: z.string().min(12).max(128),
  })
  .refine((input) => input.role !== "agent" || input.departmentId, {
    message: "Agents must be assigned to a department",
    path: ["departmentId"],
  });

async function listUsers(_req, res) {
  const db = getDb();
  const users = await db
    .collection("users")
    .find({}, { projection: { passwordHash: 0 } })
    .sort({ _id: -1 })
    .limit(100)
    .toArray();
  const departmentIds = [
    ...new Set(users.map((user) => user.departmentId).filter(Boolean)),
  ];
  const departments = await db
    .collection("departments")
    .find({ _id: { $in: departmentIds } })
    .toArray();
  const departmentNames = new Map(
    departments.map((department) => [department._id, department.name]),
  );
  const result = users.map((user) => ({
    id: user._id,
    empId: user.empId,
    name: user.name,
    email: user.email ?? null,
    role: user.role,
    departmentId: user.departmentId ?? null,
    department: departmentNames.get(user.departmentId) ?? null,
  }));
  res.json({ users: result });
}

async function createUser(req, res) {
  const { empId, name, email, role, departmentId, password } = req.body;
  const db = getDb();
  const empIdNormalized = empId.toLowerCase();
  if (await db.collection("users").findOne({ empIdNormalized })) {
    throw badRequest("empId: this employee ID is already in use");
  }
  if (
    departmentId &&
    !(await db.collection("departments").findOne({ _id: departmentId }))
  ) {
    throw badRequest("departmentId: unknown department");
  }

  const department = departmentId
    ? await db.collection("departments").findOne({ _id: departmentId })
    : null;
  const user = {
    _id: await nextId("users"),
    empId,
    empIdNormalized,
    name,
    email: email || null,
    passwordHash: await bcrypt.hash(password, 12),
    role,
    departmentId: departmentId || null,
  };
  try {
    await db.collection("users").insertOne(user);
  } catch (error) {
    if (error.code === 11000)
      throw badRequest("empId: this employee ID is already in use");
    throw error;
  }

  res.status(201).json({
    user: {
      id: user._id,
      empId: user.empId,
      name: user.name,
      email: user.email,
      role: user.role,
      departmentId: user.departmentId,
      department: department?.name ?? null,
    },
  });
}

const passwordResetParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});
const resetPasswordSchema = z.object({
  password: z.string().min(12).max(128),
});

async function listPasswordResetRequests(_req, res) {
  const db = getDb();
  const pending = await db
    .collection("passwordResetRequests")
    .find({ status: "pending" })
    .sort({ createdAt: 1, _id: 1 })
    .limit(100)
    .toArray();
  const requests = await Promise.all(
    pending.map(async (request) => {
      const user = await db.collection("users").findOne({
        empIdNormalized: request.empIdNormalized,
      });
      return {
        id: request._id,
        empId: user?.empId ?? request.empIdNormalized,
        name: user?.name ?? "Account no longer exists",
        email: user?.email ?? null,
        createdAt: request.createdAt,
      };
    }),
  );
  res.json({ requests });
}

async function resetRequestedPassword(req, res) {
  const { id } = passwordResetParamsSchema.parse(req.params);
  const { password } = resetPasswordSchema.parse(req.body);
  const passwordHash = await bcrypt.hash(password, 12);

  await runTransaction(async (session, db) => {
    const resetRequest = await db
      .collection("passwordResetRequests")
      .findOne({ _id: id, status: "pending" }, { session });
    if (!resetRequest) throw notFound("Password reset request not found");
    const user = await db
      .collection("users")
      .findOne({ empIdNormalized: resetRequest.empIdNormalized }, { session });
    if (!user)
      throw notFound("Account for this reset request no longer exists");

    await db
      .collection("users")
      .updateOne(
        { _id: user._id },
        { $set: { passwordHash }, $inc: { tokenVersion: 1 } },
        { session },
      );
    await db.collection("passwordResetRequests").updateOne(
      { _id: id, status: "pending" },
      {
        $set: {
          status: "completed",
          completedAt: new Date(),
          completedById: req.user._id,
        },
      },
      { session },
    );
    await db.collection("passwordResetRequests").updateMany(
      {
        empIdNormalized: resetRequest.empIdNormalized,
        status: "pending",
      },
      {
        $set: {
          status: "completed",
          completedAt: new Date(),
          completedById: req.user._id,
        },
      },
      { session },
    );
  });
  res.json({ message: "The account password was reset successfully." });
}

const catalogKinds = [
  "departments",
  "categories",
  "services",
  "priorities",
  "statuses",
];
const catalogParamSchema = z.object({
  kind: z.enum(catalogKinds),
});
const catalogItemParamSchema = catalogParamSchema
  .extend({
    id: z.string().min(1).max(80),
  })
  .superRefine(({ kind, id }, context) => {
    if (kind !== "priorities" && kind !== "statuses" && !/^\d+$/.test(id)) {
      context.addIssue({
        code: "custom",
        path: ["id"],
        message: "must be a numeric catalog ID",
      });
    }
  });
const catalogBodySchema = z.object({
  name: z.string().trim().min(2).max(80),
  categoryId: z.coerce.number().int().positive().optional(),
  departmentId: z.coerce.number().int().positive().optional(),
});

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const optionDefaults = {
  priorities: ["low", "medium", "high", "critical"],
  statuses: ["open", "in_progress", "resolved"],
};

async function listCatalog(req, res) {
  const { kind } = catalogParamSchema.parse(req.params);
  const db = getDb();
  if (kind === "priorities" || kind === "statuses") {
    const optionDoc = await db
      .collection("ticketOptions")
      .findOne({ _id: kind });
    return res.json({ items: optionDoc?.values ?? optionDefaults[kind] });
  }
  const items = await db.collection(kind).find({}).sort({ name: 1 }).toArray();
  res.json({
    items: items.map(({ _id, name, categoryId, departmentId }) => ({
      id: _id,
      name,
      ...(categoryId === undefined ? {} : { categoryId }),
      ...(departmentId === undefined ? {} : { departmentId }),
    })),
  });
}

async function createCatalogItem(req, res) {
  const { kind } = catalogParamSchema.parse(req.params);
  const { name, categoryId, departmentId } = catalogBodySchema.parse(req.body);
  const db = getDb();

  if (kind === "priorities" || kind === "statuses") {
    const collection = db.collection("ticketOptions");
    const optionDoc = await collection.findOne({ _id: kind });
    const values = optionDoc?.values ?? optionDefaults[kind];
    if (values.some((value) => value.toLowerCase() === name.toLowerCase())) {
      throw badRequest("name: this option already exists");
    }
    await collection.updateOne(
      { _id: kind },
      { $set: { values: [...values, name] } },
      { upsert: true },
    );
    return res.status(201).json({ item: name });
  }

  if (kind === "services") {
    if (!categoryId || !departmentId) {
      throw badRequest("Services need a category and department");
    }
    const [category, department] = await Promise.all([
      db.collection("categories").findOne({ _id: categoryId }),
      db.collection("departments").findOne({ _id: departmentId }),
    ]);
    if (!category || !department)
      throw badRequest("Choose a valid category and department");
    const duplicate = await db.collection(kind).findOne({
      categoryId,
      name: { $regex: `^${escapeRegex(name)}$`, $options: "i" },
    });
    if (duplicate)
      throw badRequest("name: this service already exists in that category");
    const item = {
      _id: await nextId(kind),
      name,
      categoryId,
      departmentId,
    };
    await db.collection(kind).insertOne(item);
    return res.status(201).json({
      item: { id: item._id, name: item.name, categoryId, departmentId },
    });
  }

  const duplicate = await db.collection(kind).findOne({
    name: { $regex: `^${escapeRegex(name)}$`, $options: "i" },
  });
  if (duplicate) throw badRequest("name: this option already exists");
  const item = { _id: await nextId(kind), name };
  await db.collection(kind).insertOne(item);
  res.status(201).json({ item: { id: item._id, name: item.name } });
}

async function updateCatalogItem(req, res) {
  const { kind, id: rawId } = catalogItemParamSchema.parse(req.params);
  const { name, categoryId, departmentId } = catalogBodySchema.parse(req.body);
  const db = getDb();

  if (kind === "priorities" || kind === "statuses") {
    if (kind === "statuses" && ["open", "resolved"].includes(rawId)) {
      throw badRequest(
        "The open and resolved statuses are required by ticket workflows",
      );
    }
    const collection = db.collection("ticketOptions");
    const optionDoc = await collection.findOne({ _id: kind });
    const values = optionDoc?.values ?? optionDefaults[kind];
    const index = values.findIndex((value) => value === rawId);
    if (index < 0) throw badRequest("Option not found");
    if (
      values.some(
        (value, itemIndex) =>
          itemIndex !== index && value.toLowerCase() === name.toLowerCase(),
      )
    ) {
      throw badRequest("name: this option already exists");
    }
    const oldValue = values[index];
    values[index] = name;
    await collection.updateOne(
      { _id: kind },
      { $set: { values } },
      { upsert: true },
    );
    const field = kind === "priorities" ? "priority" : "status";
    await db
      .collection("tickets")
      .updateMany({ [field]: oldValue }, { $set: { [field]: name } });
    if (kind === "statuses") {
      await db
        .collection("activities")
        .updateMany(
          { ticketStatus: oldValue },
          { $set: { ticketStatus: name } },
        );
    }
    return res.json({ item: name });
  }

  const id = z.coerce.number().int().positive().parse(rawId);
  const collection = db.collection(kind);
  const current = await collection.findOne({ _id: id });
  if (!current) throw badRequest("Option not found");
  if (kind === "services") {
    const nextCategoryId = categoryId ?? current.categoryId;
    const nextDepartmentId = departmentId ?? current.departmentId;
    const [category, department] = await Promise.all([
      db.collection("categories").findOne({ _id: nextCategoryId }),
      db.collection("departments").findOne({ _id: nextDepartmentId }),
    ]);
    if (!category || !department)
      throw badRequest("Choose a valid category and department");
    const hasTickets = await db
      .collection("tickets")
      .findOne({ serviceId: id }, { projection: { _id: 1 } });
    if (
      hasTickets &&
      (nextCategoryId !== current.categoryId ||
        nextDepartmentId !== current.departmentId)
    ) {
      throw badRequest(
        "A service with existing tickets cannot be moved to another category or department",
      );
    }
    const duplicate = await collection.findOne({
      _id: { $ne: id },
      categoryId: nextCategoryId,
      name: { $regex: `^${escapeRegex(name)}$`, $options: "i" },
    });
    if (duplicate)
      throw badRequest("name: this service already exists in that category");
    await collection.updateOne(
      { _id: id },
      {
        $set: {
          name,
          categoryId: nextCategoryId,
          departmentId: nextDepartmentId,
        },
      },
    );
    await db.collection("tickets").updateMany(
      { serviceId: id },
      {
        $set: {
          serviceName: name,
          categoryId: nextCategoryId,
          categoryName: category.name,
          departmentId: nextDepartmentId,
          departmentName: department.name,
        },
      },
    );
    return res.json({
      item: {
        id,
        name,
        categoryId: nextCategoryId,
        departmentId: nextDepartmentId,
      },
    });
  }
  const duplicate = await collection.findOne({
    _id: { $ne: id },
    name: { $regex: `^${escapeRegex(name)}$`, $options: "i" },
  });
  if (duplicate) throw badRequest("name: this option already exists");
  await collection.updateOne({ _id: id }, { $set: { name } });
  const snapshotField = {
    departments: "departmentName",
    categories: "categoryName",
    services: "serviceName",
  }[kind];
  const referenceField = {
    departments: "departmentId",
    categories: "categoryId",
    services: "serviceId",
  }[kind];
  await db
    .collection("tickets")
    .updateMany({ [referenceField]: id }, { $set: { [snapshotField]: name } });
  res.json({ item: { id, name } });
}

async function deleteCatalogItem(req, res) {
  const { kind, id: rawId } = catalogItemParamSchema.parse(req.params);
  const db = getDb();

  if (kind === "priorities" || kind === "statuses") {
    if (kind === "statuses" && ["open", "resolved"].includes(rawId)) {
      throw badRequest(
        "The open and resolved statuses are required by ticket workflows",
      );
    }
    const collection = db.collection("ticketOptions");
    const optionDoc = await collection.findOne({ _id: kind });
    const values = optionDoc?.values ?? optionDefaults[kind];
    const value = rawId;
    if (!values.includes(value)) throw badRequest("Option not found");
    if (kind === "priorities" && values.length === 1) {
      throw badRequest("At least one priority must remain available");
    }
    const field = kind === "priorities" ? "priority" : "status";
    const ticketUsesOption = await db
      .collection("tickets")
      .findOne({ [field]: value }, { projection: { _id: 1 } });
    const activityUsesStatus =
      kind === "statuses" &&
      (await db
        .collection("activities")
        .findOne({ ticketStatus: value }, { projection: { _id: 1 } }));
    if (ticketUsesOption || activityUsesStatus) {
      throw badRequest(
        "This option is used by existing tickets and cannot be deleted",
      );
    }
    await collection.updateOne(
      { _id: kind },
      { $set: { values: values.filter((item) => item !== value) } },
      { upsert: true },
    );
    return res.status(204).end();
  }

  const id = z.coerce.number().int().positive().parse(rawId);
  const collection = db.collection(kind);
  if (!(await collection.findOne({ _id: id })))
    throw badRequest("Option not found");
  const references = {
    departments: [
      ["users", { departmentId: id }],
      ["services", { departmentId: id }],
      ["tickets", { departmentId: id }],
    ],
    categories: [
      ["services", { categoryId: id }],
      ["tickets", { categoryId: id }],
    ],
    services: [["tickets", { serviceId: id }]],
  }[kind];
  for (const [collectionName, filter] of references) {
    if ( 
      await db
        .collection(collectionName)

        .findOne(filter, { projection: { _id: 1 } })
    ) {
      throw badRequest("This option is in use and cannot be deleted");
    }
  }
  await collection.deleteOne({ _id: id });
  res.status(204).end();
}

module.exports = {
  listLinkedTickets,
  createUserSchema,
  listUsers,
  createUser,
  passwordResetParamsSchema,
  resetPasswordSchema,
  listPasswordResetRequests,
  resetRequestedPassword,
  catalogParamSchema,
  catalogItemParamSchema,
  catalogBodySchema,
  listCatalog,
  createCatalogItem,
  updateCatalogItem,
  deleteCatalogItem,
};
