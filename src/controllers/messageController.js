const { env } = require("../config/env");
const { logger } = require("../utils/logger");
const { detectLanguage, getLanguageInstruction } = require("../utils/languageDetector");
const {
  chooseRelevantImages,
  getImageIntentDecision,
  parseImageTags,
  stripImageTags
} = require("../utils/imageDecider");
const { calculateCost } = require("../utils/costCalculator");
const { parseMessage, extractMessagesFromWebhook } = require("../utils/messageParser");
const supabaseService = require("../services/supabaseService");
const whatsappService = require("../services/whatsappService");
const openrouterService = require("../services/openrouterService");
const vectorSearchService = require("../services/vectorSearchService");
const { buildPrompt } = require("../services/promptBuilder");

function buildConversationEntry(role, content, extras = {}) {
  return {
    role,
    content,
    ts: new Date().toISOString(),
    ...extras
  };
}

function truncate(text, maxLength = 280) {
  const value = `${text || ""}`.replace(/\s+/g, " ").trim();
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3).trim()}...`;
}

function normalizeMessageText(text) {
  return `${text || ""}`
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const PURE_GREETING_PATTERNS = [
  /^hi+$/,
  /^hey+$/,
  /^hello+$/,
  /^good morning$/,
  /^good afternoon$/,
  /^good evening$/,
  /^السلام عليكم(?: ورحمة الله وبركاته)?$/,
  /^اهلا$/,
  /^أهلا$/,
  /^اهلا وسهلا$/,
  /^أهلا وسهلا$/,
  /^مرحبا$/,
  /^مرحب[اى]$/,
  /^هلا$/,
  /^هاي$/,
  /^صباح الخير$/,
  /^مساء الخير$/,
  /^يسعد صباحك$/,
  /^يسعد مساك$/
];

const GREETING_WITH_COURTESY_PATTERNS = [
  /^السلام عليكم(?: ورحمة الله وبركاته)?(?: يا?\s*\S+)?(?: لو سمحت| بعد اذنك| من فضلك)?$/,
  /^اهلا(?: وسهلا)?(?: لو سمحت| بعد اذنك| من فضلك)?$/,
  /^أهلا(?: وسهلا)?(?: لو سمحت| بعد اذنك| من فضلك)?$/,
  /^مرحبا(?: لو سمحت| بعد اذنك| من فضلك)?$/,
  /^مرحب[اى](?: لو سمحت| بعد اذنك| من فضلك)?$/,
  /^hi(?: please)?$/,
  /^hello(?: please)?$/,
  /^hey(?: please)?$/
];

function isGreetingMessage(text) {
  const normalized = normalizeMessageText(text);
  if (!normalized) {
    return false;
  }

  return [...PURE_GREETING_PATTERNS, ...GREETING_WITH_COURTESY_PATTERNS].some((pattern) =>
    pattern.test(normalized)
  );
}

function buildGreetingReply(detectedLang, config) {
  if (detectedLang === "ar") {
    return `وعليكم السلام ورحمة الله وبركاته.\n\nأهلاً وسهلاً بك في ${config.name}. كيف أقدر أساعدك اليوم؟`;
  }

  if (detectedLang === "en") {
    return `Hello and welcome to ${config.name}. How can I help you today?`;
  }

  return `Hello and welcome to ${config.name}. How can I help you today?`;
}

function summarizeKbResults(kbResults) {
  return (kbResults || []).map((item) => ({
    id: item.id,
    title: item.title,
    category: item.category,
    similarity: item.similarity != null ? Number(item.similarity.toFixed(4)) : null,
    preview: truncate(item.content, 160)
  }));
}

function summarizeImages(images) {
  return (images || []).map((image) => ({
    id: image.id,
    caption: image.caption || null,
    description: truncate(image.description, 120),
    tags: Array.isArray(image.tags) ? image.tags : [],
    queryScore: image.queryScore != null ? Number(image.queryScore.toFixed(4)) : null,
    kbScore: image.kbScore != null ? Number(image.kbScore.toFixed(4)) : null,
    combinedScore: image.combinedScore != null ? Number(image.combinedScore.toFixed(4)) : null,
    reason: image.reason || null
  }));
}

function summarizeHistory(history) {
  return (history || []).slice(-5).map((item) => ({
    role: item.role,
    preview: truncate(item.content, 120)
  }));
}

function summarizePrompt(messages) {
  return (messages || []).map((item, index) => ({
    index,
    role: item.role,
    chars: `${item.content || ""}`.length,
    preview: truncate(item.content, item.role === "system" ? 220 : 140)
  }));
}

function extractSnippet(text, maxLength = 220) {
  const value = `${text || ""}`.replace(/\s+/g, " ").trim();
  if (!value) {
    return "";
  }

  const firstSentence = value.split(/(?<=[.!?؟])\s+/)[0];
  return truncate(firstSentence || value, maxLength);
}

function buildRetryPrompt({ userText, kbResults, relevantImages, config, detectedLang, imageIntent }) {
  const knowledgeSummary = kbResults
    .slice(0, 3)
    .map((item, index) => [
      `[KB ${index + 1}] ${item.title || "Untitled"}`,
      `Category: ${item.category || "General"}`,
      `Content: ${extractSnippet(item.content, 320)}`
    ].join("\n"))
    .join("\n\n");

  const imageSummary = relevantImages.length > 0
    ? relevantImages
        .slice(0, 3)
        .map((image, index) => [
          `[IMAGE ${index + 1}] id=${image.id}`,
          `Caption: ${image.caption || "none"}`,
          `Description: ${extractSnippet(image.description, 160)}`
        ].join("\n"))
        .join("\n\n")
    : "No image candidates are needed unless the user explicitly asked to see them.";

  const systemPrompt = `
You are ${config.bot_name}, the WhatsApp assistant for ${config.name}.
${getLanguageInstruction(detectedLang, config.language_hint)}

Answer in 2 to 4 short sentences using only the knowledge below.
Do not leave the answer blank.
Do not mention internal tools or retrieval.
If the answer is unsupported, reply exactly: "${config.fallback_msg}"
${imageIntent.shouldAutoSend ? "If relevant images exist, you may mention that images are being shared." : ""}

Knowledge:
${knowledgeSummary}

Images:
${imageSummary}
`.trim();

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userText }
  ];
}

function buildGroundedFallbackReply({ kbResults, detectedLang, relevantImages, imageIntent, config }) {
  if (!kbResults || kbResults.length === 0) {
    return config.fallback_msg;
  }

  const lines = kbResults
    .slice(0, 3)
    .map((item) => `- ${item.title || item.category || "Info"}: ${extractSnippet(item.content, 220)}`)
    .filter(Boolean);

  if (lines.length === 0) {
    return config.fallback_msg;
  }

  if (detectedLang === "ar") {
    return [
      "بناءً على المعلومات المتاحة لدينا، هذه أهم التفاصيل:",
      ...lines,
      imageIntent.shouldAutoSend && relevantImages.length > 0
        ? "وأرسلت لك الصور المتاحة ذات الصلة."
        : ""
    ]
      .filter(Boolean)
      .join("\n");
  }

  return [
    "Based on the available information, here are the main details:",
    ...lines,
    imageIntent.shouldAutoSend && relevantImages.length > 0
      ? "I also shared the available relevant images."
      : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function hasUsableReply(reply) {
  return stripImageTags(reply).trim().length > 0;
}

function dedupeImages(images) {
  const seen = new Set();
  const result = [];

  for (const image of images || []) {
    if (!image || !image.id || seen.has(image.id)) {
      continue;
    }

    seen.add(image.id);
    result.push(image);
  }

  return result;
}

function normalizeReference(value) {
  return decodeURIComponent(`${value || ""}`).trim().toLowerCase();
}

function collectImageReferences(image) {
  const references = new Set();
  const imageId = normalizeReference(image && image.id);
  const imageUrl = normalizeReference(image && image.url);

  if (imageId) {
    references.add(imageId);
  }

  if (imageUrl) {
    references.add(imageUrl);

    try {
      const parsedUrl = new URL(image.url);
      const pathname = normalizeReference(parsedUrl.pathname);
      if (pathname) {
        references.add(pathname);
      }

      const publicMarker = "/object/public/";
      const markerIndex = pathname.indexOf(publicMarker);
      if (markerIndex >= 0) {
        const storagePath = pathname.slice(markerIndex + publicMarker.length);
        if (storagePath) {
          references.add(storagePath);

          const parts = storagePath.split("/");
          if (parts.length > 1) {
            references.add(parts.slice(1).join("/"));
          }
        }
      }
    } catch (error) {
      // Ignore malformed URLs and keep whatever plain-text references we already have.
    }
  }

  return references;
}

function buildAllowedImageMap(images) {
  const map = new Map();

  for (const image of images || []) {
    for (const reference of collectImageReferences(image)) {
      map.set(reference, image);
    }
  }

  return map;
}

async function generateReplyWithRecovery({
  prompt,
  userText,
  kbResults,
  relevantImages,
  config,
  detectedLang,
  imageIntent,
  logContext
}) {
  const attempts = [];

  try {
    const primary = await openrouterService.chat(prompt);
    attempts.push({
      stage: "primary",
      ok: hasUsableReply(primary.reply),
      inputTokens: primary.inputTokens,
      outputTokens: primary.outputTokens,
      rawReply: primary.reply
    });

    if (hasUsableReply(primary.reply)) {
      return {
        reply: primary.reply,
        inputTokens: primary.inputTokens,
        outputTokens: primary.outputTokens,
        attempts,
        recoveryMode: "primary"
      };
    }
  } catch (error) {
    logger.warn(
      {
        ...logContext,
        err: error
      },
      "Primary model call failed or returned unusable output."
    );
    attempts.push({
      stage: "primary",
      ok: false,
      inputTokens: 0,
      outputTokens: 0,
      rawReply: "",
      error: error instanceof Error ? error.message : "Unknown model error."
    });
  }

  const retryPrompt = buildRetryPrompt({
    userText,
    kbResults,
    relevantImages,
    config,
    detectedLang,
    imageIntent
  });

  try {
    const retry = await openrouterService.chat(retryPrompt, {
      maxTokens: Math.min(env.openrouterMaxTokens, 280),
      temperature: 0.15
    });
    attempts.push({
      stage: "retry",
      ok: hasUsableReply(retry.reply),
      inputTokens: retry.inputTokens,
      outputTokens: retry.outputTokens,
      rawReply: retry.reply
    });

    if (hasUsableReply(retry.reply)) {
      return {
        reply: retry.reply,
        inputTokens: attempts.reduce((sum, item) => sum + Number(item.inputTokens || 0), 0),
        outputTokens: attempts.reduce((sum, item) => sum + Number(item.outputTokens || 0), 0),
        attempts,
        recoveryMode: "retry"
      };
    }
  } catch (error) {
    logger.warn(
      {
        ...logContext,
        err: error
      },
      "Retry model call failed or returned unusable output."
    );
    attempts.push({
      stage: "retry",
      ok: false,
      inputTokens: 0,
      outputTokens: 0,
      rawReply: "",
      error: error instanceof Error ? error.message : "Unknown retry error."
    });
  }

  return {
    reply: buildGroundedFallbackReply({
      kbResults,
      detectedLang,
      relevantImages,
      imageIntent,
      config
    }),
    inputTokens: attempts.reduce((sum, item) => sum + Number(item.inputTokens || 0), 0),
    outputTokens: attempts.reduce((sum, item) => sum + Number(item.outputTokens || 0), 0),
    attempts,
    recoveryMode: "grounded_fallback"
  };
}

async function getKnowledgeResults(userText, config) {
  const topK = Math.max(
    10,
    Number(config.vector_top_k || 0),
    Number(env.vectorTopK || 0)
  );
  const threshold = Number(
    config.similarity_threshold ?? env.vectorSimilarityThreshold
  );

  try {
    const queryEmbedding = await vectorSearchService.generateEmbedding(userText, {
      mode: "query"
    });
    const kbResults = await supabaseService.searchKnowledgeBase({
      queryEmbedding,
      businessId: env.businessId,
      threshold,
      topK
    });

    return {
      kbResults,
      retrievalMode: "vector"
    };
  } catch (error) {
    logger.warn(
      {
        err: error,
        businessId: env.businessId
      },
      "Vector search failed, falling back to recent knowledge base entries."
    );

    const kbResults = await supabaseService.getRecentKnowledgeBaseEntries(
      env.businessId,
      topK
    );

    return {
      kbResults,
      retrievalMode: "fallback_recent"
    };
  }
}

async function processIncomingMessage(incoming) {
  const parsed = parseMessage(incoming.message);
  if (!parsed) {
    return;
  }

  const logContext = {
    businessId: env.businessId,
    customerPhone: parsed.from,
    messageId: parsed.messageId,
    messageType: parsed.type,
    contextMessageId: parsed.contextMessageId
  };

  logger.info(
    {
      ...logContext,
      incomingText: parsed.text,
      metadata: incoming.metadata || {},
      contacts: (incoming.contacts || []).map((item) => ({
        wa_id: item.wa_id,
        name: item.profile && item.profile.name ? item.profile.name : null
      }))
    },
    "Incoming WhatsApp message received."
  );

  const claimed = await supabaseService.claimMessage(parsed.messageId);
  if (!claimed) {
    logger.info(logContext, "Skipping duplicate message.");
    return;
  }

  const config = await supabaseService.getBusinessConfig(env.businessId);
  if (!config) {
    throw new Error(`Business ${env.businessId} was not found.`);
  }

  if (Number(config.balance) <= 0) {
    const lowBalanceSend = await whatsappService.sendText(parsed.from, config.low_balance_msg);
    logger.warn(
      {
        ...logContext,
        outgoingText: config.low_balance_msg,
        whatsappMessageIds: lowBalanceSend.chunks.map((item) => item.id).filter(Boolean)
      },
      "Skipped AI reply because business balance is not positive."
    );
    return;
  }

  let typingSession = null;
  try {
    typingSession = whatsappService.startTypingIndicator(parsed.messageId);
    await typingSession.firstRun;
  } catch (error) {
    logger.warn(
      { err: error, messageId: parsed.messageId },
      "Failed to start WhatsApp typing indicator."
    );
  }

  try {
    const detectedLang = detectLanguage(parsed.text);

    if (isGreetingMessage(parsed.text)) {
      const greetingReply = buildGreetingReply(detectedLang, config);
      const textSend = await whatsappService.sendText(parsed.from, greetingReply);

      await supabaseService.appendConversationMessages(
        env.businessId,
        parsed.from,
        [
          buildConversationEntry("user", parsed.text, {
            message_id: parsed.messageId
          }),
          buildConversationEntry("assistant", greetingReply, {
            retrieval_mode: "greeting_shortcut",
            input_tokens: 0,
            output_tokens: 0,
            cost_usd: 0
          })
        ],
        env.maxHistoryMessages
      );

      logger.info(
        {
          ...logContext,
          detectedLanguage: detectedLang,
          outgoingText: greetingReply,
          textChunkCount: textSend.chunks.length,
          textChunks: textSend.chunks.map((item) => ({
            id: item.id,
            preview: truncate(item.chunk, 160)
          })),
          retrievalMode: "greeting_shortcut",
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0
        },
        "Greeting shortcut reply sent without retrieval or model call."
      );
      return;
    }

    logger.info(
      {
        ...logContext,
        detectedLanguage: detectedLang,
        similarityThreshold: Number(
          config.similarity_threshold ?? env.vectorSimilarityThreshold
        ),
        requestedTopK: Math.max(
          10,
          Number(config.vector_top_k || 0),
          Number(env.vectorTopK || 0)
        )
      },
      "Starting retrieval workflow."
    );

    const { kbResults, retrievalMode } = await getKnowledgeResults(parsed.text, config);
    const fullHistory = await supabaseService.getConversation(env.businessId, parsed.from);
    const history = Array.isArray(fullHistory)
      ? fullHistory.slice(-Math.max(env.maxHistoryMessages, 1))
      : [];
    const imageIntent = getImageIntentDecision(parsed.text, kbResults);

    logger.info(
      {
        ...logContext,
        retrievalMode,
        kbMatchCount: kbResults.length,
        kbMatches: summarizeKbResults(kbResults),
        imageIntent,
        fullHistoryCount: Array.isArray(fullHistory) ? fullHistory.length : 0,
        historyCount: history.length,
        historyPreview: summarizeHistory(history)
      },
      "Knowledge retrieval finished."
    );

    if (kbResults.length === 0) {
      const fallbackSend = await whatsappService.sendText(parsed.from, config.fallback_msg);
      await supabaseService.appendConversationMessages(
        env.businessId,
        parsed.from,
        [
          buildConversationEntry("user", parsed.text, {
            message_id: parsed.messageId
          }),
          buildConversationEntry("assistant", config.fallback_msg, {
            retrieval_mode: retrievalMode
          })
        ],
        env.maxHistoryMessages
      );
      logger.warn(
        {
          ...logContext,
          retrievalMode,
          outgoingText: config.fallback_msg,
          whatsappMessageIds: fallbackSend.chunks.map((item) => item.id).filter(Boolean)
        },
        "No knowledge matched, fallback reply sent."
      );
      return;
    }

    const images = await supabaseService.getActiveImages(env.businessId);
    const relevantImages = chooseRelevantImages({
      queryText: parsed.text,
      kbResults,
      images,
      maxImages: env.maxCandidateImages,
      imageIntent
    });

    logger.info(
      {
        ...logContext,
        imageIntent,
        activeImageCount: images.length,
        relevantImageCount: relevantImages.length,
        relevantImages: summarizeImages(relevantImages)
      },
      "Image relevance selection finished."
    );

    const prompt = buildPrompt({
      userText: parsed.text,
      history,
      kbResults,
      relevantImages,
      config,
      detectedLang
    });

    logger.info(
      {
        ...logContext,
        promptMessageCount: prompt.length,
        promptSummary: summarizePrompt(prompt)
      },
      "Prompt built for model call."
    );

    const chatResult = await generateReplyWithRecovery({
      prompt,
      userText: parsed.text,
      kbResults,
      relevantImages,
      config,
      detectedLang,
      imageIntent,
      logContext
    });
    const cleanReply = stripImageTags(chatResult.reply) || config.fallback_msg;
    const userRequestedImages = imageIntent.wantsImages;
    const requestedImageIds = parseImageTags(chatResult.reply);
    const allowedImageMap = buildAllowedImageMap(images);
    const approvedImageIds = Array.from(new Set(requestedImageIds.map(normalizeReference)));
    const modelApprovedImages = approvedImageIds
      .map((imageId) => allowedImageMap.get(imageId))
      .filter(Boolean);
    const approvedImages = dedupeImages(
      imageIntent.shouldAutoSend
        ? [...relevantImages, ...modelApprovedImages]
        : modelApprovedImages
    );
    const imageDeliveryStrategy =
      imageIntent.shouldAutoSend && approvedImages.length > 0
        ? requestedImageIds.length > 0
          ? "auto_send_relevant_plus_model_tags"
          : "auto_send_relevant_from_search"
        : requestedImageIds.length > 0
          ? "model_tags_only"
          : "no_images_sent";

    logger.info(
      {
        ...logContext,
        model: env.openrouterModel,
        recoveryMode: chatResult.recoveryMode,
        modelAttempts: chatResult.attempts,
        rawModelReply: chatResult.reply,
        cleanReply,
        imageIntent,
        userRequestedImages,
        requestedImageIds,
        approvedImageIds,
        approvedImages: summarizeImages(approvedImages),
        imageDeliveryStrategy,
        inputTokens: chatResult.inputTokens,
        outputTokens: chatResult.outputTokens
      },
      "Model response generated."
    );

    const costUsd = calculateCost(chatResult.inputTokens, chatResult.outputTokens);
    const deduction = await supabaseService.deductBalance(
      env.businessId,
      costUsd,
      chatResult.inputTokens,
      chatResult.outputTokens,
      parsed.from
    );

    if (!deduction || !deduction.success) {
      const lowBalanceSend = await whatsappService.sendText(parsed.from, config.low_balance_msg);
      logger.warn(
        {
          ...logContext,
          outgoingText: config.low_balance_msg,
          costUsd,
          whatsappMessageIds: lowBalanceSend.chunks.map((item) => item.id).filter(Boolean)
        },
        "Balance deduction failed after model call."
      );
      return;
    }

    const textSend = await whatsappService.sendText(parsed.from, cleanReply);
    logger.info(
      {
        ...logContext,
        outgoingText: cleanReply,
        textChunkCount: textSend.chunks.length,
        textChunks: textSend.chunks.map((item) => ({
          id: item.id,
          preview: truncate(item.chunk, 160)
        }))
      },
      "WhatsApp text reply sent."
    );

    const sentImages = [];
    for (const image of approvedImages) {
      const sendImageResult = await whatsappService.sendImage(parsed.from, image);
      sentImages.push(sendImageResult);
    }

    if (sentImages.length > 0) {
      logger.info(
        {
          ...logContext,
          userRequestedImages,
          imageDeliveryStrategy,
          sentImages
        },
        "WhatsApp image replies sent."
      );
    }

    const assistantContent =
      approvedImages.length > 0
        ? `${cleanReply}\n\n[images: ${approvedImages.map((item) => item.id).join(", ")}]`
        : cleanReply;

    await supabaseService.appendConversationMessages(
      env.businessId,
      parsed.from,
      [
        buildConversationEntry("user", parsed.text, {
          message_id: parsed.messageId
        }),
        buildConversationEntry("assistant", assistantContent, {
          input_tokens: chatResult.inputTokens,
          output_tokens: chatResult.outputTokens,
          cost_usd: costUsd,
          retrieval_mode: retrievalMode
        })
      ],
      env.maxHistoryMessages
    );

    logger.info(
      {
        ...logContext,
        retrievalMode,
        kbMatches: kbResults.length,
        imagesSent: approvedImages.length,
        inputTokens: chatResult.inputTokens,
        outputTokens: chatResult.outputTokens,
        costUsd,
        balanceAfter: deduction.balance_after
      },
      "Processed incoming WhatsApp message."
    );
  } finally {
    if (typingSession) {
      await typingSession.stop();
    }
  }
}

async function processWebhook(body) {
  const messages = extractMessagesFromWebhook(body);

  logger.info(
    {
      businessId: env.businessId,
      incomingMessageCount: messages.length
    },
    "Webhook payload received."
  );

  for (const incoming of messages) {
    try {
      await processIncomingMessage(incoming);
    } catch (error) {
      logger.error(
        {
          err: error,
          messageId: incoming && incoming.message ? incoming.message.id : undefined
        },
        "Failed to process incoming message."
      );

      const parsed = parseMessage(incoming.message);
      if (!parsed) {
        continue;
      }

      try {
        const config = await supabaseService.getBusinessConfig(env.businessId);
        const fallbackSend = await whatsappService.sendText(parsed.from, config.fallback_msg);
        logger.warn(
          {
            businessId: env.businessId,
            customerPhone: parsed.from,
            messageId: parsed.messageId,
            outgoingText: config.fallback_msg,
            whatsappMessageIds: fallbackSend.chunks.map((item) => item.id).filter(Boolean)
          },
          "Sent emergency fallback WhatsApp reply after processing failure."
        );
      } catch (replyError) {
        logger.error({ err: replyError }, "Failed to send fallback WhatsApp reply.");
      }
    }
  }
}

module.exports = { processWebhook };
