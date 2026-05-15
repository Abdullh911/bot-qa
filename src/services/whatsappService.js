const axios = require("axios");
const { env } = require("../config/env");

const baseUrl = `https://graph.facebook.com/${env.whatsappGraphVersion}/${env.whatsappPhoneNumberId}`;

const whatsappClient = axios.create({
  baseURL: baseUrl,
  timeout: 20_000,
  headers: {
    Authorization: `Bearer ${env.whatsappAccessToken}`,
    "Content-Type": "application/json"
  }
});

const DEFAULT_TYPING_REFRESH_MS = 20_000;

function splitText(text, maxLength = 3900) {
  const value = `${text || ""}`.trim();
  if (!value) {
    return [];
  }

  const chunks = [];
  let remaining = value;

  while (remaining.length > maxLength) {
    const candidate = remaining.slice(0, maxLength);
    const splitIndex = Math.max(candidate.lastIndexOf("\n"), candidate.lastIndexOf(". "), candidate.lastIndexOf(" "));
    const endIndex = splitIndex > maxLength * 0.6 ? splitIndex + 1 : maxLength;
    chunks.push(remaining.slice(0, endIndex).trim());
    remaining = remaining.slice(endIndex).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

async function sendPayload(payload) {
  const response = await whatsappClient.post("/messages", {
    messaging_product: "whatsapp",
    ...payload
  });

  return response.data;
}

async function markMessageAsRead(messageId) {
  if (!messageId) {
    return null;
  }

  return sendPayload({
    status: "read",
    message_id: messageId
  });
}

async function sendTypingIndicator(messageId) {
  if (!messageId) {
    return null;
  }

  return sendPayload({
    status: "read",
    message_id: messageId,
    typing_indicator: {
      type: "text"
    }
  });
}

function startTypingIndicator(messageId, options = {}) {
  if (!messageId) {
    return {
      stop() {}
    };
  }

  const refreshMs = Math.max(Number(options.refreshMs) || DEFAULT_TYPING_REFRESH_MS, 5_000);
  let stopped = false;
  let intervalId = null;

  const fire = async () => {
    if (stopped) {
      return;
    }

    await sendTypingIndicator(messageId);
  };

  const firstRun = fire().catch(() => {});
  intervalId = setInterval(() => {
    void fire().catch(() => {});
  }, refreshMs);

  if (typeof intervalId.unref === "function") {
    intervalId.unref();
  }

  return {
    firstRun,
    async stop() {
      stopped = true;
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    }
  };
}

async function sendText(to, text) {
  const chunks = splitText(text);
  const responses = [];

  for (const chunk of chunks) {
    const response = await sendPayload({
      recipient_type: "individual",
      to,
      type: "text",
      text: {
        body: chunk,
        preview_url: false
      }
    });
    responses.push({
      id: response && Array.isArray(response.messages) && response.messages[0]
        ? response.messages[0].id
        : null,
      chunk
    });
  }

  return {
    chunks: responses
  };
}

async function sendImage(to, image) {
  const response = await sendPayload({
    recipient_type: "individual",
    to,
    type: "image",
    image: {
      link: image.url,
      caption: image.caption || image.description || ""
    }
  });

  return {
    id: response && Array.isArray(response.messages) && response.messages[0]
      ? response.messages[0].id
      : null,
    imageId: image.id,
    url: image.url
  };
}

module.exports = {
  markMessageAsRead,
  sendTypingIndicator,
  startTypingIndicator,
  sendText,
  sendImage
};
