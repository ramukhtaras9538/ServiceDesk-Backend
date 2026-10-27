const { z } = require("zod");
const service = require("../services/leave.service");

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const createBody = z.object({
  startDate: dateString,
  endDate: dateString,
});
const idParam = z.object({ id: z.coerce.number().int().positive() });

async function list(req, res) {
  res.json({ leaves: await service.listLeaves(req.user) });
}

async function create(req, res) {
  const leave = await service.createLeave(req.user, req.body);
  res.status(201).json({ leave });
}

async function cancel(req, res) {
  const leave = await service.cancelLeave(req.user, req.params.id);
  res.json({ leave });
}

module.exports = { createBody, idParam, list, create, cancel };
