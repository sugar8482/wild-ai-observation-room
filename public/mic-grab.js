export const DEFAULT_MIC_OPTIONS = Object.freeze({
  threshold: 4,
  neutralScore: 5,
  hardPassMaximum: 2,
  baselineMinSamples: 1,
  historyWindow: 20,
  pentUpWeight: 0.8,
  repeatPenalty: 2,
});

export const DEFAULT_LIGHT_MIC_OPTIONS = Object.freeze({
  silenceProbability: 0.08,
  silenceStep: 0.08,
  maximumSilenceProbability: 0.38,
  repeatWeight: 0.42,
  staleTurnWeight: 0.42,
  maximumStaleBonus: 3,
  missedTurnWeight: 0.75,
  mentionMultiplier: 4.5,
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
      && candidate.score >= threshold;
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

function lastRelevantMessage(messages = []) {
  return [...messages].reverse().find((message) => message?.kind !== "error" && String(message?.text || "").trim());
}

function mentionedAgentIds(agents, messages) {
  const text = String(lastRelevantMessage(messages)?.text || "");
  return new Set(agents
    .filter((agent) => agent?.name && text.includes(String(agent.name)))
    .map((agent) => agent.id));
}

function turnsSinceAgentSpoke(agentId, messages = []) {
  const relevant = messages.filter((message) => message?.kind !== "error");
  let index = -1;
  for (let current = relevant.length - 1; current >= 0; current -= 1) {
    if (relevant[current]?.kind === "agent" && relevant[current]?.agentId === agentId) {
      index = current;
      break;
    }
  }
  return index < 0 ? relevant.length + 1 : relevant.length - index - 1;
}

export function rankLightMicCandidates(agents, messages = [], options = {}) {
  const missedTurns = options.missedTurns || {};
  const lastSpeakerId = String(options.lastSpeakerId || "");
  const mentionIds = mentionedAgentIds(agents, messages);
  const repeatWeight = numericOption(options.repeatWeight, DEFAULT_LIGHT_MIC_OPTIONS.repeatWeight);
  const staleTurnWeight = numericOption(options.staleTurnWeight, DEFAULT_LIGHT_MIC_OPTIONS.staleTurnWeight);
  const maximumStaleBonus = numericOption(options.maximumStaleBonus, DEFAULT_LIGHT_MIC_OPTIONS.maximumStaleBonus);
  const missedTurnWeight = numericOption(options.missedTurnWeight, DEFAULT_LIGHT_MIC_OPTIONS.missedTurnWeight);
  const mentionMultiplier = numericOption(options.mentionMultiplier, DEFAULT_LIGHT_MIC_OPTIONS.mentionMultiplier);
  return agents.map((agent) => {
    const turnsSince = turnsSinceAgentSpoke(agent.id, messages);
    const staleBonus = Math.min(maximumStaleBonus, turnsSince * staleTurnWeight);
    const missedBonus = Math.max(0, Number(missedTurns[agent.id]) || 0) * missedTurnWeight;
    const mentioned = mentionIds.has(agent.id);
    let weight = Math.max(0.05, 1 + staleBonus + missedBonus);
    if (agent.id === lastSpeakerId) weight *= Math.max(0.05, repeatWeight);
    if (mentioned) weight *= Math.max(1, mentionMultiplier);
    return {
      ...agent,
      mentioned,
      turnsSince,
      weight,
    };
  });
}

export function pickLightMicWinner(agents, messages = [], options = {}, random = Math.random) {
  if (!agents.length) return null;
  const ranked = rankLightMicCandidates(agents, messages, options);
  const hasMention = ranked.some((candidate) => candidate.mentioned);
  const roundNumber = Math.max(1, Number(options.roundNumber) || 1);
  const baseSilence = numericOption(options.silenceProbability, DEFAULT_LIGHT_MIC_OPTIONS.silenceProbability);
  const silenceStep = numericOption(options.silenceStep, DEFAULT_LIGHT_MIC_OPTIONS.silenceStep);
  const maximumSilence = numericOption(
    options.maximumSilenceProbability,
    DEFAULT_LIGHT_MIC_OPTIONS.maximumSilenceProbability,
  );
  const eventRelief = options.hasEventCard ? 0.06 : 0;
  const mentionRelief = hasMention ? 0.12 : 0;
  const silenceProbability = Math.max(
    0.01,
    Math.min(maximumSilence, baseSilence + (roundNumber - 1) * silenceStep - eventRelief - mentionRelief),
  );
  if (Math.max(0, Math.min(0.999999, random())) < silenceProbability) return null;
  const total = ranked.reduce((sum, candidate) => sum + candidate.weight, 0);
  let needle = Math.max(0, Math.min(0.999999, random())) * total;
  for (const candidate of ranked) {
    needle -= candidate.weight;
    if (needle < 0) return candidate;
  }
  return ranked.at(-1) || null;
}
