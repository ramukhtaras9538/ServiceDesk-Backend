const multer = require("multer");
const { badRequest } = require("../utils/errors");

const ALLOWED = new Set(["image/png", "image/jpeg", "application/pdf"]);

module.exports = multer({
  storage: multer.memoryStorage(),
  limits: { files: 5, fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) =>
    ALLOWED.has(file.mimetype)
      ? cb(null, true)
      : cb(badRequest("Only PNG, JPG, or PDF attachments are allowed")),
});
