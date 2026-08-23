import assert from "node:assert/strict";
import test from "node:test";

import { chatScrollThumbMetrics } from "../public/chat-scroll-indicator.js";

test("chat scroll thumb stays within the rail", () => {
  const top = chatScrollThumbMetrics({
    scrollTop: 100,
    scrollStart: 100,
    scrollEnd: 900,
    contentHeight: 1_000,
    visibleHeight: 200,
    trackHeight: 500,
  });
  assert.equal(top.visible, true);
  assert.equal(top.thumbHeight, 100);
  assert.equal(top.thumbOffset, 0);

  const bottom = chatScrollThumbMetrics({
    scrollTop: 900,
    scrollStart: 100,
    scrollEnd: 900,
    contentHeight: 1_000,
    visibleHeight: 200,
    trackHeight: 500,
  });
  assert.equal(bottom.thumbOffset, 400);
  assert.equal(bottom.progress, 1);
});

test("short transcripts do not show a redundant thumb", () => {
  const metrics = chatScrollThumbMetrics({
    contentHeight: 300,
    visibleHeight: 500,
    trackHeight: 500,
  });
  assert.equal(metrics.visible, false);
});

test("chat scroll thumb uses a readable minimum size", () => {
  const metrics = chatScrollThumbMetrics({
    scrollTop: 500,
    scrollStart: 0,
    scrollEnd: 1_000,
    contentHeight: 20_000,
    visibleHeight: 500,
    trackHeight: 400,
  });
  assert.equal(metrics.thumbHeight, 38);
  assert.equal(metrics.thumbOffset, 181);
});
