import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { appendAgentMemory } from "../public/agent-memory.js";
import { MAX_CHAT_BUBBLES } from "../public/chat-bubbles.js";
import { isPrivateMessage, ROOM_USER_ID } from "../public/private-messages.js";

const FORMATS = new Set(["openai", "anthropic", "gemini"]);
const AUTH_TYPES = new Set(["bearer", "x-api-key", "x-goog-api-key", "custom", "none"]);

function text(value, maxLength) {
  return String(value ?? "").slice(0, maxLength);
}

function cleanId(value) {
  const id = text(value, 120);
  return /^[a-zA-Z0-9_-]+$/.test(id) ? id : "";
}

function isExternalVisitorId(value) {
  return /^invite-[a-f0-9]{16}$/i.test(String(value || ""));
}

function agentMemoryFields(agent) {
  return {
    memoryEnabled: agent?.memoryEnabled === true,
    memory: text(agent?.memory, 100_000),
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
    focus: text(eventCards?.focus, 4_000),
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

function sanitizeMessage(message, validAgentIds = new Set()) {
  const kind = new Set(["user", "agent", "error"]).has(message?.kind) ? message.kind : "agent";
  let remaining = 50_000;
  const segments = (Array.isArray(message?.segments) ? message.segments : [])
    .slice(0, MAX_CHAT_BUBBLES)
    .map((segment) => {
      const cleaned = text(segment, remaining).trim();
      remaining -= cleaned.length;
      return cleaned;
    })
    .filter(Boolean);
  const savedSegments = segments.length > 1 ? segments : [];
  const recipientIds = [...new Set((Array.isArray(message?.recipientIds) ? message.recipientIds : [])
    .map((id) => id === ROOM_USER_ID ? ROOM_USER_ID : cleanId(id))
    .filter((id) => id === ROOM_USER_ID || validAgentIds.has(id) || isExternalVisitorId(id))
    .filter(Boolean))]
    .slice(0, 20);
  const requestedPrivate = message?.privacy === "private";
  const safeRecipientIds = requestedPrivate && !recipientIds.length ? [ROOM_USER_ID] : recipientIds;
  const privacy = requestedPrivate ? "private" : null;
  return {
    id: cleanId(message?.id) || `message-${randomBytes(8).toString("hex")}`,
    kind,
    author: text(message?.author, 80) || "未知嘉宾",
    text: savedSegments.length ? savedSegments.join("\n") : text(message?.text, 50_000),
    segments: savedSegments,
    agentId: cleanId(message?.agentId) || null,
    privacy,
    recipientIds: privacy ? safeRecipientIds : [],
    source: ["scheduled", "visitor", "mcp"].includes(message?.source) ? message.source : null,
    externalId: cleanId(message?.externalId) || null,
    ...(message?.privateRepairEligible === true ? { privateRepairEligible: true } : {}),
    timestamp: Number.isFinite(Number(message?.timestamp)) ? Number(message.timestamp) : Date.now(),
  };
}

function sanitizeRoomMembers(room, participants, validAgentIds) {
  const fallbackTime = Number.isFinite(Number(room?.createdAt)) ? Number(room.createdAt) : Date.now();
  const participantSet = new Set(participants);
  const members = new Map();
  for (const rawMember of (Array.isArray(room?.members) ? room.members : []).slice(0, 100)) {
    const id = cleanId(rawMember?.id);
    if (!id) continue;
    const type = ["agent", "mcp", "human"].includes(rawMember?.type) ? rawMember.type : "agent";
    let status = ["active", "away", "left"].includes(rawMember?.status) ? rawMember.status : "active";
    if (type === "agent" && validAgentIds.has(id) && !participantSet.has(id)) status = "left";
    members.set(id, {
      id,
      name: text(rawMember?.name, 80).trim() || "未命名嘉宾",
      type,
      status,
      note: text(rawMember?.note, 240).trim(),
      joinedAt: Number.isFinite(Number(rawMember?.joinedAt)) ? Number(rawMember.joinedAt) : fallbackTime,
      statusChangedAt: Number.isFinite(Number(rawMember?.statusChangedAt)) ? Number(rawMember.statusChangedAt) : fallbackTime,
      lastSeenAt: Number.isFinite(Number(rawMember?.lastSeenAt)) ? Number(rawMember.lastSeenAt) : null,
    });
  }
  for (const id of participants) {
    const existing = members.get(id);
    if (existing) continue;
    members.set(id, {
      id,
      name: "未命名嘉宾",
      type: "agent",
      status: "active",
      note: "",
      joinedAt: fallbackTime,
      statusChangedAt: fallbackTime,
      lastSeenAt: null,
    });
  }

  // Older state files had no member ledger. Recover everyone who appeared in
  // the transcript so an upgrade does not erase former guests from the room's
  // history. A historical external visitor is only marked away; "left" remains
  // an explicit decision except for an internal agent already removed here.
  for (const rawMessage of Array.isArray(room?.messages) ? room.messages : []) {
    const external = rawMessage?.source === "mcp" || rawMessage?.source === "visitor";
    const id = cleanId(external ? (rawMessage?.externalId || rawMessage?.agentId) : rawMessage?.agentId);
    if (!id || rawMessage?.kind !== "agent") continue;
    const timestamp = Number.isFinite(Number(rawMessage?.timestamp)) ? Number(rawMessage.timestamp) : fallbackTime;
    const existing = members.get(id);
    if (existing) {
      existing.joinedAt = Math.min(existing.joinedAt || timestamp, timestamp);
      existing.lastSeenAt = Math.max(existing.lastSeenAt || 0, timestamp);
      continue;
    }
    if (members.size >= 100) break;
    members.set(id, {
      id,
      name: text(rawMessage?.author, 80).trim() || "未命名嘉宾",
      type: external ? (rawMessage.source === "visitor" ? "human" : "mcp") : "agent",
      status: external ? "away" : "left",
      note: "",
      joinedAt: timestamp,
      statusChangedAt: timestamp,
      lastSeenAt: timestamp,
    });
  }
  return [...members.values()];
}

function sanitizeRoom(room, validAgentIds) {
  const participants = Array.isArray(room?.participantIds)
    ? [...new Set(room.participantIds.map(cleanId).filter((id) => validAgentIds.has(id)))].slice(0, 20)
    : [];
  const members = sanitizeRoomMembers(room, participants, validAgentIds);
  const canonicalParticipants = members
    .filter((member) => member.type === "agent" && validAgentIds.has(member.id) && member.status !== "left")
    .map((member) => member.id)
    .slice(0, 20);
  return {
    id: cleanId(room?.id) || `room-${randomBytes(8).toString("hex")}`,
    name: text(room?.name, 60).trim() || "未命名观察间",
    roomPrompt: text(room?.roomPrompt, 20_000),
    bubbleSplit: room?.bubbleSplit === true,
    memory: sanitizeRoomMemory(room?.memory),
    schedule: sanitizeRoomSchedule(room?.schedule),
    eventCards: sanitizeRoomEventCards(room?.eventCards),
    mic: sanitizeRoomMic(room?.mic),
    externalRevision: boundedInteger(room?.externalRevision, 0, 0, Number.MAX_SAFE_INTEGER),
    participantIds: canonicalParticipants,
    members,
    messages: Array.isArray(room?.messages)
      ? room.messages.slice(-500).map((message) => sanitizeMessage(message, validAgentIds))
      : [],
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
  const currentMembers = sanitizeRoom(currentRoom, validAgentIds).members;
  const memberById = new Map(next.members.map((member) => [member.id, member]));
  for (const currentMember of currentMembers) {
    const incomingMember = memberById.get(currentMember.id);
    if (!incomingMember || currentMember.statusChangedAt > incomingMember.statusChangedAt) {
      memberById.set(currentMember.id, currentMember);
      continue;
    }
    if ((currentMember.lastSeenAt || 0) > (incomingMember.lastSeenAt || 0)) {
      incomingMember.lastSeenAt = currentMember.lastSeenAt;
    }
  }
  next.members = [...memberById.values()].slice(0, 100);
  next.participantIds = next.members
    .filter((member) => member.type === "agent" && validAgentIds.has(member.id) && member.status !== "left")
    .map((member) => member.id)
    .slice(0, 20);
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
      .map((message) => sanitizeMessage(message, validAgentIds))
      .filter((message) => (
        message.source === "scheduled"
        && message.timestamp > seenScheduledThrough
        && !incomingIds.has(message.id)
      ));
    next.messages = [...next.messages, ...missingScheduled]
      .sort((left, right) => left.timestamp - right.timestamp)
      .slice(-500);
  }
  const currentExternalRevision = boundedInteger(currentRoom.externalRevision, 0, 0, Number.MAX_SAFE_INTEGER);
  const incomingExternalRevision = boundedInteger(incomingRoom?.externalRevision, 0, 0, Number.MAX_SAFE_INTEGER);
  if (incomingExternalRevision < currentExternalRevision) {
    const incomingIds = new Set(next.messages.map((message) => message.id));
    const missingExternal = (currentRoom.messages || [])
      .map((message) => sanitizeMessage(message, validAgentIds))
      .filter((message) => (
        ["visitor", "mcp"].includes(message.source)
        && !incomingIds.has(message.id)
      ));
    next.messages = [...next.messages, ...missingExternal]
      .sort((left, right) => left.timestamp - right.timestamp)
      .slice(-500);
  }
  next.externalRevision = Math.max(incomingExternalRevision, currentExternalRevision);
  const currentMic = sanitizeRoomMic(currentRoom.mic);
  const incomingMic = sanitizeRoomMic(incomingRoom?.mic);
  next.mic = incomingMic.revision >= currentMic.revision ? incomingMic : currentMic;
  const currentEventCards = sanitizeRoomEventCards(currentRoom.eventCards);
  const incomingEventCards = sanitizeRoomEventCards(incomingRoom?.eventCards);
  next.eventCards = incomingEventCards.revision >= currentEventCards.revision
    ? incomingEventCards
    : currentEventCards;
  const currentMemory = sanitizeRoomMemory(currentRoom.memory);
  const incomingMemory = sanitizeRoomMemory(incomingRoom?.memory);
  if ((Number(currentMemory.updatedAt) || 0) > (Number(incomingMemory.updatedAt) || 0)) {
    next.memory = {
      ...currentMemory,
      enabled: incomingMemory.enabled,
      interval: incomingMemory.interval,
      recentMessages: incomingMemory.recentMessages,
      focus: incomingMemory.focus,
    };
  }
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

export function createStateStore({ filePath, secret, onStateChange = null }) {
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
    if (typeof onStateChange === "function") {
      queueMicrotask(() => {
        void clientState()
          .then((nextState) => onStateChange(nextState))
          .catch(() => {});
      });
    }
  }

  async function clientState() {
    const current = await load();
    const validAgentIds = new Set(current.agents.map((agent) => agent.id));
    const agentNames = new Map(current.agents.map((agent) => [agent.id, agent.name]));
    return {
      version: 3,
      agents: current.agents.map(clientAgent),
      summarizer: clientSummarizer(current.summarizer),
      rooms: current.rooms.map((room) => {
        const sanitized = sanitizeRoom(room, validAgentIds);
        sanitized.members = sanitized.members.map((member) => ({
          ...member,
          name: member.type === "agent" && agentNames.has(member.id)
            ? agentNames.get(member.id)
            : member.name,
        }));
        return sanitized;
      }),
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
      const validAgentIds = new Set(current.agents.map((agent) => agent.id));
      const savedMessages = messages.map((message) => sanitizeMessage(
        { ...message, source: "scheduled" },
        validAgentIds,
      ));
      room.messages = [
        ...(room.messages || []).map((message) => sanitizeMessage(message, validAgentIds)),
        ...savedMessages,
      ].slice(-500);
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
    expectedPreviousUpdatedAt = undefined,
    at = Date.now(),
  } = {}) {
    const task = async () => {
      const current = await load();
      const room = current.rooms.find((item) => item.id === cleanId(roomId));
      if (!room) return false;
      const memory = sanitizeRoomMemory(room.memory);
      if (memory.summarizedThroughId !== cleanId(expectedPreviousMarker)) return false;
      if (
        expectedPreviousUpdatedAt !== undefined
        && (Number(memory.updatedAt) || 0) !== (Number(expectedPreviousUpdatedAt) || 0)
      ) return false;
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

  async function publicRoomSnapshot(roomId, {
    after = 0,
    limit = 200,
    externalViewerId = "",
    includeContext = false,
  } = {}) {
    const current = await load();
    const room = current.rooms.find((item) => item.id === cleanId(roomId));
    if (!room) return null;
    const afterTimestamp = Number(after) || 0;
    const safeLimit = boundedInteger(limit, 200, 1, 500);
    const viewerId = isExternalVisitorId(externalViewerId) ? externalViewerId : "";
    const messages = (room.messages || [])
      .filter((message) => (
        !isPrivateMessage(message)
        || (viewerId && (
          message.externalId === viewerId
          || message.agentId === viewerId
          || message.recipientIds?.includes(viewerId)
        ))
      ))
      .filter((message) => Number(message.timestamp) > afterTimestamp)
      .slice(-safeLimit)
      .map((message) => sanitizeMessage(message, new Set(current.agents.map((agent) => agent.id))));
    const validAgentIds = new Set(current.agents.map((agent) => agent.id));
    const agentNames = new Map(current.agents.map((agent) => [agent.id, agent.name]));
    const members = sanitizeRoomMembers(room, room.participantIds || [], validAgentIds).map((member) => ({
      ...member,
      name: member.type === "agent" && agentNames.has(member.id) ? agentNames.get(member.id) : member.name,
    }));
    const participantNames = members.filter((member) => member.status === "active").map((member) => member.name);
    const snapshot = {
      id: room.id,
      name: room.name,
      participantNames,
      members,
      messages,
      externalRevision: boundedInteger(room.externalRevision, 0, 0, Number.MAX_SAFE_INTEGER),
      updatedAt: Number(room.updatedAt) || Date.now(),
    };
    if (includeContext) {
      snapshot.roomPrompt = text(room.roomPrompt, 20_000);
      snapshot.longTermSummary = text(room.memory?.summary, 50_000);
      snapshot.summaryStale = room.memory?.stale === true;
      snapshot.privateRecipients = [
        { id: ROOM_USER_ID, protocolId: "user", name: "晨曦", type: "human" },
        ...members.filter((member) => member.status !== "left" && member.id !== viewerId).map((member) => ({
          id: member.id,
          protocolId: member.id,
          name: member.name,
          type: member.type,
        })),
      ];
    }
    return snapshot;
  }

  async function appendExternalMessage(roomId, {
    kind = "user",
    author = "访客",
    text: messageText = "",
    source = "visitor",
    externalId = "",
    privacy = null,
    recipientIds = [],
    at = Date.now(),
  } = {}) {
    const task = async () => {
      const current = await load();
      const room = current.rooms.find((item) => item.id === cleanId(roomId));
      if (!room) return null;
      const cleanText = text(messageText, 4_000).trim();
      if (!cleanText) return null;
      const safeExternalId = isExternalVisitorId(externalId) ? externalId : "";
      const validAgentIds = new Set(current.agents.map((agent) => agent.id));
      const allowedPrivateRecipients = new Set([
        ROOM_USER_ID,
        ...sanitizeRoomMembers(room, room.participantIds || [], validAgentIds)
          .filter((member) => member.status !== "left")
          .map((member) => member.id),
      ]);
      const safeRecipientIds = [...new Set((Array.isArray(recipientIds) ? recipientIds : [])
        .map(cleanId)
        .filter((id) => allowedPrivateRecipients.has(id)))].slice(0, 1);
      const isPrivate = privacy === "private" && safeRecipientIds.length === 1;
      const message = sanitizeMessage({
        id: `message-${randomBytes(8).toString("hex")}`,
        kind: kind === "agent" ? "agent" : "user",
        author: text(author, 80).trim() || "访客",
        text: cleanText,
        source: source === "mcp" ? "mcp" : "visitor",
        externalId: safeExternalId,
        agentId: kind === "agent" ? safeExternalId : null,
        ...(isPrivate ? { privacy: "private", recipientIds: safeRecipientIds } : {}),
        timestamp: Number.isFinite(Number(at)) ? Number(at) : Date.now(),
      }, validAgentIds);
      room.messages = [...(room.messages || []), message].slice(-500);
      room.externalRevision = boundedInteger(room.externalRevision, 0, 0, Number.MAX_SAFE_INTEGER) + 1;
      room.updatedAt = message.timestamp;
      await writeState();
      return message;
    };
    writeQueue = writeQueue.then(task, task);
    return writeQueue;
  }

  async function setRoomMemberPresence(roomId, {
    memberId = "",
    name = "",
    type = "agent",
    status = "",
    note = "",
    at = Date.now(),
    touch = false,
  } = {}) {
    const task = async () => {
      const current = await load();
      const room = current.rooms.find((item) => item.id === cleanId(roomId));
      const id = cleanId(memberId);
      if (!room || !id) return null;
      const safeType = ["agent", "mcp", "human"].includes(type) ? type : "agent";
      const timestamp = Number.isFinite(Number(at)) ? Number(at) : Date.now();
      const validAgentIds = new Set(current.agents.map((agent) => agent.id));
      const members = sanitizeRoomMembers(room, room.participantIds || [], validAgentIds);
      let member = members.find((item) => item.id === id);
      const safeStatus = ["active", "away", "left"].includes(status)
        ? status
        : member?.status || "active";
      const resolvedName = text(name, 80).trim()
        || current.agents.find((agent) => agent.id === id)?.name
        || member?.name
        || "未命名嘉宾";
      const nextNote = status ? text(note, 240).trim() : member?.note || text(note, 240).trim();
      const changed = !member
        || member.status !== safeStatus
        || member.note !== nextNote
        || member.name !== resolvedName
        || member.type !== safeType;
      if (!member) {
        member = {
          id,
          name: resolvedName,
          type: safeType,
          status: safeStatus,
          note: nextNote,
          joinedAt: timestamp,
          statusChangedAt: timestamp,
          lastSeenAt: touch ? timestamp : null,
        };
        members.push(member);
      } else {
        member.name = resolvedName;
        member.type = safeType;
        member.status = safeStatus;
        member.note = nextNote;
        if (changed) member.statusChangedAt = timestamp;
        if (touch && timestamp - Number(member.lastSeenAt || 0) >= 30_000) member.lastSeenAt = timestamp;
      }
      if (safeType === "agent" && validAgentIds.has(id)) {
        if (safeStatus === "left") room.participantIds = (room.participantIds || []).filter((item) => item !== id);
        else if (!room.participantIds?.includes(id)) room.participantIds = [...(room.participantIds || []), id];
      }
      const shouldWrite = changed || (touch && member.lastSeenAt === timestamp);
      if (!shouldWrite) return member;
      room.members = members.slice(0, 100);
      room.externalRevision = boundedInteger(room.externalRevision, 0, 0, Number.MAX_SAFE_INTEGER) + 1;
      room.updatedAt = Math.max(Number(room.updatedAt) || 0, timestamp);
      await writeState();
      return member;
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
    publicRoomSnapshot,
    appendExternalMessage,
    setRoomMemberPresence,
  };
}
