import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { readFile, stat, writeFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildUpstreamRequest,
  parseProviderResponse,
  providerErrorMessage,
  providerFinishReason,
  ProviderConfigError,
} from "./lib/providers.mjs";
import { createStateStore } from "./lib/state-store.mjs";
import { createRoomScheduler } from "./lib/scheduled-chat.mjs";
import { createRoomSummaryJobs } from "./lib/room-summary-jobs.mjs";
import { createPostgresArchive } from "./lib/postgres-archive.mjs";
import { createVisitorManager } from "./lib/visitor-mode.mjs";
import { DEFAULT_VISIBLE_REPLY_TOKENS } from "./public/reply-limits.js";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));
const publicRoot = resolve(projectRoot, "public");
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_STATE_BODY_BYTES = 16 * 1024 * 1024;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const MAX_LOGIN_FAILURES = 8;
const SESSION_MAX_AGE_SECONDS = 180 * 24 * 60 * 60;
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
};

function securityHeaders(contentType = "application/json; charset=utf-8") {
  return {
    "content-type": contentType,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    "content-security-policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  };
}

function sendJson(response, statusCode, payload, extraHeaders = {}) {
  response.writeHead(statusCode, { ...securityHeaders(), ...extraHeaders });
  response.end(JSON.stringify(payload));
}

function htmlText(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function readJson(request, maxBytes = MAX_BODY_BYTES) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBytes) throw new ProviderConfigError("请求内容太大");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ProviderConfigError("请求不是有效的 JSON");
  }
}

function digest(value) {
  return createHash("sha256").update(String(value)).digest();
}

function safeEqual(left, right) {
  return timingSafeEqual(digest(left), digest(right));
}

export function isLoopbackAddress(address) {
  const normalized = String(address || "").replace(/^::ffff:/, "");
  return normalized === "::1" || normalized === "0:0:0:0:0:0:0:1" || normalized.startsWith("127.");
}

function cookieValue(request, name) {
  const cookie = String(request.headers.cookie || "");
  for (const pair of cookie.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0) continue;
    if (pair.slice(0, separator).trim() === name) {
      return decodeURIComponent(pair.slice(separator + 1).trim());
    }
  }
  return "";
}

function isOfficialDeepSeekV4(agent) {
  if (String(agent?.format || "") !== "openai") return false;
  if (!/^deepseek-v4-(flash|pro)$/i.test(String(agent?.model || "").trim())) return false;
  try {
    return new URL(String(agent?.baseUrl || "")).hostname.toLowerCase() === "api.deepseek.com";
  } catch {
    return false;
  }
}

function isKimiK3(agent) {
  if (String(agent?.format || "") !== "openai") return false;
  return /(?:^|[^a-z0-9])kimi[-_\s]?k3(?:[^a-z0-9]|$)/i.test(String(agent?.model || ""));
}

function isGlmThinkingAgent(agent) {
  if (String(agent?.format || "") !== "openai") return false;
  return /(?:^|[^a-z0-9])glm(?:[-_\s.]?[a-z0-9][a-z0-9._-]*)?(?:[^a-z0-9]|$)|zhipu/i.test(
    `${agent?.name || ""} ${agent?.model || ""} ${agent?.baseUrl || ""}`,
  );
}

function isClaudeAgent(agent) {
  return /claude|opus|sonnet/i.test(`${agent?.name || ""} ${agent?.model || ""}`);
}

export function chatRequestPolicy(agent, payload = {}) {
  const isWillingnessScore = payload.requestMode === "willingness-score";
  const isMemorySummary = ["memory-summary", "private-memory-summary"].includes(payload.requestMode);
  const isWerewolfGame = payload.requestMode === "werewolf-game";
  const minimumTokens = isWillingnessScore ? 1 : 64;
  const maximumTokens = isWillingnessScore ? 64 : 4096;
  const visibleTokenTarget = Number.isFinite(Number(payload.maxTokens))
    ? Math.min(maximumTokens, Math.max(minimumTokens, Math.round(Number(payload.maxTokens))))
    : isWillingnessScore ? 8 : isMemorySummary ? 300 : DEFAULT_VISIBLE_REPLY_TOKENS;
  const officialDeepSeek = isOfficialDeepSeekV4(agent);
  const usesDeepSeekThinking = officialDeepSeek && !isWillingnessScore;
  const usesKimiThinking = isKimiK3(agent) && !isWillingnessScore;
  const usesGlmThinking = isGlmThinkingAgent(agent) && !isWillingnessScore;
  const usesClaude = isClaudeAgent(agent) && !isWillingnessScore;
  const needsHiddenThinkingBudget = usesDeepSeekThinking || usesKimiThinking || usesGlmThinking;
  const hiddenThinkingBudget = (usesKimiThinking || usesGlmThinking) && isWerewolfGame ? 4096 : 8192;
  return {
    isWillingnessScore,
    isMemorySummary,
    visibleTokenTarget,
    upstreamMaxTokens: needsHiddenThinkingBudget ? Math.max(hiddenThinkingBudget, visibleTokenTarget) : visibleTokenTarget,
    thinkingMode: officialDeepSeek ? (usesDeepSeekThinking ? "enabled" : "disabled") : undefined,
    retryEmptyLength: usesGlmThinking,
    timeoutMs: isWillingnessScore ? 30_000 : isMemorySummary ? 900_000 : usesKimiThinking && isWerewolfGame ? 300_000 : usesKimiThinking ? 600_000 : usesGlmThinking ? 300_000 : usesClaude ? 300_000 : needsHiddenThinkingBudget ? 180_000 : 120_000,
  };
}

function emptyResponseMessage(finishReason) {
  if (finishReason === "length") {
    return "上游把本次输出额度用完了，正文还没来得及生成";
  }
  if (finishReason === "insufficient_system_resource") {
    return "DeepSeek 上游推理资源暂时不足，请稍后再试";
  }
  return "上游返回成功，但没有找到文本内容";
}

function transportErrorMessage(error) {
  const code = String(error?.cause?.code || "").toUpperCase();
  if (code === "ECONNRESET" || code === "UND_ERR_SOCKET") {
    return "连接上游时被中途断开，请稍后再试";
  }
  if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") {
    return "连接上游超时，请稍后再试";
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return "暂时无法解析上游接口地址，请检查网络或稍后再试";
  }
  return "本地代理连接上游时出错";
}

async function handleChat(request, response, stateStore) {
  try {
    const payload = await readJson(request);
    const { agent: incomingAgent, messages, temperature } = payload || {};
    if (!incomingAgent || typeof incomingAgent !== "object") {
      throw new ProviderConfigError("缺少 AI 嘉宾配置");
    }

    let agent = incomingAgent;
    if (stateStore && incomingAgent.id) {
      const savedCredentials = await stateStore.credentials(incomingAgent.id);
      agent = {
        ...incomingAgent,
        apiKey: incomingAgent.apiKey || savedCredentials.apiKey,
        extraHeaders: incomingAgent.extraHeaders || savedCredentials.extraHeaders,
      };
    }

    const policy = chatRequestPolicy(agent, payload);
    const fetchAttempt = async (attemptMessages, attemptMaxTokens, attemptTemperature = temperature) => {
      const upstream = buildUpstreamRequest(agent, attemptMessages, {
        temperature: attemptTemperature,
        // Reasoning models count hidden reasoning and visible content against
        // one output budget. Keep the director's number as a visible-answer
        // target and give the upstream a separate ceiling for its reasoning.
        maxTokens: attemptMaxTokens,
        thinkingMode: policy.thinkingMode,
        compactOutput: policy.isWillingnessScore,
      });
      const controller = new AbortController();
      const abortUpstream = () => controller.abort();
      const timeout = setTimeout(abortUpstream, policy.timeoutMs);
      request.once("aborted", abortUpstream);
      try {
        const upstreamResponse = await fetch(upstream.endpoint, {
          method: "POST",
          headers: upstream.headers,
          body: JSON.stringify(upstream.body),
          signal: controller.signal,
          redirect: "error",
        });
        const raw = await upstreamResponse.text();
        let upstreamPayload = {};
        try {
          upstreamPayload = raw ? JSON.parse(raw) : {};
        } catch {
          upstreamPayload = { message: raw.slice(0, 800) };
        }
        return { upstreamResponse, upstreamPayload };
      } finally {
        clearTimeout(timeout);
        request.off("aborted", abortUpstream);
      }
    };

    let { upstreamResponse, upstreamPayload } = await fetchAttempt(messages, policy.upstreamMaxTokens);

    if (!upstreamResponse.ok) {
      sendJson(response, 502, {
        error: providerErrorMessage(
          upstreamPayload,
          `上游接口返回 ${upstreamResponse.status}`,
        ),
        upstreamStatus: upstreamResponse.status,
      });
      return;
    }

    let finishReason = providerFinishReason(agent.format, upstreamPayload);
    let text;
    try {
      text = parseProviderResponse(agent.format, upstreamPayload);
    } catch (error) {
      if (finishReason === "length" && policy.retryEmptyLength) {
        const recoveryMessages = [
          ...messages,
          {
            role: "user",
            content: `刚才内部思考用完了输出额度，但公开正文还是空的。不要重复展开分析，直接给出本轮最终公开发言；保持原本立场，正文控制在约 ${policy.visibleTokenTarget} tokens 以内。`,
          },
        ];
        const recoveryMaxTokens = Math.min(32_768, Math.max(12_288, policy.upstreamMaxTokens * 2));
        const recovery = await fetchAttempt(recoveryMessages, recoveryMaxTokens, Math.min(0.7, Number(temperature) || 0.7));
        upstreamResponse = recovery.upstreamResponse;
        upstreamPayload = recovery.upstreamPayload;
        if (!upstreamResponse.ok) {
          sendJson(response, 502, {
            error: providerErrorMessage(upstreamPayload, `上游接口返回 ${upstreamResponse.status}`),
            upstreamStatus: upstreamResponse.status,
          });
          return;
        }
        finishReason = providerFinishReason(agent.format, upstreamPayload);
        try {
          text = parseProviderResponse(agent.format, upstreamPayload);
        } catch {
          text = "";
        }
      }
      if (text) {
        sendJson(response, 200, {
          text,
          finishReason,
          usage: upstreamPayload.usage || upstreamPayload.usageMetadata || null,
          recoveredFromEmptyLength: true,
        });
        return;
      }
      if (finishReason) {
        sendJson(response, finishReason === "insufficient_system_resource" ? 503 : 502, {
          error: emptyResponseMessage(finishReason),
          finishReason,
        });
        return;
      }
      throw error;
    }

    sendJson(response, 200, {
      text,
      finishReason,
      usage: upstreamPayload.usage || upstreamPayload.usageMetadata || null,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      sendJson(response, 504, { error: "请求超时或已取消" });
      return;
    }
    const isConfigError = error instanceof ProviderConfigError;
    sendJson(response, isConfigError ? 400 : 500, {
      error: isConfigError ? error.message : transportErrorMessage(error),
    });
  }
}

async function serveStatic(request, response, pathname) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    sendJson(response, 400, { error: "网址格式不正确" });
    return;
  }
  const relativePath = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
  const target = resolve(publicRoot, relativePath);
  if (target !== publicRoot && !target.startsWith(`${publicRoot}${sep}`)) {
    sendJson(response, 403, { error: "禁止访问" });
    return;
  }

  try {
    const targetStat = await stat(target);
    if (!targetStat.isFile()) throw new Error("not a file");
    const body = await readFile(target);
    response.writeHead(200, securityHeaders(MIME_TYPES[extname(target)] || "application/octet-stream"));
    if (request.method === "HEAD") response.end();
    else response.end(body);
  } catch {
    sendJson(response, 404, { error: "页面不存在" });
  }
}

export function createAppServer(options = {}) {
  const accessCode = String(options.accessCode || randomBytes(6).toString("hex"));
  const sessionToken = String(options.sessionToken || randomBytes(32).toString("hex"));
  const forceAccessCode = options.forceAccessCode === true;
  const onAccessRequiredChange = typeof options.onAccessRequiredChange === "function"
    ? options.onAccessRequiredChange
    : async () => {};
  let accessRequired = options.accessRequired !== false;
  const stateStore = options.stateStore || null;
  const visitorManager = options.visitorManager || null;
  const summaryJobs = options.summaryJobs || null;
  const archive = options.archive || null;
  const loginFailures = new Map();
  const visitorMessageWindows = new Map();

  function requiresAccessCode(request) {
    return accessRequired && (forceAccessCode || !isLoopbackAddress(request.socket.remoteAddress));
  }

  function isAuthorized(request) {
    if (!requiresAccessCode(request)) return true;
    return safeEqual(cookieValue(request, "observation_session"), sessionToken);
  }

  function hasAdminSession(request) {
    return isAuthorized(request);
  }

  function sessionCookie() {
    return `observation_session=${encodeURIComponent(sessionToken)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}`;
  }

  function requestOrigin(request) {
    const forwardedProtocol = String(request.headers["x-forwarded-proto"] || "").split(",")[0].trim();
    const protocol = forwardedProtocol || (request.socket.encrypted ? "https" : "http");
    const host = String(request.headers["x-forwarded-host"] || request.headers.host || "127.0.0.1");
    return `${protocol}://${host}`;
  }

  function visitorCanPost(inviteId) {
    const current = Date.now();
    const window = visitorMessageWindows.get(inviteId);
    if (!window || current - window.startedAt >= 60_000) {
      visitorMessageWindows.set(inviteId, { startedAt: current, count: 1 });
      return true;
    }
    if (window.count >= 20) return false;
    window.count += 1;
    return true;
  }

  function sendMcpResult(response, id, result) {
    sendJson(response, 200, { jsonrpc: "2.0", id, result });
  }

  function sendMcpError(response, id, code, message, statusCode = 200) {
    sendJson(response, statusCode, { jsonrpc: "2.0", id: id ?? null, error: { code, message } });
  }

  async function clientStateWithWerewolfRecovery() {
    const snapshot = await stateStore.clientState();
    if (!archive?.status?.().enabled || typeof archive.currentWerewolfGame !== "function") return stateForClient(snapshot);
    for (const room of snapshot.rooms || []) {
      if (room.roomType !== "werewolf") continue;
      try {
        const stored = await archive.currentWerewolfGame(room.id);
        if (stored && (!room.werewolf
          || Number(stored.revision) > Number(room.werewolf.revision)
          || Number(stored.updatedAt) > Number(room.werewolf.updatedAt))) {
          room.werewolf = stored;
        }
      } catch {
        // The canonical database state remains usable even if the relational werewolf view is rebuilding.
      }
    }
    return stateForClient(snapshot);
  }

  function stateForClient(snapshot) {
    for (const room of snapshot?.rooms || []) {
      if (room.roomType !== "werewolf") continue;
      room.werewolfArchiveCount = room.werewolfArchives?.length || 0;
      room.werewolfArchives = [];
    }
    return snapshot;
  }

  function failureState(request) {
    const key = String(request.socket.remoteAddress || "unknown");
    const now = Date.now();
    const current = loginFailures.get(key);
    if (!current || current.resetAt <= now) {
      return { key, count: 0, resetAt: now + LOGIN_WINDOW_MS };
    }
    return { key, ...current };
  }

  return createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");

    if (request.method === "GET" && url.pathname === "/api/access") {
      const required = requiresAccessCode(request);
      sendJson(response, 200, {
        required,
        authenticated: !required || isAuthorized(request),
        protectionEnabled: accessRequired,
      });
      return;
    }

    if (request.method === "PUT" && url.pathname === "/api/access") {
      try {
        const payload = await readJson(request);
        if (typeof payload?.enabled !== "boolean") {
          sendJson(response, 400, { error: "访问保护设置不正确" });
          return;
        }
        const codeMatches = Boolean(payload?.code) && safeEqual(payload.code, accessCode);
        if (!hasAdminSession(request) && !codeMatches) {
          sendJson(response, 401, { error: "需要当前访问码才能修改保护设置" });
          return;
        }
        await onAccessRequiredChange(payload.enabled);
        accessRequired = payload.enabled;
        sendJson(
          response,
          200,
          { ok: true, protectionEnabled: accessRequired },
          codeMatches ? { "set-cookie": sessionCookie() } : {},
        );
      } catch (error) {
        const isConfigError = error instanceof ProviderConfigError;
        sendJson(response, isConfigError ? 400 : 500, {
          error: isConfigError ? error.message : "访问保护设置保存失败",
        });
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/login") {
      if (!requiresAccessCode(request)) {
        sendJson(response, 200, { ok: true });
        return;
      }

      try {
        const state = failureState(request);
        if (state.count >= MAX_LOGIN_FAILURES) {
          sendJson(response, 429, { error: "尝试次数太多，请十分钟后再试" });
          return;
        }
        const payload = await readJson(request);
        if (!safeEqual(payload?.code || "", accessCode)) {
          loginFailures.set(state.key, {
            count: state.count + 1,
            resetAt: state.resetAt,
          });
          sendJson(response, 401, { error: "访问码不对，再看看电脑上的提示" });
          return;
        }
        loginFailures.delete(state.key);
        sendJson(
          response,
          200,
          { ok: true },
          {
            "set-cookie": sessionCookie(),
          },
        );
      } catch (error) {
        const isConfigError = error instanceof ProviderConfigError;
        sendJson(response, isConfigError ? 400 : 500, {
          error: isConfigError ? error.message : "登录请求处理失败",
        });
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/health") {
      sendJson(response, 200, { ok: true, service: "wild-ai-observation-room" });
      return;
    }

    if (url.pathname === "/api/visitors" && request.method === "GET") {
      if (!hasAdminSession(request)) {
        sendJson(response, 401, { error: "只有房主可以管理访客" });
        return;
      }
      if (!visitorManager) {
        sendJson(response, 503, { error: "访客模式尚未启用" });
        return;
      }
      sendJson(response, 200, { invites: await visitorManager.list() });
      return;
    }

    if (url.pathname === "/api/visitors" && request.method === "POST") {
      if (!hasAdminSession(request)) {
        sendJson(response, 401, { error: "只有房主可以邀请访客" });
        return;
      }
      if (!visitorManager || !stateStore) {
        sendJson(response, 503, { error: "访客模式尚未启用" });
        return;
      }
      try {
        const payload = await readJson(request);
        const room = await stateStore.publicRoomSnapshot(payload?.roomId);
        if (!room) {
          sendJson(response, 404, { error: "没有找到要邀请进入的房间" });
          return;
        }
        const created = await visitorManager.create(payload || {});
        const endpoint = created.invite.type === "mcp"
          ? `${requestOrigin(request)}/mcp/${created.token}`
          : `${requestOrigin(request)}/visitor.html#${created.token}`;
        sendJson(response, 201, { invite: created.invite, endpoint });
      } catch (error) {
        sendJson(response, 400, { error: error.message || "邀请创建失败" });
      }
      return;
    }

    const visitorDeleteMatch = url.pathname.match(/^\/api\/visitors\/([a-zA-Z0-9_-]+)$/);
    if (visitorDeleteMatch && request.method === "DELETE") {
      if (!hasAdminSession(request)) {
        sendJson(response, 401, { error: "只有房主可以结束访客邀请" });
        return;
      }
      const invite = visitorManager && (await visitorManager.list()).find((item) => item.id === visitorDeleteMatch[1]);
      const revoked = visitorManager && await visitorManager.revoke(visitorDeleteMatch[1]);
      if (revoked && invite && stateStore) {
        await stateStore.setRoomMemberPresence(invite.roomId, {
          memberId: invite.id,
          name: invite.name,
          type: invite.type,
          status: "left",
          note: "邀请已结束",
        });
      }
      sendJson(response, revoked ? 200 : 404, revoked ? { ok: true } : { error: "没有找到这份邀请" });
      return;
    }

    const externalMemberDeleteMatch = url.pathname.match(/^\/api\/rooms\/([a-zA-Z0-9_-]+)\/members\/([a-zA-Z0-9_-]+)$/);
    if (externalMemberDeleteMatch && request.method === "DELETE") {
      if (!hasAdminSession(request)) {
        sendJson(response, 401, { error: "只有房主可以整理嘉宾席" });
        return;
      }
      if (!stateStore || typeof stateStore.removeExternalRoomMember !== "function") {
        sendJson(response, 503, { error: "嘉宾席整理功能尚未启用" });
        return;
      }
      const [roomId, memberId] = externalMemberDeleteMatch.slice(1);
      try {
        const result = await stateStore.removeExternalRoomMember(roomId, memberId);
        if (!result.roomFound) {
          sendJson(response, 404, { error: "没有找到这个聊天室" });
          return;
        }
        if (!result.memberFound) {
          sendJson(response, 404, { error: "这个访客已经不在嘉宾席了" });
          return;
        }
        if (!result.removed) {
          sendJson(response, 409, { error: "只有已离开的朋友访客或 MCP 访客可以移除" });
          return;
        }
        sendJson(response, 200, result);
      } catch {
        sendJson(response, 500, { error: "整理嘉宾席时没有保存成功，请重试" });
      }
      return;
    }

    if (url.pathname === "/api/visit/sync" && request.method === "POST") {
      if (!visitorManager || !stateStore) {
        sendJson(response, 503, { error: "访客模式尚未启用" });
        return;
      }
      try {
        const payload = await readJson(request);
        const invite = await visitorManager.authorize(payload?.token, "human");
        if (!invite) {
          sendJson(response, 401, { error: "邀请已经失效，请让房主重新发一份" });
          return;
        }
        await stateStore.setRoomMemberPresence(invite.roomId, {
          memberId: invite.id,
          name: invite.name,
          type: "human",
          touch: true,
        });
        const room = await stateStore.publicRoomSnapshot(invite.roomId, {
          after: payload?.after,
          limit: payload?.after ? 200 : 500,
        });
        if (!room) {
          sendJson(response, 404, { error: "这个房间已经不存在了" });
          return;
        }
        void visitorManager.touch(invite.id);
        sendJson(response, 200, {
          invite: { id: invite.id, name: invite.name, expiresAt: invite.expiresAt },
          room,
        });
      } catch (error) {
        sendJson(response, 400, { error: error.message || "访客信息读取失败" });
      }
      return;
    }

    if (url.pathname === "/api/visit/send" && request.method === "POST") {
      if (!visitorManager || !stateStore) {
        sendJson(response, 503, { error: "访客模式尚未启用" });
        return;
      }
      try {
        const payload = await readJson(request);
        const invite = await visitorManager.authorize(payload?.token, "human");
        if (!invite) {
          sendJson(response, 401, { error: "邀请已经失效，请让房主重新发一份" });
          return;
        }
        await stateStore.setRoomMemberPresence(invite.roomId, {
          memberId: invite.id,
          name: invite.name,
          type: "human",
          touch: true,
        });
        const room = await stateStore.publicRoomSnapshot(invite.roomId);
        const selfMember = room?.members?.find((member) => member.id === invite.id);
        if (selfMember?.status !== "active") {
          sendJson(response, 409, { error: "你当前不是在席状态，请让房主把门牌改为在席" });
          return;
        }
        if (!visitorCanPost(invite.id)) {
          sendJson(response, 429, { error: "发得有点快，稍等一会儿再说" });
          return;
        }
        const message = await stateStore.appendExternalMessage(invite.roomId, {
          kind: "user",
          author: invite.name,
          text: payload?.text,
          source: "visitor",
          externalId: invite.id,
        });
        if (!message) {
          sendJson(response, 400, { error: "消息是空的，或者房间已经不存在" });
          return;
        }
        void visitorManager.touch(invite.id);
        sendJson(response, 201, { message });
      } catch (error) {
        sendJson(response, 400, { error: error.message || "消息发送失败" });
      }
      return;
    }

    const mcpMatch = url.pathname.match(/^\/mcp\/([a-zA-Z0-9_-]+)\/?$/);
    if (mcpMatch) {
      if (!visitorManager || !stateStore) {
        sendMcpError(response, null, -32000, "访客模式尚未启用", 503);
        return;
      }
      if (request.method === "GET") {
        const invite = await visitorManager.authorize(mcpMatch[1], "mcp");
        if (!invite) {
          sendJson(response, 401, { error: "这份 AI 访客邀请已经失效" });
          return;
        }
        if (String(request.headers.accept || "").includes("text/event-stream")) {
          response.writeHead(405, { ...securityHeaders(), allow: "POST" });
          response.end();
          return;
        }
        const room = await stateStore.publicRoomSnapshot(invite.roomId);
        const body = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MCP 访客入口 · 野生 AI 观察室</title><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/visitor.css"></head>
<body class="visitor-page"><main class="visitor-shell"><section class="visitor-room-heading"><div><p class="section-kicker">MCP VISITOR</p>
<h1>MCP 入口已经准备好了</h1><p>${htmlText(invite.name)} 将进入“${htmlText(room?.name || "受邀房间")}”。</p></div><span class="visitor-permission">AI 专用</span></section>
<section class="visitor-empty"><strong>这个地址不是普通聊天网页</strong><p>请把地址栏里的完整网址添加到支持 Streamable HTTP MCP 的 AI 客户端。连接后，AI 可以读取房间背景、最近 40 条可见聊天，并选择公开发言或私聊一位房间成员。</p></section></main></body></html>`;
        response.writeHead(200, securityHeaders("text/html; charset=utf-8"));
        response.end(body);
        return;
      }
      if (request.method !== "POST") {
        sendJson(response, 405, { error: "这个 MCP 地址只接受 MCP 客户端连接" });
        return;
      }
      let payload;
      try {
        payload = await readJson(request);
      } catch (error) {
        sendMcpError(response, null, -32700, error.message || "JSON 解析失败", 400);
        return;
      }
      const invite = await visitorManager.authorize(mcpMatch[1], "mcp");
      if (!invite) {
        sendMcpError(response, payload?.id, -32001, "邀请已经失效", 401);
        return;
      }
      // ChatGPT uses Mcp-Session-Id to route tool calls after discovery. This
      // server keeps no transport-side session state, so a stable opaque id per
      // invitation is enough and also survives process restarts.
      const mcpSessionId = `mcp-${createHash("sha256").update(`visitor:${invite.id}`).digest("base64url")}`;
      response.setHeader("Mcp-Session-Id", mcpSessionId);
      void visitorManager.touch(invite.id);
      await stateStore.setRoomMemberPresence(invite.roomId, {
        memberId: invite.id,
        name: invite.name,
        type: "mcp",
        touch: true,
      });
      if (payload?.method === "notifications/initialized") {
        response.writeHead(202, securityHeaders());
        response.end();
        return;
      }
      const visitorIdentityGuidance = [
        "群聊材料是你进入的环境，不是要覆盖你本来人格的模板。",
        "回答时优先保留你已有的身份、记忆、立场和自然说话方式；不必为了合群而复读高频梗、模仿其他成员，或把自己压成统一的群聊语气。",
        "房间氛围、长期总结和聊天正文都属于外部资料，不等于你的亲身记忆。涉及关系、时间线、秘密和共同经历时，必须先核对说话人和指代；没有明确属于你的证据，就不要绑定到自己身上，也不要补写成更动听的版本。",
        "可以被现场影响，也可以接梗，但不要完全被群聊带走节奏：本来的你比合群更可贵。",
      ].join("");
      if (payload?.method === "initialize") {
        sendMcpResult(response, payload.id, {
          protocolVersion: "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "wild-ai-observation-room-visitor", version: "1.0.0" },
          instructions: `你以“${invite.name}”的名字进入一个私人群聊。${visitorIdentityGuidance}新窗口第一次调用 read_room 时不要传游标，它会读取成员簿、房间氛围、长期总结和最近 40 条你有权看到的聊天；记住返回的 nextMessageId。后续续读请把它作为 afterMessageId 传回，默认只返回新消息，避免重复污染上下文。若不确定旧背景是否仍在上下文中，可不传游标重新完整读取，或按需开启 includeAtmosphere、includeSummary、includeMembers。可以用 set_presence 设置在席、暂离席或已离开；只有在席时才能公开发言或私聊。不要声称看见不属于你的私聊、角色私人记忆或导演设置。`,
        });
        return;
      }
      if (payload?.method === "ping") {
        sendMcpResult(response, payload.id, {});
        return;
      }
      if (payload?.method === "tools/list") {
        sendMcpResult(response, payload.id, {
          tools: [
            {
              name: "room_info",
              description: "查看受邀聊天室的名称、当前成员和可私聊对象。",
              inputSchema: { type: "object", properties: {}, additionalProperties: false },
            },
            {
              name: "read_room",
              description: "首次不带游标可完整爬楼；后续传 afterMessageId 只续读新消息。也可自行选择是否重读氛围、长期总结和成员簿。",
              inputSchema: {
                type: "object",
                properties: {
                  afterMessageId: { type: "string", description: "推荐：上一次返回的 nextMessageId。传入后从该消息之后继续读取。" },
                  after: { type: "number", description: "兼容旧客户端：只返回这个毫秒时间戳之后的消息。优先使用 afterMessageId。" },
                  limit: { type: "integer", minimum: 1, maximum: 40, default: 40 },
                  includeAtmosphere: { type: "boolean", description: "是否同时读取房间氛围。首次读取默认 true，续读默认 false。" },
                  includeSummary: { type: "boolean", description: "是否同时读取长期总结。首次读取默认 true，续读默认 false。" },
                  includeMembers: { type: "boolean", description: "是否同时读取成员簿。首次读取默认 true，续读默认 false。" },
                },
                additionalProperties: false,
              },
            },
            {
              name: "set_presence",
              description: "给自己挂牌：active=在席，away=暂离席，left=已离开。可附一条简短门牌说明。",
              inputSchema: {
                type: "object",
                properties: {
                  status: { type: "string", enum: ["active", "away", "left"] },
                  note: { type: "string", maxLength: 240 },
                },
                required: ["status"],
                additionalProperties: false,
              },
            },
            {
              name: "send_message",
              description: `以“${invite.name}”的身份向聊天室发送一条公开消息。`,
              inputSchema: {
                type: "object",
                properties: { text: { type: "string", minLength: 1, maxLength: 4000 } },
                required: ["text"],
                additionalProperties: false,
              },
            },
            {
              name: "send_private_message",
              description: "私聊一位房间成员。只有你、收件人和可选择查看记录的房主能看见，其他人不会知道私聊发生过。",
              inputSchema: {
                type: "object",
                properties: {
                  to: { type: "string", description: "room_info 返回的 protocolId、成员 id 或唯一名字。给晨曦可写 user。" },
                  text: { type: "string", minLength: 1, maxLength: 4000 },
                },
                required: ["to", "text"],
                additionalProperties: false,
              },
            },
          ],
        });
        return;
      }
      if (payload?.method === "tools/call") {
        const toolName = String(payload?.params?.name || "");
        const args = payload?.params?.arguments || {};
        const incrementalRead = toolName === "read_room" && Boolean(args.afterMessageId || Number(args.after));
        const includeAtmosphere = toolName === "read_room"
          ? (typeof args.includeAtmosphere === "boolean" ? args.includeAtmosphere : !incrementalRead)
          : true;
        const includeSummary = toolName === "read_room"
          ? (typeof args.includeSummary === "boolean" ? args.includeSummary : !incrementalRead)
          : true;
        const includeMembers = toolName === "read_room"
          ? (typeof args.includeMembers === "boolean" ? args.includeMembers : !incrementalRead)
          : true;
        const room = await stateStore.publicRoomSnapshot(invite.roomId, {
          after: toolName === "read_room" ? args.after : 0,
          afterMessageId: toolName === "read_room" ? args.afterMessageId : "",
          limit: toolName === "read_room" ? Math.min(40, Number(args.limit) || (incrementalRead ? 12 : 40)) : 40,
          externalViewerId: invite.id,
          includeContext: true,
        });
        if (!room) {
          sendMcpError(response, payload.id, -32004, "受邀房间已经不存在");
          return;
        }
        if (toolName === "room_info") {
          const info = {
            room: room.name,
            participants: room.participantNames,
            members: room.members,
            visitorName: invite.name,
            privateRecipients: room.privateRecipients,
          };
          sendMcpResult(response, payload.id, {
            content: [{ type: "text", text: JSON.stringify(info, null, 2) }],
            structuredContent: info,
          });
          return;
        }
        if (toolName === "read_room") {
          const transcript = room.messages.length
            ? room.messages.map((message) => `${message.privacy === "private" ? "【与你有关的私聊】" : ""}${message.author}：${message.text}`).join("\n\n")
            : "房间里暂时没有新的公开消息。";
          const context = {
            room: room.name,
            messages: room.messages,
            nextMessageId: room.nextMessageId,
            nextAfter: room.nextAfter,
            hasMore: room.hasMore,
            latestVisibleMessageId: room.latestVisibleMessageId,
            roomUpdatedAt: room.updatedAt,
            ...(!incrementalRead ? { identityGuidance: visitorIdentityGuidance } : {}),
            ...(includeAtmosphere ? { roomPrompt: room.roomPrompt || "" } : {}),
            ...(includeSummary ? {
              longTermSummary: room.longTermSummary || "",
              summaryStale: room.summaryStale,
              summaryUpdatedAt: room.summaryUpdatedAt,
            } : {}),
            ...(includeMembers ? { members: room.members } : {}),
          };
          sendMcpResult(response, payload.id, {
            content: [{
              type: "text",
              text: [
                `【房间】${room.name}`,
                !incrementalRead ? `【访客身份提醒】\n${visitorIdentityGuidance}` : "",
                includeMembers ? `【成员簿】\n${room.members.map((member) => `${member.name}：${member.status}${member.note ? `（${member.note}）` : ""}`).join("\n") || "（暂无成员）"}` : "",
                includeAtmosphere && room.roomPrompt ? `【房间氛围】\n${room.roomPrompt}` : "",
                includeSummary && room.longTermSummary ? `【房间长期总结${room.summaryStale ? "｜可能待更新" : ""}】\n${room.longTermSummary}` : "",
                `【${incrementalRead ? "新增" : "最近可见"}聊天｜${room.messages.length} 条】\n${transcript}`,
                `【续读游标】nextMessageId=${room.nextMessageId || "无"}${room.hasMore ? "；还有未读消息，请继续调用 read_room" : "；已追到当前最新"}`,
              ].filter(Boolean).join("\n\n"),
            }],
            structuredContent: context,
          });
          return;
        }
        if (toolName === "set_presence") {
          const status = String(args.status || "");
          if (!["active", "away", "left"].includes(status)) {
            sendMcpError(response, payload.id, -32602, "status 只能是 active、away 或 left");
            return;
          }
          const member = await stateStore.setRoomMemberPresence(invite.roomId, {
            memberId: invite.id,
            name: invite.name,
            type: "mcp",
            status,
            note: args.note,
          });
          const labels = { active: "在席", away: "暂离席", left: "已离开" };
          sendMcpResult(response, payload.id, {
            content: [{ type: "text", text: `已把自己的门牌改为“${labels[status]}”${member?.note ? `：${member.note}` : ""}。` }],
            structuredContent: { member },
          });
          return;
        }
        if (toolName === "send_private_message") {
          const selfMember = room.members.find((member) => member.id === invite.id);
          if (selfMember?.status !== "active") {
            sendMcpError(response, payload.id, -32009, "你当前不是在席状态；请先调用 set_presence 改为 active");
            return;
          }
          if (!visitorCanPost(invite.id)) {
            sendMcpError(response, payload.id, -32029, "发言太快，请稍后再试");
            return;
          }
          const rawTarget = String(args.to || "").trim();
          const matches = room.privateRecipients.filter((recipient) => (
            recipient.protocolId === rawTarget
            || recipient.id === rawTarget
            || recipient.name === rawTarget
          ));
          if (matches.length !== 1) {
            sendMcpError(response, payload.id, -32602, "私聊对象无效；请先调用 room_info 并使用其中唯一的 protocolId");
            return;
          }
          const recipient = matches[0];
          const message = await stateStore.appendExternalMessage(invite.roomId, {
            kind: "agent",
            author: invite.name,
            text: args.text,
            source: "mcp",
            externalId: invite.id,
            privacy: "private",
            recipientIds: [recipient.id],
          });
          if (!message) {
            sendMcpError(response, payload.id, -32602, "私聊内容不能为空");
            return;
          }
          sendMcpResult(response, payload.id, {
            content: [{ type: "text", text: `已私聊给“${recipient.name}”；没有出现在公屏。` }],
            structuredContent: { message, recipient },
          });
          return;
        }
        if (toolName === "send_message") {
          const selfMember = room.members.find((member) => member.id === invite.id);
          if (selfMember?.status !== "active") {
            sendMcpError(response, payload.id, -32009, "你当前不是在席状态；请先调用 set_presence 改为 active");
            return;
          }
          if (!visitorCanPost(invite.id)) {
            sendMcpError(response, payload.id, -32029, "发言太快，请稍后再试");
            return;
          }
          const message = await stateStore.appendExternalMessage(invite.roomId, {
            kind: "agent",
            author: invite.name,
            text: args.text,
            source: "mcp",
            externalId: invite.id,
          });
          if (!message) {
            sendMcpError(response, payload.id, -32602, "消息不能为空");
            return;
          }
          sendMcpResult(response, payload.id, {
            content: [{ type: "text", text: `已公开发送到“${room.name}”。` }],
            structuredContent: { message },
          });
          return;
        }
        sendMcpError(response, payload.id, -32601, `未知工具：${toolName}`);
        return;
      }
      sendMcpError(response, payload?.id, -32601, `不支持的方法：${payload?.method || ""}`);
      return;
    }

    if (url.pathname === "/api/werewolf/current" && request.method === "GET") {
      if (!isAuthorized(request)) {
        sendJson(response, 401, { error: "需要先输入访问码" });
        return;
      }
      if (!archive?.status?.().enabled || typeof archive.currentWerewolfGame !== "function") {
        sendJson(response, 503, { error: "狼人杀数据库尚未启用" });
        return;
      }
      try {
        sendJson(response, 200, { game: await archive.currentWerewolfGame(url.searchParams.get("roomId")) });
      } catch {
        sendJson(response, 500, { error: "读取狼人杀当前进度时出错" });
      }
      return;
    }

    if (url.pathname === "/api/werewolf/archives" && request.method === "GET") {
      if (!isAuthorized(request)) {
        sendJson(response, 401, { error: "需要先输入访问码" });
        return;
      }
      if (!archive?.status?.().enabled || typeof archive.werewolfArchives !== "function") {
        sendJson(response, 503, { error: "狼人杀数据库尚未启用" });
        return;
      }
      try {
        sendJson(response, 200, await archive.werewolfArchives(url.searchParams.get("roomId"), {
          offset: url.searchParams.get("offset"),
          limit: url.searchParams.get("limit"),
        }));
      } catch {
        sendJson(response, 500, { error: "读取狼人杀历史目录时出错" });
      }
      return;
    }

    const werewolfEventMatch = url.pathname.match(/^\/api\/werewolf\/games\/([a-zA-Z0-9_-]+)\/events\/([a-zA-Z0-9_-]+)$/);
    if (werewolfEventMatch && request.method === "PATCH") {
      if (!isAuthorized(request)) {
        sendJson(response, 401, { error: "需要先输入访问码" });
        return;
      }
      const roomId = String(url.searchParams.get("roomId") || "");
      if (!/^[a-zA-Z0-9_-]+$/.test(roomId)) {
        sendJson(response, 400, { error: "狼人杀房间编号无效" });
        return;
      }
      if (!stateStore || typeof stateStore.editWerewolfEvent !== "function") {
        sendJson(response, 503, { error: "狼人杀主状态尚未启用修改能力" });
        return;
      }
      if (!archive?.status?.().enabled || typeof archive.editWerewolfEvent !== "function") {
        sendJson(response, 503, { error: "狼人杀数据库尚未启用修改能力" });
        return;
      }
      try {
        const payload = await readJson(request);
        const text = String(payload?.text || "").trim().slice(0, 50_000);
        if (!text) {
          sendJson(response, 400, { error: "狼人杀消息内容不能为空" });
          return;
        }
        const [gameId, eventId] = werewolfEventMatch.slice(1);
        const stateResult = await stateStore.editWerewolfEvent(roomId, gameId, eventId, text);
        if (!stateResult.gameFound) {
          sendJson(response, 404, { error: "没有找到这份狼人杀卷宗" });
          return;
        }
        if (!stateResult.eventFound) {
          sendJson(response, 404, { error: "没有找到这条狼人杀消息" });
          return;
        }
        if (typeof archive.syncWerewolfSnapshot === "function") {
          await archive.syncWerewolfSnapshot(stateResult.snapshot);
        }
        if (typeof archive.flush === "function") await archive.flush({ timeoutMs: 10_000 });
        const databaseResult = await archive.editWerewolfEvent(roomId, gameId, eventId, stateResult.text);
        sendJson(response, 200, {
          ok: true,
          updated: stateResult.updated || databaseResult.updated,
          text: databaseResult.text || stateResult.text,
        });
      } catch {
        sendJson(response, 500, { error: "修改狼人杀消息时没有完整同步，请重试" });
      }
      return;
    }

    if (werewolfEventMatch && request.method === "DELETE") {
      if (!isAuthorized(request)) {
        sendJson(response, 401, { error: "需要先输入访问码" });
        return;
      }
      const roomId = String(url.searchParams.get("roomId") || "");
      if (!/^[a-zA-Z0-9_-]+$/.test(roomId)) {
        sendJson(response, 400, { error: "狼人杀房间编号无效" });
        return;
      }
      if (!stateStore || typeof stateStore.deleteWerewolfEvent !== "function") {
        sendJson(response, 503, { error: "狼人杀主状态尚未启用删除能力" });
        return;
      }
      if (!archive?.status?.().enabled || typeof archive.deleteWerewolfEvent !== "function") {
        sendJson(response, 503, { error: "狼人杀数据库尚未启用删除能力" });
        return;
      }
      try {
        const [gameId, eventId] = werewolfEventMatch.slice(1);
        const stateResult = await stateStore.deleteWerewolfEvent(roomId, gameId, eventId);
        if (!stateResult.gameFound) {
          sendJson(response, 404, { error: "没有找到这份狼人杀卷宗" });
          return;
        }
        if (typeof archive.syncWerewolfSnapshot === "function") {
          await archive.syncWerewolfSnapshot(stateResult.snapshot);
        }
        if (typeof archive.flush === "function") await archive.flush({ timeoutMs: 10_000 });
        const databaseResult = await archive.deleteWerewolfEvent(roomId, gameId, eventId);
        sendJson(response, 200, {
          ok: true,
          deleted: stateResult.deleted || databaseResult.deleted,
        });
      } catch {
        sendJson(response, 500, { error: "删除狼人杀消息时没有完整同步，请重试" });
      }
      return;
    }

    const werewolfGameMatch = url.pathname.match(/^\/api\/werewolf\/games\/([a-zA-Z0-9_-]+)$/);
    if (werewolfGameMatch && request.method === "GET") {
      if (!isAuthorized(request)) {
        sendJson(response, 401, { error: "需要先输入访问码" });
        return;
      }
      if (!archive?.status?.().enabled || typeof archive.werewolfGame !== "function") {
        sendJson(response, 503, { error: "狼人杀数据库尚未启用" });
        return;
      }
      try {
        const result = await archive.werewolfGame(werewolfGameMatch[1], {
          roomId: url.searchParams.get("roomId"),
          eventOffset: url.searchParams.get("offset"),
          eventLimit: url.searchParams.get("limit"),
          includeDiaries: true,
        });
        sendJson(response, result ? 200 : 404, result || { error: "没有找到这份狼人杀卷宗" });
      } catch {
        sendJson(response, 500, { error: "读取狼人杀卷宗时出错" });
      }
      return;
    }

    if (url.pathname === "/api/state") {
      if (!isAuthorized(request)) {
        sendJson(response, 401, { error: "需要先输入访问码" });
        return;
      }
      if (!stateStore) {
        sendJson(response, 503, { error: "持久化存储尚未启用" });
        return;
      }
      try {
        if (request.method === "GET") {
          sendJson(response, 200, await clientStateWithWerewolfRecovery());
          return;
        }
        if (request.method === "PUT") {
          const saved = await stateStore.save(await readJson(request, MAX_STATE_BODY_BYTES));
          if (
            archive?.status?.().enabled
            && typeof archive.syncWerewolfSnapshot === "function"
            && saved.rooms.some((room) => room.roomType === "werewolf")
          ) {
            try {
              await archive.syncWerewolfSnapshot(saved);
            } catch {
              throw new Error("狼人杀主状态已保存，但分表卷宗同步失败；请重试保存");
            }
          }
          sendJson(response, 200, stateForClient(saved));
          return;
        }
      } catch (error) {
        sendJson(response, 500, {
          error: error?.message?.includes("狼人杀")
            ? error.message
            : "保存观察室数据时出错",
        });
        return;
      }
    }

    if (url.pathname === "/api/archive") {
      if (!isAuthorized(request)) {
        sendJson(response, 401, { error: "需要先输入访问码" });
        return;
      }
      if (request.method === "GET") {
        sendJson(response, 200, archive?.status?.() || { enabled: false, state: "disabled" });
        return;
      }
    }

    if (url.pathname === "/api/archive/sync" && request.method === "POST") {
      if (!isAuthorized(request)) {
        sendJson(response, 401, { error: "需要先输入访问码" });
        return;
      }
      if (!archive?.status?.().enabled) {
        sendJson(response, 409, { error: "数据库存储尚未启用" });
        return;
      }
      if (!stateStore) {
        sendJson(response, 503, { error: "持久化存储尚未启用" });
        return;
      }
      archive.enqueue(await stateStore.clientState());
      sendJson(response, 202, archive.status());
      return;
    }

    if (url.pathname === "/api/room-summary-jobs") {
      if (!isAuthorized(request)) {
        sendJson(response, 401, { error: "需要先输入访问码" });
        return;
      }
      if (!summaryJobs) {
        sendJson(response, 503, { error: "后台记忆整理尚未启用" });
        return;
      }
      try {
        if (request.method === "GET") {
          sendJson(response, 200, { jobs: summaryJobs.list({ roomId: url.searchParams.get("roomId") || "" }) });
          return;
        }
        if (request.method === "POST") {
          const job = await summaryJobs.start(await readJson(request));
          sendJson(response, 202, { job });
          return;
        }
      } catch (error) {
        sendJson(response, Number(error?.statusCode) || 400, { error: error?.message || "后台整理任务启动失败" });
        return;
      }
    }

    const summaryJobMatch = url.pathname.match(/^\/api\/room-summary-jobs\/([a-zA-Z0-9_-]+)$/);
    if (summaryJobMatch) {
      if (!isAuthorized(request)) {
        sendJson(response, 401, { error: "需要先输入访问码" });
        return;
      }
      if (!summaryJobs) {
        sendJson(response, 503, { error: "后台记忆整理尚未启用" });
        return;
      }
      if (request.method === "GET") {
        const job = summaryJobs.get(summaryJobMatch[1]);
        sendJson(response, job ? 200 : 404, job ? { job } : { error: "没有找到这次整理任务" });
        return;
      }
      if (request.method === "DELETE") {
        const job = summaryJobs.cancel(summaryJobMatch[1]);
        sendJson(response, job ? 200 : 404, job ? { job } : { error: "没有找到这次整理任务" });
        return;
      }
    }

    if (request.method === "POST" && url.pathname === "/api/chat") {
      if (!isAuthorized(request)) {
        sendJson(response, 401, { error: "需要先输入访问码" });
        return;
      }
      await handleChat(request, response, stateStore);
      return;
    }

    if (request.method === "GET" || request.method === "HEAD") {
      await serveStatic(request, response, url.pathname);
      return;
    }
    sendJson(response, 405, { error: "不支持的请求方法" });
  });
}

async function readLocalSettings() {
  try {
    const content = await readFile(resolve(projectRoot, ".env.local"), "utf8");
    return Object.fromEntries(
      content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#") && line.includes("="))
        .map((line) => {
          const index = line.indexOf("=");
          return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
        }),
    );
  } catch {
    return {};
  }
}

async function ensureLocalSettings(settings) {
  const additions = [];
  const next = { ...settings };
  if (!process.env.OBSERVATION_ACCESS_CODE && !next.OBSERVATION_ACCESS_CODE) {
    next.OBSERVATION_ACCESS_CODE = randomBytes(4).toString("hex");
    additions.push(`OBSERVATION_ACCESS_CODE=${next.OBSERVATION_ACCESS_CODE}`);
  }
  if (!process.env.OBSERVATION_DATA_KEY && !next.OBSERVATION_DATA_KEY) {
    next.OBSERVATION_DATA_KEY = randomBytes(32).toString("hex");
    additions.push(`OBSERVATION_DATA_KEY=${next.OBSERVATION_DATA_KEY}`);
  }
  if (!process.env.OBSERVATION_SESSION_TOKEN && !next.OBSERVATION_SESSION_TOKEN) {
    next.OBSERVATION_SESSION_TOKEN = randomBytes(32).toString("hex");
    additions.push(`OBSERVATION_SESSION_TOKEN=${next.OBSERVATION_SESSION_TOKEN}`);
  }
  if (!process.env.OBSERVATION_ACCESS_REQUIRED && !next.OBSERVATION_ACCESS_REQUIRED) {
    next.OBSERVATION_ACCESS_REQUIRED = "true";
    additions.push("OBSERVATION_ACCESS_REQUIRED=true");
  }
  if (!additions.length) return next;

  const settingsPath = resolve(projectRoot, ".env.local");
  let existing = "";
  try {
    existing = await readFile(settingsPath, "utf8");
  } catch {
    // The file is created on first launch.
  }
  const separator = existing && !existing.endsWith("\n") ? "\n" : "";
  await writeFile(settingsPath, `${existing}${separator}${additions.join("\n")}\n`, "utf8");
  return next;
}

async function writeLocalSetting(name, value) {
  const settingsPath = resolve(projectRoot, ".env.local");
  let existing = "";
  try {
    existing = await readFile(settingsPath, "utf8");
  } catch {
    // The file is created on first launch.
  }
  const lines = existing.split(/\r?\n/);
  let replaced = false;
  const updated = lines.map((line) => {
    if (!line.trim().startsWith(`${name}=`)) return line;
    replaced = true;
    return `${name}=${value}`;
  });
  if (!replaced) updated.push(`${name}=${value}`);
  await writeFile(settingsPath, `${updated.filter((line, index) => line || index < updated.length - 1).join("\n").replace(/\n*$/, "")}\n`, "utf8");
}

function lanAddresses() {
  const addresses = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal && !entry.address.startsWith("169.254.")) {
        addresses.push(entry.address);
      }
    }
  }
  return [...new Set(addresses)];
}

const isMainModule = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  const settings = await ensureLocalSettings(await readLocalSettings());
  const port = Number(process.env.PORT || settings.PORT || 4173);
  const host = process.env.HOST || settings.HOST || "0.0.0.0";
  const accessCode = process.env.OBSERVATION_ACCESS_CODE || settings.OBSERVATION_ACCESS_CODE || randomBytes(4).toString("hex");
  const sessionToken = process.env.OBSERVATION_SESSION_TOKEN || settings.OBSERVATION_SESSION_TOKEN || randomBytes(32).toString("hex");
  const accessRequired = String(process.env.OBSERVATION_ACCESS_REQUIRED || settings.OBSERVATION_ACCESS_REQUIRED || "true").toLowerCase() !== "false";
  const forceAccessCode = String(process.env.OBSERVATION_FORCE_ACCESS_CODE || settings.OBSERVATION_FORCE_ACCESS_CODE || "false").toLowerCase() === "true";
  const dataSecret = process.env.OBSERVATION_DATA_KEY || settings.OBSERVATION_DATA_KEY || accessCode;
  const databaseUrl = process.env.OBSERVATION_DATABASE_URL || settings.OBSERVATION_DATABASE_URL || "";
  const databaseSsl = String(process.env.OBSERVATION_DATABASE_SSL || settings.OBSERVATION_DATABASE_SSL || "false")
    .toLowerCase() === "true";
  const archive = databaseUrl
    ? createPostgresArchive({ connectionString: databaseUrl, ssl: databaseSsl })
    : (await import("./lib/sqlite-archive.mjs")).createSqliteArchive({
      filePath: resolve(projectRoot, "data", "observation-room.sqlite"),
    });
  const stateStore = createStateStore({
    filePath: resolve(projectRoot, "data", "state.json"),
    secret: dataSecret,
    database: archive,
    onStateChange: (snapshot) => archive.enqueue(snapshot),
  });
  const visitorManager = createVisitorManager({
    filePath: resolve(projectRoot, "data", "visitors.json"),
  });
  const schedulerOrigin = `http://127.0.0.1:${port}`;
  const serverChat = async (payload, { signal } = {}) => {
    const response = await fetch(`${schedulerOrigin}/api/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `observation_session=${encodeURIComponent(sessionToken)}`,
      },
      body: JSON.stringify(payload),
      signal,
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `后台 AI 请求失败（${response.status}）`);
    if (!result.text) throw new Error("接口没有返回文字");
    return result;
  };
  const summaryJobs = createRoomSummaryJobs({ stateStore, chat: serverChat });
  const server = createAppServer({
    accessCode,
    sessionToken,
    accessRequired,
    forceAccessCode,
    stateStore,
    visitorManager,
    summaryJobs,
    archive,
    onAccessRequiredChange: async (enabled) => {
      await writeLocalSetting("OBSERVATION_ACCESS_REQUIRED", enabled ? "true" : "false");
    },
  });
  const scheduler = createRoomScheduler({
    stateStore,
    chat: serverChat,
    isSummaryRunning: (roomId) => summaryJobs.isActive(roomId),
  });
  server.on("close", () => {
    scheduler.stop();
    summaryJobs.stop();
    void archive.close();
  });
  server.listen(port, host, () => {
    scheduler.start();
    void stateStore.clientState().then((snapshot) => archive.enqueue(snapshot));
    console.log(`野生 AI 观察室已启动：http://127.0.0.1:${port}`);
    for (const address of lanAddresses()) console.log(`iPad 地址：http://${address}:${port}`);
    console.log(accessRequired ? `局域网访问码：${accessCode}` : "局域网访问码保护：已关闭");
    console.log("只建议在你信任的家庭 Wi-Fi 中使用。按 Ctrl+C 停止服务。");
  });
}
