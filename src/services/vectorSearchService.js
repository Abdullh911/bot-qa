const axios = require("axios");
const { env } = require("../config/env");

const hfClient = axios.create({
  timeout: 45_000,
  headers: {
    Authorization: `Bearer ${env.hfApiToken}`,
    "Content-Type": "application/json"
  }
});

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
  if (!Array.isArray(payload) || payload.length === 0) {
    throw new Error("Unexpected empty embedding response.");
  }

  if (typeof payload[0] === "number") {
    return payload.map((value) => Number(value || 0));
  }

  if (Array.isArray(payload[0]) && typeof payload[0][0] === "number") {
    return averageVectors(payload);
  }

  if (
    Array.isArray(payload[0]) &&
    Array.isArray(payload[0][0]) &&
    typeof payload[0][0][0] === "number"
  ) {
    return averageVectors(payload[0]);
  }

  throw new Error("Unsupported embedding response shape from Hugging Face.");
}

async function requestEmbedding(endpoint, text) {
  const response = await hfClient.post(endpoint, {
    inputs: text,
    options: {
      wait_for_model: true,
      use_cache: true
    }
  });

  return normalizeVectorPayload(response.data);
}

async function generateEmbedding(text) {
  const cleanText = `${text || ""}`.trim();
  if (!cleanText) {
    throw new Error("Cannot generate an embedding for empty text.");
  }

  const endpoints = [
    `https://api-inference.huggingface.co/models/${env.hfEmbeddingModel}`,
    `https://router.huggingface.co/hf-inference/models/${env.hfEmbeddingModel}`
  ];

  let lastError;

  for (const endpoint of endpoints) {
    try {
      return await requestEmbedding(endpoint, cleanText);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("Failed to generate embedding.");
}

module.exports = { generateEmbedding };
