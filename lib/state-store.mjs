import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const FORMATS = new Set(["openai", "anthropic", "gemini"]);
const AUTH_TYPES = new Set(["bearer", "x-api-key", "x-goog-api-key", "custom", "none"]);

function text(value, maxLength) {
  return String(value ?? "").slice(0, maxLength);
}

function cleanId(value) {
  const id = text(value, 120);
  return /^[a-zA-Z0-9_-]+$/.test(id) ? id : "";
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
  return {
    id: cleanId(message?.id) || `message-${randomBytes(8).toString("hex")}`,
    kind,
    author: text(message?.author, 80) || "未知嘉宾",
    text: text(message?.text, 50_000),
    agentId: cleanId(message?.agentId) || null,
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
    memory: sanitizeRoomMemory(room?.memory),
    participantIds: participants,
    messages: Array.isArray(room?.messages) ? room.messages.slice(-500).map(sanitizeMessage) : [],
    createdAt: Number.isFinite(Number(room?.createdAt)) ? Number(room.createdAt) : Date.now(),
    updatedAt: Number.isFinite(Number(room?.updatedAt)) ? Number(room.updatedAt) : Date.now(),
  };
}

function clientAgent(agent) {
  const { apiKeyCipher: _key, extraHeadersCipher: _headers, ...profile } = agent;
  return {
    ...profile,
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
        const format = FORMATS.has(agent?.format) ? agent.format : "openai";
        const authType = AUTH_TYPES.has(agent?.authType) ? agent.authType : "bearer";
        let apiKeyCipher = existing?.apiKeyCipher || null;
        let extraHeadersCipher = existing?.extraHeadersCipher || null;
        if (agent?.clearApiKey === true) apiKeyCipher = null;
        else if (String(agent?.apiKey || "").trim()) apiKeyCipher = encrypt(text(agent.apiKey, 10_000), key);
        if (agent?.clearExtraHeaders === true) extraHeadersCipher = null;
        else if (String(agent?.extraHeaders || "").trim()) {
          extraHeadersCipher = encrypt(text(agent.extraHeaders, 20_000), key);
        }

        nextAgents.push({
          id,
          name: text(agent?.name, 80).trim() || "未命名嘉宾",
          format,
          baseUrl: text(agent?.baseUrl, 2_048).trim(),
          model: text(agent?.model, 300).trim(),
          authType,
          customHeader: text(agent?.customHeader, 200).trim(),
          persona: text(agent?.persona, 20_000),
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
      const rooms = Array.isArray(incoming?.rooms)
        ? incoming.rooms.slice(0, 50).map((room) => sanitizeRoom(room, validAgentIds))
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

  return { clientState, save, credentials };
}
