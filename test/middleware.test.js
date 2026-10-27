const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const multer = require("multer");

const app = require("../src/app");
const { createCorsOptions } = require("../src/middleware/cors");
const { errorHandler } = require("../src/middleware/error");
const { badRequest } = require("../src/utils/errors");

function invokeErrorHandler(error) {
  let statusCode;
  let body;
  const response = {
    status(status) {
      statusCode = status;
      return this;
    },
    json(value) {
      body = value;
      return this;
    },
  };

  errorHandler(error, {}, response, () => {});
  return { statusCode, body };
}

test("upload size errors return a safe client error response", () => {
  const response = invokeErrorHandler(new multer.MulterError("LIMIT_FILE_SIZE"));

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.code, "UPLOAD_ERROR");
  assert.equal(response.body.message, "Each attachment must be 5 MB or smaller");
});

test("upload count and unexpected-field errors return actionable messages", () => {
  const countError = invokeErrorHandler(
    new multer.MulterError("LIMIT_FILE_COUNT"),
  );
  const fieldError = invokeErrorHandler(
    new multer.MulterError("LIMIT_UNEXPECTED_FILE"),
  );

  assert.equal(countError.body.message, "You can attach up to 5 files");
  assert.equal(
    fieldError.body.message,
    "An unexpected attachment field was received",
  );
});

test("unsupported attachment types preserve the validation error response", () => {
  const response = invokeErrorHandler(
    badRequest("Only PNG, JPG, or PDF attachments are allowed"),
  );

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.code, "BAD_REQUEST");
  assert.equal(response.body.message, "Only PNG, JPG, or PDF attachments are allowed");
});

test("production CORS allows only configured origins and non-browser clients", () => {
  const options = createCorsOptions({
    NODE_ENV: "production",
    corsOrigins: ["https://desk.example.org"],
  });
  const checkOrigin = (origin) =>
    new Promise((resolve, reject) => {
      options.origin(origin, (error, allowed) => {
        if (error) reject(error);
        else resolve(allowed);
      });
    });

  return Promise.all([
    checkOrigin("https://desk.example.org"),
    checkOrigin("https://attacker.example"),
    checkOrigin(undefined),
  ]).then(([allowed, rejected, native]) => {
    assert.equal(allowed, true);
    assert.equal(rejected, false);
    assert.equal(native, true);
  });
});

test("health and not-found routes respond over HTTP", async () => {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;

  try {
    const health = await fetch(`${origin}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });

    const protectedUnknown = await fetch(`${origin}/api/missing`);
    assert.equal(protectedUnknown.status, 401);
    assert.equal((await protectedUnknown.json()).code, "UNAUTHORIZED");

    const missing = await fetch(`${origin}/missing`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).code, "NOT_FOUND");
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
