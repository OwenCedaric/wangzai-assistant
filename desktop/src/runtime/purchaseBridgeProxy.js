const ALLOWED_REQUESTS = new Map([
  ["GET /api/purchase/plugin-context", ""],
  ["GET /api/purchase/plugin-captures", ""],
  ["POST /api/purchase/pdd-title-search", "purchase.manage"],
  ["POST /api/purchase/image-search", "purchase.manage"],
  ["POST /api/purchase/plugin-context", "purchase.manage"],
  ["POST /api/purchase/plugin-capture", "purchase.manage"],
  ["POST /api/purchase/account-removal/ozon-shop", "purchase.manage"],
  ["POST /api/purchase/account-removal/purchase-account", "purchase.manage"],
]);
const MAX_BODY_BYTES = 1024 * 1024;

function normalizedInput(baseUrl, input = {}) {
  const method = String(input.method || "GET").toUpperCase();
  const base = new URL(baseUrl);
  const candidate = new URL(String(input.path || ""), `${baseUrl}/`);
  if (candidate.origin !== base.origin) {
    throw new Error("拍单服务请求地址不在允许范围内");
  }
  const permission = ALLOWED_REQUESTS.get(`${method} ${candidate.pathname}`);
  if (permission === undefined) throw new Error("拍单服务接口不在允许列表中");
  const serialized = input.body === undefined ? undefined : JSON.stringify(input.body);
  if (serialized && Buffer.byteLength(serialized, "utf8") > MAX_BODY_BYTES) {
    throw new Error("拍单服务请求体过大");
  }
  return { method, url: candidate.toString(), permission, serialized };
}

async function parseJsonResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, message: "拍单服务返回了无效响应" };
  }
}

export function createPurchaseBridgeProxy({
  baseUrl,
  authToken,
  licenseRuntime,
  fetchImpl = fetch,
}) {
  return async function proxyPurchaseBridge(input) {
    let request;
    try {
      request = normalizedInput(baseUrl, input);
      const runtime = await licenseRuntime.getRuntime();
      if (runtime.mode === "enforce") {
        const session = await licenseRuntime.getSession();
        if (!session.authorized) {
          return { ok: false, status: 403, error: "请先完成软件授权" };
        }
        const permissions = new Set(session.entitlement?.permissions || []);
        if (request.permission && !permissions.has(request.permission)) {
          return {
            ok: false,
            status: 403,
            error: `当前授权缺少权限：${request.permission}`,
          };
        }
      }
    } catch (error) {
      return { ok: false, status: 400, error: error?.message || "拍单服务请求无效" };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    try {
      const response = await fetchImpl(request.url, {
        method: request.method,
        headers: {
          Accept: "application/json",
          ...(request.serialized ? { "Content-Type": "application/json" } : {}),
          ...(authToken ? { "X-Wangzai-Purchase-Token": authToken } : {}),
        },
        body: request.serialized,
        signal: controller.signal,
      });
      const data = await parseJsonResponse(response);
      return {
        ok: response.ok && data?.ok !== false,
        status: response.status,
        data,
        ...(!response.ok || data?.ok === false
          ? { error: data?.message || `拍单服务 HTTP ${response.status}` }
          : {}),
      };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        error: error?.name === "AbortError" ? "拍单服务请求超时" : "无法连接拍单服务",
      };
    } finally {
      clearTimeout(timer);
    }
  };
}
