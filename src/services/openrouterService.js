const axios = require("axios");
const { env } = require("../config/env");

const openrouterClient = axios.create({
  baseURL: "https://openrouter.ai/api/v1",
  timeout: 45_000,
  headers: {
    Authorization: `Bearer ${env.openrouterApiKey}`,
    "Content-Type": "application/json",
    "HTTP-Referer": env.appBaseUrl || "https://example.com",
    "X-Title": "WhatsApp Business Bot"
  }
});

async function chat(messages) {
  const response = await openrouterClient.post("/chat/completions", {
    model: env.openrouterModel,
    messages,
    max_tokens: env.openrouterMaxTokens,
    temperature: env.openrouterTemperature
  });

  const choice = response.data && Array.isArray(response.data.choices) ? response.data.choices[0] : null;
  const usage = response.data && response.data.usage ? response.data.usage : {};

  return {
    reply: choice && choice.message ? `${choice.message.content || ""}`.trim() : "",
    inputTokens: Number(usage.prompt_tokens || 0),
    outputTokens: Number(usage.completion_tokens || 0),
    raw: response.data
  };
}

module.exports = { chat };
