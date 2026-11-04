import test from "node:test";
import assert from "node:assert/strict";
import {
  createExternalDataInsightService,
  EXTERNAL_DATA_INSIGHT_MODEL_TIMEOUT_MS,
} from "./externalDataInsightService.js";

function createRepository(capabilities = ["text-generation"]) {
  return {
    getAccountForInternalUse(accountId) {
      if (accountId !== "analysis-account") return null;
      return {
        id: accountId,
        baseUrl: "https://relay.example/v1",
        apiKey: "secret-key",
        discoveryVerified: true,
        availableModels: [{ id: "gpt-5.5", capabilities }],
      };
    },
  };
}

test("generates a structured external-data report with the configured text model", async () => {
  let request = null;
  const service = createExternalDataInsightService({
    modelApiAccountRepository: createRepository(),
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        json: async () => ({
          choices: [
            { message: { content: '{"executiveSummary":"市场有机会"}' } },
          ],
          usage: { total_tokens: 123 },
        }),
      };
    },
  });

  const result = await service.generate({
    accountId: "analysis-account",
    model: "gpt-5.5",
    systemPrompt: "只根据真实数据分析。",
    userPrompt: "搜索量 10000。",
  });

  assert.equal(result.reportText, '{"executiveSummary":"市场有机会"}');
  assert.equal(request.url, "https://relay.example/v1/chat/completions");
  const payload = JSON.parse(request.options.body);
  assert.equal(payload.model, "gpt-5.5");
  assert.equal(payload.temperature, 0.15);
  assert.equal(payload.messages[1].content, "搜索量 10000。");
  assert.equal(EXTERNAL_DATA_INSIGHT_MODEL_TIMEOUT_MS, 270000);
});

test("turns the model timeout into a readable retry message", async () => {
  const service = createExternalDataInsightService({
    modelApiAccountRepository: createRepository(),
    fetchImpl: async () => {
      const error = new Error("The operation was aborted due to timeout");
      error.name = "TimeoutError";
      throw error;
    },
  });

  await assert.rejects(
    service.generate({
      accountId: "analysis-account",
      model: "gpt-5.5",
      systemPrompt: "system",
      userPrompt: "user",
    }),
    /分析模型响应超时.*重新分析/u,
  );
});

test("uses the authenticated points model when auto mode detects an unavailable BYOK endpoint", async () => {
  const paidCalls = [];
  const service = createExternalDataInsightService({
    modelApiAccountRepository: createRepository(),
    paidCapabilityAccess: {
      execute: async (request) => {
        paidCalls.push(request);
        return {
          result: { text: '{"summary":"积分模型已完成"}' },
          chargedPoints: 6,
        };
      },
    },
    fetchImpl: async () => {
      const error = new TypeError("fetch failed");
      error.cause = { code: "ECONNRESET", message: "TLS connection reset" };
      throw error;
    },
  });

  const result = await service.generate(
    {
      accountId: "analysis-account",
      model: "gpt-5.5",
      allowPaidFallback: true,
      systemPrompt: "system",
      userPrompt: "user",
    },
    { accessToken: "license-token", requestId: "request-1" },
  );

  assert.equal(result.model, "builtin-points");
  assert.equal(result.reportText, '{"summary":"积分模型已完成"}');
  assert.deepEqual(result.billing, { chargedPoints: 6, source: "paid-cloud" });
  assert.equal(paidCalls.length, 1);
});

test("keeps using BYOK after the auto-mode preflight succeeds", async () => {
  const calls = [];
  const service = createExternalDataInsightService({
    modelApiAccountRepository: createRepository(),
    paidCapabilityAccess: {
      execute: async () => {
        throw new Error("must not use points");
      },
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/models")) return { ok: true, status: 200 };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: "自有模型完成" } }],
        }),
      };
    },
  });

  const result = await service.generate({
    accountId: "analysis-account",
    model: "gpt-5.5",
    allowPaidFallback: true,
    systemPrompt: "system",
    userPrompt: "user",
  });

  assert.equal(result.model, "gpt-5.5");
  assert.equal(result.reportText, "自有模型完成");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[1].options.method, "POST");
});

test("uses the managed points model when the old BYOK address returns a non-success preflight", async () => {
  const calls = [];
  const paidCalls = [];
  const service = createExternalDataInsightService({
    modelApiAccountRepository: createRepository(),
    paidCapabilityAccess: {
      execute: async (request) => {
        paidCalls.push(request);
        return {
          result: { text: "管理端新地址已生效" },
          chargedPoints: 6,
        };
      },
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: false, status: 404 };
    },
  });

  const result = await service.generate({
    accountId: "analysis-account",
    model: "gpt-5.5",
    allowPaidFallback: true,
    systemPrompt: "system",
    userPrompt: "user",
  });

  assert.equal(result.model, "builtin-points");
  assert.equal(result.reportText, "管理端新地址已生效");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://relay.example/v1/models");
  assert.equal(paidCalls.length, 1);
});

test("does not hide an explicitly selected BYOK transport failure behind raw fetch failed text", async () => {
  const service = createExternalDataInsightService({
    modelApiAccountRepository: createRepository(),
    fetchImpl: async () => {
      const error = new TypeError("fetch failed");
      error.cause = { code: "ECONNRESET", message: "socket disconnected" };
      throw error;
    },
  });

  await assert.rejects(
    service.generate({
      accountId: "analysis-account",
      model: "gpt-5.5",
      systemPrompt: "system",
      userPrompt: "user",
    }),
    (error) => {
      assert.equal(error.code, "MODEL_API_CONNECTION_FAILED");
      assert.match(error.message, /自有模型接口当前无法连接/u);
      assert.doesNotMatch(error.message, /fetch failed/iu);
      return true;
    },
  );
});

test("rejects an image-only model before sending external data", async () => {
  const service = createExternalDataInsightService({
    modelApiAccountRepository: createRepository(["image-generation"]),
    fetchImpl: async () => {
      throw new Error("must not call");
    },
  });
  await assert.rejects(
    service.generate({
      accountId: "analysis-account",
      model: "gpt-5.5",
      systemPrompt: "system",
      userPrompt: "user",
    }),
    /不是文本生成模型/u,
  );
});
