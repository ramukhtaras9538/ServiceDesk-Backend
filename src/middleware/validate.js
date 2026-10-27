const { badRequest } = require("../utils/errors");

// validate(schema, 'body' | 'query' | 'params')
module.exports =
  (schema, source = "body") =>
  (req, _res, next) => {
    const result = schema.safeParse(req[source] ?? {});
    if (!result.success) {
      const first = result.error.issues[0];
      const field = first.path.join(".") || "input";
      return next(badRequest(`${field}: ${first.message}`));
    }
    // Express 5 exposes req.query as a read-only getter, so redefine it
    Object.defineProperty(req, source, {
      value: result.data,
      writable: true,
      configurable: true,
      enumerable: true,
    });
    next();
  };
