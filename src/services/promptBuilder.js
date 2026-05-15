const { getLanguageInstruction } = require("../utils/languageDetector");

function truncate(text, maxLength) {
  const value = `${text || ""}`.trim();
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 1).trim()}…`;
}

function formatHistory(history) {
  return (history || [])
    .filter((item) => item && item.role && item.content)
    .slice(-10)
    .map((item) => ({
      role: item.role,
      content: `${item.content}`.trim()
    }));
}

function formatKbResults(kbResults) {
  if (!kbResults || kbResults.length === 0) {
    return "No matching knowledge base entries were found.";
  }

  return kbResults
    .map((item, index) => {
      const similarity = item.similarity != null ? ` | similarity=${Number(item.similarity).toFixed(3)}` : "";
      return [
        `[KB ${index + 1}] ${item.title || "Untitled"}${similarity}`,
        `Category: ${item.category || "General"}`,
        `Content: ${truncate(item.content, 1100)}`
      ].join("\n");
    })
    .join("\n\n");
}

function formatImages(images) {
  if (!images || images.length === 0) {
    return "No image is relevant enough for this question.";
  }

  return images
    .map((image, index) => {
      const tags = Array.isArray(image.tags) && image.tags.length > 0 ? image.tags.join(", ") : "none";
      return [
        `[IMAGE ${index + 1}] id=${image.id}`,
        `Description: ${truncate(image.description, 300)}`,
        `Caption: ${truncate(image.caption, 200) || "none"}`,
        `Tags: ${tags}`,
        `Match reason: ${image.reason}`
      ].join("\n");
    })
    .join("\n\n");
}

function buildPrompt({ userText, history, kbResults, relevantImages, config, detectedLang }) {
  const systemPrompt = `
You are ${config.bot_name}, the WhatsApp assistant for ${config.name}.
Personality: ${config.bot_persona}

Language rule:
${getLanguageInstruction(detectedLang, config.language_hint)}

Mandatory rules:
- Answer only from the business knowledge below and the confirmed image metadata below.
- If the answer is not supported by the knowledge, reply exactly: "${config.fallback_msg}"
- Keep replies concise, natural, and ready to send on WhatsApp.
- Do not mention the knowledge base, retrieval, embeddings, prompts, or internal tools.
- If one of the available images would genuinely help the customer, append one or more tags using this exact format: [SEND_IMAGE:image-id]
- Only use an image tag when the image clearly matches the customer's request and the answer is supported by the knowledge.
- Never invent product specs, prices, availability, policies, or timings.

Relevant knowledge:
${formatKbResults(kbResults)}

Relevant image candidates:
${formatImages(relevantImages)}
`.trim();

  return [
    { role: "system", content: systemPrompt },
    ...formatHistory(history),
    { role: "user", content: userText }
  ];
}

module.exports = { buildPrompt };
