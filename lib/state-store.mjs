import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { appendAgentMemory } from "../public/agent-memory.js";

const FORMATS = new Set(["openai", "anthropic", "gemini"]);
const AUTH_TYPES = new Set(["bearer", "x-api-key", "x-goog-api-key", "custom", "none"]);

function text(value, maxLength) {
  return String(value ?? "").slice(0, maxLength);
}

function cleanId(value) {
  const id = text(value, 120);
  return /^[a-zA-Z0-9_-]+$/.test(id) ? id : "";
}

function agentMemoryFields(agent) {
  return {
    memoryEnabled: agent?.memoryEnabled === true,
    memory: text(agent?.memory, 20_000),
    memoryRevision: boundedInteger(agent?.memoryRevision, 0, 0, Number.MAX_SAFE_INTEGER),
  };
}

function encryptionKey(secret) {
  const raw = String(secret || "").trim();
  if (/^[a-f0-9]{64}$/i.test(raw)) return Buffer.from(raw, "hex");
  return createHash("sha256").update(raw || "local-observation-room").digest();
}

function encrypt(value, key) {
  if (!String(value || "")) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: encrypted.toString("base64"),
  };
}

function decrypt(payload, key) {
  if (!payload?.iv || !payload?.tag || !payload?.data) return "";
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64"));
    decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(payload.data, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return "";
  }
}

function emptyState() {
  return { version: 3, agents: [], summarizer: null, rooms: [], activeRoomId: "" };
}

function boundedInteger(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
}

function clockTime(value, fallback) {
  const normalized = text(value, 5);
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(normalized) ? normalized : fallback;
}

function sanitizeRoomSchedule(schedule) {
  const intervalMinutes = Number(schedule?.intervalMinutes) === 30 ? 30 : 60;
  return {
    enabled: schedule?.enabled === true,
    strategy: schedule?.strategy === "light-mic" ? "light-mic" : "mic-grab",
    intervalMinutes,
    maxTurns: boundedInteger(schedule?.maxTurns, 3, 1, 6),
    dailyLimit: boundedInteger(schedule?.dailyLimit, 8, 1, 48),
    quietEnabled: schedule?.quietEnabled === true,
    quietStart: clockTime(schedule?.quietStart, "23:00"),
    quietEnd: clockTime(schedule?.quietEnd, "08:00"),
    nextWakeAt: Number.isFinite(Number(schedule?.nextWakeAt)) ? Number(schedule.nextWakeAt) : null,
    lastWakeAt: Number.isFinite(Number(schedule?.lastWakeAt)) ? Number(schedule.lastWakeAt) : null,
    lastResult: text(schedule?.lastResult, 500),
    dayKey: /^\d{4}-\d{2}-\d{2}$/.test(String(schedule?.dayKey || "")) ? String(schedule.dayKey) : "",
    dailyCount: boundedInteger(schedule?.dailyCount, 0, 0, 48),
    revision: boundedInteger(schedule?.revision, 0, 0, Number.MAX_SAFE_INTEGER),
  };
}

function sanitizeRoomEventCards(eventCards) {
  const recentIds = Array.isArray(eventCards?.recentIds)
    ? [...new Set(eventCards.recentIds.map((id) => text(id, 80)).filter(Boolean))].slice(-4)
    : [];
  return {
    enabled: eventCards?.enabled === true,
    recentIds,
    lastEvent: text(eventCards?.lastEvent, 500),
    revision: boundedInteger(eventCards?.revision, 0, 0, Number.MAX_SAFE_INTEGER),
  };
}

function sanitizeRoomMic(mic) {
  const scoreHistory = {};
  for (const [rawId, rawHistory] of Object.entries(mic?.scoreHistory || {}).slice(0, 20)) {
    const id = cleanId(rawId);
    if (!id || !Array.isArray(rawHistory)) continue;
    scoreHistory[id] = rawHistory
      .map(Number)
      .filter((score) => Number.isFinite(score) && score >= 0 && score <= 10)
      .slice(-20);
  }
  return {
    scoreHistory,
    revision: boundedInteger(mic?.revision, 0, 0, Number.MAX_SAFE_INTEGER),
  };
}

function scheduleConfig(schedule) {
  return {
    enabled: schedule.enabled,
    strategy: schedule.strategy,
    intervalMinutes: schedule.intervalMinutes,
    maxTurns: schedule.maxTurns,
    dailyLimit: schedule.dailyLimit,
    quietEnabled: schedule.quietEnabled,
    quietStart: schedule.quietStart,
    quietEnd: schedule.quietEnd,
  };
}

function sameScheduleConfig(left, right) {
  return JSON.stringify(scheduleConfig(left)) === JSON.stringify(scheduleConfig(right));
}

function sanitizeRoomMemory(memory) {
  return {
    enabled: memory?.enabled !== false,
    interval: boundedInteger(memory?.interval, 20, 5, 100),
    recentMessages: boundedInteger(memory?.recentMessages, 30, 10, 80),
    focus: text(memory?.focus, 20_000),
    summary: text(memory?.summary, 50_000),
    summarizedThroughId: cleanId(memory?.summarizedThroughId),
    summarizedMessageCount: boundedInteger(memory?.summarizedMessageCount, 0, 0, 500),
    updatedAt: Number.isFinite(Number(memory?.updatedAt)) ? Number(memory.updatedAt) : null,
    stale: memory?.stale === true,
  };
}

function sanitizeMessage(message) {
  const kind = new Set(["user", "agent", "error"]).has(message?.kind) ? message.kind : "agent";
  let remaining = 50_000;
  const segments = (Array.isArray(message?.segments) ? message.segments : [])
    .slice(0, 3)
    .map((segment) => {
      const cleaned = text(segment, remaining).trim();
      remaining -= cleaned.length;
      return cleaned;
    })
    .filter(Boolean);
  const savedSegments = segments.length > 1 ? segments : [];
  return {
    id: cleanId(message?.id) || `message-${randomBytes(8).toString("hex")}`,
    kind,
    author: text(message?.author, 80) || "未知嘉宾",
    text: savedSegments.length ? savedSegments.join("\n") : text(message?.text, 50_000),
    segments: savedSegments,
    agentId: cleanId(message?.agentId) || null,
    source: message?.source === "scheduled" ? "scheduled" : null,
    timestamp: Number.isFinite(Number(message?.timestamp)) ? Number(message.timestamp) : Date.now(),
  };
}

function sanitizeRoom(room, validAgentIds) {
  const participants = Array.isArray(room?.participantIds)
    ? [...new Set(room.participantIds.map(cleanId).filter((id) => validAgentIds.has(id)))].slice(0, 20)
    : [];
  return {
    id: cleanId(room?.id) || `room-${randomBytes(8).toString("hex")}`,
    name: text(room?.name, 60).trim() || "未命名观察间",
    roomPrompt: text(room?.roomPrompt, 20_000),
    bubbleSplit: room?.bubbleSplit === true,
    memory: sanitizeRoomMemory(room?.memory),
    schedule: sanitizeRoomSchedule(room?.schedule),
    eventCards: sanitizeRoomEventCards(room?.eventCards),
    mic: sanitizeRoomMic(room?.mic),
    participantIds: participants,
    messages: Array.isArray(room?.messages) ? room.messages.slice(-500).map(sanitizeMessage) : [],
    createdAt: Number.isFinite(Number(room?.createdAt)) ? Number(room.createdAt) : Date.now(),
    updatedAt: Number.isFinite(Number(room?.updatedAt)) ? Number(room.updatedAt) : Date.now(),
  };
}

function mergeRoomForSave(incomingRoom, currentRoom, validAgentIds, now = Date.now()) {
  const next = sanitizeRoom(incomingRoom, validAgentIds);
  if (!currentRoom) {
    if (next.schedule.enabled && !next.schedule.nextWakeAt) {
      next.schedule.nextWakeAt = now + next.schedule.intervalMinutes * 60_000;
      next.schedule.lastResult = "定时已开启，等待第一次唤醒";
      next.schedule.revision += 1;
    }
    return next;
  }

  const currentSchedule = sanitizeRoomSchedule(currentRoom.schedule);
  const incomingHasSchedule = incomingRoom?.schedule && typeof incomingRoom.schedule === "object";
  const incomingSchedule = incomingHasSchedule ? sanitizeRoomSchedule(incomingRoom.schedule) : currentSchedule;
  const configChanged = incomingHasSchedule && !sameScheduleConfig(incomingSchedule, currentSchedule);
  next.schedule = {
    ...currentSchedule,
    ...scheduleConfig(incomingSchedule),
  };
  if (configChanged) {
    next.schedule.nextWakeAt = incomingSchedule.enabled
      ? now + incomingSchedule.intervalMinutes * 60_000
      : null;
    next.schedule.lastResult = incomingSchedule.enabled
      ? "定时已开启，等待下一次唤醒"
      : "定时已关闭";
    next.schedule.revision = currentSchedule.revision + 1;
  }

  if (incomingSchedule.revision < currentSchedule.revision) {
    const incomingIds = new Set(next.messages.map((message) => message.id));
    const seenScheduledThrough = Number(incomingSchedule.lastWakeAt) || 0;
    const missingScheduled = (currentRoom.messages || [])
      .map(sanitizeMessage)
      .filter((message) => (
        message.source === "scheduled"
        && message.timestamp > seenScheduledThrough
        && !incomingIds.has(message.id)
      ));
    next.messages = [...next.messages, ...missingScheduled]
      .sort((left, right) => left.timestamp - right.timestamp)
      .slice(-500);
  }
  const currentMic = sanitizeRoomMic(currentRoom.mic);
  const incomingMic = sanitizeRoomMic(incomingRoom?.mic);
  next.mic = incomingMic.revision >= currentMic.revision ? incomingMic : currentMic;
  const currentEventCards = sanitizeRoomEventCards(currentRoom.eventCards);
  const incomingEventCards = sanitizeRoomEventCards(incomingRoom?.eventCards);
  next.eventCards = incomingEventCards.revision >= currentEventCards.revision
    ? incomingEventCards
    : currentEventCards;
  next.updatedAt = Math.max(Number(currentRoom.updatedAt) || 0, Number(next.updatedAt) || 0);
  return next;
}

function clientAgent(agent) {
  const { apiKeyCipher: _key, extraHeadersCipher: _headers, ...profile } = agent;
  return {
    ...profile,
    ...agentMemoryFields(agent),
    apiKey: "",
    extraHeaders: "",
    hasApiKey: Boolean(agent.apiKeyCipher),
    hasExtraHeaders: Boolean(agent.extraHeadersCipher),
  };
}

function clientSummarizer(summarizer) {
  if (!summarizer) {
    return {
      id: "memory-summarizer",
      format: "openai",
      baseUrl: "",
      model: "",
      authType: "bearer",
      customHeader: "",
      apiKey: "",
      extraHeaders: "",
      hasApiKey: false,
      hasExtraHeaders: false,
    };
  }
  const { apiKeyCipher: _key, extraHeadersCipher: _headers, ...profile } = summarizer;
  return {
    ...profile,
    id: "memory-summarizer",
    apiKey: "",
    extraHeaders: "",
    hasApiKey: Boolean(summarizer.apiKeyCipher),
    hasExtraHeaders: Boolean(summarizer.extraHeadersCipher),
  };
}

export function createStateStore({ filePath, secret }) {
  const key = encryptionKey(secret);
  let state = null;
  let writeQueue = Promise.resolve();

  async function load() {
    if (state) return state;
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8"));
      state = parsed && typeof parsed === "object" ? parsed : emptyState();
    } catch {
      state = emptyState();
    }
    state.agents = Array.isArray(state.agents) ? state.agents : [];
    state.summarizer = state.summarizer && typeof state.summarizer === "object" ? state.summarizer : null;
    state.rooms = Array.isArray(state.rooms) ? state.rooms : [];
    return state;
  }

  async function writeState() {
    const snapshot = JSON.stringify(state, null, 2);
    const temporary = `${filePath}.tmp`;
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(temporary, snapshot, "utf8");
    await rename(temporary, filePath);
  }

  async function clientState() {
    const current = await load();
    return {
      version: 3,
      agents: current.agents.map(clientAgent),
      summarizer: clientSummarizer(current.summarizer),
      rooms: current.rooms.map((room) => ({
        ...room,
        roomPrompt: String(room.roomPrompt || ""),
        memory: sanitizeRoomMemory(room.memory),
        schedule: sanitizeRoomSchedule(room.schedule),
        mic: sanitizeRoomMic(room.mic),
      })),
      activeRoomId: current.activeRoomId || current.rooms[0]?.id || "",
    };
  }

  async function save(incoming) {
    const task = async () => {
      const current = await load();
      const existingAgents = new Map(current.agents.map((agent) => [agent.id, agent]));
      const incomingAgents = Array.isArray(incoming?.agents) ? incoming.agents.slice(0, 20) : [];
      const nextAgents = [];

      for (const agent of incomingAgents) {
        const id = cleanId(agent?.id);
        if (!id) continue;
        const existing = existingAgents.get(id);
        const credentialSource = existingAgents.get(cleanId(agent?.credentialSourceId));
        const format = FORMATS.has(agent?.format) ? agent.format : "openai";
        const authType = AUTH_TYPES.has(agent?.authType) ? agent.authType : "bearer";
        let apiKeyCipher = existing?.apiKeyCipher || credentialSource?.apiKeyCipher || null;
        let extraHeadersCipher = existing?.extraHeadersCipher || credentialSource?.extraHeadersCipher || null;
        if (agent?.clearApiKey === true) apiKeyCipher = null;
        else if (String(agent?.apiKey || "").trim()) apiKeyCipher = encrypt(text(agent.apiKey, 10_000), key);
        if (agent?.clearExtraHeaders === true) extraHeadersCipher = null;
        else if (String(agent?.extraHeaders || "").trim()) {
          extraHeadersCipher = encrypt(text(agent.extraHeaders, 20_000), key);
        }

        const existingMemory = agentMemoryFields(existing);
        const incomingHasMemory = Object.hasOwn(agent || {}, "memoryEnabled")
          || Object.hasOwn(agent || {}, "memory")
          || Object.hasOwn(agent || {}, "memoryRevision");
        const incomingMemory = agentMemoryFields(agent);
        const memoryFields = !existing
          ? incomingMemory
          : incomingHasMemory && incomingMemory.memoryRevision > existingMemory.memoryRevision
            ? incomingMemory
            : existingMemory;

        nextAgents.push({
          id,
          name: text(agent?.name, 80).trim() || "未命名嘉宾",
          format,
          baseUrl: text(agent?.baseUrl, 2_048).trim(),
          model: text(agent?.model, 300).trim(),
          authType,
          customHeader: text(agent?.customHeader, 200).trim(),
          persona: text(agent?.persona, 20_000),
          ...memoryFields,
          apiKeyCipher,
          extraHeadersCipher,
        });
      }

      const validAgentIds = new Set(nextAgents.map((agent) => agent.id));
      const incomingSummarizer = incoming?.summarizer;
      const existingSummarizer = current.summarizer;
      let summarizer = existingSummarizer;
      if (incomingSummarizer && typeof incomingSummarizer === "object") {
        const format = FORMATS.has(incomingSummarizer.format) ? incomingSummarizer.format : "openai";
        const authType = AUTH_TYPES.has(incomingSummarizer.authType)
          ? incomingSummarizer.authType
          : "bearer";
        let apiKeyCipher = existingSummarizer?.apiKeyCipher || null;
        let extraHeadersCipher = existingSummarizer?.extraHeadersCipher || null;
        if (incomingSummarizer.clearApiKey === true) apiKeyCipher = null;
        else if (String(incomingSummarizer.apiKey || "").trim()) {
          apiKeyCipher = encrypt(text(incomingSummarizer.apiKey, 10_000), key);
        }
        if (incomingSummarizer.clearExtraHeaders === true) extraHeadersCipher = null;
        else if (String(incomingSummarizer.extraHeaders || "").trim()) {
          extraHeadersCipher = encrypt(text(incomingSummarizer.extraHeaders, 20_000), key);
        }
        summarizer = {
          id: "memory-summarizer",
          format,
          baseUrl: text(incomingSummarizer.baseUrl, 2_048).trim(),
          model: text(incomingSummarizer.model, 300).trim(),
          authType,
          customHeader: text(incomingSummarizer.customHeader, 200).trim(),
          apiKeyCipher,
          extraHeadersCipher,
        };
      }
      const existingRooms = new Map(current.rooms.map((room) => [room.id, room]));
      const rooms = Array.isArray(incoming?.rooms)
        ? incoming.rooms
          .slice(0, 50)
          .map((room) => mergeRoomForSave(room, existingRooms.get(cleanId(room?.id)), validAgentIds))
        : [];
      const activeRoomId = cleanId(incoming?.activeRoomId);
      state = {
        version: 3,
        agents: nextAgents,
        summarizer,
        rooms,
        activeRoomId: rooms.some((room) => room.id === activeRoomId) ? activeRoomId : rooms[0]?.id || "",
      };
      await writeState();
      return clientState();
    };
    writeQueue = writeQueue.then(task, task);
    return writeQueue;
  }

  async function deferScheduledRoom(roomId, { nextWakeAt, result = "" } = {}) {
    const task = async () => {
      const current = await load();
      const room = current.rooms.find((item) => item.id === cleanId(roomId));
      if (!room) return null;
      const schedule = sanitizeRoomSchedule(room.schedule);
      schedule.nextWakeAt = Number.isFinite(Number(nextWakeAt)) ? Number(nextWakeAt) : null;
      if (result) schedule.lastResult = text(result, 500);
      schedule.revision += 1;
      room.schedule = schedule;
      room.updatedAt = Date.now();
      await writeState();
      return sanitizeRoomSchedule(room.schedule);
    };
    writeQueue = writeQueue.then(task, task);
    return writeQueue;
  }

  async function completeScheduledRun(roomId, {
    messages = [],
    result = "",
    mic = null,
    eventCards = null,
    privateMemoryItems = {},
    at = Date.now(),
  } = {}) {
    const task = async () => {
      const current = await load();
      const room = current.rooms.find((item) => item.id === cleanId(roomId));
      if (!room) return null;
      const schedule = sanitizeRoomSchedule(room.schedule);
      const date = new Date(at);
      const dayKey = [
        date.getFullYear(),
        String(date.getMonth() + 1).padStart(2, "0"),
        String(date.getDate()).padStart(2, "0"),
      ].join("-");
      schedule.dailyCount = schedule.dayKey === dayKey ? schedule.dailyCount + 1 : 1;
      schedule.dayKey = dayKey;
      schedule.lastWakeAt = at;
      schedule.lastResult = text(result, 500);
      schedule.nextWakeAt = schedule.enabled ? at + schedule.intervalMinutes * 60_000 : null;
      schedule.revision += 1;
      room.schedule = schedule;
      if (mic && typeof mic === "object") {
        const incomingMic = sanitizeRoomMic(mic);
        const currentMic = sanitizeRoomMic(room.mic);
        room.mic = incomingMic.revision >= currentMic.revision ? incomingMic : currentMic;
      }
      if (eventCards && typeof eventCards === "object") {
        const incomingEventCards = sanitizeRoomEventCards(eventCards);
        const currentEventCards = sanitizeRoomEventCards(room.eventCards);
        room.eventCards = incomingEventCards.revision >= currentEventCards.revision
          ? incomingEventCards
          : currentEventCards;
      }
      const savedMessages = messages.map((message) => sanitizeMessage({ ...message, source: "scheduled" }));
      room.messages = [...(room.messages || []).map(sanitizeMessage), ...savedMessages].slice(-500);
      room.updatedAt = at;
      for (const [rawAgentId, rawItems] of Object.entries(privateMemoryItems || {})) {
        const agent = current.agents.find((item) => item.id === cleanId(rawAgentId));
        if (!agent?.memoryEnabled || !Array.isArray(rawItems) || !rawItems.length) continue;
        const nextMemory = appendAgentMemory(agent.memory, rawItems, {
          roomName: room.name,
          at,
          maxItems: 18,
        });
        if (nextMemory === String(agent.memory || "")) continue;
        agent.memory = nextMemory;
        agent.memoryRevision = Math.max(
          Date.now(),
          boundedInteger(agent.memoryRevision, 0, 0, Number.MAX_SAFE_INTEGER) + 1,
        );
      }
      await writeState();
      return {
        schedule: sanitizeRoomSchedule(room.schedule),
        eventCards: sanitizeRoomEventCards(room.eventCards),
        messages: savedMessages,
      };
    };
    writeQueue = writeQueue.then(task, task);
    return writeQueue;
  }

  async function completeRoomSummary(roomId, {
    summary,
    summarizedThroughId,
    summarizedMessageCount,
    expectedPreviousMarker = "",
    at = Date.now(),
  } = {}) {
    const task = async () => {
      const current = await load();
      const room = current.rooms.find((item) => item.id === cleanId(roomId));
      if (!room) return false;
      const memory = sanitizeRoomMemory(room.memory);
      if (memory.summarizedThroughId !== cleanId(expectedPreviousMarker)) return false;
      memory.summary = text(summary, 50_000);
      memory.summarizedThroughId = cleanId(summarizedThroughId);
      memory.summarizedMessageCount = boundedInteger(summarizedMessageCount, 0, 0, 500);
      memory.updatedAt = at;
      memory.stale = false;
      room.memory = memory;
      room.updatedAt = at;
      await writeState();
      return true;
    };
    writeQueue = writeQueue.then(task, task);
    return writeQueue;
  }

  async function credentials(agentId) {
    const current = await load();
    const agent = agentId === "memory-summarizer"
      ? current.summarizer
      : current.agents.find((item) => item.id === agentId);
    if (!agent) return { apiKey: "", extraHeaders: "" };
    return {
      apiKey: decrypt(agent.apiKeyCipher, key),
      extraHeaders: decrypt(agent.extraHeadersCipher, key),
    };
  }

  return {
    clientState,
    save,
    credentials,
    deferScheduledRoom,
    completeScheduledRun,
    completeRoomSummary,
  };
}
