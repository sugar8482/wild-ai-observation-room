import { DEFAULT_MIC_OPTIONS, parseWillingnessScore, pickMicWinner } from "./mic-grab.js";

const LEGACY_PROFILE_KEY = "wild-ai-observation-room.profiles.v1";
const LEGACY_MESSAGE_KEY = "wild-ai-observation-room.messages.v1";
const GUEST_CATALOG_KEY = "wild-ai-observation-room.guest-catalog.v2";
const DIRECTOR_PREFS_KEY = "wild-ai-observation-room.director-prefs.v1";
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
const roomList = byId("room-list");
const messageFeed = byId("message-feed");
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
const roomDialog = byId("room-dialog");
const roomForm = byId("room-form");
const roomParticipantList = byId("room-participant-list");
const deleteRoomButton = byId("delete-room-button");
const toastElement = byId("toast");
const accessDialog = byId("access-dialog");
const accessForm = byId("access-form");
const accessResult = byId("access-result");
const accessSubmit = byId("access-submit");
const summarizerDialog = byId("summarizer-dialog");
const summarizerForm = byId("summarizer-form");
const summarizerConnectionResult = byId("summarizer-connection-result");
const roomMemoryStatus = byId("room-memory-status");

let toastTimer;
let saveChain = Promise.resolve();
let loadPromise = null;
const summarizingRoomIds = new Set();

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
    apiKey: String(profile?.apiKey || ""),
    extraHeaders: String(profile?.extraHeaders || ""),
    hasApiKey: Boolean(profile?.hasApiKey || profile?.apiKey),
    hasExtraHeaders: Boolean(profile?.hasExtraHeaders || profile?.extraHeaders),
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

function hydrateRoom(room, fallbackParticipants = []) {
  return {
    id: room?.id || newId("room"),
    name: String(room?.name || "未命名观察间"),
    roomPrompt: String(room?.roomPrompt || ""),
    memory: hydrateRoomMemory(room?.memory),
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
      apiKey: agent.apiKey,
      extraHeaders: agent.extraHeaders,
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

function applySavedCredentialFlags(serverAgents, serverSummarizer) {
  const flags = new Map(serverAgents.map((agent) => [agent.id, agent]));
  for (const agent of state.agents) {
    const saved = flags.get(agent.id);
    if (!saved) continue;
    agent.hasApiKey = saved.hasApiKey;
    agent.hasExtraHeaders = saved.hasExtraHeaders;
    agent.apiKey = "";
    agent.extraHeaders = "";
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
    renderAgents();
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
        `${room.participantIds.length} 位嘉宾 · ${room.messages.length} 条记录${room.roomPrompt.trim() ? " · 有氛围" : ""}${room.memory.summary.trim() ? " · 有记忆" : ""}`,
      ),
    );
    main.addEventListener("click", () => switchRoom(room.id));
    const edit = createElement("button", "room-edit", "设置");
    edit.type = "button";
    edit.addEventListener("click", () => openRoomDialog(room.id));
    card.append(main, edit);
    roomList.append(card);
  }
}

function renderSummarizerStatus() {
  const status = byId("summarizer-status");
  if (isConfigured(state.summarizer)) {
    status.textContent = `已配置：${state.summarizer.model}。各房间共用，记忆彼此独立。`;
  } else {
    status.textContent = "尚未配置记忆整理员；聊天不受影响，只是不会自动生成长期总结。";
  }
}

function renderAgents() {
  agentList.replaceChildren();
  const room = activeRoom();
  for (const agent of state.agents) {
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
    const personaLabel = createElement("span", "", agent.persona.trim() ? "已有人设" : "原厂味");
    const toggleLabel = createElement("label", "switch");
    toggleLabel.setAttribute("aria-label", `${participating ? "移出" : "邀请"}${agent.name}`);
    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = participating;
    toggle.addEventListener("change", () => toggleRoomParticipant(agent.id, toggle.checked));
    toggleLabel.append(toggle, createElement("span", "switch-track"));
    bottom.append(readiness, personaLabel, toggleLabel);
    card.append(top, bottom);
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
    const body = createElement("div", "message-body");
    body.append(createElement("span", "message-text", message.text));
    const actions = createElement("div", "message-actions");
    if (message.kind !== "error") {
      const copyButton = createElement("button", "copy-message", "复制");
      copyButton.type = "button";
      copyButton.setAttribute("aria-label", `复制 ${message.author} 的这条消息`);
      copyButton.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(message.text);
          showToast("已复制");
        } catch {
          showToast("复制失败，请手动选择文字");
        }
      });
      actions.append(copyButton);
    }
    const deleteButton = createElement("button", "delete-message", "删除");
    deleteButton.type = "button";
    deleteButton.setAttribute("aria-label", `删除 ${message.author} 的这条消息`);
    deleteButton.addEventListener("click", () => deleteMessage(message.id));
    actions.append(deleteButton);
    body.append(actions);
    article.append(meta, body);
    messageFeed.append(article);
  }
  if (scroll) requestAnimationFrame(() => messageFeed.scrollTo({ top: messageFeed.scrollHeight }));
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
  roomModeLabel.textContent = isMicGrab ? "自由聊 · 抢麦" : meta.label;
  sendButton.textContent = meta.action;
  modeHelp.textContent = isMicGrab
    ? "每轮先让所有嘉宾暗中报一个接话意愿分，再由最想说的一位发言。"
    : meta.help;
  speakerControl.classList.toggle("is-hidden", state.mode !== "point");
  freeStrategyControl.classList.toggle("is-hidden", !isFree);
  roundsControl.classList.toggle("is-hidden", !isFree);
  micStatus.classList.toggle("is-hidden", !isMicGrab);
  freeStrategyHelp.textContent = isMicGrab
    ? "每轮会增加一次所有嘉宾的短评分调用；切回轮流接话就没有额外费用。"
    : "按嘉宾席顺序轮流发言，不会增加额外调用。";
  roundsLabel.textContent = isMicGrab ? "抢麦轮数" : "讨论轮数";
  roundsHelp.textContent = isMicGrab
    ? "一轮只产生一位赢家的正式发言；连续两轮全员弃权会自然收场。"
    : "一轮 = 每位启用的嘉宾发言一次。设了上限，不会无限烧额度。";
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
  room.messages.push({
    id: newId("message"),
    kind,
    author,
    text: String(text).trim(),
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
  renderAll();
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
    "直接输出你在群聊里要说的话，不加姓名前缀，不复述规则。使用群聊主要语言，自然交流。",
  ].join("\n\n");
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
  ].join("\n\n");
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
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      agent,
      temperature: Number(temperatureInput.value),
      maxTokens: visibleTokenTarget,
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

function micSnapshotText(scores, winner = null, roundNumber = 1) {
  const parts = scores.map((entry) => {
    if (entry.score === null) return `${entry.name} 未接通`;
    if (entry.score < DEFAULT_MIC_OPTIONS.threshold) return `${entry.name} ${entry.score}（弃权）`;
    return `${entry.name} ${entry.score}`;
  });
  if (winner) return `第 ${roundNumber} 轮｜${parts.join(" · ")} → ${winner.name} 抢到`;
  return `第 ${roundNumber} 轮｜${parts.join(" · ")} → 没人接话`;
}

async function deliverAgentTurn(speaker, activeAgents, room, controller) {
  if (controller.signal.aborted) return false;
  setRunning(true, speaker.name);
  try {
    const reply = await callAgent(speaker, activeAgents, room, controller.signal);
    addMessage({ kind: "agent", author: speaker.name, text: reply.text, agentId: speaker.id });
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

async function runMicGrabConversation(activeAgents, room, controller, rounds) {
  const missedTurns = {};
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

    const winner = pickMicWinner(scores, {
      ...DEFAULT_MIC_OPTIONS,
      missedTurns,
      lastSpeakerId,
    });
    if (!winner) {
      consecutivePasses += 1;
      micStatus.textContent = micSnapshotText(scores, null, round);
      if (consecutivePasses >= 2) {
        showToast("连续两轮没人想接话，这次自由聊自然收场啦");
        break;
      }
      continue;
    }

    consecutivePasses = 0;
    for (const entry of scores) {
      if (entry.score === null || entry.score < DEFAULT_MIC_OPTIONS.threshold) continue;
      missedTurns[entry.id] = entry.id === winner.id ? 0 : (missedTurns[entry.id] || 0) + 1;
    }
    const speaker = activeAgents.find((agent) => agent.id === winner.id);
    micStatus.textContent = micSnapshotText(scores, speaker, round);
    if (!speaker) break;
    await deliverAgentTurn(speaker, activeAgents, room, controller);
    lastSpeakerId = speaker.id;
  }
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
  const isSavedRoom = Boolean(room.id && state.rooms.some((item) => item.id === room.id));
  const pending = room.memory.stale ? 0 : pendingMemoryMessages(room).length;
  roomMemoryStatus.classList.toggle("is-stale", room.memory.stale);
  if (busy) {
    roomMemoryStatus.textContent = "记忆整理员正在安静地翻旧记录……";
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
  byId("memory-summarize-now").disabled = busy || !isSavedRoom;
  byId("memory-rebuild").disabled = busy || !isSavedRoom || !room.messages.length;
}

async function requestSummaryChunk(room, previousSummary, messages) {
  const transcript = messages.map((message) => `${message.author}：${message.text}`).join("\n\n");
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      agent: state.summarizer,
      temperature: 0.2,
      maxTokens: 4096,
      messages: [
        {
          role: "system",
          content: [
            "你是群聊的长期记录员，不是人物评委或角色编剧。你的工作是更新一份简洁、可靠、可继续滚动维护的中文记录，让后续对话能接住已发生的内容，但不把一次行为固化成成员人格。",
            "只保留：1. 用户明确设定的房间规则、已做出的决定和重要事实；2. 具体事件与观点，用“X 在某话题中提出……”“X 回应或反驳了 Y 的某个观点”这类客观措辞；3. 尚未回应的问题和可继续的话题；4. 在本批新增聊天中再次出现、仍在被使用的共同梗或引用。",
            "成员明确建立的关系状态、彼此使用的称呼、做出的承诺、共同经历，以及亲口表达且仍影响后续的感受，属于可记录的关系事实，不是人物标签。只按原文含义记录，不得延伸推断。",
            "绝对不要写成员档案、人格画像或能力排名；不要写“X 是……的人”“X 喜欢、擅长、不擅长、总是、习惯……”这类标签；不要把互评中的人物判断当作事实延续；不要根据单次行为预测成员以后会怎样表达。",
            "旧总结只是待修订的草稿，不是权威事实。如果其中有人物标签、互评判词、未在本批新增聊天中继续出现的旧梗，在新总结中删除。",
            "区分事实、玩笑、成员当时的观点和不确定猜测；不要脑补任何人的感情、动机或固定性格。合并重复内容，删除已经失效的细节。",
            "可以使用“重要事实与决定”“已发生的讨论”“仍活跃的梗”“待继续”等标题，但不得列“成员档案”或“性格”标题。目标约 600 至 1000 个中文字，信息较少时不要凑字数。",
            room.memory.focus.trim()
              ? `【本房间的额外记忆重点】\n${room.memory.focus.trim()}\n这些要求只决定优先保留什么，不得覆盖上述“不编造、不把推断当事实”的原则。`
              : "",
            "只输出更新后的长期总结正文，不解释过程，不提及你是整理员。",
          ].filter(Boolean).join("\n"),
        },
        {
          role: "user",
          content: `房间名称：${room.name}\n\n现有长期总结：\n${previousSummary.trim() || "（暂无，这是第一次整理）"}\n\n本批新增聊天原文：\n${transcript}`,
        },
      ],
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401) {
    await checkAccess();
    throw new Error("局域网访问码已失效，请重新输入");
  }
  if (!response.ok) throw new Error(payload.error || `总结请求失败（${response.status}）`);
  if (!payload.text?.trim()) throw new Error("总结模型没有返回文字");
  return payload.text.trim();
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
  const source = pendingMemoryMessages(room, { rebuild });
  if (!source.length) {
    if (manual) showToast("暂时没有新的聊天需要整理");
    return false;
  }
  if (!manual && source.length < room.memory.interval) return false;

  summarizingRoomIds.add(room.id);
  updateRoomMemoryStatus(room);
  renderRooms();
  try {
    let summary = rebuild ? "" : room.memory.summary;
    for (let index = 0; index < source.length; index += 40) {
      summary = await requestSummaryChunk(room, summary, source.slice(index, index + 40));
    }
    if (!state.rooms.some((item) => item.id === room.id)) return false;
    const allMessages = memoryMessages(room);
    const lastId = source.at(-1).id;
    room.memory.summary = summary;
    room.memory.summarizedThroughId = lastId;
    room.memory.summarizedMessageCount = allMessages.findIndex((message) => message.id === lastId) + 1;
    room.memory.updatedAt = Date.now();
    room.memory.stale = false;
    room.updatedAt = Date.now();
    if (roomDialog.open && roomForm.elements.namedItem("id").value === room.id) {
      roomForm.elements.namedItem("memorySummary").value = summary;
    }
    renderRooms();
    await queuePersist();
    showToast(manual ? "房间长期记忆已更新" : "记忆整理员悄悄收好了旧聊天");
    return true;
  } catch (error) {
    showToast(`长期记忆没有整理成功：${error.message}`);
    return false;
  } finally {
    summarizingRoomIds.delete(room.id);
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
  for (const key of ["id", "name", "format", "baseUrl", "model", "authType", "customHeader", "persona"]) {
    setFormValue(key, draft[key]);
  }
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
  syncAuthField();
  syncEndpointHelp();
  agentDialog.showModal();
}

function agentFromForm() {
  const data = new FormData(agentForm);
  const format = String(data.get("format") || "openai");
  const existing = state.agents.find((agent) => agent.id === data.get("id"));
  const apiKey = String(data.get("apiKey") || "").trim();
  const extraHeaders = String(data.get("extraHeaders") || "").trim();
  const clearApiKey = String(data.get("clearApiKey")) === "true";
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
  byId("room-dialog-title").textContent = room ? `设置 ${room.name}` : "新建聊天室";
  roomForm.elements.namedItem("id").value = room?.id || "";
  roomForm.elements.namedItem("name").value = room?.name || "";
  roomForm.elements.namedItem("roomPrompt").value = room?.roomPrompt || "";
  roomForm.elements.namedItem("memoryEnabled").checked = memory.enabled;
  roomForm.elements.namedItem("memoryInterval").value = memory.interval;
  roomForm.elements.namedItem("memoryFocus").value = memory.focus;
  roomForm.elements.namedItem("memorySummary").value = memory.summary;
  populateRoomParticipants(room?.participantIds || activeRoom()?.participantIds || state.agents.map((agent) => agent.id));
  deleteRoomButton.classList.toggle("is-hidden", !room || state.rooms.length <= 1);
  byId("memory-summarize-now").disabled = !room;
  byId("memory-rebuild").disabled = !room || !room.messages.length;
  updateRoomMemoryStatus(room || { messages: [], memory });
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
  const memoryEnabled = data.get("memoryEnabled") === "on";
  const memoryInterval = Math.min(100, Math.max(5, Number(data.get("memoryInterval")) || 20));
  const memoryFocus = String(data.get("memoryFocus") || "").trim();
  const memorySummary = String(data.get("memorySummary") || "").trim();
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
    const previousSummary = room.memory.summary;
    const clearedSummary = previousSummary.trim() && !memorySummary;
    memoryFocusNeedsRebuild = room.memory.focus !== memoryFocus && Boolean(previousSummary.trim());
    room.memory.enabled = memoryEnabled;
    room.memory.interval = memoryInterval;
    room.memory.focus = memoryFocus;
    room.memory.summary = memorySummary;
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
      participantIds,
      messages: [],
      memory: { enabled: memoryEnabled, interval: memoryInterval, focus: memoryFocus, summary: memorySummary },
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
  if (!window.confirm("用本房间现有的全部聊天重新生成长期记忆？聊天原文会完整保留，只替换当前总结。")) return;
  void summarizeRoom(room, { rebuild: true, manual: true });
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
byId("close-room-dialog").addEventListener("click", () => roomDialog.close());
byId("close-summarizer-dialog").addEventListener("click", () => summarizerDialog.close());
byId("add-agent-button").addEventListener("click", () => openAgentDialog());
byId("add-room-button").addEventListener("click", () => openRoomDialog());
byId("open-summarizer-button").addEventListener("click", openSummarizerDialog);

document.querySelectorAll("[data-mode]").forEach((button) => {
  button.addEventListener("click", () => {
    state.mode = button.dataset.mode;
    renderMode();
  });
});
document.querySelectorAll("[data-free-strategy]").forEach((button) => {
  button.addEventListener("click", () => {
    state.freeStrategy = button.dataset.freeStrategy === "mic-grab" ? "mic-grab" : "round-robin";
    updateDirectorPrefs({ freeStrategy: state.freeStrategy });
    if (state.freeStrategy === "mic-grab") {
      micStatus.textContent = "抢麦结果会显示在这里，不会写进聊天记录。";
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
  if (messageFeed.contains(event.target)) return;
  for (const message of messageFeed.querySelectorAll(".message.is-actions-visible")) {
    message.classList.remove("is-actions-visible");
  }
});
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
    renderAll();
  })().catch((error) => {
    state.ready = true;
    renderAll();
    showToast(error.message);
  });
  return loadPromise;
}

async function checkAccess() {
  try {
    const response = await fetch("/api/access", { cache: "no-store" });
    if (!response.ok) throw new Error();
    const access = await response.json();
    if (access.required && !access.authenticated) {
      setRuntimeStatus("error", "等待输入访问码");
      accessResult.textContent = "";
      if (!accessDialog.open) accessDialog.showModal();
      return false;
    }
    if (accessDialog.open) accessDialog.close();
    await checkHealth(access.required);
    await loadServerState();
    return true;
  } catch {
    setRuntimeStatus("error", "无法确认访问状态");
    return false;
  }
}

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
state.freeStrategy = directorPrefs.freeStrategy === "mic-grab" ? "mic-grab" : "round-robin";
tokensInput.value = String(
  Math.min(4096, Math.max(64, Number(directorPrefs.visibleTokenTarget) || 300)),
);
renderAll();
checkAccess();
