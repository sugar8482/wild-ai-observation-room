import {
  DEFAULT_MIC_OPTIONS,
  parseWillingnessScore,
  pickLightMicWinner,
  pickMicWinner,
  rankMicCandidates,
  recordMicScores,
} from "./mic-grab.js";
import {
  buildAppendSummaryMessages,
  buildRebuildSectionMessages,
  completeAutomaticSummaryBatch,
  formatMemorySegment,
} from "./memory-prompt.js";
import { bubbleSplitInstruction, formatChatBubbleReply } from "./chat-bubbles.js";
import {
  PRIVATE_MEMORY_REVIEW_THRESHOLD,
  PRIVATE_MEMORY_STORAGE_LIMIT,
  PRIVATE_MEMORY_TOKEN_ALLOWANCE,
  appendAgentMemory,
  compactAgentMemory,
  numberedAgentMemory,
  parseAgentReply,
  privateMemoryContext,
  privateMemoryOutputInstruction,
  validateDeepAgentMemoryResult,
} from "./agent-memory.js";

const LEGACY_PROFILE_KEY = "wild-ai-observation-room.profiles.v1";
const LEGACY_MESSAGE_KEY = "wild-ai-observation-room.messages.v1";
const GUEST_CATALOG_KEY = "wild-ai-observation-room.guest-catalog.v2";
const DIRECTOR_PREFS_KEY = "wild-ai-observation-room.director-prefs.v1";
const THEME_KEY = "wild-ai-observation-room.theme.v1";
const SUMMARY_AGENT_ID = "memory-summarizer";

const FORMAT_META = {
  openai: {
    label: "OpenAI 兼容",
    defaultAuth: "bearer",
    help: "填到 /v1 即可；也可以直接填完整的 /chat/completions 地址。",
  },
  anthropic: {
    label: "Anthropic Messages",
    defaultAuth: "x-api-key",
    help: "填到 /v1 即可；也可以直接填完整的 /messages 地址。",
  },
  gemini: {
    label: "Gemini GenerateContent",
    defaultAuth: "x-goog-api-key",
    help: "填到 /v1beta 即可；也支持完整的 :generateContent 地址。",
  },
};

const MODE_META = {
  point: {
    label: "点名 · 单人回答",
    action: "请 TA 回答",
    help: "只让指定的一位嘉宾发言，适合单独追问。",
  },
  roundtable: {
    label: "圆桌 · 每人一轮",
    action: "开始圆桌",
    help: "本房间的嘉宾依次回答一轮，后面的人能看到前面的发言。",
  },
  free: {
    label: "自由聊 · 多轮接话",
    action: "让他们自己聊",
    help: "本房间的嘉宾轮流接话。每个人都能看到前面刚发生的内容。",
  },
};

const DEFAULT_AGENTS = [
  { id: "guest-gpt", name: "GPT", format: "openai", authType: "bearer" },
  { id: "guest-claude", name: "Claude", format: "anthropic", authType: "x-api-key" },
  { id: "guest-gemini", name: "Gemini", format: "gemini", authType: "x-goog-api-key" },
  { id: "guest-deepseek", name: "DeepSeek", format: "openai", authType: "bearer" },
  { id: "guest-grok", name: "Grok", format: "openai", authType: "bearer" },
];

const byId = (id) => document.getElementById(id);
const agentList = byId("agent-list");
const agentViewRoom = byId("agent-view-room");
const agentViewAll = byId("agent-view-all");
const agentEditingNote = byId("agent-editing-note");
const agentRoomFilters = byId("agent-room-filters");
const roomList = byId("room-list");
const messageFeed = byId("message-feed");
const mobileRoomSwitcher = byId("mobile-room-switcher");
const mobileRoomCurrent = byId("mobile-room-current");
const mobileRoomMenu = byId("mobile-room-menu");
const mobileRoomName = byId("mobile-room-name");
const mobileRoomMeta = byId("mobile-room-meta");
const newMessageJump = byId("new-message-jump");
const emptyState = byId("empty-state");
const composer = byId("composer");
const messageInput = byId("message-input");
const sendButton = byId("send-button");
const stopButton = byId("stop-button");
const speakingIndicator = byId("speaking-indicator");
const speakingText = byId("speaking-text");
const statusDot = byId("status-dot");
const statusText = byId("status-text");
const roomModeLabel = byId("room-mode-label");
const roomTitle = byId("room-title");
const speakerControl = byId("speaker-control");
const speakerSelect = byId("speaker-select");
const roundsControl = byId("rounds-control");
const roundsInput = byId("rounds-input");
const roundsOutput = byId("rounds-output");
const roundsLabel = byId("rounds-label");
const roundsHelp = byId("rounds-help");
const freeStrategyControl = byId("free-strategy-control");
const freeStrategyHelp = byId("free-strategy-help");
const micStatus = byId("mic-status");
const temperatureInput = byId("temperature-input");
const temperatureOutput = byId("temperature-output");
const tokensInput = byId("tokens-input");
const modeHelp = byId("mode-help");
const agentDialog = byId("agent-dialog");
const agentForm = byId("agent-form");
const connectionResult = byId("connection-result");
const deleteAgentButton = byId("delete-agent-button");
const duplicateAgentButton = byId("duplicate-agent-button");
const guestCopyDialog = byId("guest-copy-dialog");
const guestCopyForm = byId("guest-copy-form");
const roomDialog = byId("room-dialog");
const roomForm = byId("room-form");
const roomParticipantList = byId("room-participant-list");
const deleteRoomButton = byId("delete-room-button");
const toastElement = byId("toast");
const accessDialog = byId("access-dialog");
const accessForm = byId("access-form");
const accessResult = byId("access-result");
const accessSubmit = byId("access-submit");
const securityDialog = byId("security-dialog");
const securityForm = byId("security-form");
const securityResult = byId("security-result");
const securitySubmit = byId("security-submit");
const summarizerDialog = byId("summarizer-dialog");
const summarizerForm = byId("summarizer-form");
const summarizerConnectionResult = byId("summarizer-connection-result");
const roomMemoryStatus = byId("room-memory-status");
const roomScheduleStatus = byId("room-schedule-status");
const copyFallbackDialog = byId("copy-fallback-dialog");
const copyFallbackText = byId("copy-fallback-text");

let toastTimer;
let saveChain = Promise.resolve();
let loadPromise = null;
let unseenMessageCount = 0;
let agentListView = "room";
let agentRoomFilter = "all";
let guestCopyNameSuggestion = "";
let accessProtectionEnabled = true;
let agentMemoryDraftDirty = false;
const summarizingRoomIds = new Set();
const summaryRuns = new Map();
const summaryNotices = new Map();

function safeRead(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function safeWrite(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // The computer remains authoritative; this marker is only used for migration.
  }
}

function applyTheme(value) {
  const theme = value === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", theme);
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Theme persistence is a device-local convenience.
  }
  document.querySelectorAll("[data-theme-choice]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.themeChoice === theme));
  });
}

function updateDirectorPrefs(patch) {
  safeWrite(DIRECTOR_PREFS_KEY, {
    ...safeRead(DIRECTOR_PREFS_KEY, {}),
    ...patch,
  });
}

function newId(prefix) {
  if (globalThis.crypto?.randomUUID) return `${prefix}-${crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function hydrateAgent(profile) {
  const format = FORMAT_META[profile?.format] ? profile.format : "openai";
  return {
    id: profile?.id || newId("guest"),
    name: String(profile?.name || "未命名嘉宾"),
    format,
    baseUrl: String(profile?.baseUrl || ""),
    model: String(profile?.model || ""),
    authType: String(profile?.authType || FORMAT_META[format].defaultAuth),
    customHeader: String(profile?.customHeader || ""),
    persona: String(profile?.persona || ""),
    memoryEnabled: profile?.memoryEnabled === true,
    memory: String(profile?.memory || ""),
    memoryRevision: Math.max(0, Number(profile?.memoryRevision) || 0),
    apiKey: String(profile?.apiKey || ""),
    extraHeaders: String(profile?.extraHeaders || ""),
    hasApiKey: Boolean(profile?.hasApiKey || profile?.apiKey),
    hasExtraHeaders: Boolean(profile?.hasExtraHeaders || profile?.extraHeaders),
    credentialSourceId: String(profile?.credentialSourceId || ""),
    clearApiKey: false,
    clearExtraHeaders: false,
  };
}

function blankAgent(profile) {
  return hydrateAgent({
    ...profile,
    baseUrl: "",
    model: "",
    customHeader: "",
    persona: "",
    memoryEnabled: false,
    memory: "",
    memoryRevision: 0,
  });
}

function hydrateSummarizer(profile) {
  const format = FORMAT_META[profile?.format] ? profile.format : "openai";
  return {
    id: SUMMARY_AGENT_ID,
    name: "记忆整理员",
    format,
    baseUrl: String(profile?.baseUrl || ""),
    model: String(profile?.model || ""),
    authType: String(profile?.authType || FORMAT_META[format].defaultAuth),
    customHeader: String(profile?.customHeader || ""),
    apiKey: String(profile?.apiKey || ""),
    extraHeaders: String(profile?.extraHeaders || ""),
    hasApiKey: Boolean(profile?.hasApiKey || profile?.apiKey),
    hasExtraHeaders: Boolean(profile?.hasExtraHeaders || profile?.extraHeaders),
    clearApiKey: false,
    clearExtraHeaders: false,
  };
}

function hydrateRoomMemory(memory) {
  return {
    enabled: memory?.enabled !== false,
    interval: Math.min(100, Math.max(5, Number(memory?.interval) || 20)),
    recentMessages: Math.min(80, Math.max(10, Number(memory?.recentMessages) || 30)),
    focus: String(memory?.focus || ""),
    summary: String(memory?.summary || ""),
    summarizedThroughId: String(memory?.summarizedThroughId || ""),
    summarizedMessageCount: Math.max(0, Number(memory?.summarizedMessageCount) || 0),
    updatedAt: Number(memory?.updatedAt) || null,
    stale: memory?.stale === true,
  };
}

function hydrateRoomSchedule(schedule) {
  return {
    enabled: schedule?.enabled === true,
    strategy: schedule?.strategy === "light-mic" ? "light-mic" : "mic-grab",
    intervalMinutes: Number(schedule?.intervalMinutes) === 30 ? 30 : 60,
    maxTurns: Math.min(6, Math.max(1, Number(schedule?.maxTurns) || 3)),
    dailyLimit: Math.min(48, Math.max(1, Number(schedule?.dailyLimit) || 8)),
    quietEnabled: schedule?.quietEnabled === true,
    quietStart: /^\d{2}:\d{2}$/.test(String(schedule?.quietStart || "")) ? String(schedule.quietStart) : "23:00",
    quietEnd: /^\d{2}:\d{2}$/.test(String(schedule?.quietEnd || "")) ? String(schedule.quietEnd) : "08:00",
    nextWakeAt: Number(schedule?.nextWakeAt) || null,
    lastWakeAt: Number(schedule?.lastWakeAt) || null,
    lastResult: String(schedule?.lastResult || ""),
    dayKey: String(schedule?.dayKey || ""),
    dailyCount: Math.max(0, Number(schedule?.dailyCount) || 0),
    revision: Math.max(0, Number(schedule?.revision) || 0),
  };
}

function hydrateRoomEventCards(eventCards) {
  return {
    enabled: eventCards?.enabled === true,
    focus: String(eventCards?.focus || "").slice(0, 4_000),
    recentIds: Array.isArray(eventCards?.recentIds)
      ? [...new Set(eventCards.recentIds.map(String).filter(Boolean))].slice(-4)
      : [],
    lastEvent: String(eventCards?.lastEvent || ""),
    revision: Math.max(0, Number(eventCards?.revision) || 0),
  };
}

function hydrateRoomMic(mic) {
  const scoreHistory = {};
  for (const [id, history] of Object.entries(mic?.scoreHistory || {})) {
    if (!Array.isArray(history)) continue;
    scoreHistory[id] = history
      .map(Number)
      .filter((score) => Number.isFinite(score) && score >= 0 && score <= 10)
      .slice(-DEFAULT_MIC_OPTIONS.historyWindow);
  }
  return {
    scoreHistory,
    revision: Math.max(0, Number(mic?.revision) || 0),
  };
}

function hydrateRoom(room, fallbackParticipants = []) {
  return {
    id: room?.id || newId("room"),
    name: String(room?.name || "未命名观察间"),
    roomPrompt: String(room?.roomPrompt || ""),
    bubbleSplit: room?.bubbleSplit === true,
    memory: hydrateRoomMemory(room?.memory),
    schedule: hydrateRoomSchedule(room?.schedule),
    eventCards: hydrateRoomEventCards(room?.eventCards),
    mic: hydrateRoomMic(room?.mic),
    participantIds: Array.isArray(room?.participantIds) ? [...new Set(room.participantIds)] : fallbackParticipants,
    messages: Array.isArray(room?.messages) ? room.messages : [],
    createdAt: Number(room?.createdAt || Date.now()),
    updatedAt: Number(room?.updatedAt || Date.now()),
  };
}

function legacyInitialState() {
  const storedProfiles = safeRead(LEGACY_PROFILE_KEY, null);
  let agents = (Array.isArray(storedProfiles) && storedProfiles.length ? storedProfiles : DEFAULT_AGENTS).map(hydrateAgent);
  const shouldAddNewGuests = Number(safeRead(GUEST_CATALOG_KEY, 0)) < 2;
  if (shouldAddNewGuests) {
    for (const profile of DEFAULT_AGENTS.slice(3)) {
      if (!agents.some((agent) => agent.id === profile.id)) agents.push(blankAgent(profile));
    }
    safeWrite(GUEST_CATALOG_KEY, 2);
  }
  if (!agents.length) agents = DEFAULT_AGENTS.map(blankAgent);
  const legacyMessages = safeRead(LEGACY_MESSAGE_KEY, []);
  const room = hydrateRoom({
    id: "room-main",
    name: "一号观察间",
    participantIds: agents.filter((agent) => agent.enabled !== false).map((agent) => agent.id),
    messages: Array.isArray(legacyMessages) ? legacyMessages : [],
  });
  return { agents, summarizer: hydrateSummarizer(), rooms: [room], activeRoomId: room.id };
}

const initial = legacyInitialState();
const state = {
  ...initial,
  summarizer: initial.summarizer || hydrateSummarizer(),
  mode: "roundtable",
  freeStrategy: "round-robin",
  running: false,
  abortController: null,
  ready: false,
};

function activeRoom() {
  let room = state.rooms.find((item) => item.id === state.activeRoomId);
  if (!room) {
    room = state.rooms[0];
    state.activeRoomId = room?.id || "";
  }
  return room;
}

function currentMessages() {
  return activeRoom()?.messages || [];
}

function showToast(message) {
  clearTimeout(toastTimer);
  toastElement.textContent = message;
  toastElement.classList.add("is-visible");
  toastTimer = setTimeout(() => toastElement.classList.remove("is-visible"), 3000);
}

function setRuntimeStatus(kind, text) {
  statusDot.classList.toggle("is-busy", kind === "busy");
  statusDot.classList.toggle("is-error", kind === "error");
  statusText.textContent = text;
}

function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function legacyCopyText(text) {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.inset = "0 auto auto 0";
  textarea.style.width = "1px";
  textarea.style.height = "1px";
  textarea.style.padding = "0";
  textarea.style.border = "0";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.focus({ preventScroll: true });
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  textarea.remove();
  return copied;
}

async function copyText(text) {
  if (globalThis.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Safari may expose Clipboard API while still denying this particular write.
    }
  }
  return legacyCopyText(text);
}

function selectCopyFallbackText() {
  copyFallbackText.focus({ preventScroll: true });
  copyFallbackText.select();
  copyFallbackText.setSelectionRange(0, copyFallbackText.value.length);
}

function openCopyFallback(text) {
  copyFallbackText.value = text;
  if (!copyFallbackDialog.open) copyFallbackDialog.showModal();
  requestAnimationFrame(selectCopyFallbackText);
}

function isConfigured(agent) {
  const hasAuth = agent.authType === "none" || agent.hasApiKey || Boolean(agent.apiKey.trim());
  return Boolean(agent.baseUrl.trim() && agent.model.trim() && hasAuth);
}

function stateSnapshot() {
  return {
    version: 3,
    activeRoomId: state.activeRoomId,
    agents: state.agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      format: agent.format,
      baseUrl: agent.baseUrl,
      model: agent.model,
      authType: agent.authType,
      customHeader: agent.customHeader,
      persona: agent.persona,
      memoryEnabled: agent.memoryEnabled,
      memory: agent.memory,
      memoryRevision: agent.memoryRevision,
      apiKey: agent.apiKey,
      extraHeaders: agent.extraHeaders,
      credentialSourceId: agent.credentialSourceId,
      clearApiKey: agent.clearApiKey === true,
      clearExtraHeaders: agent.clearExtraHeaders === true,
    })),
    summarizer: {
      id: SUMMARY_AGENT_ID,
      format: state.summarizer.format,
      baseUrl: state.summarizer.baseUrl,
      model: state.summarizer.model,
      authType: state.summarizer.authType,
      customHeader: state.summarizer.customHeader,
      apiKey: state.summarizer.apiKey,
      extraHeaders: state.summarizer.extraHeaders,
      clearApiKey: state.summarizer.clearApiKey === true,
      clearExtraHeaders: state.summarizer.clearExtraHeaders === true,
    },
    rooms: state.rooms,
  };
}

function mergeServerRoomUpdates(serverRooms = []) {
  const remoteById = new Map(serverRooms.map((room) => [room.id, room]));
  let addedMessages = 0;
  for (const room of state.rooms) {
    const remote = remoteById.get(room.id);
    if (!remote) continue;
    const localIds = new Set(room.messages.map((message) => message.id));
    const scheduledMessages = (remote.messages || [])
      .filter((message) => message.source === "scheduled" && !localIds.has(message.id));
    if (scheduledMessages.length) {
      room.messages = [...room.messages, ...scheduledMessages]
        .sort((left, right) => left.timestamp - right.timestamp)
        .slice(-500);
      addedMessages += scheduledMessages.length;
    }
    room.schedule = hydrateRoomSchedule(remote.schedule);
    if (Number(remote.eventCards?.revision) > Number(room.eventCards?.revision)) {
      room.eventCards = hydrateRoomEventCards(remote.eventCards);
    }
    if (Number(remote.mic?.revision) > Number(room.mic?.revision)) {
      room.mic = hydrateRoomMic(remote.mic);
    }
    if (Number(remote.memory?.updatedAt) > Number(room.memory?.updatedAt)) {
      room.memory = hydrateRoomMemory(remote.memory);
    }
    room.updatedAt = Math.max(Number(room.updatedAt) || 0, Number(remote.updatedAt) || 0);
  }
  return addedMessages;
}

function applySavedCredentialFlags(serverAgents, serverSummarizer) {
  const flags = new Map(serverAgents.map((agent) => [agent.id, agent]));
  for (const agent of state.agents) {
    const saved = flags.get(agent.id);
    if (!saved) continue;
    agent.hasApiKey = saved.hasApiKey;
    agent.hasExtraHeaders = saved.hasExtraHeaders;
    agent.apiKey = "";
    agent.extraHeaders = "";
    agent.credentialSourceId = "";
    agent.clearApiKey = false;
    agent.clearExtraHeaders = false;
  }
  if (serverSummarizer) {
    state.summarizer.hasApiKey = Boolean(serverSummarizer.hasApiKey);
    state.summarizer.hasExtraHeaders = Boolean(serverSummarizer.hasExtraHeaders);
    state.summarizer.apiKey = "";
    state.summarizer.extraHeaders = "";
    state.summarizer.clearApiKey = false;
    state.summarizer.clearExtraHeaders = false;
  }
}

function mergeServerAgentMemories(serverAgents = []) {
  const remoteById = new Map(serverAgents.map((agent) => [agent.id, agent]));
  let changed = false;
  for (const agent of state.agents) {
    const remote = remoteById.get(agent.id);
    if (!remote || Number(remote.memoryRevision) <= Number(agent.memoryRevision)) continue;
    agent.memoryEnabled = remote.memoryEnabled === true;
    agent.memory = String(remote.memory || "");
    agent.memoryRevision = Math.max(0, Number(remote.memoryRevision) || 0);
    if (
      agentDialog.open
      && String(agentForm.elements.namedItem("id")?.value || "") === agent.id
      && !agentMemoryDraftDirty
    ) {
      agentForm.elements.namedItem("memoryEnabled").checked = agent.memoryEnabled;
      agentForm.elements.namedItem("memory").value = agent.memory;
      syncAgentMemoryField();
    }
    changed = true;
  }
  return changed;
}

function queuePersist() {
  const snapshot = JSON.parse(JSON.stringify(stateSnapshot()));
  const save = async () => {
    const response = await fetch("/api/state", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(snapshot),
    });
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401) {
      await checkAccess();
      throw new Error("访问码已失效");
    }
    if (!response.ok) throw new Error(payload.error || "保存失败");
    applySavedCredentialFlags(payload.agents || [], payload.summarizer);
    mergeServerAgentMemories(payload.agents || []);
    mergeServerRoomUpdates(payload.rooms || []);
    renderAgents();
    renderRooms();
    renderSummarizerStatus();
    return payload;
  };
  saveChain = saveChain.then(save, save).catch((error) => {
    showToast(`没有保存成功：${error.message}`);
  });
  return saveChain;
}

function renderRooms() {
  roomList.replaceChildren();
  for (const room of state.rooms) {
    const card = createElement("article", `room-card${room.id === state.activeRoomId ? " is-active" : ""}`);
    const main = createElement("button", "room-card-main");
    main.type = "button";
    main.append(
      createElement("strong", "", room.name),
      createElement(
        "span",
        "",
        `${room.participantIds.length} 位嘉宾 · ${room.messages.length} 条记录${room.roomPrompt.trim() ? " · 有氛围" : ""}${room.bubbleSplit ? " · 连发气泡" : ""}${room.memory.summary.trim() ? " · 有记忆" : ""}${room.schedule.enabled ? ` · 定时 ${room.schedule.intervalMinutes}m${room.schedule.strategy === "light-mic" ? " 轻量" : ""}` : ""}${room.eventCards.enabled ? " · 事件卡" : ""}`,
      ),
    );
    main.addEventListener("click", () => switchRoom(room.id));
    const edit = createElement("button", "room-edit", "设置");
    edit.type = "button";
    edit.addEventListener("click", () => openRoomDialog(room.id));
    card.append(main, edit);
    roomList.append(card);
  }
  renderMobileRoomSwitcher();
}

function compactModeLabel() {
  if (state.mode === "free" && state.freeStrategy === "mic-grab") return "真实抢麦";
  if (state.mode === "free" && state.freeStrategy === "light-mic") return "轻量抢麦";
  if (state.mode === "free") return "自由聊";
  if (state.mode === "point") return "点名";
  return "圆桌";
}

function closeMobileRoomMenu() {
  mobileRoomSwitcher.classList.remove("is-open");
  mobileRoomCurrent.setAttribute("aria-expanded", "false");
}

function renderMobileRoomSwitcher() {
  const current = activeRoom();
  mobileRoomName.textContent = current?.name || "选择聊天室";
  mobileRoomMeta.textContent = current
    ? `${current.messages.length} 条 · ${compactModeLabel()}`
    : "还没有房间";
  mobileRoomMenu.replaceChildren();

  for (const room of state.rooms) {
    const row = createElement("div", `mobile-room-option${room.id === state.activeRoomId ? " is-active" : ""}`);
    const open = createElement("button", "mobile-room-option-main");
    open.type = "button";
    if (room.id === state.activeRoomId) open.setAttribute("aria-current", "page");
    open.append(
      createElement("strong", "", room.name),
      createElement("span", "", `${room.messages.length} 条记录 · ${room.participantIds.length} 位嘉宾`),
    );
    open.addEventListener("click", () => {
      closeMobileRoomMenu();
      if (room.id === state.activeRoomId) scrollToLatest({ revealOnSmallScreen: true, behavior: "smooth" });
      else switchRoom(room.id);
    });
    const edit = createElement("button", "mobile-room-option-edit", "设置");
    edit.type = "button";
    edit.setAttribute("aria-label", `设置 ${room.name}`);
    edit.addEventListener("click", () => {
      closeMobileRoomMenu();
      openRoomDialog(room.id);
    });
    row.append(open, edit);
    mobileRoomMenu.append(row);
  }

  const add = createElement("button", "mobile-room-add", "＋ 新建聊天室");
  add.type = "button";
  add.addEventListener("click", () => {
    closeMobileRoomMenu();
    openRoomDialog();
  });
  mobileRoomMenu.append(add);
}

function renderSummarizerStatus() {
  const status = byId("summarizer-status");
  const button = byId("open-summarizer-button");
  if (isConfigured(state.summarizer)) {
    status.textContent = `已配置：${state.summarizer.model}`;
    button.textContent = "更换";
  } else {
    status.textContent = "尚未配置；聊天不受影响，只是不会自动生成长期总结。";
    button.textContent = "配置";
  }
}

function renderAgents() {
  agentList.replaceChildren();
  const room = activeRoom();
  if (!room) return;

  const roomMemberIds = new Set(room.participantIds);
  const membershipsFor = (agentId) => state.rooms.filter((item) => item.participantIds.includes(agentId));
  const unassignedCount = state.agents.filter((agent) => membershipsFor(agent.id).length === 0).length;
  const validRoomFilter = agentRoomFilter.startsWith("room:")
    ? state.rooms.some((item) => `room:${item.id}` === agentRoomFilter)
    : ["all", "unassigned"].includes(agentRoomFilter);
  if (!validRoomFilter) agentRoomFilter = "all";

  const roomView = agentListView === "room";
  agentViewRoom.textContent = `本房成员 ${room.participantIds.length}`;
  agentViewAll.textContent = `全部嘉宾 ${state.agents.length}`;
  agentViewRoom.setAttribute("aria-pressed", String(roomView));
  agentViewAll.setAttribute("aria-pressed", String(!roomView));
  agentEditingNote.textContent = `正在编辑：${room.name}的嘉宾阵容`;
  agentRoomFilters.classList.toggle("is-hidden", roomView);
  agentRoomFilters.replaceChildren();

  if (!roomView) {
    const filters = [
      { value: "all", label: `全部 ${state.agents.length}` },
      ...state.rooms.map((item) => ({
        value: `room:${item.id}`,
        label: `${item.name} ${state.agents.filter((agent) => item.participantIds.includes(agent.id)).length}`,
      })),
      ...(unassignedCount ? [{ value: "unassigned", label: `未分房 ${unassignedCount}` }] : []),
    ];
    for (const filter of filters) {
      const button = createElement("button", "agent-room-filter", filter.label);
      button.type = "button";
      button.dataset.agentRoomFilter = filter.value;
      button.setAttribute("aria-pressed", String(agentRoomFilter === filter.value));
      agentRoomFilters.append(button);
    }
  }

  let visibleAgents = roomView
    ? state.agents.filter((agent) => roomMemberIds.has(agent.id))
    : [...state.agents];
  if (!roomView && agentRoomFilter === "unassigned") {
    visibleAgents = visibleAgents.filter((agent) => membershipsFor(agent.id).length === 0);
  } else if (!roomView && agentRoomFilter.startsWith("room:")) {
    const filterRoomId = agentRoomFilter.slice("room:".length);
    visibleAgents = visibleAgents.filter((agent) => state.rooms
      .find((item) => item.id === filterRoomId)?.participantIds.includes(agent.id));
  } else if (!roomView) {
    visibleAgents.sort((left, right) => Number(roomMemberIds.has(right.id)) - Number(roomMemberIds.has(left.id)));
  }

  if (!visibleAgents.length) {
    const empty = createElement(
      "div",
      "agent-list-empty",
      roomView ? "本房还没有嘉宾。切换到“全部嘉宾”邀请一位吧。" : "这个分类里还没有嘉宾。",
    );
    agentList.append(empty);
    return;
  }

  for (const agent of visibleAgents) {
    const participating = Boolean(room?.participantIds.includes(agent.id));
    const card = createElement("article", `agent-card${participating ? "" : " is-disabled"}`);
    const top = createElement("div", "agent-card-top");
    const initial = createElement("span", "agent-initial", agent.name.trim().slice(0, 1).toUpperCase() || "?");
    const identity = createElement("div", "agent-identity");
    identity.append(
      createElement("strong", "", agent.name),
      createElement("span", "", agent.model || FORMAT_META[agent.format].label),
    );
    const editButton = createElement("button", "agent-edit", "编辑");
    editButton.type = "button";
    editButton.addEventListener("click", () => openAgentDialog(agent.id));
    top.append(initial, identity, editButton);

    const bottom = createElement("div", "agent-card-bottom");
    const readiness = createElement(
      "span",
      `agent-readiness${isConfigured(agent) ? " is-ready" : ""}`,
      isConfigured(agent) ? "配置已保存" : "等待配置",
    );
    const personaLabel = createElement(
      "span",
      "",
      `${agent.persona.trim() ? "已有人设" : "原厂味"}${agent.memoryEnabled ? " · 私忆开" : ""}`,
    );
    const memberships = membershipsFor(agent.id);
    const membershipRow = createElement("div", "agent-memberships");
    if (memberships.length) {
      for (const membership of memberships) {
        membershipRow.append(createElement(
          "span",
          `agent-membership${membership.id === room.id ? " is-current" : ""}`,
          membership.name,
        ));
      }
    } else {
      membershipRow.append(createElement("span", "agent-membership is-unassigned", "尚未加入房间"));
    }
    const toggleLabel = createElement("label", "switch");
    toggleLabel.setAttribute("aria-label", `${participating ? "移出" : "邀请"}${agent.name}`);
    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = participating;
    toggle.addEventListener("change", () => toggleRoomParticipant(agent.id, toggle.checked));
    toggleLabel.append(toggle, createElement("span", "switch-track"));
    const status = createElement("div", "agent-status");
    status.append(readiness, personaLabel);
    const roomToggle = createElement("div", "agent-room-toggle");
    roomToggle.append(createElement("span", "agent-room-toggle-text", participating ? "已在本房" : "加入本房"), toggleLabel);
    bottom.append(status, roomToggle);
    card.append(top);
    if (!roomView) card.append(membershipRow);
    card.append(bottom);
    agentList.append(card);
  }
}

function renderSpeakerOptions() {
  const previous = speakerSelect.value;
  speakerSelect.replaceChildren();
  const room = activeRoom();
  const participants = state.agents.filter((agent) => room?.participantIds.includes(agent.id));
  for (const agent of participants) {
    const option = document.createElement("option");
    option.value = agent.id;
    option.textContent = `${agent.name}${isConfigured(agent) ? "" : "（未配置）"}`;
    speakerSelect.append(option);
  }
  if (participants.some((agent) => agent.id === previous)) speakerSelect.value = previous;
}

function formatTime(timestamp) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(timestamp));
}

function renderMessages({ scroll = false } = {}) {
  const previousScrollTop = messageFeed.scrollTop;
  for (const element of [...messageFeed.querySelectorAll(".message")]) element.remove();
  const messages = currentMessages();
  emptyState.classList.toggle("is-hidden", messages.length > 0);
  for (const message of messages) {
    const article = createElement(
      "article",
      `message${message.kind === "user" ? " is-user" : ""}${message.kind === "error" ? " is-error" : ""}`,
    );
    const meta = createElement("div", "message-meta");
    meta.append(
      createElement("span", "message-author", message.author),
      createElement("time", "message-time", formatTime(message.timestamp)),
    );
    const segments = Array.isArray(message.segments) && message.segments.length > 1
      ? message.segments
      : [message.text];
    const stack = createElement("div", segments.length > 1 ? "message-bubble-stack" : "message-bubble-single");
    const bodies = segments.map((segment) => {
      const body = createElement("div", "message-body");
      body.append(createElement("span", "message-text", segment));
      stack.append(body);
      return body;
    });
    const body = bodies.at(-1);
    body.classList.add("has-actions");
    const actions = createElement("div", "message-actions");
    if (message.kind !== "error") {
      const copyButton = createElement("button", "copy-message", "复制");
      copyButton.type = "button";
      copyButton.setAttribute("aria-label", `复制 ${message.author} 的${segments.length > 1 ? "这组" : "这条"}消息`);
      copyButton.addEventListener("click", async () => {
        if (await copyText(message.text)) {
          showToast("已复制");
        } else {
          openCopyFallback(message.text);
          showToast("浏览器拦住了自动复制，已为你选中原文");
        }
      });
      actions.append(copyButton);
    }
    const deleteButton = createElement("button", "delete-message", "删除");
    deleteButton.type = "button";
    deleteButton.setAttribute("aria-label", `删除 ${message.author} 的${segments.length > 1 ? "整组" : "这条"}消息`);
    deleteButton.addEventListener("click", () => deleteMessage(message.id));
    actions.append(deleteButton);
    body.append(actions);
    article.append(meta, stack);
    messageFeed.append(article);
  }
  if (scroll) scrollToLatest({ revealOnSmallScreen: true });
  else requestAnimationFrame(() => { messageFeed.scrollTop = previousScrollTop; });
}

function isSmallRoomLayout() {
  return globalThis.matchMedia?.("(max-width: 840px)").matches === true;
}

function isViewingLatest() {
  if (isSmallRoomLayout()) {
    const composerRect = composer.getBoundingClientRect();
    return composerRect.top <= window.innerHeight + 140 && composerRect.bottom >= -140;
  }
  return messageFeed.scrollHeight - messageFeed.scrollTop - messageFeed.clientHeight < 120;
}

function updateNewMessageJump() {
  newMessageJump.classList.toggle("is-hidden", unseenMessageCount <= 0);
  newMessageJump.textContent = unseenMessageCount > 1
    ? `↓ ${unseenMessageCount} 条新消息`
    : "↓ 1 条新消息";
}

function scrollToLatest({ revealOnSmallScreen = false, behavior = "auto" } = {}) {
  requestAnimationFrame(() => {
    messageFeed.scrollTo({ top: messageFeed.scrollHeight, behavior });
    if (revealOnSmallScreen && isSmallRoomLayout() && currentMessages().length) {
      composer.scrollIntoView({ block: "end", behavior });
    }
    unseenMessageCount = 0;
    updateNewMessageJump();
  });
}

function renderRoomHeader() {
  roomTitle.textContent = activeRoom()?.name || "观察间";
}

function renderMode() {
  document.querySelectorAll("[data-mode]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.mode === state.mode);
  });
  document.querySelectorAll("[data-free-strategy]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.freeStrategy === state.freeStrategy);
  });
  const meta = MODE_META[state.mode];
  const isFree = state.mode === "free";
  const isMicGrab = isFree && state.freeStrategy === "mic-grab";
  const isLightMic = isFree && state.freeStrategy === "light-mic";
  roomModeLabel.textContent = isMicGrab
    ? "自由聊 · 真实抢麦"
    : isLightMic ? "自由聊 · 轻量抢麦" : meta.label;
  sendButton.textContent = meta.action;
  modeHelp.textContent = isMicGrab
    ? "每轮先让所有嘉宾暗中报一个接话意愿分，再由最想说的一位发言。"
    : isLightMic
      ? "本地参考点名、冷场和发言间隔抽一位接话；不先询问 AI，也不增加评分调用。"
      : meta.help;
  speakerControl.classList.toggle("is-hidden", state.mode !== "point");
  freeStrategyControl.classList.toggle("is-hidden", !isFree);
  roundsControl.classList.toggle("is-hidden", !isFree);
  micStatus.classList.toggle("is-hidden", !(isMicGrab || isLightMic));
  freeStrategyHelp.textContent = isMicGrab
    ? "每轮会增加一次所有嘉宾的短评分调用；系统会按每位嘉宾自己的平时分数校准。"
    : isLightMic
      ? "只调用最终被抽中的嘉宾；刚说过会降权、久未发言和被点名会加权，也可能全员安静。"
      : "按嘉宾席顺序轮流发言，不会增加额外调用。";
  roundsLabel.textContent = (isMicGrab || isLightMic) ? "抢麦轮数" : "讨论轮数";
  roundsHelp.textContent = isMicGrab
    ? "一轮只产生一位赢家的正式发言；连续两轮全员弃权会自然收场。"
    : isLightMic
      ? "一轮最多产生一位正式发言；本地抽到安静就自然收场。"
      : "一轮 = 每位启用的嘉宾发言一次。设了上限，不会无限烧额度。";
  const room = activeRoom();
  mobileRoomMeta.textContent = room ? `${room.messages.length} 条 · ${compactModeLabel()}` : "还没有房间";
}

function renderAll(options = {}) {
  renderRooms();
  renderAgents();
  renderSpeakerOptions();
  renderRoomHeader();
  renderMode();
  renderSummarizerStatus();
  renderMessages(options);
}

function addMessage({ kind, author, text, agentId = null }) {
  const room = activeRoom();
  if (!room) return;
  const formatted = formatChatBubbleReply(text, room.bubbleSplit && kind === "agent");
  room.messages.push({
    id: newId("message"),
    kind,
    author,
    text: formatted.text,
    ...(formatted.segments.length ? { segments: formatted.segments } : {}),
    agentId,
    timestamp: Date.now(),
  });
  room.updatedAt = Date.now();
  renderMessages({ scroll: true });
  renderRooms();
  queuePersist();
}

function deleteMessage(messageId) {
  if (state.running) {
    showToast("先暂停当前讨论，再删除消息");
    return;
  }
  const room = activeRoom();
  const message = room?.messages.find((item) => item.id === messageId);
  if (!room || !message) return;
  if (summarizingRoomIds.has(room.id)) {
    showToast("记忆整理员正在翻这间房，等它收好再删除");
    return;
  }
  if (!globalThis.confirm(`删除 ${message.author} 的这条消息？\n\n删除后无法从观察室恢复。`)) return;
  const rememberedMessages = memoryMessages(room);
  const deletedMemoryIndex = rememberedMessages.findIndex((item) => item.id === messageId);
  const markerIndex = rememberedMessages.findIndex((item) => item.id === room.memory.summarizedThroughId);
  if (room.memory.summary.trim() && deletedMemoryIndex >= 0 && deletedMemoryIndex <= markerIndex) {
    room.memory.stale = true;
  }
  room.messages = room.messages.filter((item) => item.id !== messageId);
  room.updatedAt = Date.now();
  renderMessages();
  renderRooms();
  queuePersist();
  showToast("这一条已经删除");
}

function switchRoom(roomId) {
  if (state.running) {
    showToast("先停下当前讨论，再换房间");
    return;
  }
  state.activeRoomId = roomId;
  agentListView = "room";
  agentRoomFilter = "all";
  unseenMessageCount = 0;
  closeMobileRoomMenu();
  renderAll({ scroll: true });
  queuePersist();
}

function toggleRoomParticipant(agentId, shouldJoin) {
  const room = activeRoom();
  if (!room) return;
  if (shouldJoin && !room.participantIds.includes(agentId)) room.participantIds.push(agentId);
  if (!shouldJoin) room.participantIds = room.participantIds.filter((id) => id !== agentId);
  room.updatedAt = Date.now();
  renderAgents();
  renderSpeakerOptions();
  renderRooms();
  queuePersist();
}

function setRunning(running, speaker = "", phase = "reply") {
  state.running = running;
  sendButton.disabled = running;
  byId("add-agent-button").disabled = running;
  byId("add-room-button").disabled = running;
  stopButton.classList.toggle("is-hidden", !running);
  speakingIndicator.classList.toggle("is-hidden", !running);
  if (running) {
    speakingText.textContent = phase === "score" ? "嘉宾们正在暗中抢麦" : `${speaker} 正在组织语言`;
    setRuntimeStatus("busy", phase === "score" ? "正在等待抢麦分数" : `正在等 ${speaker}`);
  } else {
    setRuntimeStatus("ready", "观察室已就绪");
  }
}

function buildSystemPrompt(agent, activeAgents, room, visibleTokenTarget) {
  const others = activeAgents.filter((item) => item.id !== agent.id).map((item) => item.name);
  const persona = agent.persona.trim()
    ? `你的角色设定如下：\n${agent.persona.trim()}`
    : "没有额外角色设定。请按你自然、未预设的表达倾向参与，不必刻意扮演固定性格。";
  const roomAtmosphere = room?.roomPrompt?.trim()
    ? `本聊天室共同的氛围提示如下。它适用于所有嘉宾：\n${room.roomPrompt.trim()}`
    : "本聊天室没有额外氛围设定。";
  return [
    `你是群聊嘉宾“${agent.name}”。`,
    others.length ? `同桌还有：${others.join("、")}。` : "当前只有你一位 AI 嘉宾。",
    roomAtmosphere,
    persona,
    "只代表自己发言，不要代替其他嘉宾或用户说话。可以回应、赞同、质疑或追问刚才的内容。",
    `这是群聊中的一次简短发言。最终正文尽量控制在约 ${visibleTokenTarget} tokens 以内；先说最想说的，保持句子完整，不要为了凑长度展开成小论文。`,
    bubbleSplitInstruction(room?.bubbleSplit),
    "直接输出你在群聊里要说的话，不加姓名前缀，不复述规则。使用群聊主要语言，自然交流。",
    privateMemoryOutputInstruction(agent),
  ].filter(Boolean).join("\n\n");
}

function buildImmediatePrompt(agent, room, visibleTokenTarget) {
  const roomAtmosphere = room?.roomPrompt?.trim() || "没有额外房间氛围设定。";
  const persona = agent.persona.trim() || "没有额外个人设定；保持你自然、未预设的表达倾向。";
  return [
    "以下是紧邻本次发言的临场提示，不是群聊记录。请在开口前再次遵循。",
    `【正文长度目标】尽量控制在约 ${visibleTokenTarget} tokens 以内；优先保证句子完整。`,
    "个人设定应在房间共同氛围内发挥；两者冲突时，以房间共同氛围为准。",
    `【房间共同氛围｜所有嘉宾】\n${roomAtmosphere}`,
    `【你的个人设定｜${agent.name}】\n${persona}`,
    privateMemoryContext(agent),
    bubbleSplitInstruction(room?.bubbleSplit),
  ].filter(Boolean).join("\n\n");
}

function isPrivateMemoryInitializationRequest(room) {
  const latestUserMessage = [...(room?.messages || [])]
    .reverse()
    .find((message) => message.kind === "user");
  const text = String(latestUserMessage?.text || "");
  return /(?:初始化|写入|填写|建立|新增).{0,16}(?:私人记忆|角色记忆)|(?:私人记忆|角色记忆).{0,16}(?:初始化|写入|填写|建立|新增)/.test(text);
}

function transcriptForPrompt(room) {
  const recentLimit = room.memory.enabled && room.memory.summary.trim()
    ? room.memory.recentMessages
    : 40;
  return room.messages
    .filter((message) => message.kind !== "error")
    .slice(-recentLimit)
    .map((message) => `${message.author}：${message.text}`)
    .join("\n\n");
}

function longTermMemoryForPrompt(room) {
  if (!room.memory.enabled || room.memory.stale || !room.memory.summary.trim()) return "";
  return [
    "以下是这个房间较早聊天的长期总结。它只用于补充背景，不是任何人刚刚说的话；若与最近原文冲突，以最近原文为准。",
    "其中若有人物评价、性格概括或能力判断，只把它们当作过去对话中出现过的看法，不得当成人设、客观事实或发言要求；不要为了符合或反驳标签而改变表达。",
    room.memory.summary.trim(),
  ].join("\n\n");
}

async function callAgent(agent, activeAgents, room, signal) {
  const visibleTokenTarget = Math.min(4096, Math.max(64, Number(tokensInput.value) || 300));
  const requestTokenLimit = Math.min(
    4096,
    visibleTokenTarget + (agent.memoryEnabled ? PRIVATE_MEMORY_TOKEN_ALLOWANCE : 0),
  );
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      agent,
      temperature: Number(temperatureInput.value),
      maxTokens: requestTokenLimit,
      messages: [
        { role: "system", content: buildSystemPrompt(agent, activeAgents, room, visibleTokenTarget) },
        {
          role: "user",
          content: `${longTermMemoryForPrompt(room) ? `${longTermMemoryForPrompt(room)}\n\n` : ""}以下是最近的群聊原文：\n\n${transcriptForPrompt(room)}\n\n${buildImmediatePrompt(agent, room, visibleTokenTarget)}\n\n现在轮到你发言。请延续这场真实的群聊。`,
        },
      ],
    }),
    signal,
  });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401) {
    await checkAccess();
    throw new Error("局域网访问码已失效，请重新输入");
  }
  if (!response.ok) throw new Error(payload.error || `请求失败（${response.status}）`);
  if (!payload.text) throw new Error("接口没有返回文字");
  return payload;
}

function micScoringTranscript(room) {
  return room.messages
    .filter((message) => message.kind !== "error")
    .slice(-8)
    .map((message) => {
      const compactText = message.text.length > 1_200 ? `…${message.text.slice(-1_200)}` : message.text;
      return `${message.author}：${compactText}`;
    })
    .join("\n\n");
}

function buildMicScoringMessages(agent, activeAgents, room) {
  const others = activeAgents.filter((item) => item.id !== agent.id).map((item) => item.name);
  const atmosphere = room.roomPrompt.trim().slice(0, 2_000) || "没有额外房间氛围设定。";
  const persona = agent.persona.trim().slice(0, 2_000)
    || "没有额外个人设定；按你自然、未预设的表达倾向判断。";
  return [
    {
      role: "system",
      content: [
        `你是群聊嘉宾“${agent.name}”。${others.length ? `同桌还有：${others.join("、")}。` : ""}`,
        `【房间共同氛围】\n${atmosphere}`,
        `【你的个人设定】\n${persona}`,
        privateMemoryContext(agent, { maxLength: 4_000 }),
        "你现在只决定要不要争取下一次发言机会，不要生成正式回复。",
        "只输出一个 0 到 10 的整数：0=完全不想接话，4=勉强有话可说，7=很想接，10=必须现在说。",
        "不要解释，不要加标点或其他文字。",
      ].filter(Boolean).join("\n\n"),
    },
    {
      role: "user",
      content: `【最近群聊】\n${micScoringTranscript(room)}\n\n你现在有多想接话？只输出 0-10 的整数。`,
    },
  ];
}

async function scoreWillingness(agent, activeAgents, room, conversationSignal) {
  const controller = new AbortController();
  const stopWithConversation = () => controller.abort();
  if (conversationSignal.aborted) controller.abort();
  else conversationSignal.addEventListener("abort", stopWithConversation, { once: true });
  const timeout = setTimeout(() => controller.abort(), 25_000);
  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent,
        temperature: 0.2,
        maxTokens: 8,
        requestMode: "willingness-score",
        messages: buildMicScoringMessages(agent, activeAgents, room),
      }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `评分请求失败（${response.status}）`);
    const score = parseWillingnessScore(payload.text);
    if (score === null) throw new Error("没有返回可识别的意愿分");
    return score;
  } finally {
    clearTimeout(timeout);
    conversationSignal.removeEventListener("abort", stopWithConversation);
  }
}

async function scoreMicRound(activeAgents, room, signal) {
  const settled = await Promise.allSettled(
    activeAgents.map((agent) => scoreWillingness(agent, activeAgents, room, signal)),
  );
  return activeAgents.map((agent, index) => ({
    id: agent.id,
    name: agent.name,
    score: settled[index].status === "fulfilled" ? settled[index].value : null,
    failed: settled[index].status === "rejected",
  }));
}

function micSnapshotText(scores, winner = null, roundNumber = 1, options = {}) {
  const ranked = new Map(rankMicCandidates(scores, options).map((entry) => [entry.id, entry]));
  const parts = scores.map((entry) => {
    if (entry.score === null) return `${entry.name} 未接通`;
    const result = ranked.get(entry.id);
    const shift = result?.baseline === null ? 0 : result.calibratedScore - entry.score;
    const trend = shift > 0.4 ? "↑" : shift < -0.4 ? "↓" : "";
    if (!result?.eligible) return `${entry.name} ${entry.score}${trend}（弃权）`;
    return `${entry.name} ${entry.score}${trend}`;
  });
  if (winner) return `第 ${roundNumber} 轮｜${parts.join(" · ")} → ${winner.name} 抢到`;
  return `第 ${roundNumber} 轮｜${parts.join(" · ")} → 没人接话`;
}

async function deliverAgentTurn(speaker, activeAgents, room, controller) {
  if (controller.signal.aborted) return false;
  setRunning(true, speaker.name);
  try {
    const memoryWasEmpty = speaker.memoryEnabled && !String(speaker.memory || "").trim();
    const reply = await callAgent(speaker, activeAgents, room, controller.signal);
    const parsedReply = speaker.memoryEnabled
      ? parseAgentReply(reply.text)
      : { visibleText: reply.text, memoryItems: [] };
    if (parsedReply.memoryItems.length) {
      const nextMemory = appendAgentMemory(speaker.memory, parsedReply.memoryItems, {
        roomName: room.name,
        at: Date.now(),
      });
      if (nextMemory !== speaker.memory) {
        speaker.memory = nextMemory;
        speaker.memoryRevision = Math.max(
          Date.now(),
          Math.max(0, Number(speaker.memoryRevision) || 0) + 1,
        );
      }
    }
    addMessage({ kind: "agent", author: speaker.name, text: parsedReply.visibleText, agentId: speaker.id });
    if (memoryWasEmpty && isPrivateMemoryInitializationRequest(room) && !parsedReply.memoryItems.length) {
      showToast(`${speaker.name} 本轮没有实际写入私人记忆`);
    }
    if (reply.finishReason === "length") {
      addMessage({
        kind: "error",
        author: "内容截断",
        text: `${speaker.name} 达到了单次回复上限；上面这句不是完整发言。`,
        agentId: speaker.id,
      });
    } else if (reply.finishReason === "insufficient_system_resource") {
      addMessage({
        kind: "error",
        author: "上游繁忙",
        text: `${speaker.name} 的推理资源不足；本次回复可能不完整。`,
        agentId: speaker.id,
      });
    }
    return true;
  } catch (error) {
    if (error?.name === "AbortError") return false;
    addMessage({
      kind: "error",
      author: "传话失败",
      text: `${speaker.name} 没有接通：${error.message}`,
      agentId: speaker.id,
    });
    return false;
  }
}

async function runLightMicConversation(activeAgents, room, controller, rounds) {
  const missedTurns = {};
  let lastSpeakerId = room.messages.filter((message) => message.kind === "agent").at(-1)?.agentId || "";

  for (let round = 1; round <= rounds; round += 1) {
    if (controller.signal.aborted) break;
    const winner = pickLightMicWinner(activeAgents, room.messages, {
      missedTurns,
      lastSpeakerId,
      roundNumber: round,
    });
    if (!winner) {
      micStatus.textContent = `第 ${round} 轮｜轻量抢麦没有抽中发言者，这轮安静收场。`;
      break;
    }

    for (const agent of activeAgents) {
      missedTurns[agent.id] = agent.id === winner.id ? 0 : (missedTurns[agent.id] || 0) + 1;
    }
    const reason = winner.mentioned
      ? "（刚被点名）"
      : winner.turnsSince >= 6 ? "（久未发言）" : "";
    micStatus.textContent = `第 ${round} 轮｜本地抽中 ${winner.name}${reason}，没有进行意愿评分。`;
    const delivered = await deliverAgentTurn(winner, activeAgents, room, controller);
    if (delivered) lastSpeakerId = winner.id;
  }
}

async function runMicGrabConversation(activeAgents, room, controller, rounds) {
  const missedTurns = {};
  let micChanged = false;
  let consecutivePasses = 0;
  let lastSpeakerId = room.messages.filter((message) => message.kind === "agent").at(-1)?.agentId || "";

  for (let round = 1; round <= rounds; round += 1) {
    if (controller.signal.aborted) break;
    if (activeAgents.length === 1) {
      const onlyAgent = activeAgents[0];
      micStatus.textContent = `第 ${round} 轮｜只有 ${onlyAgent.name} 一位嘉宾，直接交麦。`;
      await deliverAgentTurn(onlyAgent, activeAgents, room, controller);
      lastSpeakerId = onlyAgent.id;
      continue;
    }

    setRunning(true, "", "score");
    const scores = await scoreMicRound(activeAgents, room, controller.signal);
    if (controller.signal.aborted) break;
    if (scores.every((entry) => entry.score === null)) {
      micStatus.textContent = `第 ${round} 轮｜所有抢麦评分都没有接通，讨论已停止。`;
      showToast("抢麦评分都没有接通，已经停止本次自由聊");
      break;
    }

    const micOptions = {
      ...DEFAULT_MIC_OPTIONS,
      missedTurns,
      lastSpeakerId,
      scoreHistory: room.mic.scoreHistory,
    };
    const rankedScores = rankMicCandidates(scores, micOptions);
    const winner = pickMicWinner(scores, micOptions);
    const snapshotText = micSnapshotText(scores, winner, round, micOptions);
    const updatedHistory = recordMicScores(room.mic.scoreHistory, scores);
    if (scores.some((entry) => Number.isFinite(entry.score))) {
      room.mic.scoreHistory = updatedHistory;
      room.mic.revision += 1;
      room.updatedAt = Date.now();
      micChanged = true;
    }
    if (!winner) {
      consecutivePasses += 1;
      micStatus.textContent = snapshotText;
      if (consecutivePasses >= 2) {
        showToast("连续两轮没人想接话，这次自由聊自然收场啦");
        break;
      }
      continue;
    }

    consecutivePasses = 0;
    for (const entry of rankedScores) {
      if (!entry.eligible) continue;
      missedTurns[entry.id] = entry.id === winner.id ? 0 : (missedTurns[entry.id] || 0) + 1;
    }
    const speaker = activeAgents.find((agent) => agent.id === winner.id);
    micStatus.textContent = snapshotText;
    if (!speaker) break;
    await deliverAgentTurn(speaker, activeAgents, room, controller);
    lastSpeakerId = speaker.id;
  }
  if (micChanged) await queuePersist();
}

function memoryMessages(room) {
  return room.messages.filter((message) => message.kind !== "error" && message.text.trim());
}

function pendingMemoryMessages(room, { rebuild = false } = {}) {
  const messages = memoryMessages(room);
  if (rebuild || !room.memory.summary.trim() || !room.memory.summarizedThroughId) return messages;
  const markerIndex = messages.findIndex((message) => message.id === room.memory.summarizedThroughId);
  if (markerIndex < 0) {
    room.memory.stale = true;
    return [];
  }
  return messages.slice(markerIndex + 1);
}

function updateRoomMemoryStatus(room) {
  if (!room) return;
  const busy = summarizingRoomIds.has(room.id);
  const run = summaryRuns.get(room.id);
  const notice = summaryNotices.get(room.id);
  const isSavedRoom = Boolean(room.id && state.rooms.some((item) => item.id === room.id));
  const pending = room.memory.stale ? 0 : pendingMemoryMessages(room).length;
  roomMemoryStatus.classList.toggle("is-stale", room.memory.stale);
  roomMemoryStatus.classList.toggle("is-error", !busy && notice?.kind === "error");
  if (busy) {
    const elapsed = Math.max(1, Math.floor((Date.now() - (run?.startedAt || Date.now())) / 1000));
    roomMemoryStatus.textContent = `${run?.phase || "记忆整理员正在安静地翻旧记录"}……已等待 ${elapsed} 秒，可以随时取消。`;
  } else if (notice) {
    roomMemoryStatus.textContent = notice.message;
  } else if (room.memory.stale) {
    roomMemoryStatus.textContent = "有已经整理过的旧消息被删除了，请点“重新生成”。";
  } else if (room.memory.summary.trim()) {
    const updated = room.memory.updatedAt
      ? new Date(room.memory.updatedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })
      : "时间未知";
    roomMemoryStatus.textContent = `已整理约 ${room.memory.summarizedMessageCount} 条 · ${updated} · 还有 ${pending} 条新消息未整理。`;
  } else {
    roomMemoryStatus.textContent = `还没有长期总结；当前有 ${memoryMessages(room).length} 条可整理记录。`;
  }
  byId("memory-cancel").classList.toggle("is-hidden", !busy);
  byId("memory-summarize-now").disabled = busy || !isSavedRoom;
  byId("memory-rebuild").disabled = busy || !isSavedRoom || !room.messages.length;
}

function updateRoomScheduleStatus(room) {
  const schedule = hydrateRoomSchedule(room?.schedule);
  const eventCards = hydrateRoomEventCards(room?.eventCards);
  if (!schedule.enabled) {
    roomScheduleStatus.textContent = "后台定时未开启。";
    return;
  }
  const next = schedule.nextWakeAt
    ? new Date(schedule.nextWakeAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : "保存后开始计时";
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const used = schedule.dayKey === todayKey ? schedule.dailyCount : 0;
  const strategyLabel = schedule.strategy === "light-mic" ? "轻量抢麦" : "真实抢麦";
  roomScheduleStatus.textContent = `下次约 ${next} · 今日 ${used}/${schedule.dailyLimit} 次 · ${strategyLabel}${eventCards.enabled ? " · 本房事件卡" : ""}${schedule.lastResult ? ` · ${schedule.lastResult}` : ""}`;
}

function roomScheduleConfigFromForm(data = new FormData(roomForm)) {
  return {
    enabled: data.get("scheduleEnabled") === "on",
    strategy: data.get("scheduleStrategy") === "light-mic" ? "light-mic" : "mic-grab",
    intervalMinutes: Number(data.get("scheduleInterval")) === 30 ? 30 : 60,
    maxTurns: Math.min(6, Math.max(1, Number(data.get("scheduleMaxTurns")) || 3)),
    dailyLimit: Math.min(48, Math.max(1, Number(data.get("scheduleDailyLimit")) || 8)),
    quietEnabled: data.get("scheduleQuietEnabled") === "on",
    quietStart: String(data.get("scheduleQuietStart") || "23:00"),
    quietEnd: String(data.get("scheduleQuietEnd") || "08:00"),
  };
}

function roomEventCardsConfigFromForm(data = new FormData(roomForm)) {
  return {
    enabled: data.get("scheduleEventsEnabled") === "on",
    focus: String(data.get("scheduleEventsFocus") || "").trim().slice(0, 4_000),
  };
}

function previewRoomScheduleStatus() {
  const room = state.rooms.find((item) => item.id === roomForm.elements.namedItem("id").value);
  const current = room?.schedule || hydrateRoomSchedule();
  const draft = { ...current, ...roomScheduleConfigFromForm() };
  const currentEvents = room?.eventCards || hydrateRoomEventCards();
  const eventDraft = { ...currentEvents, ...roomEventCardsConfigFromForm() };
  updateRoomScheduleStatus({ schedule: draft, eventCards: eventDraft });
  if (JSON.stringify(roomScheduleConfigFromForm()) !== JSON.stringify({
    enabled: current.enabled,
    strategy: current.strategy,
    intervalMinutes: current.intervalMinutes,
    maxTurns: current.maxTurns,
    dailyLimit: current.dailyLimit,
    quietEnabled: current.quietEnabled,
    quietStart: current.quietStart,
    quietEnd: current.quietEnd,
  }) || JSON.stringify(roomEventCardsConfigFromForm()) !== JSON.stringify({
    enabled: currentEvents.enabled,
    focus: currentEvents.focus,
  })) {
    roomScheduleStatus.textContent += " · 点击“保存房间”后生效";
  }
}

function waitForSummaryRetry(signal, milliseconds = 1200) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("整理已取消", "AbortError"));
      return;
    }
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new DOMException("整理已取消", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function requestSummary(room, promptMessages, signal, maxTokens) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: state.summarizer,
        temperature: 0.2,
        maxTokens,
        requestMode: "memory-summary",
        messages: promptMessages,
      }),
      signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401) {
      await checkAccess();
      throw new Error("局域网访问码已失效，请重新输入");
    }
    if (response.ok) {
      if (!payload.text?.trim()) throw new Error("总结模型没有返回文字");
      return payload.text.trim();
    }

    const error = new Error(payload.error || `总结请求失败（${response.status}）`);
    error.status = response.status;
    if (attempt === 1 && [502, 503].includes(response.status)) {
      const run = summaryRuns.get(room.id);
      if (run) run.phase = "整理接口刚才短暂失败，正在自动重试一次";
      if (roomDialog.open && roomForm.elements.namedItem("id").value === room.id) updateRoomMemoryStatus(room);
      await waitForSummaryRetry(signal);
      continue;
    }
    throw error;
  }
  throw new Error("总结接口连续两次没有接通");
}

async function summarizeRoom(room, { rebuild = false, manual = false } = {}) {
  if (!room || summarizingRoomIds.has(room.id)) return false;
  if (!isConfigured(state.summarizer)) {
    if (manual) {
      showToast("先配置记忆整理员的接口");
      openSummarizerDialog();
    }
    return false;
  }
  if (room.memory.stale && !rebuild) {
    if (manual) showToast("旧记忆已经变动，请使用“重新生成”");
    return false;
  }
  const pendingSource = pendingMemoryMessages(room, { rebuild });
  const source = rebuild || manual
    ? pendingSource
    : completeAutomaticSummaryBatch(pendingSource, room.memory.interval);
  if (!source.length) {
    if (manual) showToast("暂时没有新的聊天需要整理");
    return false;
  }
  const controller = new AbortController();
  summarizingRoomIds.add(room.id);
  summaryNotices.delete(room.id);
  summaryRuns.set(room.id, {
    controller,
    startedAt: Date.now(),
    phase: `记忆整理员正在翻 ${source.length} 条记录`,
  });
  updateRoomMemoryStatus(room);
  renderRooms();
  try {
    const previousSummary = room.memory.summary.trim();
    let summary = previousSummary;
    if (rebuild) {
      const sections = [];
      for (let index = 0; index < source.length; index += 40) {
        const chunk = source.slice(index, index + 40);
        const run = summaryRuns.get(room.id);
        if (run) run.phase = `正在细读第 ${index + 1}–${index + chunk.length} 条记录`;
        if (roomDialog.open && roomForm.elements.namedItem("id").value === room.id) updateRoomMemoryStatus(room);
        const body = await requestSummary(
          room,
          buildRebuildSectionMessages(room, chunk),
          controller.signal,
          2200,
        );
        sections.push(formatMemorySegment(chunk, body, index + 1, index + chunk.length));
      }
      summary = `# 全篇时间记录\n\n${sections.join("\n\n---\n\n")}`;
    } else {
      const sections = [];
      const chunkSize = Math.max(5, Number(room.memory.interval) || 20);
      const startOffset = Math.max(0, Number(room.memory.summarizedMessageCount) || 0);
      for (let index = 0; index < source.length; index += chunkSize) {
        const chunk = source.slice(index, index + chunkSize);
        const startNumber = startOffset + index + 1;
        const endNumber = startOffset + index + chunk.length;
        const run = summaryRuns.get(room.id);
        if (run) run.phase = `正在整理新增的第 ${startNumber}–${endNumber} 条记录`;
        if (roomDialog.open && roomForm.elements.namedItem("id").value === room.id) updateRoomMemoryStatus(room);
        const body = await requestSummary(
          room,
          buildAppendSummaryMessages(room, chunk),
          controller.signal,
          1400,
        );
        sections.push(formatMemorySegment(chunk, body, startNumber, endNumber));
      }
      summary = [previousSummary, ...sections].filter(Boolean).join("\n\n---\n\n");
    }
    if (!state.rooms.some((item) => item.id === room.id)) return false;
    const allMessages = memoryMessages(room);
    const lastId = source.at(-1).id;
    room.memory.summary = summary;
    room.memory.summarizedThroughId = lastId;
    room.memory.summarizedMessageCount = allMessages.findIndex((message) => message.id === lastId) + 1;
    room.memory.updatedAt = Date.now();
    room.memory.stale = false;
    summaryNotices.delete(room.id);
    room.updatedAt = Date.now();
    if (roomDialog.open && roomForm.elements.namedItem("id").value === room.id) {
      roomForm.elements.namedItem("memorySummary").value = summary;
    }
    renderRooms();
    await queuePersist();
    showToast(rebuild
      ? "已用现存聊天重建全篇记忆"
      : manual
        ? "新的记忆片段已追加，旧内容没有改动"
        : "记忆整理员追加了一段新记忆");
    return true;
  } catch (error) {
    if (error?.name === "AbortError") {
      summaryNotices.set(room.id, { kind: "cancelled", message: "上次整理已取消，原来的聊天和摘要都没有改动。" });
      showToast("已经取消整理，没有改动房间记忆");
    } else {
      summaryNotices.set(room.id, { kind: "error", message: `上次整理失败：${error.message}。可以检查整理员连接后重试。` });
      showToast(`长期记忆没有整理成功：${error.message}`);
    }
    return false;
  } finally {
    summarizingRoomIds.delete(room.id);
    summaryRuns.delete(room.id);
    if (roomDialog.open && roomForm.elements.namedItem("id").value === room.id) {
      updateRoomMemoryStatus(room);
    }
  }
}

function maybeAutoSummarize(room) {
  if (!room?.memory.enabled || room.memory.stale) return;
  void summarizeRoom(room).catch(() => {});
}

async function startConversation() {
  if (state.running) return;
  if (!state.ready) {
    showToast("观察室数据还在加载，再等一下");
    return;
  }
  const room = activeRoom();
  const participants = state.agents.filter((agent) => room?.participantIds.includes(agent.id));
  const configuredAgents = participants.filter(isConfigured);
  if (!configuredAgents.length) {
    showToast("先给本房间至少一位嘉宾填好接口配置");
    return;
  }

  let speakers = [];
  let micGrabRounds = 0;
  let lightMicRounds = 0;
  if (state.mode === "point") {
    const target = participants.find((agent) => agent.id === speakerSelect.value);
    if (!target || !isConfigured(target)) {
      showToast("被点名的嘉宾还没有配好接口");
      return;
    }
    speakers = [target];
  } else if (state.mode === "free") {
    const rounds = Math.min(6, Math.max(1, Number(roundsInput.value) || 2));
    if (state.freeStrategy === "mic-grab") micGrabRounds = rounds;
    else if (state.freeStrategy === "light-mic") lightMicRounds = rounds;
    else speakers = Array.from({ length: rounds }, () => configuredAgents).flat();
  } else {
    speakers = configuredAgents;
  }

  const userText = messageInput.value.trim();
  if (userText) {
    addMessage({ kind: "user", author: "晨曦", text: userText });
    messageInput.value = "";
  } else if (!room.messages.some((message) => message.kind !== "error")) {
    showToast("第一句话还是要由导演来：先给他们一个话题吧");
    return;
  }
  if (configuredAgents.length < participants.length && state.mode !== "point") {
    showToast("未配好接口的嘉宾会先坐在旁听席");
  }

  const controller = new AbortController();
  state.abortController = controller;
  try {
    if (micGrabRounds) {
      await runMicGrabConversation(configuredAgents, room, controller, micGrabRounds);
    } else if (lightMicRounds) {
      await runLightMicConversation(configuredAgents, room, controller, lightMicRounds);
    } else {
      for (const speaker of speakers) {
        if (controller.signal.aborted) break;
        await deliverAgentTurn(speaker, configuredAgents, room, controller);
      }
    }
  } finally {
    state.abortController = null;
    setRunning(false);
  }
  maybeAutoSummarize(room);
}

function setFormValue(name, value) {
  const control = agentForm.elements.namedItem(name);
  if (control) control.value = value ?? "";
}

function syncAuthField() {
  byId("custom-header-field").classList.toggle("is-hidden", byId("agent-auth").value !== "custom");
}

function syncEndpointHelp() {
  byId("endpoint-help").textContent = FORMAT_META[byId("agent-format").value].help;
}

function openAgentDialog(agentId = null) {
  const agent = state.agents.find((item) => item.id === agentId);
  const draft = agent || blankAgent({
    id: "",
    name: "",
    format: "openai",
    authType: "bearer",
  });
  byId("dialog-title").textContent = agent ? `编辑 ${agent.name}` : "添加 AI 嘉宾";
  agentMemoryDraftDirty = false;
  for (const key of ["id", "name", "format", "baseUrl", "model", "authType", "customHeader", "persona", "memory"]) {
    setFormValue(key, draft[key]);
  }
  agentForm.elements.namedItem("memoryEnabled").checked = draft.memoryEnabled === true;
  setFormValue("apiKey", "");
  setFormValue("extraHeaders", "");
  setFormValue("clearApiKey", "false");
  byId("agent-api-key").type = "password";
  byId("agent-api-key").placeholder = agent?.hasApiKey ? "已保存；留空不修改" : "保存到这台电脑";
  byId("toggle-key-button").textContent = "显示";
  byId("saved-key-row").classList.toggle("is-hidden", !agent?.hasApiKey);
  connectionResult.className = "connection-result is-hidden";
  connectionResult.textContent = "";
  deleteAgentButton.classList.toggle("is-hidden", !agent);
  duplicateAgentButton.classList.toggle("is-hidden", !agent);
  syncAuthField();
  syncEndpointHelp();
  syncAgentMemoryField();
  agentDialog.showModal();
}

function suggestedGuestCopyName(source, roomId) {
  const destination = state.rooms.find((room) => room.id === roomId)?.name || "副本";
  return `${source.name} · ${destination}`.slice(0, 28);
}

function refreshGuestCopyName() {
  const source = state.agents.find((agent) => agent.id === byId("guest-copy-source-id").value);
  if (!source) return;
  const input = byId("guest-copy-name");
  const nextSuggestion = suggestedGuestCopyName(source, byId("guest-copy-room").value);
  if (!input.value.trim() || input.value === guestCopyNameSuggestion) input.value = nextSuggestion;
  guestCopyNameSuggestion = nextSuggestion;
}

function openGuestCopyDialog(sourceId) {
  const source = state.agents.find((agent) => agent.id === sourceId);
  if (!source) return;
  guestCopyForm.reset();
  byId("guest-copy-source-id").value = source.id;
  byId("guest-copy-title").textContent = `复制 ${source.name}`;
  byId("guest-copy-credentials").checked = true;
  byId("guest-copy-persona").checked = false;
  byId("guest-copy-memory").checked = false;
  byId("guest-copy-memory-enabled").checked = false;
  const roomSelect = byId("guest-copy-room");
  roomSelect.replaceChildren();
  const noRoom = document.createElement("option");
  noRoom.value = "";
  noRoom.textContent = "暂不加入房间";
  roomSelect.append(noRoom);
  for (const room of state.rooms) {
    const option = document.createElement("option");
    option.value = room.id;
    option.textContent = room.name;
    roomSelect.append(option);
  }
  roomSelect.value = activeRoom()?.id || "";
  guestCopyNameSuggestion = "";
  refreshGuestCopyName();
  agentDialog.close();
  guestCopyDialog.showModal();
}

function createGuestCopyFromForm() {
  const data = new FormData(guestCopyForm);
  const source = state.agents.find((agent) => agent.id === data.get("sourceId"));
  if (!source) throw new Error("没有找到要复制的原嘉宾");
  const name = String(data.get("name") || "").trim();
  if (!name) throw new Error("先给副本起个名字");
  const copyCredentials = data.get("copyCredentials") === "on";
  const copyPersona = data.get("copyPersona") === "on";
  const copyMemory = data.get("copyMemory") === "on";
  const memoryEnabled = data.get("memoryEnabled") === "on";
  const duplicate = hydrateAgent({
    id: newId("guest"),
    name,
    format: copyCredentials ? source.format : "openai",
    baseUrl: copyCredentials ? source.baseUrl : "",
    model: copyCredentials ? source.model : "",
    authType: copyCredentials ? source.authType : "bearer",
    customHeader: copyCredentials ? source.customHeader : "",
    apiKey: copyCredentials ? source.apiKey : "",
    extraHeaders: copyCredentials ? source.extraHeaders : "",
    hasApiKey: copyCredentials && source.hasApiKey,
    hasExtraHeaders: copyCredentials && source.hasExtraHeaders,
    credentialSourceId: copyCredentials ? source.id : "",
    persona: copyPersona ? source.persona : "",
    memoryEnabled,
    memory: copyMemory ? source.memory : "",
    memoryRevision: copyMemory ? source.memoryRevision : 0,
  });
  return {
    duplicate,
    roomId: String(data.get("roomId") || ""),
  };
}

function syncAgentMemoryField() {
  const enabled = byId("agent-memory-enabled").checked;
  byId("agent-memory-editor").classList.toggle("is-hidden", !enabled);
  byId("agent-memory-editor").setAttribute("aria-hidden", String(!enabled));
  updateAgentMemoryStatus();
}

function updateAgentMemoryStatus(message = "") {
  const memory = byId("agent-memory").value.trim();
  const entries = memory ? memory.split(/\r?\n/).filter((line) => line.trim()).length : 0;
  const sizeHint = memory.length >= PRIVATE_MEMORY_REVIEW_THRESHOLD
    ? `已超过 ${PRIVATE_MEMORY_REVIEW_THRESHOLD.toLocaleString("zh-CN")} 字，建议找角色本人深度整理；不会自动删除旧事。`
    : `可保存至约 ${PRIVATE_MEMORY_STORAGE_LIMIT.toLocaleString("zh-CN")} 字；接近 ${PRIVATE_MEMORY_REVIEW_THRESHOLD.toLocaleString("zh-CN")} 字时建议深度整理。`;
  byId("agent-memory-status").textContent = message || `${entries} 条 · ${memory.length.toLocaleString("zh-CN")} 字；${sizeHint}`;
}

function contextExcerpt(value, maxLength) {
  const text = String(value || "").trim();
  if (!text || text.length <= maxLength) return text;
  const headLength = Math.max(1, Math.floor(maxLength * 0.38));
  const tailLength = Math.max(1, maxLength - headLength - 12);
  return `${text.slice(0, headLength)}\n…（中间省略）…\n${text.slice(-tailLength)}`;
}

function privateMemoryDeepContext(agentId, { maxLength = 24_000 } = {}) {
  const joinedRooms = state.rooms.filter((room) => room.participantIds.includes(agentId));
  const currentRoomId = activeRoom()?.id;
  joinedRooms.sort((left, right) => Number(right.id === currentRoomId) - Number(left.id === currentRoomId));
  if (!joinedRooms.length) return "（这位角色尚未加入任何房间，没有可供核对的房间上下文。）";

  const sections = [];
  let remaining = maxLength;
  for (const room of joinedRooms) {
    if (remaining < 500) break;
    const atmosphere = contextExcerpt(room.roomPrompt, 1_800);
    const longMemory = room.memory.enabled && !room.memory.stale
      ? contextExcerpt(room.memory.summary, 6_000)
      : "";
    const recent = room.messages
      .filter((message) => message.kind !== "error" && String(message.text || "").trim())
      .slice(-24)
      .map((message) => `${message.author}：${contextExcerpt(message.text, 800)}`)
      .join("\n\n");
    const section = [
      `【房间：${room.name}】`,
      atmosphere ? `房间氛围：\n${atmosphere}` : "",
      longMemory ? `较早聊天的房间长期记忆：\n${longMemory}` : "",
      recent ? `最近公开聊天：\n${recent}` : "（这个房间还没有公开聊天记录。）",
    ].filter(Boolean).join("\n\n");
    const visibleSection = contextExcerpt(section, remaining);
    sections.push(visibleSection);
    remaining -= visibleSection.length + 4;
  }
  return sections.join("\n\n---\n\n");
}

function agentFromForm() {
  const data = new FormData(agentForm);
  const format = String(data.get("format") || "openai");
  const existing = state.agents.find((agent) => agent.id === data.get("id"));
  const apiKey = String(data.get("apiKey") || "").trim();
  const extraHeaders = String(data.get("extraHeaders") || "").trim();
  const clearApiKey = String(data.get("clearApiKey")) === "true";
  const memoryEnabled = data.get("memoryEnabled") === "on";
  const memory = String(data.get("memory") || "").trim();
  const memoryChanged = Boolean(existing) && (
    memoryEnabled !== existing.memoryEnabled
    || memory !== existing.memory
  );
  const draft = {
    id: String(data.get("id") || newId("guest")),
    name: String(data.get("name") || "").trim(),
    format,
    baseUrl: String(data.get("baseUrl") || "").trim(),
    model: String(data.get("model") || "").trim(),
    authType: String(data.get("authType") || FORMAT_META[format].defaultAuth),
    apiKey,
    customHeader: String(data.get("customHeader") || "").trim(),
    extraHeaders,
    persona: String(data.get("persona") || "").trim(),
    memoryEnabled,
    memory,
    memoryRevision: existing
      ? memoryChanged
        ? Math.max(Date.now(), Math.max(0, Number(existing.memoryRevision) || 0) + 1)
        : Math.max(0, Number(existing.memoryRevision) || 0)
      : 0,
    hasApiKey: clearApiKey ? false : Boolean(apiKey || existing?.hasApiKey),
    hasExtraHeaders: Boolean(extraHeaders || existing?.hasExtraHeaders),
    clearApiKey,
    clearExtraHeaders: false,
  };
  if (!draft.name) throw new Error("先给这位嘉宾起个名字");
  if (extraHeaders) {
    const parsed = JSON.parse(extraHeaders);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error("额外请求头必须是 JSON 对象");
    }
  }
  return draft;
}

function setSummarizerFormValue(name, value) {
  const control = summarizerForm.elements.namedItem(name);
  if (control) control.value = value ?? "";
}

function syncSummarizerAuthField() {
  byId("summarizer-custom-header-field").classList.toggle(
    "is-hidden",
    byId("summarizer-auth").value !== "custom",
  );
}

function syncSummarizerEndpointHelp() {
  byId("summarizer-endpoint-help").textContent = FORMAT_META[byId("summarizer-format").value].help;
}

function openSummarizerDialog() {
  const draft = state.summarizer;
  for (const key of ["format", "baseUrl", "model", "authType", "customHeader"]) {
    setSummarizerFormValue(key, draft[key]);
  }
  setSummarizerFormValue("apiKey", "");
  setSummarizerFormValue("extraHeaders", "");
  setSummarizerFormValue("clearApiKey", "false");
  byId("summarizer-api-key").type = "password";
  byId("summarizer-api-key").placeholder = draft.hasApiKey ? "已保存；留空不修改" : "保存到这台电脑";
  byId("summarizer-toggle-key").textContent = "显示";
  byId("summarizer-saved-key-row").classList.toggle("is-hidden", !draft.hasApiKey);
  summarizerConnectionResult.className = "connection-result is-hidden";
  summarizerConnectionResult.textContent = "";
  syncSummarizerAuthField();
  syncSummarizerEndpointHelp();
  summarizerDialog.showModal();
}

function summarizerFromForm() {
  const data = new FormData(summarizerForm);
  const format = String(data.get("format") || "openai");
  const apiKey = String(data.get("apiKey") || "").trim();
  const extraHeaders = String(data.get("extraHeaders") || "").trim();
  const clearApiKey = String(data.get("clearApiKey")) === "true";
  const draft = hydrateSummarizer({
    id: SUMMARY_AGENT_ID,
    format,
    baseUrl: String(data.get("baseUrl") || "").trim(),
    model: String(data.get("model") || "").trim(),
    authType: String(data.get("authType") || FORMAT_META[format].defaultAuth),
    apiKey,
    customHeader: String(data.get("customHeader") || "").trim(),
    extraHeaders,
    hasApiKey: clearApiKey ? false : Boolean(apiKey || state.summarizer.hasApiKey),
    hasExtraHeaders: Boolean(extraHeaders || state.summarizer.hasExtraHeaders),
  });
  draft.clearApiKey = clearApiKey;
  if (!draft.baseUrl) throw new Error("请填写整理模型的 Base URL");
  if (!draft.model) throw new Error("请填写整理模型名称");
  if (extraHeaders) {
    const parsed = JSON.parse(extraHeaders);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error("额外请求头必须是 JSON 对象");
    }
  }
  return draft;
}

function populateRoomParticipants(selectedIds) {
  roomParticipantList.replaceChildren();
  for (const agent of state.agents) {
    const label = createElement("label", "participant-option");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.name = "participantIds";
    checkbox.value = agent.id;
    checkbox.checked = selectedIds.includes(agent.id);
    label.append(checkbox, createElement("span", "", agent.name));
    roomParticipantList.append(label);
  }
}

function openRoomDialog(roomId = null) {
  const room = state.rooms.find((item) => item.id === roomId);
  const memory = room?.memory || hydrateRoomMemory();
  const schedule = room?.schedule || hydrateRoomSchedule();
  const eventCards = room?.eventCards || hydrateRoomEventCards();
  byId("room-dialog-title").textContent = room ? `设置 ${room.name}` : "新建聊天室";
  roomForm.elements.namedItem("id").value = room?.id || "";
  roomForm.elements.namedItem("name").value = room?.name || "";
  roomForm.elements.namedItem("roomPrompt").value = room?.roomPrompt || "";
  roomForm.elements.namedItem("bubbleSplit").checked = room?.bubbleSplit === true;
  roomForm.elements.namedItem("memoryEnabled").checked = memory.enabled;
  roomForm.elements.namedItem("memoryInterval").value = memory.interval;
  roomForm.elements.namedItem("memoryFocus").value = memory.focus;
  roomForm.elements.namedItem("memorySummary").value = memory.summary;
  roomForm.elements.namedItem("scheduleEnabled").checked = schedule.enabled;
  roomForm.elements.namedItem("scheduleStrategy").value = schedule.strategy;
  roomForm.elements.namedItem("scheduleInterval").value = String(schedule.intervalMinutes);
  roomForm.elements.namedItem("scheduleMaxTurns").value = String(schedule.maxTurns);
  roomForm.elements.namedItem("scheduleDailyLimit").value = String(schedule.dailyLimit);
  roomForm.elements.namedItem("scheduleEventsEnabled").checked = eventCards.enabled;
  roomForm.elements.namedItem("scheduleEventsFocus").value = eventCards.focus;
  roomForm.elements.namedItem("scheduleQuietEnabled").checked = schedule.quietEnabled;
  roomForm.elements.namedItem("scheduleQuietStart").value = schedule.quietStart;
  roomForm.elements.namedItem("scheduleQuietEnd").value = schedule.quietEnd;
  populateRoomParticipants(room?.participantIds || activeRoom()?.participantIds || state.agents.map((agent) => agent.id));
  deleteRoomButton.classList.toggle("is-hidden", !room || state.rooms.length <= 1);
  byId("memory-summarize-now").disabled = !room;
  byId("memory-rebuild").disabled = !room || !room.messages.length;
  updateRoomMemoryStatus(room || { messages: [], memory });
  updateRoomScheduleStatus(room || { schedule, eventCards });
  roomDialog.showModal();
}

agentForm.addEventListener("submit", (event) => {
  event.preventDefault();
  try {
    const draft = agentFromForm();
    const index = state.agents.findIndex((agent) => agent.id === draft.id);
    if (index >= 0) state.agents[index] = draft;
    else {
      state.agents.push(draft);
      const room = activeRoom();
      if (room && !room.participantIds.includes(draft.id)) room.participantIds.push(draft.id);
    }
    renderAll();
    queuePersist();
    agentDialog.close();
    showToast(`${draft.name} 的配置已保存`);
  } catch (error) {
    showToast(error instanceof SyntaxError ? "额外请求头不是有效的 JSON" : error.message);
  }
});

byId("test-agent-button").addEventListener("click", async () => {
  let draft;
  try {
    draft = agentFromForm();
  } catch (error) {
    connectionResult.className = "connection-result is-error";
    connectionResult.textContent = error instanceof SyntaxError ? "额外请求头不是有效的 JSON" : error.message;
    return;
  }
  connectionResult.className = "connection-result";
  connectionResult.textContent = "正在发一条极短的测试消息……";
  byId("test-agent-button").disabled = true;
  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: draft,
        temperature: 0,
        maxTokens: 64,
        messages: [
          { role: "system", content: "这是接口连通测试。" },
          { role: "user", content: "请只回复：连接成功" },
        ],
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401) {
      await checkAccess();
      throw new Error("局域网访问码已失效，请重新输入");
    }
    if (!response.ok) throw new Error(payload.error || `连接失败（${response.status}）`);
    connectionResult.className = "connection-result";
    connectionResult.textContent = `接口已接通。返回：${payload.text}`;
  } catch (error) {
    connectionResult.className = "connection-result is-error";
    connectionResult.textContent = error.message;
  } finally {
    byId("test-agent-button").disabled = false;
  }
});

byId("clear-key-button").addEventListener("click", () => {
  setFormValue("clearApiKey", "true");
  setFormValue("apiKey", "");
  byId("saved-key-row").classList.add("is-hidden");
  connectionResult.className = "connection-result";
  connectionResult.textContent = "已标记清除；点击“保存嘉宾”后生效。";
});

deleteAgentButton.addEventListener("click", () => {
  const id = String(new FormData(agentForm).get("id") || "");
  const agent = state.agents.find((item) => item.id === id);
  if (!agent) return;
  if (!window.confirm(`让 ${agent.name} 永久离席？已产生的聊天记录仍会保留。`)) return;
  state.agents = state.agents.filter((item) => item.id !== id);
  for (const room of state.rooms) room.participantIds = room.participantIds.filter((item) => item !== id);
  renderAll();
  queuePersist();
  agentDialog.close();
  showToast(`${agent.name} 已离开嘉宾库`);
});

summarizerForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    state.summarizer = summarizerFromForm();
    await queuePersist();
    renderSummarizerStatus();
    summarizerDialog.close();
    showToast("记忆整理员已经就位");
  } catch (error) {
    showToast(error instanceof SyntaxError ? "额外请求头不是有效的 JSON" : error.message);
  }
});

byId("test-summarizer-button").addEventListener("click", async () => {
  let draft;
  try {
    draft = summarizerFromForm();
  } catch (error) {
    summarizerConnectionResult.className = "connection-result is-error";
    summarizerConnectionResult.textContent = error instanceof SyntaxError
      ? "额外请求头不是有效的 JSON"
      : error.message;
    return;
  }
  summarizerConnectionResult.className = "connection-result";
  summarizerConnectionResult.textContent = "正在测试整理模型……";
  byId("test-summarizer-button").disabled = true;
  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: draft,
        temperature: 0,
        maxTokens: 128,
        messages: [
          { role: "system", content: "这是长期记忆整理员接口测试。" },
          { role: "user", content: "请只回复：整理员就位" },
        ],
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401) {
      await checkAccess();
      throw new Error("局域网访问码已失效，请重新输入");
    }
    if (!response.ok) throw new Error(payload.error || `连接失败（${response.status}）`);
    summarizerConnectionResult.className = "connection-result";
    summarizerConnectionResult.textContent = `接口已接通。返回：${payload.text}`;
  } catch (error) {
    summarizerConnectionResult.className = "connection-result is-error";
    summarizerConnectionResult.textContent = error.message;
  } finally {
    byId("test-summarizer-button").disabled = false;
  }
});

byId("summarizer-clear-key").addEventListener("click", () => {
  setSummarizerFormValue("clearApiKey", "true");
  setSummarizerFormValue("apiKey", "");
  byId("summarizer-saved-key-row").classList.add("is-hidden");
  summarizerConnectionResult.className = "connection-result";
  summarizerConnectionResult.textContent = "已标记清除；点击“保存整理员”后生效。";
});

roomForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const data = new FormData(roomForm);
  const name = String(data.get("name") || "").trim();
  const roomPrompt = String(data.get("roomPrompt") || "").trim();
  const bubbleSplit = data.get("bubbleSplit") === "on";
  const memoryEnabled = data.get("memoryEnabled") === "on";
  const memoryInterval = Math.min(100, Math.max(5, Number(data.get("memoryInterval")) || 20));
  const memoryFocus = String(data.get("memoryFocus") || "").trim();
  const memorySummary = String(data.get("memorySummary") || "").trim();
  const scheduleConfig = roomScheduleConfigFromForm(data);
  const eventCardsConfig = roomEventCardsConfigFromForm(data);
  const participantIds = data.getAll("participantIds").map(String);
  if (!name) {
    showToast("先给聊天室起个名字");
    return;
  }
  if (!participantIds.length) {
    showToast("至少邀请一位 AI，空房间会有点尴尬");
    return;
  }
  const id = String(data.get("id") || "");
  const room = state.rooms.find((item) => item.id === id);
  let memoryFocusNeedsRebuild = false;
  if (room) {
    room.name = name;
    room.roomPrompt = roomPrompt;
    room.bubbleSplit = bubbleSplit;
    const previousSummary = room.memory.summary;
    const clearedSummary = previousSummary.trim() && !memorySummary;
    memoryFocusNeedsRebuild = room.memory.focus !== memoryFocus && Boolean(previousSummary.trim());
    room.memory.enabled = memoryEnabled;
    room.memory.interval = memoryInterval;
    room.memory.focus = memoryFocus;
    room.memory.summary = memorySummary;
    room.schedule = { ...room.schedule, ...scheduleConfig };
    if (
      room.eventCards.enabled !== eventCardsConfig.enabled
      || room.eventCards.focus !== eventCardsConfig.focus
    ) {
      room.eventCards.enabled = eventCardsConfig.enabled;
      room.eventCards.focus = eventCardsConfig.focus;
      room.eventCards.revision += 1;
    }
    if (clearedSummary) {
      room.memory.summarizedThroughId = "";
      room.memory.summarizedMessageCount = 0;
      room.memory.updatedAt = null;
      room.memory.stale = false;
    } else if (memorySummary !== previousSummary) {
      room.memory.updatedAt = Date.now();
    }
    room.participantIds = participantIds;
    room.updatedAt = Date.now();
  } else {
    const created = hydrateRoom({
      name,
      roomPrompt,
      bubbleSplit,
      participantIds,
      messages: [],
      memory: { enabled: memoryEnabled, interval: memoryInterval, focus: memoryFocus, summary: memorySummary },
      schedule: scheduleConfig,
      eventCards: eventCardsConfig,
    });
    state.rooms.push(created);
    state.activeRoomId = created.id;
  }
  renderAll();
  queuePersist();
  roomDialog.close();
  showToast(memoryFocusNeedsRebuild
    ? "记忆重点已保存；点“重新生成”后会应用到旧摘要"
    : `${name} 已准备好`);
});

byId("memory-summarize-now").addEventListener("click", () => {
  const room = state.rooms.find((item) => item.id === roomForm.elements.namedItem("id").value);
  void summarizeRoom(room, { manual: true });
});

byId("memory-rebuild").addEventListener("click", () => {
  const room = state.rooms.find((item) => item.id === roomForm.elements.namedItem("id").value);
  if (!room) return;
  if (!window.confirm([
    "重新生成一份全篇记忆？",
    "",
    "这会清空并覆盖当前总结；聊天原文不会删除。整理员会重新阅读全部现存聊天，按时间顺序生成一组不重复的分段记录。",
  ].join("\n"))) return;
  void summarizeRoom(room, { rebuild: true, manual: true });
});

byId("memory-cancel").addEventListener("click", () => {
  const roomId = String(roomForm.elements.namedItem("id").value || "");
  summaryRuns.get(roomId)?.controller.abort();
});

deleteRoomButton.addEventListener("click", () => {
  const id = String(new FormData(roomForm).get("id") || "");
  const room = state.rooms.find((item) => item.id === id);
  if (!room || state.rooms.length <= 1) return;
  if (summarizingRoomIds.has(room.id)) {
    showToast("先等记忆整理员收好这间房");
    return;
  }
  if (!window.confirm(`删除“${room.name}”及其中的全部聊天记录？`)) return;
  state.rooms = state.rooms.filter((item) => item.id !== id);
  if (state.activeRoomId === id) state.activeRoomId = state.rooms[0].id;
  renderAll();
  queuePersist();
  roomDialog.close();
  showToast(`${room.name} 已删除`);
});

byId("agent-format").addEventListener("change", () => {
  const format = byId("agent-format").value;
  byId("agent-auth").value = FORMAT_META[format].defaultAuth;
  syncAuthField();
  syncEndpointHelp();
});
byId("agent-auth").addEventListener("change", syncAuthField);
byId("agent-memory-enabled").addEventListener("change", () => {
  agentMemoryDraftDirty = true;
  syncAgentMemoryField();
});
byId("agent-memory").addEventListener("input", () => {
  agentMemoryDraftDirty = true;
  updateAgentMemoryStatus();
});
byId("compact-agent-memory-button").addEventListener("click", () => {
  const editor = byId("agent-memory");
  const before = editor.value.trim();
  if (!before) {
    updateAgentMemoryStatus("现在没有需要整理的私人记忆。");
    return;
  }
  const beforeCount = before.split(/\r?\n/).filter((line) => line.trim()).length;
  const after = compactAgentMemory(before, { mergeTopics: false });
  const afterCount = after ? after.split(/\r?\n/).filter((line) => line.trim()).length : 0;
  editor.value = after;
  agentMemoryDraftDirty = true;
  if (after === before) {
    updateAgentMemoryStatus("本地检查完成：暂时没有可合并的重复内容。");
  } else {
    updateAgentMemoryStatus(`本地瘦身完成：${beforeCount} → ${afterCount} 条；保存嘉宾后生效。`);
  }
});
byId("deep-compact-agent-memory-button").addEventListener("click", async () => {
  const editor = byId("agent-memory");
  const memory = editor.value.trim();
  if (!memory) {
    updateAgentMemoryStatus("现在没有需要深度整理的私人记忆。");
    return;
  }
  let draft;
  try {
    draft = agentFromForm();
  } catch (error) {
    updateAgentMemoryStatus(`暂时不能深度整理：${error instanceof SyntaxError ? "额外请求头不是有效的 JSON" : error.message}`);
    return;
  }
  if (!isConfigured(draft)) {
    showToast("先配置并保存这位嘉宾自己的 API");
    return;
  }
  const joinedRoomCount = state.rooms.filter((room) => room.participantIds.includes(draft.id)).length;
  if (!window.confirm([
    `让“${draft.name}”亲自整理自己的私人记忆？`,
    "",
    `这会产生 1 次这位嘉宾自己的 API 调用，并让它同时参考自己的人设、私人记忆${joinedRoomCount ? `、${joinedRoomCount} 个所属房间的长期记忆与近期聊天` : ""}。`,
    "结果只会替换当前编辑草稿，检查后仍需点击“保存嘉宾”才生效。",
  ].join("\n"))) return;

  const button = byId("deep-compact-agent-memory-button");
  button.disabled = true;
  updateAgentMemoryStatus(`${draft.name}正在回看自己的记忆与房间上下文……`);
  try {
    const roomContext = privateMemoryDeepContext(draft.id);
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: draft,
        temperature: 0.1,
        maxTokens: 3600,
        requestMode: "private-memory-summary",
        messages: [
          {
            role: "system",
            content: [
              `你就是群聊嘉宾“${draft.name}”。现在不是对外聊天，而是安静整理只属于你自己的私人记忆。`,
              "这些不是普通聊天摘要，而是你跨越多轮对话保持‘我是我’的个人经历。它们会影响你以后记得什么、在意什么、如何判断关系；一旦删掉，未来的你就无法再从私人记忆中取回。请把保存连续性放在缩短文本之前。",
              `【你的个人设定】\n${contextExcerpt(draft.persona, 8_000) || "没有额外个人设定；依照你自然的判断整理。"}`,
              "这是逐项校订，不是把一生压成近况摘要。整理得更短不会得到任何奖励；没有真正重复时，原样保留全部记忆就是正确答案。不要只留最近发生的事情。",
              "只整理“现有私人记忆”中已经写下的事情；房间上下文仅用于辨认同一事件、核对后来变化和避免误解，不得从上下文另行摘抄新事件充数。",
              "只有确定属于同一件事、同一阶段的重复情绪、重复等待或重复计划才能合并；拿不准是不是同一事件时必须保留。",
              "每一条旧记忆前都有临时来源编号。你必须让每个编号在最终输出中恰好出现一次，不得遗漏、重复或虚构编号。",
              "每条最终记忆最多对应两个来源编号，这只是禁止过度合并的安全上限，不是要求你尽量两两配对。两条记忆只要分别含有独立事实、人物观察、物品、行动、计划、未完成问题或情绪阶段，就必须分开保留。",
              "同一事件合并时要把较早的原因和后来的新变化写在一条里，不能只留下结局。不同日期发生的独立事件、已经结束但有独特意义的共同经历，也要保留至少一条。",
              "由你自己判断什么仍值得记住。优先保留重要误会、关系转折、未公开秘密、仍会影响后续判断的偏向或打算；只有不含独立信息的普通复读可以删除。",
              "不要评价或重写自己的人设，不要为了显得深情、聪明或有戏剧性而增加原文没有的心思。",
              "修掉重复的房间与日期标签。保留第一人称；不确定内容继续使用“我怀疑／我猜／我以为”。",
              "只输出整理后的逐条记忆，不要标题、说明或代码块。每行严格使用：- [房间 · 月/日] 第一人称内容 <!-- sources:M001,M002 -->。未合并时只写一个来源编号。",
            ].join("\n"),
          },
          {
            role: "user",
            content: [
              `【你当前的私人记忆｜需要逐项整理】\n${numberedAgentMemory(memory)}`,
              `【所属房间上下文｜只供核对，不要照抄】\n${roomContext}`,
              "现在逐项校订你的私人记忆。重视它们，不必为了显得会整理而缩短。只输出校订后的记忆条目。",
            ].join("\n\n"),
          },
        ],
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401) {
      await checkAccess();
      throw new Error("局域网访问码已失效，请重新输入");
    }
    if (!response.ok) throw new Error(payload.error || `深度整理失败（${response.status}）`);
    const beforeCount = memory.split(/\r?\n/).filter((line) => line.trim()).length;
    const reviewed = validateDeepAgentMemoryResult(memory, payload.text, { maxSourcesPerEntry: 2 });
    if (!reviewed.ok) {
      updateAgentMemoryStatus(`已拦下不合格的整理：${reviewed.error}；原来的 ${beforeCount} 条记忆一条未动。`);
      return;
    }
    editor.value = reviewed.text;
    agentMemoryDraftDirty = true;
    updateAgentMemoryStatus(`保守深度整理完成：${beforeCount} → ${reviewed.count} 条；请检查后保存嘉宾。`);
  } catch (error) {
    updateAgentMemoryStatus(`深度整理没有完成：${error.message}`);
  } finally {
    button.disabled = false;
  }
});
byId("summarizer-format").addEventListener("change", () => {
  const format = byId("summarizer-format").value;
  byId("summarizer-auth").value = FORMAT_META[format].defaultAuth;
  syncSummarizerAuthField();
  syncSummarizerEndpointHelp();
});
byId("summarizer-auth").addEventListener("change", syncSummarizerAuthField);
byId("toggle-key-button").addEventListener("click", () => {
  const keyInput = byId("agent-api-key");
  const shouldShow = keyInput.type === "password";
  keyInput.type = shouldShow ? "text" : "password";
  byId("toggle-key-button").textContent = shouldShow ? "隐藏" : "显示";
});
byId("summarizer-toggle-key").addEventListener("click", () => {
  const keyInput = byId("summarizer-api-key");
  const shouldShow = keyInput.type === "password";
  keyInput.type = shouldShow ? "text" : "password";
  byId("summarizer-toggle-key").textContent = shouldShow ? "隐藏" : "显示";
});
byId("close-dialog-button").addEventListener("click", () => agentDialog.close());
byId("close-guest-copy-dialog").addEventListener("click", () => guestCopyDialog.close());
byId("guest-copy-cancel").addEventListener("click", () => guestCopyDialog.close());
byId("close-room-dialog").addEventListener("click", () => roomDialog.close());
byId("close-summarizer-dialog").addEventListener("click", () => summarizerDialog.close());
byId("add-agent-button").addEventListener("click", () => openAgentDialog());
byId("add-room-button").addEventListener("click", () => openRoomDialog());
byId("open-summarizer-button").addEventListener("click", openSummarizerDialog);
duplicateAgentButton.addEventListener("click", () => {
  const sourceId = String(new FormData(agentForm).get("id") || "");
  openGuestCopyDialog(sourceId);
});
byId("guest-copy-room").addEventListener("change", refreshGuestCopyName);
byId("guest-copy-memory").addEventListener("change", (event) => {
  if (event.target.checked) byId("guest-copy-memory-enabled").checked = true;
});
guestCopyForm.addEventListener("submit", (event) => {
  event.preventDefault();
  try {
    const { duplicate, roomId } = createGuestCopyFromForm();
    state.agents.push(duplicate);
    const room = state.rooms.find((item) => item.id === roomId);
    if (room && !room.participantIds.includes(duplicate.id)) {
      room.participantIds.push(duplicate.id);
      room.updatedAt = Date.now();
    }
    if (room?.id === activeRoom()?.id) agentListView = "room";
    renderAll();
    queuePersist();
    guestCopyDialog.close();
    showToast(`${duplicate.name} 已成为独立嘉宾`);
  } catch (error) {
    showToast(error.message);
  }
});
byId("copy-persona-button").addEventListener("click", async () => {
  const persona = byId("agent-persona").value;
  if (!persona.trim()) {
    showToast("人设框还是空的");
    return;
  }
  if (await copyText(persona)) showToast("人设文本已复制");
  else {
    openCopyFallback(persona);
    showToast("浏览器拦住了自动复制，已为你选中人设原文");
  }
});
byId("clear-persona-button").addEventListener("click", () => {
  const persona = byId("agent-persona");
  if (!persona.value) {
    showToast("人设框已经是空的");
    return;
  }
  persona.value = "";
  persona.focus();
  showToast("已清空人设草稿，保存嘉宾后生效");
});
agentViewRoom.addEventListener("click", () => {
  agentListView = "room";
  renderAgents();
});
agentViewAll.addEventListener("click", () => {
  agentListView = "all";
  renderAgents();
});
agentRoomFilters.addEventListener("click", (event) => {
  const button = event.target.closest("[data-agent-room-filter]");
  if (!button) return;
  agentRoomFilter = button.dataset.agentRoomFilter;
  renderAgents();
});
byId("copy-fallback-select").addEventListener("click", selectCopyFallbackText);
for (const id of [
  "room-schedule-enabled",
  "room-schedule-strategy",
  "room-schedule-interval",
  "room-schedule-max-turns",
  "room-schedule-daily-limit",
  "room-schedule-events-enabled",
  "room-schedule-events-focus",
  "room-schedule-quiet-enabled",
  "room-schedule-quiet-start",
  "room-schedule-quiet-end",
]) {
  byId(id).addEventListener("input", previewRoomScheduleStatus);
  byId(id).addEventListener("change", previewRoomScheduleStatus);
}
mobileRoomCurrent.addEventListener("click", () => {
  const opening = !mobileRoomSwitcher.classList.contains("is-open");
  mobileRoomSwitcher.classList.toggle("is-open", opening);
  mobileRoomCurrent.setAttribute("aria-expanded", String(opening));
});
newMessageJump.addEventListener("click", () => scrollToLatest({ revealOnSmallScreen: true, behavior: "smooth" }));

document.querySelectorAll("[data-mode]").forEach((button) => {
  button.addEventListener("click", () => {
    state.mode = button.dataset.mode;
    renderMode();
  });
});
document.querySelectorAll("[data-free-strategy]").forEach((button) => {
  button.addEventListener("click", () => {
    state.freeStrategy = ["mic-grab", "light-mic"].includes(button.dataset.freeStrategy)
      ? button.dataset.freeStrategy
      : "round-robin";
    updateDirectorPrefs({ freeStrategy: state.freeStrategy });
    if (state.freeStrategy === "mic-grab") {
      micStatus.textContent = "抢麦结果会显示在这里；↑↓ 表示相对这位嘉宾自己的平时分数。";
    } else if (state.freeStrategy === "light-mic") {
      micStatus.textContent = "轻量抢麦只在本地抽取发言者，不显示或伪造 AI 意愿分。";
    }
    renderMode();
  });
});
roundsInput.addEventListener("input", () => {
  roundsOutput.textContent = `${roundsInput.value} 轮`;
});
temperatureInput.addEventListener("input", () => {
  temperatureOutput.textContent = Number(temperatureInput.value).toFixed(1);
});
tokensInput.addEventListener("input", () => {
  const value = Math.min(4096, Math.max(64, Number(tokensInput.value) || 300));
  updateDirectorPrefs({ visibleTokenTarget: value });
});
messageFeed.addEventListener("click", (event) => {
  if (event.target.closest(".message-actions")) return;
  const selected = event.target.closest(".message");
  const wasVisible = selected?.classList.contains("is-actions-visible");
  for (const message of messageFeed.querySelectorAll(".message.is-actions-visible")) {
    message.classList.remove("is-actions-visible");
  }
  if (selected && !wasVisible) selected.classList.add("is-actions-visible");
});
document.addEventListener("click", (event) => {
  if (!mobileRoomSwitcher.contains(event.target)) closeMobileRoomMenu();
  if (messageFeed.contains(event.target)) return;
  for (const message of messageFeed.querySelectorAll(".message.is-actions-visible")) {
    message.classList.remove("is-actions-visible");
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeMobileRoomMenu();
});
const clearNewMessageNoticeAtLatest = () => {
  if (unseenMessageCount > 0 && isViewingLatest()) {
    unseenMessageCount = 0;
    updateNewMessageJump();
  }
};
window.addEventListener("scroll", clearNewMessageNoticeAtLatest, { passive: true });
messageFeed.addEventListener("scroll", clearNewMessageNoticeAtLatest, { passive: true });
composer.addEventListener("submit", (event) => {
  event.preventDefault();
  startConversation();
});
messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    startConversation();
  }
});
stopButton.addEventListener("click", () => {
  state.abortController?.abort();
  showToast("已按下暂停，正在收尾当前请求");
});

byId("new-chat-button").addEventListener("click", () => {
  const room = activeRoom();
  if (!room?.messages.length) return;
  if (summarizingRoomIds.has(room.id)) {
    showToast("先等记忆整理员收好这间房");
    return;
  }
  if (!window.confirm(`清空“${room.name}”的全部聊天记录？`)) return;
  room.messages = [];
  room.memory.summary = "";
  room.memory.summarizedThroughId = "";
  room.memory.summarizedMessageCount = 0;
  room.memory.updatedAt = null;
  room.memory.stale = false;
  room.updatedAt = Date.now();
  renderAll();
  queuePersist();
  showToast("本房间已清空");
});

byId("export-button").addEventListener("click", () => {
  const room = activeRoom();
  if (!room?.messages.length) {
    showToast("本房间还没有可以导出的记录");
    return;
  }
  const lines = [`# ${room.name}`, "", `导出时间：${new Date().toLocaleString("zh-CN")}`, ""];
  if (room.memory.summary.trim()) {
    lines.push("## 房间长期记忆", "", room.memory.summary.trim(), "");
  }
  for (const message of room.messages) {
    lines.push(`## ${message.author} · ${new Date(message.timestamp).toLocaleString("zh-CN")}`, "", message.text, "");
  }
  const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${room.name}-${new Date().toISOString().slice(0, 10)}.md`;
  link.click();
  URL.revokeObjectURL(link.href);
});

async function checkHealth(isLan = false) {
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    if (!response.ok) throw new Error();
    setRuntimeStatus("ready", isLan ? "iPad 已入席" : "本地代理就绪");
  } catch {
    setRuntimeStatus("error", "本地代理未连接");
  }
}

async function loadServerState() {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const response = await fetch("/api/state", { cache: "no-store" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "读取观察室数据失败");
    if (Array.isArray(payload.rooms) && payload.rooms.length) {
      state.agents = Array.isArray(payload.agents) ? payload.agents.map(hydrateAgent) : [];
      state.summarizer = hydrateSummarizer(payload.summarizer);
      const shouldAddNewGuests = Number(safeRead(GUEST_CATALOG_KEY, 0)) < 2;
      if (shouldAddNewGuests) {
        for (const profile of DEFAULT_AGENTS.slice(3)) {
          if (!state.agents.some((agent) => agent.id === profile.id)) state.agents.push(blankAgent(profile));
        }
        safeWrite(GUEST_CATALOG_KEY, 2);
      }
      state.rooms = payload.rooms.map((room) => hydrateRoom(room));
      state.activeRoomId = payload.activeRoomId || state.rooms[0].id;
      if (shouldAddNewGuests) {
        const room = activeRoom();
        for (const profile of DEFAULT_AGENTS.slice(3)) {
          if (room && !room.participantIds.includes(profile.id)) room.participantIds.push(profile.id);
        }
        queuePersist();
      }
    } else {
      await queuePersist();
    }
    state.ready = true;
    renderAll({ scroll: true });
  })().catch((error) => {
    state.ready = true;
    renderAll();
    showToast(error.message);
  });
  return loadPromise;
}

async function syncBackgroundUpdates() {
  if (!state.ready || state.running) return;
  try {
    await saveChain;
    const response = await fetch("/api/state", { cache: "no-store" });
    if (!response.ok) return;
    const payload = await response.json();
    const wasViewingLatest = isViewingLatest();
    const beforeActiveCount = activeRoom()?.messages.length || 0;
    const agentMemoriesChanged = mergeServerAgentMemories(payload.agents || []);
    const addedMessages = mergeServerRoomUpdates(payload.rooms || []);
    const activeAddedMessages = Math.max(0, (activeRoom()?.messages.length || 0) - beforeActiveCount);
    renderRooms();
    if (agentMemoriesChanged) renderAgents();
    if (addedMessages) {
      if (activeAddedMessages && wasViewingLatest) renderMessages({ scroll: true });
      else if (activeAddedMessages) {
        renderMessages();
        unseenMessageCount += activeAddedMessages;
        updateNewMessageJump();
      }
      showToast(`后台定时聊天新增了 ${addedMessages} 条发言`);
    }
    if (roomDialog.open) {
      const room = state.rooms.find((item) => item.id === roomForm.elements.namedItem("id").value);
      if (room) {
        updateRoomScheduleStatus(room);
        updateRoomMemoryStatus(room);
      }
    }
  } catch {
    // Background refresh is best-effort; the next refresh or page open will retry.
  }
}

async function checkAccess() {
  try {
    const response = await fetch("/api/access", { cache: "no-store" });
    if (!response.ok) throw new Error();
    const access = await response.json();
    accessProtectionEnabled = access.protectionEnabled !== false;
    if (access.required && !access.authenticated) {
      setRuntimeStatus("error", "等待输入访问码");
      accessResult.textContent = "";
      if (!accessDialog.open) accessDialog.showModal();
      return false;
    }
    if (accessDialog.open) accessDialog.close();
    const isLanView = !["localhost", "127.0.0.1", "::1"].includes(location.hostname);
    await checkHealth(isLanView);
    await loadServerState();
    return true;
  } catch {
    setRuntimeStatus("error", "无法确认访问状态");
    return false;
  }
}

byId("settings-button").addEventListener("click", async () => {
  securityResult.textContent = "";
  byId("security-access-code").value = "";
  applyTheme(document.documentElement.dataset.theme);
  try {
    const response = await fetch("/api/access", { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "无法读取访问保护设置");
    accessProtectionEnabled = payload.protectionEnabled !== false;
    byId("security-access-enabled").checked = accessProtectionEnabled;
    securityDialog.showModal();
  } catch (error) {
    showToast(error.message);
  }
});

document.querySelectorAll("[data-theme-choice]").forEach((button) => {
  button.addEventListener("click", () => applyTheme(button.dataset.themeChoice));
});

byId("security-cancel").addEventListener("click", () => securityDialog.close());
securityForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(securityForm);
  const enabled = data.get("enabled") === "on";
  const code = String(data.get("code") || "").trim();
  securitySubmit.disabled = true;
  securityResult.textContent = "正在保存……";
  try {
    const response = await fetch("/api/access", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled, ...(code ? { code } : {}) }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "访问保护设置保存失败");
    accessProtectionEnabled = payload.protectionEnabled !== false;
    securityDialog.close();
    showToast(accessProtectionEnabled ? "局域网访问码已开启" : "局域网访问码已关闭");
    await checkAccess();
  } catch (error) {
    securityResult.textContent = error.message;
  } finally {
    securitySubmit.disabled = false;
  }
});

accessDialog.addEventListener("cancel", (event) => event.preventDefault());
accessForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const code = String(new FormData(accessForm).get("code") || "").trim();
  if (!code) return;
  accessSubmit.disabled = true;
  accessResult.textContent = "正在核对……";
  try {
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "访问码验证失败");
    accessForm.reset();
    accessResult.textContent = "";
    accessDialog.close();
    setRuntimeStatus("ready", "iPad 已入席");
    await loadServerState();
    showToast("暗号正确，欢迎回到导演席");
  } catch (error) {
    accessResult.textContent = error.message;
  } finally {
    accessSubmit.disabled = false;
  }
});

const directorPrefs = safeRead(DIRECTOR_PREFS_KEY, {});
state.freeStrategy = ["mic-grab", "light-mic"].includes(directorPrefs.freeStrategy)
  ? directorPrefs.freeStrategy
  : "round-robin";
tokensInput.value = String(
  Math.min(4096, Math.max(64, Number(directorPrefs.visibleTokenTarget) || 300)),
);
renderAll();
checkAccess();
setInterval(() => void syncBackgroundUpdates(), 15_000);
setInterval(() => {
  if (!roomDialog.open) return;
  const room = state.rooms.find((item) => item.id === roomForm.elements.namedItem("id").value);
  if (room && summarizingRoomIds.has(room.id)) updateRoomMemoryStatus(room);
}, 1000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void syncBackgroundUpdates();
});
