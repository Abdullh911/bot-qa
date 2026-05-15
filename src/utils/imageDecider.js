const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "how",
  "i",
  "in",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "or",
  "our",
  "please",
  "show",
  "the",
  "this",
  "to",
  "us",
  "we",
  "what",
  "when",
  "where",
  "with",
  "you",
  "your",
  "\u0639\u0646",
  "\u0641\u064a",
  "\u0645\u0646",
  "\u0639\u0644\u0649",
  "\u0627\u0644\u0649",
  "\u0625\u0644\u0649",
  "\u0645\u0627",
  "\u0645\u062a\u0649",
  "\u0643\u064a\u0641",
  "\u0647\u0644",
  "\u0627\u0648",
  "\u0623\u0648"
]);

const IMAGE_INTENT_TERMS = new Set([
  "image",
  "images",
  "photo",
  "photos",
  "pic",
  "pics",
  "picture",
  "pictures",
  "catalog",
  "\u0635\u0648\u0631",
  "\u0635\u0648\u0631\u0629",
  "\u0635\u0648\u0631\u0647",
  "\u0635\u0648\u0631\u0647\u0627",
  "\u0641\u0648\u062a\u0648"
]);

const VISUAL_REQUEST_TERMS = [
  "show",
  "see",
  "view",
  "look",
  "browse",
  "check",
  "\u0627\u0634\u0648\u0641",
  "\u0623\u0634\u0648\u0641",
  "\u0634\u0648\u0641",
  "\u0648\u0631\u064a\u0646\u064a",
  "\u0648\u0631\u064a\u0646\u0649",
  "\u0627\u0648\u0631\u064a\u0646\u064a",
  "\u0627\u0631\u064a\u0646\u064a",
  "\u0623\u0631\u0646\u064a",
  "\u0627\u0639\u0631\u0636",
  "\u0639\u0631\u0636",
  "\u0646\u0634\u0648\u0641"
];

const PRODUCT_REFERENCE_TERMS = [
  "product",
  "products",
  "item",
  "items",
  "catalog",
  "\u0645\u0646\u062a\u062c",
  "\u0645\u0646\u062a\u062c\u0627\u062a",
  "\u0627\u0644\u0645\u0646\u062a\u062c\u0627\u062a",
  "\u0627\u0644\u0628\u0636\u0627\u0639\u0629",
  "\u0628\u0636\u0627\u0639\u0629"
];

function normalizeText(value) {
  return `${value || ""}`.toLowerCase().replace(/\s+/g, " ").trim();
}

function tokenize(text) {
  return `${text || ""}`
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token));
}

function uniqueTokens(text) {
  return Array.from(new Set(tokenize(text)));
}

function overlapScore(leftTokens, rightTokens) {
  if (!leftTokens.length || !rightTokens.length) {
    return 0;
  }

  const rightSet = new Set(rightTokens);
  let matches = 0;

  for (const token of leftTokens) {
    if (rightSet.has(token)) {
      matches += 1;
    }
  }

  return matches / Math.max(leftTokens.length, 1);
}

function buildKnowledgeCorpus(kbResults) {
  return (kbResults || [])
    .map((item) => [item.category, item.title, item.content].filter(Boolean).join(" "))
    .join(" ");
}

function kbHasImageEvidence(kbResults) {
  return (kbResults || []).some((item) => {
    const normalizedCategory = normalizeText(item && item.category);
    const normalizedText = normalizeText(
      [item && item.title, item && item.content].filter(Boolean).join(" ")
    );

    return (
      normalizedCategory === "images" ||
      normalizedText.includes("image url") ||
      normalizedText.includes("/storage/v1/object/public/") ||
      normalizedText.includes("image description:")
    );
  });
}

function hasImageIntent(queryText) {
  const normalizedText = normalizeText(queryText);

  return uniqueTokens(queryText).some(
    (token) =>
      IMAGE_INTENT_TERMS.has(token) ||
      token.includes("\u0635\u0648\u0631") ||
      token.includes("\u0635\u0648\u0631\u0629") ||
      token.includes("image") ||
      token.includes("photo") ||
      token.includes("picture") ||
      token.includes("pic")
  ) || VISUAL_REQUEST_TERMS.some((term) => normalizedText.includes(term));
}

function getImageIntentDecision(queryText, kbResults = []) {
  const normalizedText = normalizeText(queryText);
  const explicitImageIntent = hasImageIntent(queryText);
  const visualRequest = VISUAL_REQUEST_TERMS.some((term) => normalizedText.includes(term));
  const productReference = PRODUCT_REFERENCE_TERMS.some((term) => normalizedText.includes(term));
  const hasKbEvidence = kbHasImageEvidence(kbResults);
  const reasons = [];
  let confidence = 0;

  if (explicitImageIntent) {
    confidence += 0.7;
    reasons.push("explicit_image_intent");
  }

  if (visualRequest) {
    confidence += explicitImageIntent ? 0.1 : 0.4;
    reasons.push("visual_request_language");
  }

  if (productReference && (explicitImageIntent || visualRequest)) {
    confidence += 0.15;
    reasons.push("product_reference");
  }

  if (hasKbEvidence) {
    confidence += explicitImageIntent || visualRequest ? 0.2 : 0.05;
    reasons.push("kb_image_evidence");
  }

  confidence = Math.min(1, Number(confidence.toFixed(4)));

  return {
    confidence,
    wantsImages: confidence >= 0.45,
    shouldAutoSend: confidence >= 0.45 && hasKbEvidence,
    hasKbEvidence,
    reasons
  };
}

function buildKbText(item) {
  return [item.category, item.title, item.content].filter(Boolean).join(" ");
}

function findDirectKbMatch(image, kbResults) {
  const imageUrl = `${image.url || ""}`.trim().toLowerCase();
  const imageTokens = uniqueTokens(
    [image.description, image.caption, Array.isArray(image.tags) ? image.tags.join(" ") : ""]
      .filter(Boolean)
      .join(" ")
  );
  const labelTokens = uniqueTokens(
    [image.caption, image.description].filter(Boolean).join(" ")
  );

  for (const item of kbResults || []) {
    const kbText = buildKbText(item);
    const normalizedKbText = kbText.toLowerCase();
    const kbTokens = uniqueTokens(kbText);
    const titleTokens = uniqueTokens([item.title, item.category].filter(Boolean).join(" "));
    const metadataOverlap = overlapScore(imageTokens, kbTokens);
    const titleOverlap = overlapScore(labelTokens, titleTokens);
    const urlMatched = Boolean(imageUrl) && normalizedKbText.includes(imageUrl);
    const imageCategoryMatch = `${item.category || ""}`.toLowerCase() === "images";

    if (urlMatched) {
      return {
        matched: true,
        reason: "matched linked knowledge-base image URL"
      };
    }

    if (imageCategoryMatch && (metadataOverlap >= 0.18 || titleOverlap >= 0.4)) {
      return {
        matched: true,
        reason: `matched image knowledge entry (metadata=${metadataOverlap.toFixed(2)}, title=${titleOverlap.toFixed(2)})`
      };
    }
  }

  return {
    matched: false,
    reason: ""
  };
}

function chooseRelevantImages({ queryText, kbResults, images, maxImages = 3, imageIntent }) {
  const queryTokens = uniqueTokens(queryText);
  const kbTokens = uniqueTokens(buildKnowledgeCorpus(kbResults));
  const decision = imageIntent || getImageIntentDecision(queryText, kbResults);
  const queryWantsImage = decision.wantsImages;

  const ranked = (images || [])
    .map((image) => {
      const imageText = [
        image.description,
        image.caption,
        Array.isArray(image.tags) ? image.tags.join(" ") : ""
      ]
        .filter(Boolean)
        .join(" ");

      const imageTokens = uniqueTokens(imageText);
      const queryScore = overlapScore(queryTokens, imageTokens);
      const kbScore = overlapScore(kbTokens, imageTokens);
      const baseScore = Number((queryScore * 0.65 + kbScore * 0.35).toFixed(4));
      const directKbMatch = findDirectKbMatch(image, kbResults);
      const qualifiesByOverlap = queryScore >= 0.2 && kbScore >= 0.08;
      const qualifiesByIntentAndKb = decision.shouldAutoSend && directKbMatch.matched;
      const combinedScore = Number(
        Math.max(baseScore, qualifiesByIntentAndKb ? 0.3 + kbScore * 0.7 : baseScore).toFixed(4)
      );

      return {
        ...image,
        queryScore,
        kbScore,
        combinedScore,
        directKbMatch: directKbMatch.matched,
        reason: qualifiesByIntentAndKb
          ? `${directKbMatch.reason}; query requested images`
          : baseScore > 0
            ? `query=${queryScore.toFixed(2)}, kb=${kbScore.toFixed(2)}`
            : "no meaningful overlap"
      };
    })
    .filter((image) => {
      const qualifiesByOverlap = image.queryScore >= 0.2 && image.kbScore >= 0.08;
      const qualifiesByIntentAndKb = decision.shouldAutoSend && image.directKbMatch;
      return qualifiesByOverlap || qualifiesByIntentAndKb;
    })
    .sort((a, b) => b.combinedScore - a.combinedScore)
    .slice(0, maxImages);

  return ranked;
}

function parseImageTags(replyText) {
  const matches = [...`${replyText || ""}`.matchAll(/\[SEND_IMAGE:([^\]]+)\]/g)];
  return matches.map((match) => match[1].trim()).filter(Boolean);
}

function stripImageTags(replyText) {
  return `${replyText || ""}`
    .replace(/\s*\[SEND_IMAGE:[^\]]+\]\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

module.exports = {
  chooseRelevantImages,
  getImageIntentDecision,
  hasImageIntent,
  parseImageTags,
  stripImageTags
};
