import { createHash } from "node:crypto";
import { assertWechatAssistantPointsAvailable } from "./wechatAssistantPoints.js";

const BUILTIN_MODELS = new Set(["gpt-5.6-terra", "gpt-5.6-sol"]);

function cacheScope(session = {}, profileId = "") {
  const identity = String(
    session?.user?.id || session?.user?.email || session?.user?.username || profileId || "anonymous",
  ).trim();
  return createHash("sha256").update(identity).digest("hex").slice(0, 24);
}

async function parseJson(response) {
  try { return await response.json(); }
  catch { return {}; }
}

function publicFailure(payload, status, metadata = {}) {
  const detail = payload?.detail && typeof payload.detail === "object" ? payload.detail : payload;
  const stringDetail = typeof payload?.detail === "string" ? payload.detail.trim() : "";
  const error = new Error(String(detail?.message || detail?.error || stringDetail || "模型请求失败。"));
  error.publicMessage = error.message;
  error.code = String(detail?.code || "WANGZAI_MODEL_REQUEST_FAILED");
  error.status = Number(status) || 502;
  error.retrySafe = metadata.retrySafe === true || detail?.retrySafe === true;
  error.outcome = String(metadata.outcome || detail?.outcome || "");
  error.channelSource = String(metadata.channelSource || detail?.channelSource || "");
  error.deliverAsAssistantNotice = metadata.deliverAsAssistantNotice === true;
  return error;
}

function missingOpenClawRoute(response, payload) {
  if (response?.status !== 404) return false;
  const detail = typeof payload?.detail === "string" ? payload.detail.trim().toLowerCase() : "";
  return detail === "not found"
    || (!payload || (typeof payload === "object" && Object.keys(payload).length === 0));
}

function unavailablePointsPrice(response, payload) {
  if (response?.status !== 503) return false;
  const detail = payload?.detail && typeof payload.detail === "object" ? payload.detail : payload;
  const code = String(detail?.code || "").trim();
  const message = String(detail?.message || detail?.error || payload?.detail || "").trim();
  return ["MODEL_PRESET_RATE_UNAVAILABLE", "PAID_CAPABILITY_RATE_UNAVAILABLE"].includes(code)
    || message.includes("没有当前功能的有效积分价格")
    || message.includes("积分价格暂不可用");
}

export function createWechatAssistantModelExecutor({
  runtimeInfo,
  licenseRuntime,
  getPointsWallet,
  fetchImpl = fetch,
} = {}) {
  const localApi = runtimeInfo?.localApi || {};
  const coreServiceUrl = String(localApi.coreServiceUrl || "").replace(/\/+$/, "");

  async function resolveByok(accountId, model, signal) {
    const session = await licenseRuntime.getSession();
    const localCacheAgent = localApi.localCacheAgent === true;
    const path = localCacheAgent
      ? "/v1/internal/model-api-credentials/get"
      : "/api/internal/model-api-credentials/get";
    const headers = localCacheAgent
      ? {
          "x-wangzai-cache-agent-token": localApi.authToken,
          "x-wangzai-cache-scope": cacheScope(session, localApi.profile?.profileId),
        }
      : { "x-wangzai-local-api-token": localApi.authToken };
    let response;
    try {
      response = await fetchImpl(`${localApi.baseUrl}${path}`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ accountId }),
        signal,
      });
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      throw publicFailure({
        code: "MODEL_API_CREDENTIAL_READ_FAILED",
        message: "读取本机模型接口凭证失败，请检查旺崽本地服务。",
      }, 503, { retrySafe: true, outcome: "not-dispatched", channelSource: "saved-api" });
    }
    const payload = await parseJson(response);
    const account = payload?.account;
    const apiKey = String(payload?.credentials?.apiKey || "").trim();
    const baseUrl = String(account?.baseUrl || "").trim();
    const availableModels = Array.isArray(account?.availableModels) ? account.availableModels : [];
    const selectedModel = availableModels.find((item) => String(item?.id || item?.model || "").trim() === model);
    if (!response.ok || account?.discoveryVerified !== true || !apiKey || !baseUrl) {
      throw publicFailure({ code: "MODEL_API_CREDENTIAL_UNAVAILABLE", message: "所选模型接口凭证不可用，请到模型接口中重新检测。" }, 409, {
        retrySafe: true,
        outcome: "not-dispatched",
        channelSource: "saved-api",
      });
    }
    if (availableModels.length && !selectedModel) {
      throw publicFailure({ code: "MODEL_API_MODEL_NOT_DISCOVERED", message: "所选模型接口中没有当前模型。" }, 409, {
        retrySafe: true,
        outcome: "not-dispatched",
        channelSource: "saved-api",
      });
    }
    const capabilities = (Array.isArray(selectedModel?.capabilities) ? selectedModel.capabilities : [])
      .map((item) => String(item || "").toLowerCase());
    if (capabilities.length && !capabilities.includes("text-generation")) {
      throw publicFailure({ code: "MODEL_API_CAPABILITY_INVALID", message: "所选模型不支持文本和工具调用。" }, 409, {
        retrySafe: true,
        outcome: "not-dispatched",
        channelSource: "saved-api",
      });
    }
    return { account_id: accountId, base_url: baseUrl, api_key: apiKey, model };
  }

  return async function executeWechatAssistantModel({ requestId, settings = {}, payload = {}, assertAuthorizationCurrent = () => undefined } = {}) {
    assertAuthorizationCurrent();
    if (!coreServiceUrl) {
      throw publicFailure({ code: "CORE_SERVICE_UNAVAILABLE", message: "管理端模型服务尚未配置。" }, 503, {
        retrySafe: true,
        outcome: "not-dispatched",
      });
    }
    const model = String(settings.modelName || "").trim();
    const source = String(settings.modelSource || "builtin-points");
    if (!model) {
      throw publicFailure({ code: "MODEL_SELECTION_REQUIRED", message: "请先选择模型。" }, 409, {
        retrySafe: true,
        outcome: "not-dispatched",
        channelSource: source,
      });
    }
    if (source === "builtin-points" && !BUILTIN_MODELS.has(model)) {
      throw publicFailure({ code: "BUILTIN_MODEL_FORBIDDEN", message: "内置积分模型只允许选择已上架的文本模型。" }, 409, {
        retrySafe: true,
        outcome: "not-dispatched",
        channelSource: source,
      });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 280_000);
    let byok = null;
    let modelDispatched = false;
    try {
      if (source === "builtin-points") {
        if (typeof getPointsWallet !== "function") {
          throw publicFailure({ code: "WECHAT_POINTS_CHECK_UNAVAILABLE", message: "积分校验尚未初始化，暂时不能使用内置模型。" }, 503);
        }
        assertWechatAssistantPointsAvailable(await getPointsWallet());
      }
      if (source === "saved-api") {
        const accountId = String(settings.modelAccountId || "").trim();
        if (!accountId) throw publicFailure({ code: "MODEL_API_ACCOUNT_REQUIRED", message: "请选择已保存的模型接口。" }, 409);
        byok = await resolveByok(accountId, model, controller.signal);
      }
      assertAuthorizationCurrent();
      let token = String(await licenseRuntime.getProtectedComputeAccessToken()).trim();
      assertAuthorizationCurrent();
      if (!token) throw publicFailure({ code: "LOGIN_REQUIRED", message: "请先登录授权账号。" }, 401);
      const body = {
        request_id: String(requestId || ""),
        model,
        request_body: { ...payload, model, stream: false },
        byok,
      };
      const forward = async () => {
        assertAuthorizationCurrent();
        modelDispatched = true;
        try {
          return await fetchImpl(`${coreServiceUrl}/api/core-v2/openclaw/chat/completions`, {
            method: "POST",
            headers: { Accept: "application/json", Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
        } catch (error) {
          if (error?.name === "AbortError") throw error;
          throw publicFailure({
            code: "MODEL_CHANNEL_OUTCOME_UNKNOWN",
            message: "模型通道连接中断；本次结果与计费状态未知，为防止重复扣费不会自动重发。",
          }, 503, { retrySafe: false, outcome: "unknown", channelSource: source });
        }
      };
      let response = await forward();
      if (response.status === 401) {
        // The authenticated endpoint rejected the request before execution, so
        // refreshing the token and reusing the same request id is safe.
        modelDispatched = false;
        token = String(await licenseRuntime.getProtectedComputeAccessToken({
          forceRefresh: true,
          rejectedAccessToken: token,
        })).trim();
        if (!token) throw publicFailure({ code: "LOGIN_REQUIRED", message: "登录会话刷新失败，请重新登录。" }, 401);
        response = await forward();
      }
      const result = await parseJson(response);
      if (unavailablePointsPrice(response, result)) {
        throw publicFailure({
          code: "MODEL_POINTS_PRICE_UNAVAILABLE",
          message: "当前模型暂未启用积分价格，微信连接不受影响；本次没有调用模型，也不会扣积分。请联系管理员启用该模型后再试。",
        }, 409, {
          retrySafe: true,
          outcome: "not-dispatched",
          channelSource: source,
          deliverAsAssistantNotice: true,
        });
      }
      if (missingOpenClawRoute(response, result)) {
        throw publicFailure({
          code: "OPENCLAW_CORE_ROUTE_UNAVAILABLE",
          message: "微信通道已连接，但模型服务版本尚未同步；本次未调用模型、不会扣积分。请稍后重试，如持续出现请联系管理员更新模型服务。",
        }, 409, {
          retrySafe: true,
          outcome: "not-dispatched",
          channelSource: source,
          deliverAsAssistantNotice: true,
        });
      }
      if (!response.ok || result?.ok !== true || !result?.response) {
        throw publicFailure(result, response.status, {
          retrySafe: false,
          outcome: "server-confirmed",
          channelSource: source,
        });
      }
      if (source === "builtin-points") {
        try {
          const wallet = await getPointsWallet();
          result.billing = {
            ...(result.billing || {}),
            pointsRemaining: wallet.availablePoints,
            pointsExhausted: wallet.availablePoints <= 0,
          };
        } catch {
          result.billing = { ...(result.billing || {}), pointsBalancePending: true };
        }
      }
      result.channel = {
        source,
        model,
        strategy: source === "builtin-points" ? "managed-safe-failover" : "single-saved-api",
      };
      return result;
    } catch (error) {
      if (error?.name === "AbortError") {
        throw publicFailure({
          code: modelDispatched ? "MODEL_REQUEST_TIMEOUT" : "MODEL_PREFLIGHT_TIMEOUT",
          message: modelDispatched
            ? "模型请求超时；为防止重复扣费，本次不会自动重试。"
            : "模型调用前的本机检查超时，尚未向模型发送请求。",
        }, 504, {
          retrySafe: !modelDispatched,
          outcome: modelDispatched ? "unknown" : "not-dispatched",
          channelSource: source,
        });
      }
      if (!modelDispatched && error && typeof error === "object" && !error.outcome) {
        error.retrySafe = true;
        error.outcome = "not-dispatched";
        error.channelSource = source;
      }
      throw error;
    } finally {
      if (byok) byok.api_key = "";
      clearTimeout(timer);
    }
  };
}
