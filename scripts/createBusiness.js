const path = require("path");
const dotenv = require("dotenv");
const { createClient } = require("@supabase/supabase-js");

dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

const BUSINESS_CONFIG = {
  ownerEmail: "3abdullah7mohamed@gmail.com",
  ownerId: "",
  name: "abdullah",
  botName: "Assistant",
  botPersona: "friendly and professional",
  fallbackMsg: "Sorry, I did not understand. Please contact us directly.",
  lowBalanceMsg: "Service temporarily unavailable. Please try again later.",
  languageHint: "auto",
  balance: 0,
  similarityThreshold: 0.65,
  vectorTopK: 10,
  forceCreateDuplicateName: false,
};

function requiredEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function parseNumber(value, fieldName, fallback) {
  if (value == null || value === "") {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${fieldName} must be a valid number.`);
  }

  return parsed;
}

function normalizeLanguageHint(value) {
  const normalized = `${value || "auto"}`.trim().toLowerCase();
  if (!["auto", "en", "ar"].includes(normalized)) {
    throw new Error("languageHint must be one of: auto, en, ar");
  }
  return normalized;
}

function getConfig() {
  const config = {
    ownerEmail: `${BUSINESS_CONFIG.ownerEmail || ""}`.trim().toLowerCase(),
    ownerId: `${BUSINESS_CONFIG.ownerId || ""}`.trim(),
    name: `${BUSINESS_CONFIG.name || ""}`.trim(),
    botName: `${BUSINESS_CONFIG.botName || "Assistant"}`.trim(),
    botPersona:
      `${BUSINESS_CONFIG.botPersona || "friendly and professional"}`.trim(),
    fallbackMsg:
      `${BUSINESS_CONFIG.fallbackMsg || "Sorry, I did not understand. Please contact us directly."}`.trim(),
    lowBalanceMsg:
      `${BUSINESS_CONFIG.lowBalanceMsg || "Service temporarily unavailable. Please try again later."}`.trim(),
    languageHint: normalizeLanguageHint(BUSINESS_CONFIG.languageHint),
    balance: parseNumber(BUSINESS_CONFIG.balance, "balance", 0),
    similarityThreshold: parseNumber(
      BUSINESS_CONFIG.similarityThreshold,
      "similarityThreshold",
      0.65,
    ),
    vectorTopK: parseNumber(BUSINESS_CONFIG.vectorTopK, "vectorTopK", 10),
    forceCreateDuplicateName: Boolean(BUSINESS_CONFIG.forceCreateDuplicateName),
  };

  if (!config.ownerEmail) {
    throw new Error(
      "Set BUSINESS_CONFIG.ownerEmail before running this script.",
    );
  }

  if (!config.name) {
    throw new Error("Set BUSINESS_CONFIG.name before running this script.");
  }

  return config;
}

async function findAuthUserByEmail(supabase, email) {
  const normalizedEmail = email.trim().toLowerCase();
  let page = 1;
  const perPage = 200;

  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({
      page,
      perPage,
    });

    if (error) {
      throw error;
    }

    const users = Array.isArray(data && data.users) ? data.users : [];
    const match = users.find(
      (user) => `${user.email || ""}`.trim().toLowerCase() === normalizedEmail,
    );

    if (match) {
      return match;
    }

    if (users.length < perPage) {
      return null;
    }

    page += 1;
  }
}

async function ensureBusinessDoesNotAlreadyExist(
  supabase,
  ownerEmail,
  businessName,
) {
  const { data, error } = await supabase
    .from("businesses")
    .select("id, name, created_at")
    .eq("owner_email", ownerEmail.toLowerCase())
    .eq("name", businessName)
    .limit(1);

  if (error) {
    throw error;
  }

  return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

async function createBusiness() {
  const config = getConfig();
  const supabaseUrl = requiredEnv("SUPABASE_URL");
  const supabaseServiceKey = requiredEnv("SUPABASE_SERVICE_KEY");

  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  let ownerUser = null;
  let ownerId = config.ownerId || null;

  if (!ownerId) {
    ownerUser = await findAuthUserByEmail(supabase, config.ownerEmail);
    ownerId = ownerUser ? ownerUser.id : null;
  }

  if (!config.forceCreateDuplicateName) {
    const existing = await ensureBusinessDoesNotAlreadyExist(
      supabase,
      config.ownerEmail,
      config.name,
    );

    if (existing) {
      throw new Error(
        `A business named "${existing.name}" already exists for ${config.ownerEmail} (id: ${existing.id}). Set forceCreateDuplicateName=true if you really want another one.`,
      );
    }
  }

  const payload = {
    owner_id: ownerId,
    owner_email: config.ownerEmail,
    name: config.name,
    bot_name: config.botName,
    bot_persona: config.botPersona,
    fallback_msg: config.fallbackMsg,
    low_balance_msg: config.lowBalanceMsg,
    language_hint: config.languageHint,
    balance: config.balance,
    similarity_threshold: config.similarityThreshold,
    vector_top_k: config.vectorTopK,
  };

  const { data, error } = await supabase
    .from("businesses")
    .insert(payload)
    .select(
      "id, owner_id, owner_email, name, bot_name, language_hint, balance, similarity_threshold, vector_top_k, created_at",
    )
    .single();

  if (error) {
    throw error;
  }

  console.log("Business created successfully.\n");
  console.log(`Owner email:      ${data.owner_email}`);
  console.log(`Owner user id:    ${data.owner_id || "(not linked yet)"}`);
  console.log(`Business id:      ${data.id}`);
  console.log(`Business name:    ${data.name}`);
  console.log(`Bot name:         ${data.bot_name}`);
  console.log(`Language hint:    ${data.language_hint}`);
  console.log(`Starting balance: ${data.balance}`);
  console.log(`Top K:            ${data.vector_top_k}`);
  console.log(`Threshold:        ${data.similarity_threshold}`);
  console.log(`Created at:       ${data.created_at}`);

  if (!ownerId) {
    console.log(
      "\nWarning: no auth user was found for this email, so owner_id was stored as null.",
    );
  }

  console.log("\nPut this in the bot env:");
  console.log(`BUSINESS_ID=${data.id}`);
}

createBusiness().catch((error) => {
  console.error(`\nError: ${error.message}`);
  process.exitCode = 1;
});
