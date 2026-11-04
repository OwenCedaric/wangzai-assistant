import path from "node:path";
import { loadLicenseConfig, publicLicenseConfig } from "./licenseConfig.js";
import { LicenseSessionStore } from "./licenseSessionStore.js";
import { verifyOfflineToken } from "./offlineTokenVerifier.js";
import { RememberedLoginStore } from "./rememberedLoginStore.js";
import { licenseAuthorizationScope } from "./licenseAuthorizationScope.js";

const ALLOWED_PATHS = [
  /^\/api\/auth\/(?:login|register|sms\/send|sms\/verify|refresh|logout|me)$/,
  /^\/api\/store\/plans$/,
  /^\/api\/orders(?:\/[A-Za-z0-9_-]+(?:\/(?:pay|query))?)?$/,
  /^\/api\/payments\/development\/[A-Za-z0-9_-]+\/complete$/,
  /^\/api\/points\/(?:packages|wallet|ledger|spend)$/,
  /^\/api\/model-presets$/,
  /^\/api\/license\/(?:activate|activate-shop|bind-shop|check|heartbeat|public-key|renew|entitlements)$/,
  /^\/api\/shops\/bind$/,
  /^\/api\/smart-reply\/(?:status|credentials|rules|tasks(?:\/[A-Za-z0-9_-]+\/retry)?|rules\/[A-Za-z0-9_-]+\/enabled)$/,
  /^\/api\/core-v2\/cross-border\/(?:authorize|revoke|endpoints|read|write\/(?:preview|confirm))$/,
];
const ALLOWED_METHODS = new Set(["GET", "POST"]);
const BODY_LIMIT = 64 * 1024;
const ONLINE_ONLY_FRESHNESS_MS = 12 * 60 * 1000;
const SHOP_ENTITLEMENT_FRESHNESS_MS = 30 * 1000;
const ENTITLEMENT_REJECTION_STATUSES = new Set([403, 404, 409, 410, 422]);
// Overload / gateway answers say nothing about the grant. Treat them like a transport
// failure so one busy period cannot strip every online client's fresh lease at once
// (the lease still expires on schedule; explicit rejections above still clear it).
const TRANSIENT_SERVER_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

function publicPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const clean = { ...payload };
  delete clean.access_token;
  delete clean.refresh_token;
  delete clean.license_token;
  delete clean.offline_token;
  delete clean.license_key;
  if (clean.entitlement && typeof clean.entitlement === "object" && !Array.isArray(clean.entitlement)) {
    clean.entitlement = publicPayload(clean.entitlement);
  }
  return clean;
}

function trustedBody(config, requestPath, requestMethod, inputBody, { deviceCode, session }) {
  const body = inputBody && typeof inputBody === "object" ? { ...inputBody } : {};
  if (
    requestPath === "/api/auth/login" ||
    requestPath === "/api/auth/register" ||
    requestPath === "/api/auth/sms/send" ||
    requestPath === "/api/auth/sms/verify"
  ) {
    Object.assign(body, {
      project_code: config.projectCode,
      device_code: deviceCode,
      device_name: "旺崽助手桌面端",
      version: config.version,
    });
    if (requestPath.startsWith("/api/auth/sms/")) body.scene = "login_or_register";
    else delete body.scene;
    if (config.versionHash) body.version_hash = config.versionHash;
    else delete body.version_hash;
    if (config.channelCode && config.distributionToken) {
      body.channel_code = config.channelCode;
      body.distribution_token = config.distributionToken;
    } else {
      delete body.channel_code;
      delete body.distribution_token;
    }
  }
  if (requestPath === "/api/auth/refresh") {
    return { refresh_token: session.refreshToken, device_code: deviceCode };
  }
  if (requestPath === "/api/auth/logout") {
    return { refresh_token: session.refreshToken };
  }
  if (requestPath === "/api/orders") body.project_code = config.projectCode;
  if (requestPath === "/api/points/spend") body.project_code = config.projectCode;
  if (requestPath === "/api/model-presets" && requestMethod === "PUT") {
    body.project_code = config.projectCode;
  }
  if (["/api/license/activate", "/api/license/activate-shop", "/api/license/check", "/api/license/heartbeat", "/api/license/renew"].includes(requestPath)) {
    Object.assign(body, {
      project_code: config.projectCode,
      device_code: deviceCode,
      version: config.version,
    });
    if (requestPath !== "/api/license/renew") delete body.license_key;
    if (requestPath !== "/api/license/heartbeat") body.device_name = "旺崽助手桌面端";
    else delete body.device_name;
    if (config.versionHash) body.version_hash = config.versionHash;
    else delete body.version_hash;
  }
  if (requestPath === "/api/license/bind-shop") body.project_code = config.projectCode;
  if (requestPath === "/api/shops/bind") {
    Object.assign(body, {
      license_key: session.licenseKey,
      project_code: config.projectCode,
      platform: "ozon",
    });
  }
  return Object.keys(body).length ? body : undefined;
}

function normalizedRequest(config, input = {}, context) {
  const method = String(input.method || "GET").toUpperCase();
  const candidate = new URL(String(input.path || ""), `${config.serverUrl}/`);
  const server = new URL(config.serverUrl);
  const isModelPresetWrite = method === "PUT" && candidate.pathname === "/api/model-presets";
  if (!ALLOWED_METHODS.has(method) && !isModelPresetWrite) {
    throw new Error("不支持的 License Center 请求方法");
  }
  if (candidate.origin !== server.origin || !ALLOWED_PATHS.some((pattern) => pattern.test(candidate.pathname))) {
    throw new Error("请求地址不在 License Center 允许列表中");
  }
  if (
    candidate.pathname === "/api/store/plans" ||
    candidate.pathname === "/api/license/entitlements" ||
    ["/api/points/packages", "/api/points/wallet", "/api/points/ledger", "/api/model-presets"].includes(
      candidate.pathname,
    )
  ) {
    candidate.search = "";
    candidate.searchParams.set("project_code", config.projectCode);
    if (candidate.pathname === "/api/points/ledger") {
      const requestedPage = Math.max(1, Math.min(10000, Number(input.page) || 1));
      const requestedSize = Math.max(1, Math.min(100, Number(input.pageSize) || 20));
      candidate.searchParams.set("page", String(requestedPage));
      candidate.searchParams.set("page_size", String(requestedSize));
    }
  }
  const body = trustedBody(config, candidate.pathname, method, input.body, context);
  const serialized = body === undefined ? undefined : JSON.stringify(body);
  if (serialized && Buffer.byteLength(serialized, "utf8") > BODY_LIMIT) {
    throw new Error("License Center 请求体过大");
  }
  return { method, url: candidate.toString(), path: candidate.pathname, serialized };
}

function tokenForPath(session, requestPath) {
  if (requestPath.startsWith("/api/core-v2/cross-border/")) {
    return session.licenseAccessToken;
  }
  if (
    requestPath === "/api/license/heartbeat" ||
    requestPath === "/api/license/check" ||
    requestPath.startsWith("/api/smart-reply/")
  ) {
    return session.licenseAccessToken || session.userAccessToken;
  }
  return session.userAccessToken;
}

async function parseResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { detail: "License Center 返回了无效响应" };
  }
}

function errorMessage(payload, status) {
  if (typeof payload?.detail === "string") return payload.detail;
  if (typeof payload?.detail?.message === "string") return payload.detail.message;
  if (typeof payload?.message === "string") return payload.message;
  return `License Center 请求失败（${status}）`;
}

export function createLicenseRuntime({
  app,
  safeStorage,
  desktopRoot,
  resourcesPath,
  fetchImpl = fetch,
  onSessionSnapshot = () => undefined,
  onlineOnlyFreshnessMs = ONLINE_ONLY_FRESHNESS_MS,
}) {
  const config = loadLicenseConfig({ app, desktopRoot, resourcesPath });
  const store = new LicenseSessionStore({
    directory: path.join(app.getPath("userData"), "license"),
    safeStorage,
  });
  const rememberedLoginStore = new RememberedLoginStore({
    directory: path.join(app.getPath("userData"), "license"),
    safeStorage,
  });
  // A persisted token is useful only inside the process that created it. Each
  // desktop start clears the old authentication session so account status and
  // license expiry must be checked through a new password login.
  const startupSessionReset = store.clear();
  let deviceCodePromise;
  let offlineKeyPromise;
  let refreshPromise;
  let protectedComputeTokenPromise;
  let shopEntitlementsPromise;
  let serviceBindingEpoch = 0;
  let shopEntitlementCache = {
    freshUntilMs: 0,
    recordCount: 0,
    expiryByShopId: new Map(),
  };
  let onlineOnlyEntitlement = null;
  let onlineOnlyFreshUntilMs = 0;
  let onlineOnlyExpiryTimer;

  function clearOnlineOnlyEntitlement() {
    onlineOnlyEntitlement = null;
    onlineOnlyFreshUntilMs = 0;
    clearTimeout(onlineOnlyExpiryTimer);
    onlineOnlyExpiryTimer = undefined;
  }

  function clearShopEntitlementCache() {
    shopEntitlementCache = {
      freshUntilMs: 0,
      recordCount: 0,
      expiryByShopId: new Map(),
    };
  }

  function staleLicenseResponse(requestPath, epoch) {
    return requestPath.startsWith('/api/license/') && epoch !== serviceBindingEpoch;
  }

  function reboundLicenseResult() {
    return { ok: false, status: 409, code: 'LICENSE_RUNTIME_REBOUND', error: '授权服务连接已更新，请刷新授权状态后再继续。' };
  }

  function adoptShopEntitlements(payload) {
    const now = Date.now();
    const expiryByShopId = new Map();
    for (const item of Array.isArray(payload) ? payload : []) {
      const expiry = Date.parse(item?.expire_time || "");
      if (item?.status !== "active" || !Number.isFinite(expiry) || expiry <= now) continue;
      for (const shop of Array.isArray(item?.shops) ? item.shops : []) {
        const shopId = String(shop?.shop_id || "").trim();
        if (shop?.status !== "active" || !shopId) continue;
        expiryByShopId.set(shopId, Math.max(expiryByShopId.get(shopId) || 0, expiry));
      }
    }
    shopEntitlementCache = {
      freshUntilMs: now + SHOP_ENTITLEMENT_FRESHNESS_MS,
      recordCount: Array.isArray(payload) ? payload.length : 0,
      expiryByShopId,
    };
  }

  function currentOnlineOnlyEntitlement(clockValid) {
    if (
      clockValid === false ||
      !onlineOnlyEntitlement?.valid ||
      Date.now() >= onlineOnlyFreshUntilMs
    ) {
      clearOnlineOnlyEntitlement();
      return null;
    }
    return onlineOnlyEntitlement;
  }

  function adoptOnlineOnlyEntitlement(payload) {
    clearOnlineOnlyEntitlement();
    const clean = publicPayload(payload);
    const licenseDeadline = Date.parse(clean.expire || clean.expire_time || "");
    onlineOnlyFreshUntilMs = Math.min(
      Date.now() + Math.max(1, Number(onlineOnlyFreshnessMs) || ONLINE_ONLY_FRESHNESS_MS),
      Number.isFinite(licenseDeadline) ? licenseDeadline : Number.POSITIVE_INFINITY,
    );
    if (onlineOnlyFreshUntilMs <= Date.now()) return;
    onlineOnlyEntitlement = {
      ...clean,
      valid: true,
      online_session_only: true,
      permissions: Array.isArray(clean.permissions) ? [...new Set(clean.permissions)] : [],
    };
    onlineOnlyExpiryTimer = setTimeout(() => {
      clearOnlineOnlyEntitlement();
      publishSessionSnapshot({ observeClock: true }).catch(() => undefined);
    }, Math.max(0, onlineOnlyFreshUntilMs - Date.now()) + 10);
    onlineOnlyExpiryTimer.unref?.();
  }

  async function publishSessionSnapshot({ observeClock = false } = {}) {
    await store.load();
    const clockValid = observeClock ? await store.observeClock() : true;
    const storedSnapshot = await store.publicSnapshot({
      projectCode: config.projectCode,
      deviceCode: await getDeviceCode(),
      jwtIssuer: config.jwtIssuer,
      jwtAudience: config.jwtAudience,
      offlineKeyFingerprint: config.offlineKeyFingerprint,
      clockValid,
    });
    const volatileEntitlement = currentOnlineOnlyEntitlement(clockValid);
    const snapshot = volatileEntitlement
      ? { ...storedSnapshot, authorized: true, entitlement: volatileEntitlement }
      : storedSnapshot;
    const entitlement = snapshot.entitlement || {};
    await Promise.resolve().then(() =>
      onSessionSnapshot({
        mode: config.mode,
        authorized: snapshot.authorized === true,
        authorizationScope: snapshot.authorized === true ? licenseAuthorizationScope(snapshot.user, config.projectCode) : null,
        permissions: entitlement.permissions || [],
        expire: entitlement.expire || "",
        offline_until: entitlement.offline_until || "",
      }),
    ).catch(() => undefined);
    return snapshot;
  }

  const getDeviceCode = () => {
    deviceCodePromise ||= store.getDeviceCode();
    return deviceCodePromise;
  };

  async function fetchOfflineKey(force = false) {
    if (!force && offlineKeyPromise) return offlineKeyPromise;
    offlineKeyPromise = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12_000);
      try {
        const response = await fetchImpl(`${config.serverUrl}/api/license/public-key`, {
          method: "GET",
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        const payload = await parseResponse(response);
        if (!response.ok) throw new Error(errorMessage(payload, response.status));
        const keyId = String(payload.key_id || "");
        const publicKeyPem = String(payload.public_key_pem || "");
        if (!keyId || !publicKeyPem) throw new Error("授权服务未返回离线验签公钥");
        return { keyId, publicKeyPem };
      } catch (error) {
        offlineKeyPromise = undefined;
        if (error?.name === "AbortError") throw new Error("获取离线验签公钥超时");
        throw error;
      } finally {
        clearTimeout(timer);
      }
    })();
    return offlineKeyPromise;
  }

  async function verifiedEntitlement(payload) {
    const token = String(payload.offline_token || "");
    if (!token) throw new Error("授权服务未返回签名离线凭证");
    let key = await fetchOfflineKey();
    const expected = {
      publicKeyPem: key.publicKeyPem,
      keyId: key.keyId,
      expectedKeyFingerprint: config.offlineKeyFingerprint,
      issuer: config.jwtIssuer,
      audience: config.jwtAudience,
      projectCode: config.projectCode,
      deviceCode: await getDeviceCode(),
    };
    let claims;
    try {
      claims = verifyOfflineToken(token, expected);
    } catch {
      key = await fetchOfflineKey(true);
      claims = verifyOfflineToken(token, {
        ...expected,
        publicKeyPem: key.publicKeyPem,
        keyId: key.keyId,
      });
    }
    return {
      entitlement: {
        ...publicPayload(payload),
        valid: true,
        expire: claims.expire,
        offline_until: claims.offline_until,
        permissions: claims.permissions,
        device_limit: claims.device_limit,
        shop_limit: claims.shop_limit,
        offline_token: token,
      },
      offlinePublicKeyPem: key.publicKeyPem,
      offlineKeyId: key.keyId,
    };
  }

  async function adoptTokens(requestPath, payload, requestEpoch) {
    if (!payload || typeof payload !== "object") return;
    const shopEntitlementMutation = [
      "/api/license/activate",
      "/api/license/activate-shop",
      "/api/license/bind-shop",
      "/api/license/renew",
    ].includes(requestPath);
    const addOnShopEntitlementMutation = shopEntitlementMutation && [
      "shop_standard_monthly",
      "shop_standard_annual",
    ].includes(String(payload.license_role || ""));
    const sessionUpdate = {};
    const accessToken = String(payload.access_token || payload.license_token || "");
    if (accessToken) {
      if (requestPath.startsWith("/api/license/")) {
        if (!addOnShopEntitlementMutation) sessionUpdate.licenseAccessToken = accessToken;
      } else {
        sessionUpdate.userAccessToken = accessToken;
      }
    }
    if (payload.refresh_token) sessionUpdate.refreshToken = String(payload.refresh_token);
    if (payload.user && typeof payload.user === "object") sessionUpdate.user = payload.user;
    const entitlementPayload = requestPath.startsWith("/api/license/") && !addOnShopEntitlementMutation
      ? payload
      : requestPath === "/api/auth/register" && payload.entitlement && typeof payload.entitlement === "object"
        ? payload.entitlement
        : null;
    if (entitlementPayload && typeof entitlementPayload.valid === "boolean") {
      const licenseAccessToken = String(
        entitlementPayload.access_token || entitlementPayload.license_token || "",
      );
      if (licenseAccessToken) sessionUpdate.licenseAccessToken = licenseAccessToken;
      if (entitlementPayload.license_key) {
        sessionUpdate.licenseKey = String(entitlementPayload.license_key);
      }
      if (entitlementPayload.valid) {
        if (entitlementPayload.offline_token) {
          const verified = await verifiedEntitlement(entitlementPayload);
          if (staleLicenseResponse(requestPath, requestEpoch)) {
            throw Object.assign(new Error('LICENSE_RUNTIME_REBOUND'), { code: 'LICENSE_RUNTIME_REBOUND' });
          }
          clearOnlineOnlyEntitlement();
          Object.assign(sessionUpdate, verified);
        } else {
          adoptOnlineOnlyEntitlement(entitlementPayload);
          Object.assign(sessionUpdate, {
            entitlement: null,
            offlinePublicKeyPem: "",
            offlineKeyId: "",
          });
        }
        const serverTime = Date.parse(entitlementPayload.server_time);
        sessionUpdate.lastObservedAtMs = Math.max(
          Date.now(),
          Number.isFinite(serverTime) ? serverTime : 0,
        );
      }
      else {
        clearOnlineOnlyEntitlement();
        Object.assign(sessionUpdate, {
          licenseAccessToken: "",
          licenseKey: "",
          entitlement: null,
          offlinePublicKeyPem: "",
          offlineKeyId: "",
        });
      }
    }
    if (Object.keys(sessionUpdate).length) await store.save(sessionUpdate);
  }

  async function refreshUserSession() {
    if (!refreshPromise) {
      refreshPromise = (async () => {
        const current = await store.load();
        if (!current.refreshToken) {
          return { ok: false, status: 401, error: "登录会话已过期" };
        }
        return perform(
          {
            method: "POST",
            path: "/api/auth/refresh",
            body: { refresh_token: current.refreshToken, device_code: await getDeviceCode() },
          },
          false,
        );
      })().finally(() => {
        refreshPromise = undefined;
      });
    }
    return refreshPromise;
  }

  async function perform(input, allowRefresh = true) {
    const requestEpoch = serviceBindingEpoch;
    const session = await store.load();
    const request = normalizedRequest(config, input, {
      deviceCode: await getDeviceCode(),
      session,
    });
    const isCrossBorderCoreRequest = request.path.startsWith("/api/core-v2/cross-border/");
    if (isCrossBorderCoreRequest && !session.licenseAccessToken && allowRefresh) {
      const checked = await perform({ method: "POST", path: "/api/license/check", body: {} }, false);
      if (!checked.ok) {
        return {
          ok: false,
          status: checked.status,
          error: checked.error || "卡密授权校验失败，请重新登录或检查授权状态",
        };
      }
      return perform(input, false);
    }
    const token = tokenForPath(session, request.path);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    let response;
    try {
      response = await fetchImpl(request.url, {
        method: request.method,
        headers: {
          Accept: "application/json",
          ...(request.serialized ? { "Content-Type": "application/json" } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: request.serialized,
        signal: controller.signal,
      });
    } catch (error) {
      return { ok: false, status: 0, error: error?.name === "AbortError" ? "请求超时" : "无法连接授权服务" };
    } finally {
      clearTimeout(timer);
    }
    const payload = await parseResponse(response);
    // A response issued before sleep/recovery rebinding cannot repopulate the
    // replacement service's authorization cache. User refresh-token rotation
    // is deliberately not fenced: losing its response would destroy login.
    if (staleLicenseResponse(request.path, requestEpoch)) return reboundLicenseResult();
    if (response.status === 401 && allowRefresh && isCrossBorderCoreRequest) {
      await store.save({ licenseAccessToken: "" });
      const checked = await perform({ method: "POST", path: "/api/license/check", body: {} }, false);
      if (checked.ok) return perform(input, false);
      return {
        ok: false,
        status: checked.status,
        error: checked.error || "卡密授权校验失败，请重新登录或检查授权状态",
      };
    }
    if (response.status === 401 && allowRefresh && session.refreshToken && request.path !== "/api/auth/refresh") {
      if (request.path.startsWith("/api/license/")) {
        await store.save({ licenseAccessToken: "" });
      }
      const refreshed = await refreshUserSession();
      if (refreshed.ok) {
        if (request.path === "/api/license/heartbeat") {
          return perform({ method: "POST", path: "/api/license/check", body: input.body }, false);
        }
        return perform(input, false);
      }
      if (request.path.startsWith("/api/license/") && refreshed.status > 0) {
        await store.save({
          entitlement: null,
          offlinePublicKeyPem: "",
          offlineKeyId: "",
        });
      }
    }
    if (!response.ok) {
      if (request.path === "/api/auth/login" && response.status === 401) {
        await rememberedLoginStore.clear();
      }
      const validatesCurrentEntitlement =
        request.path === "/api/license/check" || request.path === "/api/license/heartbeat";
      if (validatesCurrentEntitlement && !TRANSIENT_SERVER_STATUSES.has(response.status)) {
        clearOnlineOnlyEntitlement();
      }
      if (
        validatesCurrentEntitlement &&
        ENTITLEMENT_REJECTION_STATUSES.has(response.status)
      ) {
        await store.save({ licenseAccessToken: "", licenseKey: "", entitlement: null });
      }
      if (request.path.startsWith("/api/license/") && response.status === 401) {
        await store.save({
          entitlement: null,
          offlinePublicKeyPem: "",
          offlineKeyId: "",
        });
      }
      if (response.status === 401) {
        await store.save({
          userAccessToken: "",
          refreshToken: "",
          licenseAccessToken: "",
          licenseKey: "",
          user: null,
        });
      }
      return { ok: false, status: response.status, error: errorMessage(payload, response.status) };
    }
    try {
      await adoptTokens(request.path, payload, requestEpoch);
    } catch (error) {
      if (error?.code === 'LICENSE_RUNTIME_REBOUND') return reboundLicenseResult();
      if (request.path.startsWith("/api/license/")) {
        clearOnlineOnlyEntitlement();
        await store.save({
          licenseAccessToken: "",
          licenseKey: "",
          entitlement: null,
          offlinePublicKeyPem: "",
          offlineKeyId: "",
        });
      }
      return {
        ok: false,
        status: 502,
        error: error?.message || "离线授权凭证验证失败",
      };
    }
    if (staleLicenseResponse(request.path, requestEpoch)) return reboundLicenseResult();
    if (request.path === "/api/license/entitlements") adoptShopEntitlements(payload);
    if (["/api/license/activate-shop", "/api/license/bind-shop", "/api/license/renew"].includes(request.path)) {
      clearShopEntitlementCache();
    }
    return { ok: true, status: response.status, data: publicPayload(payload) };
  }

  async function getUserAccessToken({
    forceRefresh = false,
    rejectedAccessToken = "",
  } = {}) {
    let session = await store.load();
    const rejected = String(rejectedAccessToken || "");
    if (
      forceRefresh &&
      rejected &&
      session.userAccessToken &&
      session.userAccessToken !== rejected
    ) {
      return session.userAccessToken;
    }
    if (forceRefresh || !session.userAccessToken) {
      if (!session.refreshToken) throw new Error("登录会话已过期");
      const refreshed = await refreshUserSession();
      if (!refreshed.ok) {
        const error = new Error("登录会话刷新失败");
        error.status = Number(refreshed.status) || 0;
        throw error;
      }
      session = await store.load();
    }
    if (!session.userAccessToken) throw new Error("登录会话已过期");
    return session.userAccessToken;
  }

  async function getProtectedComputeAccessToken({
    forceRefresh = false,
    rejectedAccessToken = "",
  } = {}) {
    const session = await store.load();
    const rejected = String(rejectedAccessToken || "");
    if (
      rejected &&
      session.licenseAccessToken &&
      session.licenseAccessToken !== rejected
    ) {
      return session.licenseAccessToken;
    }
    if (!forceRefresh && session.licenseAccessToken) {
      return session.licenseAccessToken;
    }
    if (!protectedComputeTokenPromise) {
      protectedComputeTokenPromise = (async () => {
        const current = await store.load();
        if (
          rejected &&
          current.licenseAccessToken &&
          current.licenseAccessToken !== rejected
        ) {
          return current.licenseAccessToken;
        }
        // A 401 identifies the rejected device-bound license token. Clear only
        // that token before /api/license/check so the check can safely fall
        // back to the authenticated user token and mint a replacement bound to
        // this runtime's sealed project and device code.
        if (rejected && current.licenseAccessToken === rejected) {
          await store.save({ licenseAccessToken: "" });
        }
        const checked = await perform({
          method: "POST",
          path: "/api/license/check",
          body: {},
        });
        if (!checked.ok) {
          throw new Error(checked.error || "设备授权令牌轮换失败");
        }
        const updated = await store.load();
        if (!updated.licenseAccessToken) {
          throw new Error("设备授权令牌轮换失败");
        }
        return updated.licenseAccessToken;
      })().finally(() => {
        protectedComputeTokenPromise = undefined;
      });
    }
    return protectedComputeTokenPromise;
  }

  async function refreshShopEntitlements() {
    const now = Date.now();
    if (shopEntitlementCache.freshUntilMs <= now) {
      if (!shopEntitlementsPromise) {
        const pending = perform({
          method: "GET",
          path: `/api/license/entitlements?project_code=${encodeURIComponent(config.projectCode)}`,
        }).then((result) => {
          if (!result.ok) throw Object.assign(new Error(result.error || "店铺授权校验失败"), { code: result.code });
          return result;
        }).finally(() => {
          if (shopEntitlementsPromise === pending) shopEntitlementsPromise = undefined;
        });
        shopEntitlementsPromise = pending;
      }
      await shopEntitlementsPromise;
    }
    return shopEntitlementCache;
  }

  async function assertOzonShopEntitled(shopId) {
    const normalizedShopId = String(shopId || "").trim();
    if (!normalizedShopId) throw new Error("OZON_SHOP_LICENSE_ID_REQUIRED");
    await refreshShopEntitlements();
    const expiry = shopEntitlementCache.expiryByShopId.get(normalizedShopId) || 0;
    if (expiry > Date.now()) {
      return {
        authorized: true,
        shopId: normalizedShopId,
        expireAt: new Date(expiry).toISOString(),
      };
    }

    throw new Error("当前 Ozon 店铺未绑定有效卡密或授权已到期");
  }

  return {
    rebindSessionObserver(observer = () => undefined) {
      if (typeof observer !== 'function') throw new Error('LICENSE_SESSION_OBSERVER_REQUIRED');
      onSessionSnapshot = observer;
      serviceBindingEpoch += 1;
      shopEntitlementsPromise = undefined;
      // A service restart is not a new desktop process: keep the authenticated
      // session, but never extend a volatile authorization or shop-grant lease.
      // Normal getSession/check paths still validate the clock/signature/expiry,
      // and the replacement local-api must receive freshly checked shop grants.
      clearOnlineOnlyEntitlement();
      clearShopEntitlementCache();
    },
    async getRuntime() {
      await startupSessionReset;
      return publicLicenseConfig(config, await getDeviceCode());
    },
    async getSession() {
      await startupSessionReset;
      return publishSessionSnapshot({ observeClock: true });
    },
    async request(input) {
      await startupSessionReset;
      const result = await perform(input);
      await publishSessionSnapshot();
      return result;
    },
    async beginLogin() {
      await startupSessionReset;
      clearOnlineOnlyEntitlement();
      clearShopEntitlementCache();
      await store.clear();
      await publishSessionSnapshot();
      return { ok: true };
    },
    async getRememberedLogin() {
      await startupSessionReset;
      return rememberedLoginStore.publicSnapshot();
    },
    async saveRememberedLogin(input) {
      await startupSessionReset;
      return rememberedLoginStore.save(input);
    },
    async clearRememberedLogin() {
      await startupSessionReset;
      return rememberedLoginStore.clear();
    },
    async loginWithRememberedCredentials() {
      await startupSessionReset;
      const credentials = await rememberedLoginStore.credentials();
      if (!credentials) {
        return { ok: false, status: 400, error: "当前设备没有已保存的账号和密码" };
      }
      const result = await perform({
        method: "POST",
        path: "/api/auth/login",
        body: credentials,
      });
      await publishSessionSnapshot();
      return result;
    },
    async getRecoveryRemoteContext({ forceRefresh = false, rejectedAccessToken = '' } = {}) {
      await startupSessionReset;
      try {
        const accessToken = await getUserAccessToken({ forceRefresh, rejectedAccessToken });
        return { baseUrl: config.serverUrl, accessToken };
      } catch (cause) {
        const unavailable = cause?.status === 0;
        const denied = cause?.status === 403;
        const error = new Error(unavailable
          ? '无法连接登录服务，请检查网络后继续同一删除任务。'
          : denied ? '当前登录账号无权刷新恢复授权，请检查账号权限。'
            : '请先登录账号后再使用灾难备份。');
        error.code = unavailable ? 'RECOVERY_REMOTE_UNAVAILABLE' : denied ? 'RECOVERY_REMOTE_ACCESS_DENIED' : 'RECOVERY_REMOTE_LOGIN_REQUIRED';
        error.remoteStatus = unavailable ? 0 : denied ? 403 : 401;
        error.status = unavailable ? 503 : error.remoteStatus;
        error.safeAuthRetry = false;
        error.cause = cause;
        throw error;
      }
    },
    async getProtectedComputeAccessToken(input) {
      await startupSessionReset;
      return getProtectedComputeAccessToken(input);
    },
    async getUserAccessToken(input) {
      await startupSessionReset;
      return getUserAccessToken(input);
    },
    async assertOzonShopEntitled(shopId) {
      await startupSessionReset;
      return assertOzonShopEntitled(shopId);
    },
    async getOzonShopEntitlementGrants() {
      await startupSessionReset;
      await refreshShopEntitlements();
      const now = Date.now();
      return [...shopEntitlementCache.expiryByShopId.entries()]
        .filter(([, expiry]) => expiry > now)
        .map(([clientId, expiry]) => ({
          clientId,
          expireAt: new Date(expiry).toISOString(),
        }));
    },
    async logout() {
      await startupSessionReset;
      clearOnlineOnlyEntitlement();
      clearShopEntitlementCache();
      const session = await store.load();
      await perform(
        {
          method: "POST",
          path: "/api/auth/logout",
          body: { refresh_token: session.refreshToken },
        },
        false,
      ).catch(() => undefined);
      await store.clear();
      await publishSessionSnapshot();
      return { ok: true };
    },
  };
}

export function registerLicenseIpcHandlers({ ipcMain, existingRuntime = null, ...options }) {
  const runtime = existingRuntime || createLicenseRuntime(options);
  if (existingRuntime) {
    if (typeof runtime.rebindSessionObserver !== 'function') {
      throw new Error('LICENSE_RUNTIME_REBIND_UNAVAILABLE');
    }
    runtime.rebindSessionObserver(options.onSessionSnapshot);
  }
  const handlers = {
    "license:get-runtime": () => runtime.getRuntime(),
    "license:get-session": () => runtime.getSession(),
    "license:request": (_event, input) => runtime.request(input),
    "license:begin-login": () => runtime.beginLogin(),
    "license:get-remembered-login": () => runtime.getRememberedLogin(),
    "license:save-remembered-login": (_event, input) => runtime.saveRememberedLogin(input),
    "license:clear-remembered-login": () => runtime.clearRememberedLogin(),
    "license:login-with-remembered-credentials": () => runtime.loginWithRememberedCredentials(),
    "license:logout": () => runtime.logout(),
  };
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, handler);
  }
  return runtime;
}
