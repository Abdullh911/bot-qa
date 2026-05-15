const express = require("express");
const { env } = require("../config/env");
const { processWebhook } = require("../controllers/messageController");

const router = express.Router();

router.get("/", (req, res) => {
  const mode = req.query["hub.mode"];
  const verifyToken = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && verifyToken === env.whatsappVerifyToken) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

router.post("/", (req, res) => {
  res.sendStatus(200);
  void processWebhook(req.body);
});

module.exports = router;
