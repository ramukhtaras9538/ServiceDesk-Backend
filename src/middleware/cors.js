function createCorsOptions({ NODE_ENV, corsOrigins }) {
  return {
    origin(origin, callback) {
      if (
        NODE_ENV !== "production" ||
        !origin ||
        corsOrigins.includes(origin)
      ) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
  };
}

module.exports = { createCorsOptions };
