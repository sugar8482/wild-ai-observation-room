export const DEFAULT_MIC_OPTIONS = Object.freeze({
  threshold: 4,
  pentUpWeight: 0.8,
  repeatPenalty: 2,
});

export function parseWillingnessScore(value) {
  const match = String(value ?? "").match(/(?:^|[^\d-])(10|[0-9])(?:\D|$)/);
  return match ? Number(match[1]) : null;
}

export function pickMicWinner(candidates, options = {}, random = Math.random) {
  const threshold = Number.isFinite(Number(options.threshold))
    ? Number(options.threshold)
    : DEFAULT_MIC_OPTIONS.threshold;
  const pentUpWeight = Number.isFinite(Number(options.pentUpWeight))
    ? Number(options.pentUpWeight)
    : DEFAULT_MIC_OPTIONS.pentUpWeight;
  const repeatPenalty = Number.isFinite(Number(options.repeatPenalty))
    ? Number(options.repeatPenalty)
    : DEFAULT_MIC_OPTIONS.repeatPenalty;
  const missedTurns = options.missedTurns || {};
  const lastSpeakerId = String(options.lastSpeakerId || "");

  const eligible = candidates
    .filter((candidate) => Number.isFinite(candidate.score) && candidate.score >= threshold)
    .map((candidate) => ({
      ...candidate,
      priority:
        candidate.score
        + (Number(missedTurns[candidate.id]) || 0) * pentUpWeight
        - (candidate.id === lastSpeakerId ? repeatPenalty : 0),
    }));
  if (!eligible.length) return null;

  const highest = Math.max(...eligible.map((candidate) => candidate.priority));
  const tied = eligible.filter((candidate) => Math.abs(candidate.priority - highest) < 1e-9);
  const index = Math.min(tied.length - 1, Math.floor(Math.max(0, random()) * tied.length));
  return tied[index];
}
