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

test("局域网 HTTP 下复制消息有 iPad 兼容兜底", async () => {
  const [html, script] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  ]);
  for (const id of ["copy-fallback-dialog", "copy-fallback-text", "copy-fallback-select"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(script, /function legacyCopyText\(text\)/);
  assert.match(script, /document\.execCommand\("copy"\)/);
  assert.match(script, /globalThis\.isSecureContext/);
  assert.match(script, /openCopyFallback\(message\.text\)/);
});

test("嘉宾席可只看本房成员并按聊天室或未分房筛选", async () => {
  const [html, script, styles] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
  ]);
  for (const id of ["agent-view-room", "agent-view-all", "agent-room-filters", "agent-editing-note"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(script, /let agentListView = "room"/);
  assert.match(script, /agentRoomFilter === "unassigned"/);
  assert.match(script, /正在编辑：\$\{room\.name\}的嘉宾阵容/);
  assert.match(script, /尚未加入房间/);
  assert.match(styles, /\.agent-room-filters/);
  assert.match(styles, /\.agent-membership/);
});

test("嘉宾可以复制为凭据复用但人设与记忆独立的新副本", async () => {
  const [html, script] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  ]);
  for (const id of [
    "duplicate-agent-button",
    "guest-copy-dialog",
    "guest-copy-credentials",
    "guest-copy-persona",
    "guest-copy-memory",
    "guest-copy-memory-enabled",
    "guest-copy-room",
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /接口配置与凭据/);
  assert.match(html, /默认不复制/);
  assert.match(script, /function createGuestCopyFromForm\(\)/);
  assert.match(script, /credentialSourceId: copyCredentials \? source\.id : ""/);
  assert.match(script, /memory: copyMemory \? source\.memory : ""/);
  assert.match(script, /room\.participantIds\.push\(duplicate\.id\)/);
});

test("人设编辑器提供兼容 iPad 的复制文本与可撤销清空草稿", async () => {
  const [html, script] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /id="copy-persona-button"/);
  assert.match(html, /id="clear-persona-button"/);
  assert.match(script, /await copyText\(persona\)/);
  assert.match(script, /已清空人设草稿，保存嘉宾后生效/);
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
  for (const id of ["agent-memory-enabled", "agent-memory-editor", "agent-memory", "compact-agent-memory-button", "deep-compact-agent-memory-button", "agent-memory-status"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /其他嘉宾看不到/);
  assert.match(script, /parseAgentReply\(reply\.text\)/);
  assert.match(script, /appendAgentMemory/);
  assert.match(script, /compactAgentMemory/);
  assert.match(script, /requestMode: "private-memory-summary"/);
  assert.match(script, /agent: draft/);
  assert.match(script, /privateMemoryDeepContext\(draft\.id\)/);
  assert.match(script, /这会产生 1 次这位嘉宾自己的 API 调用/);
  assert.match(script, /所属房间上下文｜只供核对，不要照抄/);
  assert.match(script, /mergeTopics: false/);
  assert.match(script, /已拦下过度瘦身/);
  assert.match(script, /不要只留最近发生的事情/);
  assert.doesNotMatch(script, /agent: state\.summarizer,[\s\S]{0,240}requestMode: "private-memory-summary"/);
  assert.match(memoryModule, /只有出现新变化、重要误会、关系转折或尚未公开/);
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
    "room-schedule-strategy",
    "room-schedule-interval",
    "room-schedule-max-turns",
    "room-schedule-daily-limit",
    "room-schedule-events-enabled",
    "room-schedule-quiet-enabled",
    "room-schedule-status",
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /全员安静会立即收场/);
  assert.match(html, /事件只是可接可不接的聊天引子/);
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

test("自由聊可以选择轮流接话、轻量抢麦或并行评分抢麦", async () => {
  const [html, script] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /data-free-strategy="round-robin"/);
  assert.match(html, /data-free-strategy="light-mic"/);
  assert.match(html, /data-free-strategy="mic-grab"/);
  assert.match(script, /Promise\.allSettled/);
  assert.match(script, /requestMode: "willingness-score"/);
  assert.match(script, /runMicGrabConversation/);
  assert.match(script, /runLightMicConversation/);
  assert.match(script, /不显示或伪造 AI 意愿分/);
  assert.match(script, /recordMicScores/);
  assert.match(script, /scoreHistory: room\.mic\.scoreHistory/);
  assert.match(html, /↑↓ 表示相对这位嘉宾自己的平时分数/);
});
