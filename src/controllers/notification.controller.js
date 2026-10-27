const service = require("../services/ticket.service");

async function list(req, res) {
  res.json(await service.listNotifications(req.user));
}

async function markRead(req, res) {
  await service.markNotificationRead(req.user, req.params.id);
  res.status(204).end();
}

module.exports = { list, markRead };
