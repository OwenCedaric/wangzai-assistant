import { createHash, randomBytes } from "node:crypto";
import http from "node:http";

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE_ENTRIES = 200;

function jsonResponse(response, status, payload, headers = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    ...headers,
  });
  response.end(body);
}

function errorPayload(error) {
  return {
    error: {
      message: String(error?.publicMessage || error?.message || "模型请求失败。"),
      type: "wangzai_model_error",
      code: String(error?.code || "WANGZAI_MODEL_REQUEST_FAILED"),
      retry_safe: error?.retrySafe === true,
      outcome: String(error?.outcome || "unknown"),
    },
  };
}

function completionChunk(payload = {}) {
  const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
  const message = choice?.message && typeof choice.message === "object" ? choice.message : {};
  const delta = { role: "assistant" };
  if (message.content !== undefined) delta.content = message.content;
  if (Array.isArray(message.tool_calls)) {
    delta.tool_calls = message.tool_calls.map((item, index) => ({ index, ...item }));
  }
  return {
    id: String(payload.id || "wangzai-chat"),
    object: "chat.completion.chunk",
    created: Number(payload.created) || Math.floor(Date.now() / 1000),
    model: String(payload.model || ""),
    choices: [{
      index: 0,
      delta,
      finish_reason: choice?.finish_reason || (delta.tool_calls?.length ? "tool_calls" : "stop"),
    }],
    usage: payload.usage || undefined,
  };
}

function streamCompletion(response, payload, chargedPoints = 0, headers = {}) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "x-wangzai-charged-points": String(Math.max(0, Number(chargedPoints) || 0)),
    ...headers,
  });
  response.write(`data: ${JSON.stringify(completionChunk(payload))}\n\n`);
  response.end("data: [DONE]\n\n");
}

function assistantNoticeCompletion(model, error) {
  return {
    id: `wangzai-notice-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: String(model || "wangzai-assistant"),
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: String(error?.publicMessage || error?.message || "助理暂时无法完成回复，请稍后重试。"),
      },
      finish_reason: "stop",
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function requestFingerprint(settings, rawBody, ownerScope) {
  return createHash("sha256")
    .update(ownerScope).update("\0")
    .update(String(settings.modelSource || ""))
    .update("\0")
    .update(String(settings.modelAccountId || ""))
    .update("\0")
    .update(String(settings.modelName || ""))
    .update("\0")
    .update(rawBody)
    .digest("hex");
}

export function createWechatAssistantModelRelay({
  token = randomBytes(32).toString("hex"),
  getSettings,
  executeRequest,
  executeReadonlyRequest,
  onConversationRequest = () => undefined,
  onConversationSettled = () => undefined,
  onChannelResult = () => undefined,
  onChannelFailure = () => undefined,
  onBillingResult = () => undefined,
  log = () => undefined,
} = {}) {
  let server = null;
  let port = 0;
  const bootNonce = randomBytes(16).toString("hex");
  const cache = new Map();
  let ownerScope = "";
  let authorizationRevision = 0;
  let currentToken = token;

  function setAuthorization(input = {}) {
    const next = input.authorized === true && /^[a-f0-9]{64}$/u.test(String(input.ownerScope || ""))
      ? input.ownerScope : "";
    if (next === ownerScope) return { changed: false };
    ownerScope = next;
    authorizationRevision += 1;
    currentToken = randomBytes(32).toString("hex");
    return { changed: true };
  }
  function authorizationChanged(notDispatched = false) {
    const message = notDispatched
      ? "授权状态已变化，本次未开始新的模型执行；请在当前账户重新确认。"
      : "授权状态已变化，模型可能已执行或计费；本次结果不可交付，请核对原账号，勿自动重发。";
    return Object.assign(new Error(message), {
      code: "WECHAT_AUTHORIZATION_CHANGED", status: 409, retrySafe: notDispatched,
      outcome: notDispatched ? "not-dispatched" : "unknown",
    });
  }
  function isCurrent(context) {
    return Boolean(ownerScope && context.ownerScope === ownerScope && context.revision === authorizationRevision);
  }

  function pruneCache() {
    const cutoff = Date.now() - CACHE_TTL_MS;
    for (const [key, entry] of cache) {
      if (entry.settled && entry.settledAt < cutoff) cache.delete(key);
    }
  }

  function authorized(request) {
    return Boolean(ownerScope) && request.headers.authorization === `Bearer ${currentToken}`;
  }

  async function readBody(request) {
    const chunks = [];
    let length = 0;
    for await (const chunk of request) {
      length += chunk.length;
      if (length > MAX_BODY_BYTES) {
        const error = new Error("模型请求内容过大。");
        error.status = 413;
        error.code = "MODEL_REQUEST_TOO_LARGE";
        throw error;
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  async function handle(request, response) {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (!authorized(request)) {
      jsonResponse(response, 401, { error: { message: "本机模型转发授权无效。", code: "LOCAL_RELAY_UNAUTHORIZED" } });
      return;
    }
    const context = { ownerScope, revision: authorizationRevision };
    let executionEntry = null;
    const assertAuthorizationCurrent = () => {
      if (!isCurrent(context)) throw authorizationChanged(!executionEntry?.executionStarted);
    };
    if (request.method === "GET" && ["/v1/readonly/shops", "/v1/readonly/summary"].includes(url.pathname)) {
      try {
        if (typeof executeReadonlyRequest !== "function") throw Object.assign(new Error("只读数据通道尚未初始化。"), { status: 503, code: "WECHAT_READONLY_UNAVAILABLE" });
        const result = await executeReadonlyRequest({ pathname: url.pathname, query: Object.fromEntries(url.searchParams), assertAuthorizationCurrent });
        assertAuthorizationCurrent();
        jsonResponse(response, 200, result);
      } catch (caught) {
        const error = isCurrent(context) ? caught : authorizationChanged(true);
        jsonResponse(response, Number(error.status) || 502, { ok: false, ...errorPayload(error) });
      }
      return;
    }
    const settings = getSettings?.() || {};
    if (request.method === "GET" && url.pathname === "/v1/models") {
      jsonResponse(response, 200, {
        object: "list",
        data: [{ id: settings.modelName, object: "model", owned_by: "wangzai" }],
      });
      return;
    }
    if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
      jsonResponse(response, 404, { error: { message: "不支持的本机模型路径。", code: "LOCAL_RELAY_ROUTE_NOT_FOUND" } });
      return;
    }
    let conversationStarted = false;
    let wantsStream = false;
    let requestedModel = "";
    try {
      const rawBody = await readBody(request);
      assertAuthorizationCurrent();
      const payload = JSON.parse(rawBody.toString("utf8"));
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("模型请求格式无效。");
      requestedModel = String(payload.model || settings.modelName || "");
      onConversationRequest(payload);
      conversationStarted = true;
      if (String(payload.model || "") !== String(settings.modelName || "")) {
        const error = new Error("所选模型与小龙虾当前配置不一致。");
        error.status = 409;
        error.code = "MODEL_SELECTION_MISMATCH";
        throw error;
      }
      wantsStream = payload.stream === true;
      const managementBody = { ...payload, stream: false };
      delete managementBody.stream_options;
      const fingerprint = requestFingerprint(settings, Buffer.from(JSON.stringify(managementBody)), context.ownerScope);
      pruneCache();
      let entry = cache.get(fingerprint);
      const replayed = Boolean(entry);
      if (!entry) {
        for (const [key, cached] of cache) {
          if (cache.size < MAX_CACHE_ENTRIES) break;
          if (cached.settled) cache.delete(key);
        }
        if (cache.size >= MAX_CACHE_ENTRIES) throw Object.assign(new Error("模型请求正在处理中，请稍后再试。"), { status: 429, code: "MODEL_RELAY_CAPACITY_BUSY" });
        const requestId = `wechat-${createHash("sha256").update(bootNonce).update(fingerprint).digest("hex")}`;
        entry = {
          createdAt: Date.now(),
          settled: false,
          executionStarted: false,
          promise: null,
        };
        const ownEntry = entry;
        entry.promise = Promise.resolve().then(() => {
          assertAuthorizationCurrent();
          // Once control reaches the executor, the relay cannot infer that a
          // later authorization exception means no model work/charge happened.
          ownEntry.executionStarted = true;
          return executeRequest({
            requestId,
            settings,
            payload: managementBody,
            assertAuthorizationCurrent,
          });
        }).catch(error => {
          if (!ownEntry.executionStarted && error?.code === "WECHAT_AUTHORIZATION_CHANGED"
            && error?.outcome === "not-dispatched" && cache.get(fingerprint) === ownEntry) cache.delete(fingerprint);
          throw error;
        }).finally(() => { ownEntry.settled = true; ownEntry.settledAt = Date.now(); });
        cache.set(fingerprint, entry);
      }
      executionEntry = entry;
      const result = await entry.promise;
      assertAuthorizationCurrent();
      const completion = result?.response;
      if (!completion || typeof completion !== "object") throw new Error("模型没有返回可用结果。");
      onChannelResult(result?.channel || null);
      const chargedPoints = result?.billing?.chargedPoints || 0;
      onBillingResult(result?.billing || null, { replayed });
      if (chargedPoints > 0) log("billing", `本次内置模型已按真实用量结算 ${chargedPoints} 积分。`);
      if (result?.billing?.pointsExhausted === true) log("billing", "当前账户积分已耗尽，后续内置模型调用已停止。" );
      if (wantsStream) streamCompletion(response, completion, chargedPoints);
      else jsonResponse(response, 200, completion, { "x-wangzai-charged-points": String(chargedPoints) });
    } catch (caught) {
      const error = isCurrent(context) ? caught : authorizationChanged(!executionEntry?.executionStarted);
      const status = Math.max(400, Math.min(599, Number(error?.status || error?.statusCode) || 502));
      if (isCurrent(context)) onChannelFailure(error);
      if (error?.deliverAsAssistantNotice === true) {
        const completion = assistantNoticeCompletion(requestedModel || settings.modelName, error);
        const headers = {
          "x-wangzai-service-notice": String(error?.code || "WANGZAI_SERVICE_NOTICE"),
          "x-wangzai-retry-safe": error?.retrySafe === true ? "true" : "false",
        };
        if (wantsStream) streamCompletion(response, completion, 0, headers);
        else jsonResponse(response, 200, completion, headers);
        return;
      }
      jsonResponse(response, status, errorPayload(error), {
        "x-wangzai-retry-safe": error?.retrySafe === true ? "true" : "false",
      });
    } finally {
      if (conversationStarted && isCurrent(context)) onConversationSettled();
    }
  }

  async function start() {
    if (server?.listening) return { port, baseUrl: `http://127.0.0.1:${port}/v1` };
    server = http.createServer((request, response) => { void handle(request, response); });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    port = Number(server.address()?.port) || 0;
    log("model-relay", `本机模型转发已就绪（端口 ${port}）。`);
    return { port, baseUrl: `http://127.0.0.1:${port}/v1` };
  }

  async function stop() {
    setAuthorization({ authorized: false });
    const active = server;
    server = null;
    port = 0;
    cache.clear();
    if (active?.listening) await new Promise((resolve) => active.close(resolve));
  }

  return Object.freeze({
    start,
    stop,
    setAuthorization,
    get token() { return currentToken; },
    get baseUrl() { return port ? `http://127.0.0.1:${port}/v1` : ""; },
    get status() { return { running: Boolean(server?.listening), port }; },
  });
}
