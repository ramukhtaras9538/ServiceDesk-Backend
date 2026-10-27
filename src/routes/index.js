const router = require("express").Router();
const rateLimit = require("express-rate-limit");

const asyncHandler = require("../utils/asyncHandler");
const validate = require("../middleware/validate");
const upload = require("../middleware/upload");
const { authenticate, requireRole } = require("../middleware/auth");

const auth = require("../controllers/auth.controller");
const meta = require("../controllers/meta.controller");
const t = require("../controllers/ticket.controller");
const admin = require("../controllers/admin.controller");
const notifications = require("../controllers/notification.controller");
const workSessions = require("../controllers/work-session.controller");
const leaves = require("../controllers/leave.controller");

const loginLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
});
const passwordResetLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
});

router.get("/health", (_req, res) => res.json({ status: "ok" }));

// Auth
router.post(
  "/auth/login",
  loginLimiter,
  validate(auth.loginSchema),
  asyncHandler(auth.login),
);
router.post(
  "/auth/forgot-password",
  passwordResetLimiter,
  validate(auth.forgotPasswordSchema),
  asyncHandler(auth.requestPasswordReset),
);
router.get("/auth/me", authenticate, auth.me);

// Everything below needs a signed-in user
router.use(authenticate);

router.get("/meta", meta.getMeta);
router.get("/agents", requireRole("agent", "admin"), meta.getAgents);
router.get("/notifications", asyncHandler(notifications.list));
router.patch(
  "/notifications/:id/read",
  validate(t.idParam, "params"),
  asyncHandler(notifications.markRead),
);
router.get("/work-sessions", asyncHandler(workSessions.list));
router.get(
  "/leave",
  requireRole("agent", "admin"),
  asyncHandler(leaves.list),
);
router.post(
  "/leave",
  requireRole("agent"),
  validate(leaves.createBody),
  asyncHandler(leaves.create),
);
router.delete(
  "/leave/:id",
  requireRole("agent", "admin"),
  validate(leaves.idParam, "params"),
  asyncHandler(leaves.cancel),
);
router.post("/work-sessions/start", asyncHandler(workSessions.start));
router.post(
  "/work-sessions/:id/stop",
  validate(t.idParam, "params"),
  asyncHandler(workSessions.stop),
);
router.get("/admin/users", requireRole("admin"), asyncHandler(admin.listUsers));
router.post(
  "/admin/users",
  requireRole("admin"),
  validate(admin.createUserSchema),
  asyncHandler(admin.createUser),
);
router.get(
  "/admin/linked-tickets",
  requireRole("admin"),
  asyncHandler(admin.listLinkedTickets),
);
router.get(
  "/admin/password-reset-requests",
  requireRole("admin"),
  asyncHandler(admin.listPasswordResetRequests),
);
router.post(
  "/admin/password-reset-requests/:id/reset",
  requireRole("admin"),
  validate(admin.passwordResetParamsSchema, "params"),
  validate(admin.resetPasswordSchema),
  asyncHandler(admin.resetRequestedPassword),
);
router.get(
  "/admin/catalog/:kind",
  requireRole("admin"),
  validate(admin.catalogParamSchema, "params"),
  asyncHandler(admin.listCatalog),
);
router.post(
  "/admin/catalog/:kind",
  requireRole("admin"),
  validate(admin.catalogParamSchema, "params"),
  validate(admin.catalogBodySchema),
  asyncHandler(admin.createCatalogItem),
);
router.patch(
  "/admin/catalog/:kind/:id",
  requireRole("admin"),
  validate(admin.catalogItemParamSchema, "params"),
  validate(admin.catalogBodySchema),
  asyncHandler(admin.updateCatalogItem),
);
router.delete(
  "/admin/catalog/:kind/:id",
  requireRole("admin"),
  validate(admin.catalogItemParamSchema, "params"),
  asyncHandler(admin.deleteCatalogItem),
);

// Tickets
router.get("/tickets", validate(t.listQuery, "query"), asyncHandler(t.list));
router.post(
  "/tickets",
  upload.array("files", 5),
  validate(t.createBody),
  asyncHandler(t.create),
);
router.get(
  "/tickets/:id/attachments/:attachmentId",
  validate(t.attachmentParam, "params"),
  asyncHandler(t.attachment),
);
router.get(
  "/tickets/:id",
  validate(t.idParam, "params"),
  asyncHandler(t.getOne),
);
router.patch(
  "/tickets/:id/assign",
  validate(t.idParam, "params"),
  validate(t.assignBody),
  asyncHandler(t.assign),
);
router.post(
  "/tickets/:id/links",
  validate(t.idParam, "params"),
  validate(t.linkedTicketBody),
  asyncHandler(t.createLinkedTicket),
);
router.patch(
  "/tickets/:id/status",
  validate(t.idParam, "params"),
  validate(t.statusBody),
  asyncHandler(t.setStatus),
);

router.post(
  "/tickets/:id/comments",
  validate(t.idParam, "params"),
  validate(t.commentBody),
  asyncHandler(t.comment),
);

// Activity feed
router.get(
  "/activity",
  validate(t.activityQuery, "query"),
  asyncHandler(t.activity),
);

module.exports = router;
