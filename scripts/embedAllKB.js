const { env } = require("../src/config/env");
const { logger } = require("../src/utils/logger");
const supabaseService = require("../src/services/supabaseService");
const vectorSearchService = require("../src/services/vectorSearchService");

async function main() {
  const entries = await supabaseService.listKnowledgeBaseEntriesToEmbed(env.businessId);

  if (entries.length === 0) {
    logger.info("No pending knowledge base entries need embeddings.");
    return;
  }

  logger.info({ count: entries.length }, "Embedding pending knowledge base entries.");

  for (const entry of entries) {
    const text = [entry.title, entry.content].filter(Boolean).join("\n\n");
    const embedding = await vectorSearchService.generateEmbedding(text);
    await supabaseService.updateKnowledgeBaseEmbedding(entry.id, embedding);
    logger.info({ id: entry.id, title: entry.title }, "Embedded knowledge base entry.");
  }

  logger.info("Finished embedding knowledge base entries.");
}

main().catch((error) => {
  logger.error({ err: error }, "Embedding script failed.");
  process.exitCode = 1;
});
