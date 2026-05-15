function detectLanguage(text) {
  const value = `${text || ""}`.trim();
  if (!value) {
    return "auto";
  }

  const arabicMatches = value.match(/[\u0600-\u06FF]/g) || [];
  const latinMatches = value.match(/[A-Za-z]/g) || [];

  if (arabicMatches.length >= Math.max(3, latinMatches.length)) {
    return "ar";
  }

  if (latinMatches.length > 0) {
    return "en";
  }

  return "auto";
}

function getLanguageInstruction(detectedLang, languageHint) {
  if (languageHint && languageHint !== "auto") {
    return `Reply in ${languageHint === "ar" ? "Arabic" : "English"} unless the customer clearly used another language.`;
  }

  if (detectedLang === "ar") {
    return "Reply in Arabic unless the customer explicitly asks for another language.";
  }

  if (detectedLang === "en") {
    return "Reply in English unless the customer explicitly asks for another language.";
  }

  return "Reply in the same language as the customer when it is clear from their message.";
}

module.exports = { detectLanguage, getLanguageInstruction };
