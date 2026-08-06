const FORMATS = new Set(["openai", "anthropic", "gemini"]);
const AUTH_TYPES = new Set([
  "bearer",
  "x-api-key",
  "x-goog-api-key",
  "custom",
  "none",
]);

export class ProviderConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProviderConfigError";
  }
}

function cleanBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw new ProviderConfigError("Base URL 不是有效的网址");
  }

  if (!new Set(["http:", "https:"]).has(url.protocol)) {
    throw new ProviderConfigError("Base URL 只支持 http 或 https");
  }
  return url;
}

function appendPath(url, suffix) {
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = `${path}${suffix}`.replace(/\/{2,}/g, "/");
  return url.toString();
}

export function resolveEndpoint(format, baseUrl, model) {
  if (!FORMATS.has(format)) {
    throw new ProviderConfigError("未知的接口格式");
  }

  const url = cleanBaseUrl(baseUrl);
  const path = url.pathname.replace(/\/+$/, "");

  if (format === "openai") {
    if (/\/chat\/completions$/i.test(path)) return url.toString();
    return appendPath(url, /\/v1$/i.test(path) ? "/chat/completions" : "/v1/chat/completions");
  }

  if (format === "anthropic") {
    if (/\/messages$/i.test(path)) return url.toString();
    return appendPath(url, /\/v1$/i.test(path) ? "/messages" : "/v1/messages");
  }

  if (!String(model || "").trim()) {
    throw new ProviderConfigError("Gemini 格式需要填写模型名");
  }
  if (/:generateContent$/i.test(path)) return url.toString();
  if (/\/models\/[^/]+$/i.test(path)) return appendPath(url, ":generateContent");
  const modelPath = `/models/${encodeURIComponent(String(model).trim())}:generateContent`;
  return appendPath(url, /\/(v1|v1beta)$/i.test(path) ? modelPath : `/v1beta${modelPath}`);
}

function parseExtraHeaders(rawValue) {
  if (!String(rawValue || "").trim()) return {};
  let value;
  try {
    value = JSON.parse(rawValue);
  } catch {
    throw new ProviderConfigError("额外请求头必须是有效的 JSON");
  }
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new ProviderConfigError("额外请求头必须是 JSON 对象");
  }

  const blocked = new Set(["host", "content-length", "connection"]);
  const headers = {};
  for (const [key, headerValue] of Object.entries(value)) {
    if (blocked.has(key.toLowerCase())) continue;
    if (typeof headerValue !== "string") {
      throw new ProviderConfigError(`请求头 ${key} 的值必须是字符串`);
    }
    headers[key] = headerValue;
  }
  return headers;
}

function buildHeaders(agent) {
  const authType = agent.authType || "bearer";
  if (!AUTH_TYPES.has(authType)) {
    throw new ProviderConfigError("未知的鉴权方式");
  }

  const headers = {
    "content-type": "application/json",
    accept: "application/json",
    ...parseExtraHeaders(agent.extraHeaders),
  };

  if (authType !== "none") {
    const apiKey = String(agent.apiKey || "").trim();
    if (!apiKey) throw new ProviderConfigError("API Key 还没有填写");
    if (authType === "bearer") headers.authorization = `Bearer ${apiKey}`;
    if (authType === "x-api-key") headers["x-api-key"] = apiKey;
    if (authType === "x-goog-api-key") headers["x-goog-api-key"] = apiKey;
    if (authType === "custom") {
      const headerName = String(agent.customHeader || "").trim();
      if (!headerName) throw new ProviderConfigError("请填写自定义鉴权请求头名称");
      headers[headerName] = apiKey;
    }
  }

  if (agent.format === "anthropic" && !headers["anthropic-version"]) {
    headers["anthropic-version"] = "2023-06-01";
  }
  return headers;
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      return part?.text || part?.content || "";
    })
    .filter(Boolean)
    .join("\n");
}

export function buildUpstreamRequest(agent, messages, options = {}) {
  const format = String(agent.format || "openai");
  const model = String(agent.model || "").trim();
  if (!model) throw new ProviderConfigError("模型名还没有填写");
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new ProviderConfigError("没有可发送的消息");
  }

  const temperature = Number.isFinite(Number(options.temperature))
    ? Math.min(2, Math.max(0, Number(options.temperature)))
    : 0.8;
  const minimumMaxTokens = options.compactOutput === true ? 1 : 64;
  const maxTokens = Number.isFinite(Number(options.maxTokens))
    ? Math.min(32768, Math.max(minimumMaxTokens, Math.round(Number(options.maxTokens))))
    : 900;

  const endpoint = resolveEndpoint(format, agent.baseUrl, model);
  const headers = buildHeaders({ ...agent, format });
  let body;

  if (format === "openai") {
    body = {
      model,
      messages: messages.map(({ role, content }) => ({ role, content })),
      temperature,
      max_tokens: maxTokens,
      stream: false,
    };
    if (new Set(["enabled", "disabled"]).has(options.thinkingMode)) {
      body.thinking = { type: options.thinkingMode };
    }
  } else if (format === "anthropic") {
    const system = messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");
    const conversation = messages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        role: message.role === "assistant" ? "assistant" : "user",
        content: message.content,
      }));
    body = { model, messages: conversation, max_tokens: maxTokens, temperature };
    if (system) body.system = system;
  } else {
    const systemText = messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");
    body = {
      contents: messages
        .filter((message) => message.role !== "system")
        .map((message) => ({
          role: message.role === "assistant" ? "model" : "user",
          parts: [{ text: message.content }],
        })),
      generationConfig: {
        temperature,
        maxOutputTokens: maxTokens,
      },
    };
    if (systemText) body.systemInstruction = { parts: [{ text: systemText }] };
  }

  return { endpoint, headers, body };
}

export function parseProviderResponse(format, payload) {
  let text = "";
  if (format === "openai") {
    text =
      contentText(payload?.choices?.[0]?.message?.content) ||
      contentText(payload?.choices?.[0]?.text) ||
      contentText(payload?.output_text);
  } else if (format === "anthropic") {
    text = contentText(payload?.content) || contentText(payload?.completion);
  } else if (format === "gemini") {
    text = contentText(payload?.candidates?.[0]?.content?.parts);
  }

  if (!text) {
    text =
      contentText(payload?.message?.content) ||
      contentText(payload?.data?.choices?.[0]?.message?.content) ||
      contentText(payload?.response);
  }
  if (!String(text).trim()) {
    throw new Error("上游返回成功，但没有找到文本内容");
  }
  return String(text).trim();
}

export function providerFinishReason(format, payload) {
  if (format === "openai") {
    return payload?.choices?.[0]?.finish_reason || null;
  }
  if (format === "anthropic") {
    const reason = payload?.stop_reason;
    if (reason === "max_tokens") return "length";
    return reason || null;
  }
  if (format === "gemini") {
    const reason = payload?.candidates?.[0]?.finishReason;
    if (reason === "MAX_TOKENS") return "length";
    if (reason === "STOP") return "stop";
    return reason ? String(reason).toLowerCase() : null;
  }
  return null;
}

export function providerErrorMessage(payload, fallback) {
  const message =
    payload?.error?.message ||
    payload?.error?.details ||
    payload?.message ||
    payload?.detail ||
    fallback;
  return String(message || "上游接口返回错误").slice(0, 800);
}
