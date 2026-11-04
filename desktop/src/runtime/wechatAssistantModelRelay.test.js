import assert from "node:assert/strict";
import test from "node:test";

import { createWechatAssistantModelRelay as createProtectedRelay } from "./wechatAssistantModelRelay.js";
function createWechatAssistantModelRelay(options) {
  const relay = createProtectedRelay(options);
  relay.setAuthorization({ authorized: true, ownerScope: 'a'.repeat(64) });
  return relay;
}

test("relay converts one settled tool-call response to OpenAI streaming events and deduplicates retries", async () => {
  let calls = 0;
  const relay = createWechatAssistantModelRelay({
    token: "relay-secret",
    getSettings: () => ({ modelSource: "builtin-points", modelAccountId: "", modelName: "gpt-5.6-terra" }),
    executeRequest: async () => {
      calls += 1;
      return {
        response: {
          id: "completion-1",
          model: "gpt-5.6-terra",
          choices: [{
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "call-1", type: "function", function: { name: "read_orders", arguments: "{}" } }],
            },
            finish_reason: "tool_calls",
          }],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        },
        billing: { chargedPoints: 3 },
      };
    },
  });
  const { baseUrl } = await relay.start();
  try {
    const body = {
      model: "gpt-5.6-terra",
      messages: [{ role: "user", content: "订单" }],
      tools: [],
      stream: true,
    };
    const responses = await Promise.all([1, 2].map(() => fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${relay.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })));
    const texts = await Promise.all(responses.map((response) => response.text()));
    assert.equal(calls, 1);
    assert.equal(responses[0].headers.get("x-wangzai-charged-points"), "3");
    assert.match(texts[0], /tool_calls/);
    assert.match(texts[0], /"index":0/);
    assert.match(texts[0], /data: \[DONE\]/);
  } finally {
    await relay.stop();
  }
});

test("relay binds to loopback and rejects callers without the per-runtime token", async () => {
  const relay = createWechatAssistantModelRelay({
    token: "relay-secret",
    getSettings: () => ({ modelName: "gpt-5.6-terra" }),
    executeRequest: async () => { throw new Error("must not execute"); },
  });
  const { baseUrl } = await relay.start();
  try {
    const response = await fetch(`${baseUrl}/models`);
    assert.equal(response.status, 401);
    assert.equal(new URL(baseUrl).hostname, "127.0.0.1");
  } finally {
    await relay.stop();
  }
});

test("relay exposes the actual latest user message to the operation confirmation guard", async () => {
  let observed = null;
  const relay = createWechatAssistantModelRelay({
    token: "relay-secret",
    getSettings: () => ({ modelName: "gpt-5.6-terra" }),
    onConversationRequest: (payload) => { observed = payload; },
    executeRequest: async () => ({
      response: { model: "gpt-5.6-terra", choices: [{ message: { role: "assistant", content: "好的" }, finish_reason: "stop" }] },
    }),
  });
  const { baseUrl } = await relay.start();
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${relay.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.6-terra",
        messages: [{ role: "user", content: [{ type: "text", text: "确认执行 A1B2C3" }] }],
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(observed.messages.at(-1).content[0].text, "确认执行 A1B2C3");
  } finally {
    await relay.stop();
  }
});

test("relay caches an outcome-unknown failure and exposes the no-retry contract", async () => {
  let calls = 0;
  let started = 0;
  let settled = 0;
  let failures = 0;
  const relay = createWechatAssistantModelRelay({
    token: "relay-secret",
    getSettings: () => ({ modelSource: "builtin-points", modelName: "gpt-5.6-terra" }),
    onConversationRequest: () => { started += 1; },
    onConversationSettled: () => { settled += 1; },
    onChannelFailure: () => { failures += 1; },
    executeRequest: async () => {
      calls += 1;
      const error = new Error("模型通道连接中断；不会自动重发。");
      error.code = "MODEL_CHANNEL_OUTCOME_UNKNOWN";
      error.status = 503;
      error.retrySafe = false;
      error.outcome = "unknown";
      throw error;
    },
  });
  const { baseUrl } = await relay.start();
  try {
    const body = JSON.stringify({
      model: "gpt-5.6-terra",
      messages: [{ role: "user", content: "汇总今日销售数据" }],
    });
    const request = () => fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${relay.token}`, "Content-Type": "application/json" },
      body,
    });
    const first = await request();
    const second = await request();
    assert.equal(first.status, 503);
    assert.equal(second.status, 503);
    assert.equal(first.headers.get("x-wangzai-retry-safe"), "false");
    assert.deepEqual((await first.json()).error, {
      message: "模型通道连接中断；不会自动重发。",
      type: "wangzai_model_error",
      code: "MODEL_CHANNEL_OUTCOME_UNKNOWN",
      retry_safe: false,
      outcome: "unknown",
    });
    await second.text();
    assert.equal(calls, 1);
    assert.equal(started, 2);
    assert.equal(settled, 2);
    assert.equal(failures, 2);
  } finally {
    await relay.stop();
  }
});

test("relay turns a known no-dispatch infrastructure failure into a Chinese assistant notice", async () => {
  let failures = 0;
  const relay = createWechatAssistantModelRelay({
    token: "relay-secret",
    getSettings: () => ({ modelSource: "builtin-points", modelName: "gpt-5.6-terra" }),
    onChannelFailure: () => { failures += 1; },
    executeRequest: async () => {
      const error = new Error("微信通道已连接，但模型服务版本尚未同步；本次未调用模型、不会扣积分。");
      error.publicMessage = error.message;
      error.code = "OPENCLAW_CORE_ROUTE_UNAVAILABLE";
      error.status = 409;
      error.retrySafe = true;
      error.outcome = "not-dispatched";
      error.deliverAsAssistantNotice = true;
      throw error;
    },
  });
  const { baseUrl } = await relay.start();
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${relay.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.6-terra",
        messages: [{ role: "user", content: "汇总今日销售数据" }],
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-wangzai-service-notice"), "OPENCLAW_CORE_ROUTE_UNAVAILABLE");
    assert.equal(response.headers.get("x-wangzai-retry-safe"), "true");
    const payload = await response.json();
    assert.match(payload.choices[0].message.content, /模型服务版本尚未同步/u);
    assert.equal(payload.usage.total_tokens, 0);
    assert.equal(failures, 1);
  } finally {
    await relay.stop();
  }
});
