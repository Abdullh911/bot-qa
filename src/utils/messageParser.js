function normalizeText(value) {
  return `${value || ""}`.replace(/\s+/g, " ").trim();
}

function parseMessage(message) {
  if (!message || !message.id || !message.from) {
    return null;
  }

  const parsed = {
    messageId: message.id,
    from: message.from,
    type: message.type,
    text: "",
    contextMessageId: message.context && message.context.id ? message.context.id : null,
    raw: message
  };

  switch (message.type) {
    case "text":
      parsed.text = normalizeText(message.text && message.text.body);
      break;
    case "image":
      parsed.text = normalizeText(message.image && message.image.caption);
      break;
    case "button":
      parsed.text = normalizeText(message.button && message.button.text);
      break;
    case "interactive":
      parsed.text = normalizeText(
        message.interactive &&
          (
            (message.interactive.button_reply && message.interactive.button_reply.title) ||
            (message.interactive.list_reply && message.interactive.list_reply.title)
          )
      );
      break;
    default:
      return null;
  }

  if (!parsed.text) {
    return null;
  }

  return parsed;
}

function extractMessagesFromWebhook(body) {
  const entries = Array.isArray(body && body.entry) ? body.entry : [];
  const messages = [];

  for (const entry of entries) {
    const changes = Array.isArray(entry.changes) ? entry.changes : [];

    for (const change of changes) {
      const value = change && change.value;
      const incomingMessages = Array.isArray(value && value.messages) ? value.messages : [];

      for (const message of incomingMessages) {
        messages.push({
          message,
          metadata: value && value.metadata ? value.metadata : {},
          contacts: Array.isArray(value && value.contacts) ? value.contacts : []
        });
      }
    }
  }

  return messages;
}

module.exports = {
  parseMessage,
  extractMessagesFromWebhook
};
