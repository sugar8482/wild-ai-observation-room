import test from "node:test";
import assert from "node:assert/strict";

import {
  HISTORY_WINDOW_BATCH,
  historyWindow,
  nextHistoryWindowLimit,
} from "../public/history-window.js";

test("history window initially renders only the latest 100 records", () => {
  const source = Array.from({ length: 250 }, (_, index) => index + 1);
  const windowed = historyWindow(source);

  assert.equal(HISTORY_WINDOW_BATCH, 100);
  assert.equal(windowed.hiddenCount, 150);
  assert.equal(windowed.items.length, 100);
  assert.equal(windowed.items[0], 151);
  assert.equal(windowed.items.at(-1), 250);
});

test("older records are revealed in 100-record batches without changing source", () => {
  const source = Array.from({ length: 250 }, (_, index) => index + 1);
  const nextLimit = nextHistoryWindowLimit(source.length, 100);
  const windowed = historyWindow(source, nextLimit);

  assert.equal(nextLimit, 200);
  assert.equal(windowed.hiddenCount, 50);
  assert.equal(windowed.items[0], 51);
  assert.equal(source.length, 250);
});

test("history window stops at the oldest record", () => {
  assert.equal(nextHistoryWindowLimit(150, 100), 150);
  assert.equal(nextHistoryWindowLimit(80, 100), 80);
});
