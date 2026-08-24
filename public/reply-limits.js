export const MIN_VISIBLE_REPLY_TOKENS = 64;
export const MAX_VISIBLE_REPLY_TOKENS = 4096;
export const LEGACY_DEFAULT_VISIBLE_REPLY_TOKENS = 300;
export const DEFAULT_VISIBLE_REPLY_TOKENS = 1200;
export const VISIBLE_REPLY_LIMIT_VERSION = 2;

export function clampVisibleReplyTokens(value, fallback = DEFAULT_VISIBLE_REPLY_TOKENS) {
  const numeric = Number(value);
  const target = Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric) : fallback;
  return Math.min(MAX_VISIBLE_REPLY_TOKENS, Math.max(MIN_VISIBLE_REPLY_TOKENS, target));
}

export function resolveStoredVisibleReplyTokens(preferences = {}) {
  const stored = Number(preferences?.visibleTokenTarget);
  const usesLegacyDefault = preferences?.visibleTokenLimitVersion !== VISIBLE_REPLY_LIMIT_VERSION
    && stored === LEGACY_DEFAULT_VISIBLE_REPLY_TOKENS;
  if (!Number.isFinite(stored) || stored <= 0 || usesLegacyDefault) {
    return DEFAULT_VISIBLE_REPLY_TOKENS;
  }
  return clampVisibleReplyTokens(stored);
}

export function replyLengthNotice(speakerName, finishReason) {
  if (finishReason !== "length") return null;
  return `${speakerName} 达到了单次回复上限；上面这句不是完整发言。`;
}
