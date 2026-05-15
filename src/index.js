const express = require("express");
const pinoHttp = require("pino-http");
const { env } = require("./config/env");
const { logger } = require("./utils/logger");
const webhookRouter = require("./routes/webhook");

const app = express();

app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));
app.use(
  pinoHttp({
    logger,
    autoLogging: {
      ignorePaths: ["/health"]
    }
  })
);

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    service: "whatsapp-bot-v4",
    ts: Date.now()
  });
});

app.use("/webhook", webhookRouter);

app.use((error, req, res, next) => {
  req.log.error({ err: error }, "Unhandled request error.");

  if (res.headersSent) {
    return next(error);
  }

  return res.status(500).json({ error: "Internal Server Error" });
});

app.listen(env.port, () => {
  logger.info(
    {
      port: env.port,
      businessId: env.businessId,
      model: env.openrouterModel
    },
    "WhatsApp bot server started."
  );
});
