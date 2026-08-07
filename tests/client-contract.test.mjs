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

test("每位嘉宾可选择启用同次回复写入的第一人称私人记忆", async () => {
  const [html, script, memoryModule, memoryPrompt] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/agent-memory.js", import.meta.url), "utf8"),
    readFile(new URL("../public/memory-prompt.js", import.meta.url), "utf8"),
  ]);
  for (const id of ["agent-memory-enabled", "agent-memory-editor", "agent-memory"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /其他嘉宾看不到/);
  assert.match(script, /parseAgentReply\(reply\.text\)/);
  assert.match(script, /appendAgentMemory/);
  assert.match(script, /PRIVATE_MEMORY_TOKEN_ALLOWANCE/);
  assert.match(memoryModule, /<self_memory>/);
  assert.match(memoryModule, /不要抄写房间公开时间线/);
  assert.match(memoryPrompt, /公开故事时间线/);
  assert.match(memoryPrompt, /不属于房间总结/);
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
  assert.match(html, /id="memory-cancel"/);
  assert.match(script, /function longTermMemoryForPrompt\(room\)/);
  assert.match(script, /function summarizeRoom\(room,/);
  assert.match(script, /recentMessages: Math\.min\(80, Math\.max\(10,/);
  assert.match(script, /longTermMemoryForPrompt\(room\)/);
  assert.match(script, /requestMode: "memory-summary"/);
  assert.match(script, /summaryNotices\.set/);
  assert.match(script, /\.controller\.abort\(\)/);
  assert.match(script, /\[502, 503\]\.includes/);
  assert.match(html, /留空使用默认的“记事、不定性”规则/);
  assert.match(memoryPrompt, /不是人物评委或角色编剧/);
  assert.match(memoryPrompt, /属于关系事实。只按原文含义记录/);
  assert.match(memoryPrompt, /【本房间的额外记忆重点】/);
  assert.match(script, /focus: String\(memory\?\.focus \|\| ""\)/);
  assert.match(memoryPrompt, /不要重写、压缩或评价此前的长期记忆/);
  assert.match(memoryPrompt, /无论房间是日常聊天、朋友群、角色扮演、工作讨论或其他用途/);
  assert.match(memoryPrompt, /不会再生成另一份总概括/);
  assert.match(memoryPrompt, /原文中标为“【用户原话｜名字】”的消息具有最高保留优先级/);
  assert.match(memoryPrompt, /不得只写成“用户询问了某事”/);
  assert.match(memoryPrompt, /completeAutomaticSummaryBatch/);
  assert.match(memoryPrompt, /绝不能升级成已经确认的事实/);
  assert.match(script, /completeAutomaticSummaryBatch\(pendingSource, room\.memory\.interval\)/);
  assert.match(script, /这会清空并覆盖当前总结；聊天原文不会删除/);
  assert.doesNotMatch(script, /# 全篇概览/);
  assert.match(html, /立即或自动整理只会在末尾追加时间片段/);
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
  assert.match(script, /function previewRoomScheduleStatus\(\)/);
  assert.match(script, /点击“保存房间”后生效/);
  assert.match(script, /function syncBackgroundUpdates\(\)/);
});

test("局域网访问保护可以在页面中关闭或重新开启", async () => {
  const [html, script, styles, themeBoot] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../public/theme-boot.js", import.meta.url), "utf8"),
  ]);
  for (const id of ["settings-button", "security-dialog", "security-form", "security-access-enabled"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(script, /method: "PUT"/);
  assert.match(script, /局域网访问码已关闭/);
  assert.match(html, /API Key 仍不会显示/);
  assert.match(html, /data-theme-choice="light"/);
  assert.match(html, /data-theme-choice="dark"/);
  assert.match(script, /function applyTheme\(value\)/);
  assert.match(styles, /html\[data-theme="dark"\]/);
  assert.match(themeBoot, /wild-ai-observation-room\.theme\.v1/);
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

test("iPad 顶部可以切换房间并温和提示新消息", async () => {
  const [html, script, styles] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
  ]);
  for (const id of [
    "mobile-room-switcher",
    "mobile-room-current",
    "mobile-room-menu",
    "mobile-room-name",
    "mobile-room-meta",
    "new-message-jump",
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(script, /function renderMobileRoomSwitcher\(\)/);
  assert.match(script, /function scrollToLatest\(/);
  assert.match(script, /composer\.scrollIntoView/);
  assert.match(script, /unseenMessageCount \+= activeAddedMessages/);
  assert.match(styles, /\.mobile-room-switcher \{[\s\S]*position: sticky/);
  assert.match(styles, /\.new-message-jump/);
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
  assert.match(script, /recordMicScores/);
  assert.match(script, /scoreHistory: room\.mic\.scoreHistory/);
  assert.match(html, /↑↓ 表示相对这位嘉宾自己的平时分数/);
});
