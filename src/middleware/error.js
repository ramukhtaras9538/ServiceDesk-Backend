const multer = require("multer");
const env = require("../config/env");

const notFoundHandler = (req, res) =>
  res.status(404).json({
    error: "NotFound",
    message: `No route for ${req.method} ${req.originalUrl}`,
    code: "NOT_FOUND",
  });

// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, _next) => {
  let status = err.status || 500;
  let message = err.message;
  let code = err.code || "INTERNAL_ERROR";

  if (err instanceof multer.MulterError) {
    status = 400;
    code = "UPLOAD_ERROR";
    message = getMulterErrorMessage(err);
  }

  if (status >= 500) {
    console.error(err);
    message = "Something went wrong on our side";
  }

  res.status(status).json({
    error: err.name || "Error",
    message,
    code,
    ...(env.NODE_ENV === "development" &&
      status >= 500 && { stack: err.stack }),
  });
};

function getMulterErrorMessage(err) {
  switch (err.code) {
    case "LIMIT_FILE_SIZE":
      return "Each attachment must be 5 MB or smaller";
    case "LIMIT_FILE_COUNT":
      return "You can attach up to 5 files";
    case "LIMIT_UNEXPECTED_FILE":
      return "An unexpected attachment field was received";
    default:
      return "The attachments could not be processed";
  }
}

module.exports = { notFoundHandler, errorHandler };
