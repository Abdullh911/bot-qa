const INPUT_COST_PER_TOKEN = 0.126 / 1_000_000;
const OUTPUT_COST_PER_TOKEN = 0.252 / 1_000_000;

function roundUsd(value) {
  return Number(value.toFixed(8));
}

function calculateCost(inputTokens, outputTokens) {
  const safeInputTokens = Number.isFinite(inputTokens) ? inputTokens : 0;
  const safeOutputTokens = Number.isFinite(outputTokens) ? outputTokens : 0;

  return roundUsd(
    safeInputTokens * INPUT_COST_PER_TOKEN +
      safeOutputTokens * OUTPUT_COST_PER_TOKEN
  );
}

module.exports = {
  INPUT_COST_PER_TOKEN,
  OUTPUT_COST_PER_TOKEN,
  calculateCost
};
