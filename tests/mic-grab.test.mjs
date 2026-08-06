import assert from "node:assert/strict";
import test from "node:test";
import { parseWillingnessScore, pickMicWinner } from "../public/mic-grab.js";

test("意愿分解析兼容常见短回答并拒绝越界内容", () => {
  assert.equal(parseWillingnessScore("8"), 8);
  assert.equal(parseWillingnessScore("8/10"), 8);
  assert.equal(parseWillingnessScore("我给 8 分"), 8);
  assert.equal(parseWillingnessScore("**10**"), 10);
  assert.equal(parseWillingnessScore(""), null);
  assert.equal(parseWillingnessScore("abc"), null);
  assert.equal(parseWillingnessScore("11"), null);
  assert.equal(parseWillingnessScore("-1"), null);
});

test("抢麦选择会照顾想说却连续没抢到的嘉宾", () => {
  const winner = pickMicWinner(
    [
      { id: "gpt", name: "GPT", score: 8 },
      { id: "deepseek", name: "DeepSeek", score: 7 },
    ],
    { missedTurns: { deepseek: 2 }, pentUpWeight: 0.8, repeatPenalty: 0 },
  );
  assert.equal(winner.id, "deepseek");
});

test("刚刚发过言的嘉宾会受到轻量连续发言惩罚", () => {
  const winner = pickMicWinner(
    [
      { id: "gpt", name: "GPT", score: 8 },
      { id: "claude", name: "Claude", score: 7 },
    ],
    { lastSpeakerId: "gpt", repeatPenalty: 2 },
  );
  assert.equal(winner.id, "claude");
});

test("全员低于阈值时没有赢家，真正平手时才随机", () => {
  assert.equal(
    pickMicWinner([
      { id: "gpt", score: 3 },
      { id: "claude", score: 2 },
    ]),
    null,
  );
  const tiedWinner = pickMicWinner(
    [
      { id: "gpt", score: 7 },
      { id: "claude", score: 7 },
    ],
    {},
    () => 0.99,
  );
  assert.equal(tiedWinner.id, "claude");
});
