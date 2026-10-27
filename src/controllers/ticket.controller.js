const { z } = require("zod");
const service = require("../services/ticket.service");

const int = z.coerce.number().int().positive();
const emptyToUndef = (v) => (v === "" || v === null ? undefined : v);

const listQuery = z.object({
  scope: z.enum(["raised", "assigned", "department", "all"]).default("raised"),
  status: z.string().trim().min(1).max(80).optional(),
  statusGroup: z.enum(["open", "resolved"]).optional(),
  linkedOnly: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  department: z.preprocess(emptyToUndef, int.optional()),
  priority: z.string().trim().min(1).max(80).optional(),
  search: z.string().trim().max(100).optional(),
  sort: z.enum(["created", "updated"]).default("created"),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const createBody = z.object({
  categoryId: int,
  serviceId: int,
  departmentId: int,
  asset: z
    .string()
    .trim()
    .min(1, "Enter the asset that needs attention")
    .max(120),
  description: z.string().trim().max(2000).optional(),
  priority: z.string().trim().min(1).max(80).default("medium"),
  expectedClosingDays: z.preprocess(
    emptyToUndef,
    z.coerce.number().int().min(1).max(365).optional(),
  ),
  block: z.string().trim().max(40).optional(),
  floor: z.string().trim().max(20).optional(),
  room: z.string().trim().max(20).optional(),
});

const idParam = z.object({ id: int });
const attachmentParam = z.object({ id: int, attachmentId: int });
const statusBody = z.object({
  status: z.string().trim().min(1).max(80),
});
const assignBody = z.object({
  assigneeId: int,
  note: z.string().trim().min(3).max(500).optional(),
});
const linkedTicketBody = z.object({
  categoryId: int,
  serviceId: int,
  departmentId: int,
  asset: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).optional(),
  priority: z.string().trim().min(1).max(80).optional(),
  note: z.string().trim().min(3).max(500),
});
const commentBody = z.object({
  body: z.string().trim().min(1, "Write a comment first").max(1000),
});
const activityQuery = z.object({
  scope: z.enum(["raised", "assigned", "department", "all"]).default("raised"),
  search: z.string().trim().max(100).optional(),
  date: z.preprocess(
    emptyToUndef,
    z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD")
      .optional(),
  ),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const list = async (req, res) =>
  res.json(await service.list(req.user, req.query));
const getOne = async (req, res) =>
  res.json({ ticket: await service.getById(req.user, req.params.id) });

const create = async (req, res) => {
  const id = await service.create(req.user, req.body, req.files);
  res.status(201).json({ ticket: await service.getById(req.user, id) });
};

const setStatus = async (req, res) => {
  await service.updateStatus(req.user, req.params.id, req.body.status);
  res.json({ ticket: await service.getById(req.user, req.params.id) });
};

const assign = async (req, res) => {
  await service.assign(
    req.user,
    req.params.id,
    req.body.assigneeId,
    req.body.note,
  );
  res.json({ ticket: await service.getById(req.user, req.params.id) });
};

const createLinkedTicket = async (req, res) => {
  const id = await service.createLinkedTicket(
    req.user,
    req.params.id,
    req.body,
  );
  res.status(201).json({ ticket: await service.getById(req.user, id) });
};

const attachment = async (req, res) => {
  const file = await service.getAttachment(
    req.user,
    req.params.id,
    req.params.attachmentId,
  );
  res.type(file.mimetype).send(file.data);
};

const comment = async (req, res) => {
  await service.addComment(req.user, req.params.id, req.body.body);
  res
    .status(201)
    .json({ ticket: await service.getById(req.user, req.params.id) });
};

const activity = async (req, res) =>
  res.json({ data: await service.listActivity(req.user, req.query) });

module.exports = {
  listQuery,
  createBody,
  idParam,
  attachmentParam,
  statusBody,
  assignBody,
  linkedTicketBody,
  commentBody,
  activityQuery,
  list,
  getOne,
  create,
  setStatus,
  assign,
  createLinkedTicket,
  attachment,
  comment,
  activity,
};
