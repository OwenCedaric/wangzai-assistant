import { randomBytes } from "node:crypto";
import http from "node:http";

const MAX_BODY_BYTES = 64 * 1024;
const PREVIEW_TTL_MS = 30 * 60 * 1000;
const MAX_PENDING_PREVIEWS = 100;

const ALLOWED_ACTIONS = new Map([
  ["products", new Set([
    "product.updateInfo",
    "product.updateAttributes",
    "product.updatePrice",
    "product.updateStock",
    "product.archive",
    "product.unarchive",
  ])],
  ["orders", new Set([
    "cancelOrder",
    "createOrder",
    "cancelFboPosting",
    "cancelFbsPosting",
    "cancelFbsProduct",
    "setFbsAwaitingDelivery",
    "shipFbsPosting",
    "shipFbsPackage",
    "createFbsPackageLabel",
    "getFbsPackageLabel",
    "splitFbsPosting",
    "splitTraceableFbsPosting",
    "setMultiboxQty",
    "updateFbsExemplar",
    "setFbsExemplar",
    "createOrGetFbsExemplar",
  ])],
  ["marketing", new Set(["marketing.products.add", "marketing.products.remove"])],
  ["returns", new Set([
    "setRfbsReturnAction",
    "rejectRfbsReturn",
    "compensateRfbsReturn",
    "verifyRfbsReturn",
    "receiveRfbsReturn",
    "refundRfbsReturn",
    "approveConditionalCancellation",
    "rejectConditionalCancellation",
  ])],
  ["customer-service", new Set([
    "customerService.chat.sendMessage",
    "customerService.chat.start",
    "customerService.chat.markAllRead",
  ])],
]);

export const WECHAT_ASSISTANT_OPERATION_IDS = Object.freeze(
  [...ALLOWED_ACTIONS.entries()].flatMap(([domain, actions]) => [...actions].map((action) => `${domain}:${action}`)),
);

function text(value) {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function publicError(error, fallback = "操作失败。") {
  return text(error?.publicMessage || error?.data?.error?.message || error?.error?.message || error?.error || error?.message) || fallback;
}

function jsonResponse(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function httpError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function normalizePreviewInput(input = {}) {
  const domain = text(input.domain).toLowerCase();
  const action = text(input.action);
  const shopId = text(input.shopId || input.shop_id);
  if (!ALLOWED_ACTIONS.has(domain)) throw httpError(400, "WECHAT_ACTION_DOMAIN_NOT_ALLOWED", "该业务暂不允许由微信助理操作。");
  if (!ALLOWED_ACTIONS.get(domain).has(action)) throw httpError(400, "WECHAT_ACTION_NOT_ALLOWED", `微信助理暂不支持操作：${action || "未指定"}。`);
  if (!shopId) throw httpError(400, "WECHAT_ACTION_SHOP_REQUIRED", "执行操作前必须明确选择店铺。");
  if (!input.payload || typeof input.payload !== "object" || Array.isArray(input.payload)) {
    throw httpError(400, "WECHAT_ACTION_PAYLOAD_REQUIRED", "执行操作前必须提供结构化操作内容。");
  }
  return {
    permissionId: `${domain}:${action}`,
    domain,
    action,
    shopId,
    accountId: text(input.accountId || input.account_id) || null,
    endpointKey: text(input.endpointKey) || null,
    before: input.before ?? null,
    after: input.after ?? input.payload,
    payload: input.payload,
    idempotencyKey: text(input.idempotencyKey) || `wechat-${randomBytes(16).toString("hex")}`,
    requestedBy: "wechat-assistant",
  };
}

export function createWechatAssistantActionRelay({
  token = randomBytes(32).toString("hex"),
  getSettings,
  executeBusinessRequest,
  log = () => undefined,
  now = () => Date.now(),
} = {}) {
  let server = null;
  let port = 0;
  const pending = new Map();

  function assertEnabled() {
    const settings = getSettings?.() || {};
    if (settings.toolAccessMode !== "direct-write") {
      throw httpError(403, "WECHAT_ACTIONS_READ_ONLY", "当前小龙虾权限为只读；请先在旺崽助手中选择“允许操作与修改”。");
    }
    if (typeof executeBusinessRequest !== "function") {
      throw httpError(503, "WECHAT_ACTION_BRIDGE_UNAVAILABLE", "旺崽业务操作桥尚未初始化，请重启旺崽助手。");
    }
  }

  function cleanup() {
    const timestamp = now();
    for (const [previewId, entry] of pending) {
      if (entry.expiresAtMs <= timestamp) pending.delete(previewId);
    }
    while (pending.size > MAX_PENDING_PREVIEWS) pending.delete(pending.keys().next().value);
  }

  async function readBody(request) {
    const chunks = [];
    let length = 0;
    for await (const chunk of request) {
      length += chunk.length;
      if (length > MAX_BODY_BYTES) throw httpError(413, "WECHAT_ACTION_BODY_TOO_LARGE", "操作内容过大，请缩小到单次明确操作。");
      chunks.push(chunk);
    }
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      return parsed;
    } catch {
      throw httpError(400, "WECHAT_ACTION_BODY_INVALID", "操作内容格式无效。");
    }
  }

  async function callBusiness(path, body) {
    const result = await executeBusinessRequest({ path, method: "POST", body, timeoutMs: 120_000 });
    if (!result?.ok) {
      const error = httpError(Number(result?.status) || 502, "WECHAT_ACTION_BUSINESS_REJECTED", publicError(result, "旺崽拒绝了本次操作。"));
      error.outcomeUnknown = false;
      throw error;
    }
    const data = result.data ?? result;
    if (data?.ok === false) {
      const error = httpError(409, text(data?.error?.code) || "WECHAT_ACTION_REJECTED", publicError(data, "旺崽拒绝了本次操作。"));
      error.outcomeUnknown = false;
      throw error;
    }
    return data;
  }

  async function preview(input) {
    assertEnabled();
    cleanup();
    const operation = normalizePreviewInput(input);
    const settings = getSettings?.() || {};
    const allowed = new Set(Array.isArray(settings.allowedOperationActions) ? settings.allowedOperationActions : []);
    if (!allowed.has(operation.permissionId)) {
      throw httpError(403, "WECHAT_ACTION_PERMISSION_NOT_GRANTED", `用户没有授权小龙虾执行该操作：${operation.action}。请先在旺崽助手中勾选对应权限。`);
    }
    const result = await callBusiness(`/api/write/${encodeURIComponent(operation.domain)}/preview`, operation);
    const previewId = text(result?.previewId);
    if (!previewId) throw httpError(502, "WECHAT_ACTION_PREVIEW_ID_MISSING", "旺崽未返回有效操作预览，本次不会执行。");
    const createdAtMs = now();
    const entry = {
      previewId,
      operation,
      createdAtMs,
      expiresAtMs: Math.min(createdAtMs + PREVIEW_TTL_MS, Date.parse(result?.expiresAt) || Number.POSITIVE_INFINITY),
      state: "pending",
      result: null,
      preview: result,
    };
    pending.set(previewId, entry);
    cleanup();
    log("action-relay", `已生成并核对微信操作预览：${operation.domain}/${operation.action}，按已授权权限直接提交。`);
    return submit(entry);
  }

  async function submit(entry) {
    assertEnabled();
    cleanup();
    const previewId = entry.previewId;
    const settings = getSettings?.() || {};
    const allowed = new Set(Array.isArray(settings.allowedOperationActions) ? settings.allowedOperationActions : []);
    if (!allowed.has(entry.operation.permissionId)) {
      throw httpError(403, "WECHAT_ACTION_PERMISSION_REVOKED", "该具体操作权限已被关闭，本次预览不能再执行。");
    }
    if (entry.state === "completed") return entry.result;
    if (entry.state === "submitting") throw httpError(409, "WECHAT_ACTION_ALREADY_SUBMITTING", "该操作正在提交，请勿重复执行。");
    entry.state = "submitting";
    try {
      const body = {
        ...entry.operation,
        previewId,
        confirm: true,
        realWrite: true,
        dryRun: false,
      };
      const result = await callBusiness(`/api/write/${encodeURIComponent(entry.operation.domain)}/confirm`, body);
      entry.result = {
        ok: true,
        previewId,
        domain: entry.operation.domain,
        action: entry.operation.action,
        shopId: entry.operation.shopId,
        before: entry.operation.before,
        after: entry.operation.after,
        diffHash: entry.preview?.diffHash || null,
        expiresAt: entry.preview?.expiresAt || new Date(entry.expiresAtMs).toISOString(),
        requiresConfirmation: false,
        writeSubmitted: true,
        writeExecuted: result?.realWrite === true || result?.writeConnected === true,
        result,
        instruction: "请按旺崽返回的真实写入与回读结果答复用户；不要根据预期补造成功状态。",
      };
      entry.state = "completed";
      log("action-relay", `微信操作已提交并返回结果：${entry.operation.domain}/${entry.operation.action}。`);
      return entry.result;
    } catch (error) {
      // A network failure can leave the remote outcome unknown. Never make an
      // automatic second write attempt from the assistant.
      entry.state = "completed";
      const outcomeUnknown = error?.outcomeUnknown !== false;
      entry.result = {
        ok: false,
        previewId,
        outcomeUnknown,
        error: publicError(error, outcomeUnknown ? "操作结果尚不确定，请在旺崽中核对，勿重复提交。" : "旺崽拒绝了本次操作。"),
        instruction: outcomeUnknown
          ? "本次结果不确定，禁止自动重试；请用户回到旺崽页面核对实际状态。"
          : "本次操作已被旺崽明确拒绝；向用户说明原因，不得宣称执行成功。",
      };
      return entry.result;
    }
  }

  async function confirm(input) {
    assertEnabled();
    cleanup();
    const previewId = text(input.previewId);
    const entry = pending.get(previewId);
    if (!entry) throw httpError(409, "WECHAT_ACTION_PREVIEW_INVALID", "操作记录不存在或已过期，请重新执行。");
    return submit(entry);
  }

  async function handle(request, response) {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (request.headers.authorization !== `Bearer ${token}`) {
      jsonResponse(response, 401, { ok: false, error: { code: "WECHAT_ACTION_RELAY_UNAUTHORIZED", message: "本机操作桥授权无效。" } });
      return;
    }
    try {
      if (request.method !== "POST") throw httpError(404, "WECHAT_ACTION_ROUTE_NOT_FOUND", "不支持的本机操作路径。");
      const input = await readBody(request);
      const result = url.pathname === "/v1/actions/preview"
        ? await preview(input)
        : url.pathname === "/v1/actions/confirm"
          ? await confirm(input)
          : null;
      if (!result) throw httpError(404, "WECHAT_ACTION_ROUTE_NOT_FOUND", "不支持的本机操作路径。");
      jsonResponse(response, result.ok === false ? 409 : 200, result);
    } catch (error) {
      jsonResponse(response, Math.max(400, Math.min(599, Number(error?.status) || 500)), {
        ok: false,
        error: { code: text(error?.code) || "WECHAT_ACTION_FAILED", message: publicError(error) },
      });
    }
  }

  async function start() {
    if (server?.listening) return { port, baseUrl: `http://127.0.0.1:${port}/v1` };
    server = http.createServer((request, response) => { void handle(request, response); });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    port = Number(server.address()?.port) || 0;
    log("action-relay", `本机业务操作桥已就绪（端口 ${port}）。`);
    return { port, baseUrl: `http://127.0.0.1:${port}/v1` };
  }

  async function stop() {
    const active = server;
    server = null;
    port = 0;
    pending.clear();
    if (active?.listening) await new Promise((resolve) => active.close(resolve));
  }

  return Object.freeze({
    start,
    stop,
    get token() { return token; },
    get baseUrl() { return port ? `http://127.0.0.1:${port}/v1` : ""; },
    get status() { return { running: Boolean(server?.listening), port, pending: pending.size }; },
  });
}
