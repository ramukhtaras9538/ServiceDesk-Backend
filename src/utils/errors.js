class AppError extends Error {
  constructor(status, message, code) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
  }
}

const badRequest = (m = "Bad request") => new AppError(400, m, "BAD_REQUEST");
const unauthorized = (m = "Please sign in to continue") =>
  new AppError(401, m, "UNAUTHORIZED");
const forbidden = (m = "You do not have access to this") =>
  new AppError(403, m, "FORBIDDEN");
const notFound = (m = "Not found") => new AppError(404, m, "NOT_FOUND");
const conflict = (m = "Conflict") => new AppError(409, m, "CONFLICT");

module.exports = {
  AppError,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
};
