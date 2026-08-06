import assert from "node:assert/strict";
import test from "node:test";
import {
  buildUpstreamRequest,
  parseProviderResponse,
  providerFinishReason,
  resolveEndpoint,
} from "../lib/providers.mjs";

test("为三种兼容格式补全常见接口路径", () => {
  assert.equal(
    resolveEndpoint("openai", "https://gateway.example/v1", "model-a"),
    "https://gateway.example/v1/chat/completions",
  );
  assert.equal(
    resolveEndpoint("anthropic", "https://gateway.example/v1", "model-b"),
    "https://gateway.example/v1/messages",
  );
  assert.equal(
    resolveEndpoint("gemini", "https://gateway.example/v1beta", "gemini-2.5-pro"),
    "https://gateway.example/v1beta/models/gemini-2.5-pro:generateContent",
  );
});

test("完整接口地址保持不变", () => {
  assert.equal(
    resolveEndpoint("openai", "https://gateway.example/custom/chat/completions", "model-a"),
    "https://gateway.example/custom/chat/completions",
  );
  assert.equal(
    resolveEndpoint(
      "gemini",
      "https://gateway.example/v1beta/models/gemini-pro:generateContent",
      "gemini-pro",
    ),
    "https://gateway.example/v1beta/models/gemini-pro:generateContent",
  );
});

test("OpenAI 兼容请求使用 Bearer 鉴权且不改写消息", () => {
  const request = buildUpstreamRequest(
    {
      format: "openai",
      baseUrl: "https://gateway.example/v1",
      model: "model-a",
      authType: "bearer",
      apiKey: "secret-value",
    },
    [
      { role: "system", content: "system" },
      { role: "user", content: "hello" },
    ],
    { temperature: 0.7, maxTokens: 512 },
  );
  assert.equal(request.headers.authorization, "Bearer secret-value");
  assert.equal(request.body.model, "model-a");
  assert.equal(request.body.max_tokens, 512);
  assert.deepEqual(request.body.messages[1], { role: "user", content: "hello" });
});

test("解析三类上游响应", () => {
  assert.equal(
    parseProviderResponse("openai", { choices: [{ message: { content: "openai ok" } }] }),
    "openai ok",
  );
  assert.equal(
    parseProviderResponse("anthropic", { content: [{ type: "text", text: "anthropic ok" }] }),
    "anthropic ok",
  );
  assert.equal(
    parseProviderResponse("gemini", {
      candidates: [{ content: { parts: [{ text: "gemini ok" }] } }],
    }),
    "gemini ok",
  );
});

test("可为支持的 OpenAI 兼容接口显式开启思考并留出独立余量", () => {
  const request = buildUpstreamRequest(
    {
      format: "openai",
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-v4-flash",
      authType: "bearer",
      apiKey: "secret-value",
    },
    [{ role: "user", content: "hello" }],
    { maxTokens: 8192, thinkingMode: "enabled" },
  );
  assert.equal(request.body.max_tokens, 8192);
  assert.deepEqual(request.body.thinking, { type: "enabled" });
});

test("统一读取三类接口的截断原因", () => {
  assert.equal(providerFinishReason("openai", { choices: [{ finish_reason: "length" }] }), "length");
  assert.equal(providerFinishReason("anthropic", { stop_reason: "max_tokens" }), "length");
  assert.equal(
    providerFinishReason("gemini", { candidates: [{ finishReason: "MAX_TOKENS" }] }),
    "length",
  );
});
