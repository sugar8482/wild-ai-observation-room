export const DEFAULT_MIC_OPTIONS = Object.freeze({
  threshold: 4,
  neutralScore: 5,
  hardPassMaximum: 2,
  baselineMinSamples: 1,
  historyWindow: 20,
  pentUpWeight: 0.8,
  repeatPenalty: 2,
});

export function parseWillingnessScore(value) {
  const match = String(value ?? "").match(/(?:^|[^\d-])(10|[0-9])(?:\D|$)/);
  return match ? Number(match[1]) : null;
}

function numericOption(value, fallback) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

export function micScoreBaseline(scoreHistory, agentId, minimumSamples = DEFAULT_MIC_OPTIONS.baselineMinSamples) {
  const history = Array.isArray(scoreHistory?.[agentId])
    ? scoreHistory[agentId].filter((score) => Number.isFinite(score) && score >= 0 && score <= 10)
    : [];
  if (history.length < minimumSamples) return null;
  return history.reduce((total, score) => total + score, 0) / history.length;
}

export function rankMicCandidates(candidates, options = {}) {
  const threshold = Number.isFinite(Number(options.threshold))
    ? Number(options.threshold)
    : DEFAULT_MIC_OPTIONS.threshold;
  const neutralScore = numericOption(options.neutralScore, DEFAULT_MIC_OPTIONS.neutralScore);
  const hardPassMaximum = numericOption(options.hardPassMaximum, DEFAULT_MIC_OPTIONS.hardPassMaximum);
  const baselineMinSamples = numericOption(options.baselineMinSamples, DEFAULT_MIC_OPTIONS.baselineMinSamples);
  const pentUpWeight = numericOption(options.pentUpWeight, DEFAULT_MIC_OPTIONS.pentUpWeight);
  const repeatPenalty = numericOption(options.repeatPenalty, DEFAULT_MIC_OPTIONS.repeatPenalty);
  const missedTurns = options.missedTurns || {};
  const lastSpeakerId = String(options.lastSpeakerId || "");
  const scoreHistory = options.scoreHistory || {};

  return candidates.map((candidate) => {
    const baseline = micScoreBaseline(scoreHistory, candidate.id, baselineMinSamples);
    const calibratedScore = baseline === null
      ? candidate.score
      : neutralScore + candidate.score - baseline;
    const eligible = Number.isFinite(candidate.score)
      && candidate.score > hardPassMaximum
      && calibratedScore >= threshold;
    return {
      ...candidate,
      baseline,
      calibratedScore,
      eligible,
      priority: eligible
        ? calibratedScore
          + (Number(missedTurns[candidate.id]) || 0) * pentUpWeight
          - (candidate.id === lastSpeakerId ? repeatPenalty : 0)
        : null,
    };
  });
}

export function recordMicScores(scoreHistory, candidates, windowSize = DEFAULT_MIC_OPTIONS.historyWindow) {
  const next = Object.fromEntries(
    Object.entries(scoreHistory || {}).map(([id, history]) => [id, Array.isArray(history) ? [...history] : []]),
  );
  for (const candidate of candidates) {
    if (!Number.isFinite(candidate.score) || candidate.score < 0 || candidate.score > 10) continue;
    next[candidate.id] = [...(next[candidate.id] || []), candidate.score].slice(-windowSize);
  }
  return next;
}

export function pickMicWinner(candidates, options = {}, random = Math.random) {
  const ranked = rankMicCandidates(candidates, options);

  const eligible = ranked.filter((candidate) => candidate.eligible);
  if (!eligible.length) return null;

  const highest = Math.max(...eligible.map((candidate) => candidate.priority));
  const tied = eligible.filter((candidate) => Math.abs(candidate.priority - highest) < 1e-9);
  const index = Math.min(tied.length - 1, Math.floor(Math.max(0, random()) * tied.length));
  return tied[index];
}
