const { env } = require("../config/env");
const { logger } = require("../utils/logger");
const { detectLanguage } = require("../utils/languageDetector");
const { chooseRelevantImages, hasImageIntent, parseImageTags, stripImageTags } = require("../utils/imageDecider");
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

  try {
    await whatsappService.markMessageAsRead(parsed.messageId);
  } catch (error) {
    logger.warn({ err: error, messageId: parsed.messageId }, "Failed to mark WhatsApp message as read.");
  }

  const detectedLang = detectLanguage(parsed.text);
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
  const history = await supabaseService.getConversation(env.businessId, parsed.from);

  logger.info(
    {
      ...logContext,
      retrievalMode,
      kbMatchCount: kbResults.length,
      kbMatches: summarizeKbResults(kbResults),
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
    maxImages: env.maxCandidateImages
  });

  logger.info(
    {
      ...logContext,
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

  const chatResult = await openrouterService.chat(prompt);
  const cleanReply = stripImageTags(chatResult.reply) || config.fallback_msg;
  const userRequestedImages = hasImageIntent(parsed.text);
  const requestedImageIds = parseImageTags(chatResult.reply);
  const allowedImageMap = new Map(relevantImages.map((image) => [image.id, image]));
  const approvedImageIds = Array.from(new Set(requestedImageIds));
  const modelApprovedImages = approvedImageIds
    .map((imageId) => allowedImageMap.get(imageId))
    .filter(Boolean);
  const approvedImages = dedupeImages(
    userRequestedImages
      ? [...relevantImages, ...modelApprovedImages]
      : modelApprovedImages
  );
  const imageDeliveryStrategy =
    userRequestedImages && approvedImages.length > 0
      ? requestedImageIds.length > 0
        ? "user_intent_plus_model_tags"
        : "user_intent_auto_send_all_relevant"
      : requestedImageIds.length > 0
        ? "model_tags_only"
        : "no_images_sent";

  logger.info(
    {
      ...logContext,
      model: env.openrouterModel,
      rawModelReply: chatResult.reply,
      cleanReply,
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
