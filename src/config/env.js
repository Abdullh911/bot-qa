const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

function required(name, fallbackNames = []) {
  const keys = [name, ...fallbackNames];

  for (const key of keys) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }

  throw new Error(`Missing required environment variable: ${name}`);
}

function optional(name, fallback = "") {
  const value = process.env[name];
  return typeof value === "string" ? value.trim() : fallback;
}

function optionalNumber(name, fallback) {
  const rawValue = process.env[name];
  if (rawValue == null || rawValue === "") {
    return fallback;
  }

  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${name} must be a number.`);
  }

  return parsed;
}

const env = {
  nodeEnv: optional("NODE_ENV", "development"),
  port: optionalNumber("PORT", 3000),
  logLevel: optional("LOG_LEVEL", "info"),
  appBaseUrl: optional("APP_BASE_URL", ""),

  businessId: required("BUSINESS_ID"),

  whatsappPhoneNumberId: required("WHATSAPP_PHONE_NUMBER_ID"),
  whatsappAccessToken: required("WHATSAPP_ACCESS_TOKEN"),
  whatsappVerifyToken: required("WHATSAPP_VERIFY_TOKEN"),
  whatsappGraphVersion: optional("WHATSAPP_GRAPH_VERSION", "v22.0"),

  openrouterApiKey: required("OPENROUTER_API_KEY"),
  openrouterModel: optional("OPENROUTER_MODEL", "deepseek/deepseek-v4-flash"),
  openrouterMaxTokens: optionalNumber("OPENROUTER_MAX_TOKENS", 600),
  openrouterTemperature: optionalNumber("OPENROUTER_TEMPERATURE", 0.35),

  hfApiToken: required("HF_API_TOKEN", ["hf_token"]),
  hfEmbeddingModel: optional("HF_EMBEDDING_MODEL", "intfloat/multilingual-e5-large"),

  supabaseUrl: required("SUPABASE_URL"),
  supabaseServiceKey: required("SUPABASE_SERVICE_KEY"),

  maxHistoryMessages: optionalNumber("MAX_HISTORY_MESSAGES", 10),
  vectorTopK: optionalNumber("VECTOR_TOP_K", 10),
  vectorSimilarityThreshold: optionalNumber("VECTOR_SIMILARITY_THRESHOLD", 0.65),
  maxCandidateImages: optionalNumber("MAX_CANDIDATE_IMAGES", 3)
};

module.exports = { env };
