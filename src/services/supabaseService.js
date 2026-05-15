const { createClient } = require("@supabase/supabase-js");
const { env } = require("../config/env");

const supabase = createClient(env.supabaseUrl, env.supabaseServiceKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false
  }
});

async function getBusinessConfig(businessId) {
  const { data, error } = await supabase
    .from("businesses")
    .select(
      "id, name, bot_name, bot_persona, fallback_msg, language_hint, balance, low_balance_msg, similarity_threshold, vector_top_k"
    )
    .eq("id", businessId)
    .single();

  if (error) {
    throw error;
  }

  return data;
}

async function claimMessage(messageId) {
  const { error } = await supabase
    .from("processed_messages")
    .insert({ message_id: messageId });

  if (!error) {
    return true;
  }

  if (error.code === "23505") {
    return false;
  }

  throw error;
}

async function searchKnowledgeBase({ queryEmbedding, businessId, threshold, topK }) {
  const { data, error } = await supabase.rpc("search_knowledge_base", {
    query_embedding: queryEmbedding,
    business_id_input: businessId,
    match_threshold: threshold,
    match_count: topK
  });

  if (error) {
    throw error;
  }

  return data || [];
}

async function getRecentKnowledgeBaseEntries(businessId, limit) {
  const { data, error } = await supabase
    .from("knowledge_base")
    .select("id, category, title, content, updated_at")
    .eq("business_id", businessId)
    .eq("is_active", true)
    .order("updated_at", { ascending: false })
    .limit(limit);

  if (error) {
    throw error;
  }

  return data || [];
}

async function getActiveImages(businessId) {
  const { data, error } = await supabase
    .from("images")
    .select("id, url, description, caption, tags")
    .eq("business_id", businessId)
    .eq("is_active", true)
    .order("created_at", { ascending: false });

  if (error) {
    throw error;
  }

  return data || [];
}

async function getConversation(businessId, customerPhone) {
  const { data, error } = await supabase
    .from("conversations")
    .select("messages")
    .eq("business_id", businessId)
    .eq("customer_phone", customerPhone)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return Array.isArray(data && data.messages) ? data.messages : [];
}

async function appendConversationMessages(businessId, customerPhone, messagesToAdd, maxMessages) {
  const { data, error } = await supabase.rpc("append_conversation_messages", {
    business_id_input: businessId,
    customer_phone_input: customerPhone,
    messages_to_add_input: messagesToAdd,
    max_messages_input: maxMessages
  });

  if (error) {
    throw error;
  }

  return data;
}

async function deductBalance(businessId, costUsd, inputTokens, outputTokens, customerPhone) {
  const { data, error } = await supabase.rpc("deduct_balance", {
    business_id_input: businessId,
    cost_input: costUsd,
    input_tokens_in: inputTokens,
    output_tokens_in: outputTokens,
    customer_phone_in: customerPhone
  });

  if (error) {
    throw error;
  }

  return data;
}

async function updateKnowledgeBaseEmbedding(kbId, embedding) {
  const { error } = await supabase
    .from("knowledge_base")
    .update({
      embedding,
      embedded_at: new Date().toISOString()
    })
    .eq("id", kbId);

  if (error) {
    throw error;
  }
}

async function listKnowledgeBaseEntriesToEmbed(businessId) {
  const { data, error } = await supabase
    .from("knowledge_base")
    .select("id, category, title, content")
    .eq("business_id", businessId)
    .eq("is_active", true)
    .is("embedding", null)
    .order("created_at", { ascending: true });

  if (error) {
    throw error;
  }

  return data || [];
}

module.exports = {
  supabase,
  getBusinessConfig,
  claimMessage,
  searchKnowledgeBase,
  getRecentKnowledgeBaseEntries,
  getActiveImages,
  getConversation,
  appendConversationMessages,
  deductBalance,
  updateKnowledgeBaseEmbedding,
  listKnowledgeBaseEntriesToEmbed
};
