const pino = require("pino");

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  base: undefined,
  redact: {
    paths: [
      "req.headers.authorization",
      "authorization",
      "headers.Authorization",
      "headers.authorization",
      "config.headers.Authorization",
      "config.headers.authorization",
      "response.config.headers.Authorization",
      "response.config.headers.authorization"
    ],
    censor: "[REDACTED]"
  }
});

module.exports = { logger };
