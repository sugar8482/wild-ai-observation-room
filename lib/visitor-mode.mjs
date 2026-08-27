import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const INVITE_TYPES = new Set(["human", "mcp"]);

function compact(value, maxLength) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function tokenHash(token) {
  return createHash("sha256").update(String(token || "")).digest("hex");
}

function publicInvite(invite, now = Date.now()) {
  return {
    id: invite.id,
    roomId: invite.roomId,
    type: invite.type,
    name: invite.name,
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt,
    lastSeenAt: invite.lastSeenAt || null,
    revokedAt: invite.revokedAt || null,
    requestId: compact(invite.requestId, 120),
    active: !invite.revokedAt && invite.expiresAt > now,
  };
}

function safeRequestId(value) {
  const requestId = compact(value, 120);
  return /^[a-zA-Z0-9_-]{16,120}$/.test(requestId) ? requestId : "";
}

function safeClientToken(value) {
  const token = compact(value, 160);
  return /^[a-zA-Z0-9_-]{32,160}$/.test(token) ? token : "";
}

export function createVisitorManager({ filePath, now = () => Date.now() }) {
  let state = null;
  let writeQueue = Promise.resolve();

  async function load() {
    if (state) return state;
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8"));
      state = parsed && typeof parsed === "object" ? parsed : { version: 1, invites: [] };
    } catch {
      state = { version: 1, invites: [] };
    }
    state.version = 1;
    state.invites = Array.isArray(state.invites) ? state.invites : [];
    return state;
  }

  async function writeState() {
    const temporary = `${filePath}.tmp`;
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(temporary, JSON.stringify(state, null, 2), "utf8");
    await rename(temporary, filePath);
  }

  async function list() {
    const current = await load();
    return current.invites
      .map((invite) => publicInvite(invite, now()))
      .sort((left, right) => right.createdAt - left.createdAt);
  }

  async function create({ roomId, type, name, expiresInHours = 24, requestId = "", token: requestedToken = "" }) {
    const task = async () => {
      const current = await load();
      const safeType = INVITE_TYPES.has(type) ? type : "human";
      const safeRoomId = compact(roomId, 120);
      const safeName = compact(name, 80) || (safeType === "mcp" ? "AI 访客" : "朋友");
      const hours = Math.min(24 * 30, Math.max(1, Number(expiresInHours) || 24));
      const normalizedRequestId = safeRequestId(requestId);
      const clientToken = safeClientToken(requestedToken);
      if (requestId && !normalizedRequestId) throw new Error("邀请恢复编号无效");
      if (requestedToken && !clientToken) throw new Error("邀请恢复钥匙无效");
      const existing = normalizedRequestId
        ? current.invites.find((item) => item.requestId === normalizedRequestId)
        : null;
      if (existing) {
        if (!clientToken || existing.tokenHash !== tokenHash(clientToken)) throw new Error("这份邀请的恢复钥匙不匹配");
        return { invite: publicInvite(existing, now()), token: clientToken };
      }
      const token = clientToken || randomBytes(24).toString("base64url");
      const createdAt = now();
      const invite = {
        id: `invite-${randomBytes(8).toString("hex")}`,
        tokenHash: tokenHash(token),
        roomId: safeRoomId,
        type: safeType,
        name: safeName,
        createdAt,
        expiresAt: createdAt + hours * 60 * 60 * 1000,
        lastSeenAt: null,
        revokedAt: null,
        requestId: normalizedRequestId,
      };
      current.invites.push(invite);
      current.invites = current.invites.slice(-200);
      await writeState();
      return { invite: publicInvite(invite, now()), token };
    };
    writeQueue = writeQueue.then(task, task);
    return writeQueue;
  }

  async function authorize(token, expectedType = "") {
    const current = await load();
    const hash = tokenHash(token);
    const invite = current.invites.find((item) => item.tokenHash === hash);
    if (!invite || invite.revokedAt || invite.expiresAt <= now()) return null;
    if (expectedType && invite.type !== expectedType) return null;
    return { ...invite };
  }

  async function touch(inviteId) {
    const task = async () => {
      const current = await load();
      const invite = current.invites.find((item) => item.id === inviteId);
      if (!invite || invite.revokedAt) return false;
      const timestamp = now();
      if (invite.lastSeenAt && timestamp - invite.lastSeenAt < 30_000) return true;
      invite.lastSeenAt = timestamp;
      await writeState();
      return true;
    };
    writeQueue = writeQueue.then(task, task);
    return writeQueue;
  }

  async function revoke(inviteId) {
    const task = async () => {
      const current = await load();
      const invite = current.invites.find((item) => item.id === compact(inviteId, 120));
      if (!invite) return false;
      invite.revokedAt = now();
      await writeState();
      return true;
    };
    writeQueue = writeQueue.then(task, task);
    return writeQueue;
  }

  return { list, create, authorize, touch, revoke };
}
