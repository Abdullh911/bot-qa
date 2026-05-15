const { InferenceClient } = require("@huggingface/inference");
const { env } = require("../config/env");

const hfClient = new InferenceClient(env.hfApiToken);

function averageVectors(vectors) {
  if (!Array.isArray(vectors) || vectors.length === 0) {
    throw new Error("Cannot average empty embedding vectors.");
  }

  const length = vectors[0].length;
  const accumulator = new Array(length).fill(0);

  for (const vector of vectors) {
    if (!Array.isArray(vector) || vector.length !== length) {
      throw new Error("Inconsistent embedding shape returned by Hugging Face.");
    }

    for (let index = 0; index < length; index += 1) {
      accumulator[index] += Number(vector[index] || 0);
    }
  }

  return accumulator.map((value) => value / vectors.length);
}

function normalizeVectorPayload(payload) {
  if (
    (!Array.isArray(payload) && !ArrayBuffer.isView(payload)) ||
    payload.length === 0
  ) {
    throw new Error("Unexpected empty embedding response.");
  }

  if (
    Array.isArray(payload)
      ? payload.every((value) => typeof value === "number")
      : ArrayBuffer.isView(payload)
  ) {
    return Array.from(payload, (value) => Number(value || 0));
  }

  if (
    Array.isArray(payload[0]) &&
    payload[0].every((value) => typeof value === "number")
  ) {
    return averageVectors(payload);
  }

  if (
    Array.isArray(payload[0]) &&
    Array.isArray(payload[0][0]) &&
    payload[0][0].every((value) => typeof value === "number")
  ) {
    return averageVectors(payload[0]);
  }

  throw new Error("Unsupported embedding response shape from Hugging Face.");
}

function getPromptedText(text, mode) {
  if (env.hfEmbeddingModel.includes("multilingual-e5")) {
    return mode === "query" ? `query: ${text}` : `passage: ${text}`;
  }

  return text;
}

async function requestEmbedding(text, mode) {
  try {
    const response = await hfClient.featureExtraction({
      model: env.hfEmbeddingModel,
      inputs: getPromptedText(text, mode),
      provider: "hf-inference",
      normalize: true
    });

    return normalizeVectorPayload(response);
  } catch (error) {
    const details = error instanceof Error ? error.message : "Unknown Hugging Face error.";
    throw new Error(
      `Failed to generate embedding with ${env.hfEmbeddingModel}: ${details}`
    );
  }
}

async function generateEmbedding(text, options = {}) {
  const cleanText = `${text || ""}`.trim();
  if (!cleanText) {
    throw new Error("Cannot generate an embedding for empty text.");
  }

  const mode = options.mode === "query" ? "query" : "passage";
  return requestEmbedding(cleanText, mode);
}

module.exports = { generateEmbedding };
