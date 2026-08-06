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

const projectRoot = fileURLToPath(new URL(".", import.meta.url));
const publicRoot = resolve(projectRoot, "public");
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const MAX_LOGIN_FAILURES = 8;
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

async function readJson(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new ProviderConfigError("请求内容太大");
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

export function chatRequestPolicy(agent, payload = {}) {
  const isWillingnessScore = payload.requestMode === "willingness-score";
  const minimumTokens = isWillingnessScore ? 1 : 64;
  const maximumTokens = isWillingnessScore ? 64 : 4096;
  const visibleTokenTarget = Number.isFinite(Number(payload.maxTokens))
    ? Math.min(maximumTokens, Math.max(minimumTokens, Math.round(Number(payload.maxTokens))))
    : isWillingnessScore ? 8 : 300;
  const officialDeepSeek = isOfficialDeepSeekV4(agent);
  const usesDeepSeekThinking = officialDeepSeek && !isWillingnessScore;
  return {
    isWillingnessScore,
    visibleTokenTarget,
    upstreamMaxTokens: usesDeepSeekThinking ? Math.max(8192, visibleTokenTarget) : visibleTokenTarget,
    thinkingMode: officialDeepSeek ? (usesDeepSeekThinking ? "enabled" : "disabled") : undefined,
    timeoutMs: isWillingnessScore ? 30_000 : usesDeepSeekThinking ? 180_000 : 120_000,
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
    const upstream = buildUpstreamRequest(agent, messages, {
      temperature,
      // DeepSeek counts hidden reasoning and visible content against one output
      // budget. Keep the director's number as a visible-answer target and give
      // the official V4 endpoint a separate ceiling for its reasoning.
      maxTokens: policy.upstreamMaxTokens,
      thinkingMode: policy.thinkingMode,
      compactOutput: policy.isWillingnessScore,
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), policy.timeoutMs);
    request.once("aborted", () => controller.abort());

    let upstreamResponse;
    try {
      upstreamResponse = await fetch(upstream.endpoint, {
        method: "POST",
        headers: upstream.headers,
        body: JSON.stringify(upstream.body),
        signal: controller.signal,
        redirect: "error",
      });
    } finally {
      clearTimeout(timeout);
    }

    const raw = await upstreamResponse.text();
    let upstreamPayload = {};
    try {
      upstreamPayload = raw ? JSON.parse(raw) : {};
    } catch {
      upstreamPayload = { message: raw.slice(0, 800) };
    }

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

    const finishReason = providerFinishReason(agent.format, upstreamPayload);
    let text;
    try {
      text = parseProviderResponse(agent.format, upstreamPayload);
    } catch (error) {
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
  const stateStore = options.stateStore || null;
  const loginFailures = new Map();

  function requiresAccessCode(request) {
    return forceAccessCode || !isLoopbackAddress(request.socket.remoteAddress);
  }

  function isAuthorized(request) {
    if (!requiresAccessCode(request)) return true;
    return safeEqual(cookieValue(request, "observation_session"), sessionToken);
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
      });
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
            "set-cookie": `observation_session=${encodeURIComponent(sessionToken)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`,
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
          sendJson(response, 200, await stateStore.clientState());
          return;
        }
        if (request.method === "PUT") {
          sendJson(response, 200, await stateStore.save(await readJson(request)));
          return;
        }
      } catch {
        sendJson(response, 500, { error: "保存观察室数据时出错" });
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
  const dataSecret = process.env.OBSERVATION_DATA_KEY || settings.OBSERVATION_DATA_KEY || accessCode;
  const stateStore = createStateStore({
    filePath: resolve(projectRoot, "data", "state.json"),
    secret: dataSecret,
  });
  const server = createAppServer({ accessCode, stateStore });
  const schedulerOrigin = `http://127.0.0.1:${port}`;
  const scheduler = createRoomScheduler({
    stateStore,
    chat: async (payload) => {
      const response = await fetch(`${schedulerOrigin}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || `定时聊天请求失败（${response.status}）`);
      if (!result.text) throw new Error("接口没有返回文字");
      return result;
    },
  });
  server.on("close", () => scheduler.stop());
  server.listen(port, host, () => {
    scheduler.start();
    console.log(`野生 AI 观察室已启动：http://127.0.0.1:${port}`);
    for (const address of lanAddresses()) console.log(`iPad 地址：http://${address}:${port}`);
    console.log(`局域网访问码：${accessCode}`);
    console.log("只建议在你信任的家庭 Wi-Fi 中使用。按 Ctrl+C 停止服务。");
  });
}
