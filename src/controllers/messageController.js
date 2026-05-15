const { env } = require("../config/env");
const { logger } = require("../utils/logger");
const { detectLanguage } = require("../utils/languageDetector");
const { chooseRelevantImages, parseImageTags, stripImageTags } = require("../utils/imageDecider");
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
    const queryEmbedding = await vectorSearchService.generateEmbedding(userText);
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

  const claimed = await supabaseService.claimMessage(parsed.messageId);
  if (!claimed) {
    logger.info({ messageId: parsed.messageId }, "Skipping duplicate message.");
    return;
  }

  const config = await supabaseService.getBusinessConfig(env.businessId);
  if (!config) {
    throw new Error(`Business ${env.businessId} was not found.`);
  }

  if (Number(config.balance) <= 0) {
    await whatsappService.sendText(parsed.from, config.low_balance_msg);
    return;
  }

  try {
    await whatsappService.markMessageAsRead(parsed.messageId);
  } catch (error) {
    logger.warn({ err: error, messageId: parsed.messageId }, "Failed to mark WhatsApp message as read.");
  }

  const detectedLang = detectLanguage(parsed.text);
  const { kbResults, retrievalMode } = await getKnowledgeResults(parsed.text, config);
  const history = await supabaseService.getConversation(env.businessId, parsed.from);

  if (kbResults.length === 0) {
    await whatsappService.sendText(parsed.from, config.fallback_msg);
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
    return;
  }

  const images = await supabaseService.getActiveImages(env.businessId);
  const relevantImages = chooseRelevantImages({
    queryText: parsed.text,
    kbResults,
    images,
    maxImages: env.maxCandidateImages
  });

  const prompt = buildPrompt({
    userText: parsed.text,
    history,
    kbResults,
    relevantImages,
    config,
    detectedLang
  });

  const chatResult = await openrouterService.chat(prompt);
  const cleanReply = stripImageTags(chatResult.reply) || config.fallback_msg;
  const requestedImageIds = parseImageTags(chatResult.reply);
  const allowedImageMap = new Map(relevantImages.map((image) => [image.id, image]));
  const approvedImageIds = Array.from(new Set(requestedImageIds));
  const approvedImages = approvedImageIds.map((imageId) => allowedImageMap.get(imageId)).filter(Boolean);

  const costUsd = calculateCost(chatResult.inputTokens, chatResult.outputTokens);
  const deduction = await supabaseService.deductBalance(
    env.businessId,
    costUsd,
    chatResult.inputTokens,
    chatResult.outputTokens,
    parsed.from
  );

  if (!deduction || !deduction.success) {
    await whatsappService.sendText(parsed.from, config.low_balance_msg);
    return;
  }

  await whatsappService.sendText(parsed.from, cleanReply);

  for (const image of approvedImages) {
    await whatsappService.sendImage(parsed.from, image);
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
      businessId: env.businessId,
      customerPhone: parsed.from,
      messageId: parsed.messageId,
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
        await whatsappService.sendText(parsed.from, config.fallback_msg);
      } catch (replyError) {
        logger.error({ err: replyError }, "Failed to send fallback WhatsApp reply.");
      }
    }
  }
}

module.exports = { processWebhook };
