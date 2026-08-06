import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("客户端引用的静态控件都存在且 ID 不重复", async () => {
  const [html, script] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  ]);
  const referencedIds = [...script.matchAll(/byId\("([^"]+)"\)/g)].map((match) => match[1]);
  for (const id of new Set(referencedIds)) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `缺少控件 #${id}`);
  }

  const htmlIds = [...html.matchAll(/\sid=["']([^"']+)["']/g)].map((match) => match[1]);
  assert.equal(new Set(htmlIds).size, htmlIds.length, "HTML 中存在重复 ID");
});

test("默认嘉宾库包含五家公司模型入口", async () => {
  const script = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  for (const name of ["GPT", "Claude", "Gemini", "DeepSeek", "Grok"]) {
    assert.match(script, new RegExp(`name: ["']${name}["']`));
  }
});

test("每条消息提供持久化删除入口", async () => {
  const script = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(script, /function deleteMessage\(messageId\)/);
  assert.match(script, /"delete-message", "删除"/);
  assert.match(script, /queuePersist\(\)/);
});

test("消息操作在点选当前消息后才展开", async () => {
  const [script, styles] = await Promise.all([
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(script, /classList\.add\("is-actions-visible"\)/);
  assert.match(styles, /\.message\.is-actions-visible \.message-actions/);
  assert.match(styles, /pointer-events: none/);
});

test("房间氛围与个人设定在发言前按 Depth 0 顺序再次注入", async () => {
  const script = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(script, /function buildImmediatePrompt\(agent, room, visibleTokenTarget\)/);
  assert.match(script, /【房间共同氛围｜所有嘉宾】/);
  assert.match(script, /【你的个人设定｜\$\{agent\.name\}】/);
  assert.match(script, /\$\{buildImmediatePrompt\(agent, room, visibleTokenTarget\)\}/);
});

test("房间长期记忆独立于聊天消息并注入最近原文之前", async () => {
  const [html, script, memoryPrompt] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/memory-prompt.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /id="summarizer-dialog"/);
  assert.match(html, /id="room-memory-summary"/);
  assert.match(html, /id="room-memory-focus"/);
  assert.match(script, /function longTermMemoryForPrompt\(room\)/);
  assert.match(script, /function summarizeRoom\(room,/);
  assert.match(script, /recentMessages: Math\.min\(80, Math\.max\(10,/);
  assert.match(script, /longTermMemoryForPrompt\(room\)/);
  assert.match(html, /留空使用默认的“记事、不定性”规则/);
  assert.match(memoryPrompt, /不是人物评委或角色编剧/);
  assert.match(memoryPrompt, /属于可记录的关系事实，不是人物标签/);
  assert.match(memoryPrompt, /【本房间的额外记忆重点】/);
  assert.match(script, /focus: String\(memory\?\.focus \|\| ""\)/);
  assert.match(memoryPrompt, /旧总结只是待修订的草稿/);
  assert.match(script, /聊天原文会完整保留，只替换当前总结/);
  assert.doesNotMatch(memoryPrompt, /人物自我介绍与稳定偏好/);
});

test("每个房间可以配置后台定时抢麦", async () => {
  const [html, script] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  ]);
  for (const id of [
    "room-schedule-enabled",
    "room-schedule-interval",
    "room-schedule-max-turns",
    "room-schedule-daily-limit",
    "room-schedule-quiet-enabled",
    "room-schedule-status",
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /全员弃权立即收场/);
  assert.match(script, /function hydrateRoomSchedule\(schedule\)/);
  assert.match(script, /function syncBackgroundUpdates\(\)/);
});

test("每个房间可以用一次模型回复显示连续气泡", async () => {
  const [html, script, styles, bubbles] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../public/chat-bubbles.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /id="room-bubble-split"/);
  assert.match(html, /不会增加 API 调用/);
  assert.match(script, /formatChatBubbleReply\(text, room\.bubbleSplit/);
  assert.match(script, /message-bubble-stack/);
  assert.match(styles, /\.message-bubble-stack/);
  assert.match(bubbles, /〔分条〕/);
  assert.match(bubbles, /MAX_CHAT_BUBBLES = 3/);
});

test("自由聊可以选择轮流接话或并行评分抢麦", async () => {
  const [html, script] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /data-free-strategy="round-robin"/);
  assert.match(html, /data-free-strategy="mic-grab"/);
  assert.match(script, /Promise\.allSettled/);
  assert.match(script, /requestMode: "willingness-score"/);
  assert.match(script, /runMicGrabConversation/);
});
