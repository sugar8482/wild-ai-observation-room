export const HISTORY_WINDOW_BATCH = 100;

function positiveInteger(value, fallback) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function historyWindow(items, requestedLimit = HISTORY_WINDOW_BATCH) {
  const list = Array.isArray(items) ? items : [];
  const limit = positiveInteger(requestedLimit, HISTORY_WINDOW_BATCH);
  const start = Math.max(0, list.length - limit);
  return {
    items: list.slice(start),
    hiddenCount: start,
    limit,
  };
}

export function nextHistoryWindowLimit(totalCount, currentLimit, batchSize = HISTORY_WINDOW_BATCH) {
  const total = Math.max(0, Math.floor(Number(totalCount)) || 0);
  const batch = positiveInteger(batchSize, HISTORY_WINDOW_BATCH);
  const current = positiveInteger(currentLimit, batch);
  return Math.min(total, current + batch);
}
