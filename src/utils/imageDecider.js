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
  "عن",
  "في",
  "من",
  "على",
  "الى",
  "إلى",
  "ما",
  "متى",
  "كيف",
  "هل",
  "او",
  "أو"
]);

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

function chooseRelevantImages({ queryText, kbResults, images, maxImages = 3 }) {
  const queryTokens = uniqueTokens(queryText);
  const kbTokens = uniqueTokens(buildKnowledgeCorpus(kbResults));

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
      const combinedScore = Number((queryScore * 0.65 + kbScore * 0.35).toFixed(4));

      return {
        ...image,
        queryScore,
        kbScore,
        combinedScore,
        reason:
          combinedScore > 0
            ? `query=${queryScore.toFixed(2)}, kb=${kbScore.toFixed(2)}`
            : "no meaningful overlap"
      };
    })
    .filter((image) => image.queryScore >= 0.2 && image.kbScore >= 0.08)
    .sort((a, b) => b.combinedScore - a.combinedScore)
    .slice(0, maxImages);

  return ranked;
}

function parseImageTags(replyText) {
  const matches = [...`${replyText || ""}`.matchAll(/\[SEND_IMAGE:([^\]]+)\]/g)];
  return matches.map((match) => match[1].trim()).filter(Boolean);
}

function stripImageTags(replyText) {
  return `${replyText || ""}`.replace(/\s*\[SEND_IMAGE:[^\]]+\]\s*/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

module.exports = {
  chooseRelevantImages,
  parseImageTags,
  stripImageTags
};
