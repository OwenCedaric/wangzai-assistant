import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createLicenseRuntime, registerLicenseIpcHandlers } from "./licenseRuntime.js";

const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value, "utf8").map((byte) => byte ^ 0x6b),
  decryptString: (value) => Buffer.from(value).map((byte) => byte ^ 0x6b).toString("utf8"),
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function signedOfflineToken(privateKey, deviceCode) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", kid: "test-key", typ: "JWT" })).toString(
    "base64url",
  );
  const payload = Buffer.from(
    JSON.stringify({
      sub: "1",
      license_id: 1,
      project_code: "wangzai_desktop",
      device_code: deviceCode,
      permissions: ["orders.view"],
      device_limit: 1,
      shop_limit: 1,
      iat: now,
      nbf: now,
      exp: now + 3600,
      offline_until: now + 3600,
      expire: now + 86400,
      license_expire: now + 86400,
      iss: "license-center",
      aud: "license-center-clients",
    }),
  ).toString("base64url");
  const signature = crypto.sign(null, Buffer.from(`${header}.${payload}`, "ascii"), privateKey);
  return `${header}.${payload}.${signature.toString("base64url")}`;
}

test('same-process IPC rebind keeps login but invalidates volatile authorization and shop grants', async () => {
  const directory = await fs.mkdtemp(path.join(process.cwd(), '.license-runtime-rebind-test-'));
  const previousUrl = process.env.LICENSE_CENTER_URL;
  const previousMode = process.env.WANGZAI_LICENSE_MODE;
  const previousFixtureUrls = process.env.WANGZAI_ALLOW_TEST_FIXTURE_URLS;
  process.env.LICENSE_CENTER_URL = 'http://127.0.0.1:8000';
  process.env.WANGZAI_LICENSE_MODE = 'enforce';
  process.env.WANGZAI_ALLOW_TEST_FIXTURE_URLS = '1';
  const handlers = new Map();
  const oldSnapshots = [];
  const newSnapshots = [];
  let entitlementReads = 0;
  let revoked = false;
  try {
    const options = {
      ipcMain: { removeHandler: channel => handlers.delete(channel), handle: (channel, handler) => handlers.set(channel, handler) },
      app: { isPackaged: false, getName: () => 'Audit fixture', getVersion: () => '1.0.0', getPath: () => directory },
      safeStorage,
      desktopRoot: path.join(directory, 'isolated-app-root'),
      resourcesPath: '',
      onSessionSnapshot: snapshot => oldSnapshots.push(snapshot),
      fetchImpl: async (url) => {
        const pathname = new URL(url).pathname;
        if (pathname === '/api/auth/login') return jsonResponse({ access_token: 'fixture-user-token', refresh_token: 'fixture-refresh-token', user: { id: 84 } });
        if (pathname === '/api/license/check') {
          if (revoked) return jsonResponse({ detail: 'License disabled' }, 403);
          return jsonResponse({ valid: true, online_required: true, access_token: 'fixture-license-token', permissions: ['orders.view'], expire: new Date(Date.now() + 3600_000).toISOString() });
        }
        assert.equal(pathname, '/api/license/entitlements');
        entitlementReads += 1;
        return jsonResponse(revoked ? [] : [{ status: 'active', expire_time: new Date(Date.now() + 3600_000).toISOString(), shops: [{ status: 'active', shop_id: 'fixture-shop' }] }]);
      },
    };
    const first = registerLicenseIpcHandlers(options);
    assert.equal((await handlers.get('license:request')({}, { method: 'POST', path: '/api/auth/login', body: { email: 'fixture@example.test', password: 'fixture-only' } })).ok, true);
    assert.equal((await first.request({ method: 'POST', path: '/api/license/check', body: {} })).ok, true);
    assert.equal((await first.getSession()).authorized, true);
    assert.equal((await first.getOzonShopEntitlementGrants()).length, 1);
    assert.equal(entitlementReads, 1);
    const originalHandlerCount = handlers.size;
    const previousSnapshotCount = oldSnapshots.length;
    revoked = true;
    const rebound = registerLicenseIpcHandlers({
      ...options,
      existingRuntime: first,
      onSessionSnapshot: snapshot => newSnapshots.push(snapshot),
    });
    assert.equal(rebound, first);
    assert.equal(handlers.size, originalHandlerCount);
    const session = await handlers.get('license:get-session')();
    assert.equal(session.authenticated, true, 'sleep/resume must not erase the user login');
    assert.equal(session.authorized, false, 'rebind must not grant or extend online-only authorization');
    assert.equal(await rebound.getUserAccessToken(), 'fixture-user-token');
    assert.equal(oldSnapshots.length, previousSnapshotCount, 'session updates target the replacement bridge');
    assert.equal(newSnapshots.length, 1);
    assert.deepEqual(await rebound.getOzonShopEntitlementGrants(), []);
    assert.equal(entitlementReads, 2, 'the new local-api receives a fresh authoritative grant list');
    assert.equal((await rebound.request({ method: 'POST', path: '/api/license/check', body: {} })).status, 403);
    assert.equal((await rebound.getSession()).authorized, false);
    const restarted = registerLicenseIpcHandlers(options);
    assert.notEqual(restarted, first);
    assert.equal((await restarted.getSession()).authenticated, false, 'a genuinely new runtime still starts at the login gate');
  } finally {
    if (previousUrl === undefined) delete process.env.LICENSE_CENTER_URL;
    else process.env.LICENSE_CENTER_URL = previousUrl;
    if (previousMode === undefined) delete process.env.WANGZAI_LICENSE_MODE;
    else process.env.WANGZAI_LICENSE_MODE = previousMode;
    if (previousFixtureUrls === undefined) delete process.env.WANGZAI_ALLOW_TEST_FIXTURE_URLS;
    else process.env.WANGZAI_ALLOW_TEST_FIXTURE_URLS = previousFixtureUrls;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a failing session observer cannot turn a session read into a synchronous IPC failure', async () => {
  const directory = await fs.mkdtemp(path.join(process.cwd(), '.license-runtime-observer-test-'));
  try {
    const runtime = createLicenseRuntime({
      app: { isPackaged: false, getName: () => 'Audit fixture', getVersion: () => '1.0.0', getPath: () => directory },
      safeStorage,
      desktopRoot: path.join(directory, 'isolated-app-root'),
      resourcesPath: '',
      fetchImpl: async () => { throw new Error('this fixture never contacts a license server'); },
      onSessionSnapshot: () => { throw new TypeError('fixture observer failure'); },
    });
    assert.equal((await runtime.getSession()).authenticated, false);
    runtime.rebindSessionObserver(async () => { throw new Error('fixture async observer failure'); });
    assert.equal((await runtime.getSession()).authorized, false);
    assert.throws(() => runtime.rebindSessionObserver(null), /LICENSE_SESSION_OBSERVER_REQUIRED/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('late pre-rebind shop grants cannot repopulate cache or clear the replacement singleflight', async () => {
  const directory = await fs.mkdtemp(path.join(process.cwd(), '.license-runtime-grant-race-test-'));
  const gates = [];
  let reads = 0;
  const started = [];
  try {
    const runtime = createLicenseRuntime({
      app: { isPackaged: false, getName: () => 'Audit fixture', getVersion: () => '1.0.0', getPath: () => directory },
      safeStorage,
      desktopRoot: path.join(directory, 'isolated-app-root'),
      resourcesPath: '',
      fetchImpl: async (url) => {
        assert.equal(new URL(url).pathname, '/api/license/entitlements');
        const index = reads++;
        started[index]?.();
        return new Promise(resolve => { gates[index] = resolve; });
      },
    });
    const firstStarted = new Promise(resolve => { started[0] = resolve; });
    const secondStarted = new Promise(resolve => { started[1] = resolve; });
    const first = runtime.getOzonShopEntitlementGrants();
    const rejectedFirst = assert.rejects(first, { code: 'LICENSE_RUNTIME_REBOUND' });
    await firstStarted;
    runtime.rebindSessionObserver();
    const second = runtime.getOzonShopEntitlementGrants();
    await secondStarted;
    gates[0](jsonResponse([{ status: 'active', expire_time: new Date(Date.now() + 3600_000).toISOString(), shops: [{ status: 'active', shop_id: 'stale-shop' }] }]));
    await rejectedFirst;
    const third = runtime.getOzonShopEntitlementGrants();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads, 2, 'the late request must not clear the replacement shared request');
    gates[1](jsonResponse([]));
    assert.deepEqual(await second, []);
    assert.deepEqual(await third, []);
    assert.deepEqual(await runtime.getOzonShopEntitlementGrants(), []);
    assert.equal(reads, 2);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('late license checks cannot replace authorization adopted after service rebinding', async () => {
  const directory = await fs.mkdtemp(path.join(process.cwd(), '.license-runtime-check-race-test-'));
  let releaseOld;
  let oldStarted;
  const pendingOld = new Promise(resolve => { oldStarted = resolve; });
  let checks = 0;
  try {
    const runtime = createLicenseRuntime({
      app: { isPackaged: false, getName: () => 'Audit fixture', getVersion: () => '1.0.0', getPath: () => directory },
      safeStorage,
      desktopRoot: path.join(directory, 'isolated-app-root'),
      resourcesPath: '',
      fetchImpl: async (url) => {
        if (new URL(url).pathname === '/api/auth/login') return jsonResponse({ access_token: 'fixture-token', user: { id: 85 } });
        assert.equal(new URL(url).pathname, '/api/license/check');
        checks += 1;
        if (checks === 1) {
          oldStarted();
          return new Promise(resolve => { releaseOld = resolve; });
        }
        return jsonResponse({ valid: true, online_required: true, permissions: ['products.view'], expire: new Date(Date.now() + 3600_000).toISOString() });
      },
    });
    await runtime.request({ method: 'POST', path: '/api/auth/login', body: { email: 'fixture@example.test', password: 'fixture-only' } });
    const old = runtime.request({ method: 'POST', path: '/api/license/check', body: {} });
    await pendingOld;
    runtime.rebindSessionObserver();
    assert.equal((await runtime.request({ method: 'POST', path: '/api/license/check', body: {} })).ok, true);
    releaseOld(jsonResponse({ valid: true, online_required: true, permissions: ['purchase.manage'], expire: new Date(Date.now() + 3600_000).toISOString() }));
    const result = await old;
    assert.equal(result.code, 'LICENSE_RUNTIME_REBOUND');
    assert.equal(result.status, 409);
    const session = await runtime.getSession();
    assert.equal(session.authenticated, true);
    assert.deepEqual(session.entitlement.permissions, ['products.view']);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('service rebind preserves a user refresh-token rotation already in flight', async () => {
  const directory = await fs.mkdtemp(path.join(process.cwd(), '.license-runtime-refresh-rebind-test-'));
  let releaseRefresh;
  let notifyStarted;
  const started = new Promise(resolve => { notifyStarted = resolve; });
  try {
    const runtime = createLicenseRuntime({
      app: { isPackaged: false, getName: () => 'Audit fixture', getVersion: () => '1.0.0', getPath: () => directory },
      safeStorage,
      desktopRoot: path.join(directory, 'isolated-app-root'),
      resourcesPath: '',
      fetchImpl: async (url) => {
        if (new URL(url).pathname === '/api/auth/login') return jsonResponse({ access_token: 'old-fixture-token', refresh_token: 'old-fixture-refresh', user: { id: 86 } });
        assert.equal(new URL(url).pathname, '/api/auth/refresh');
        notifyStarted();
        return new Promise(resolve => { releaseRefresh = resolve; });
      },
    });
    await runtime.request({ method: 'POST', path: '/api/auth/login', body: { email: 'fixture@example.test', password: 'fixture-only' } });
    const refreshing = runtime.getUserAccessToken({ forceRefresh: true });
    await started;
    runtime.rebindSessionObserver();
    releaseRefresh(jsonResponse({ access_token: 'new-fixture-token', refresh_token: 'new-fixture-refresh' }));
    assert.equal(await refreshing, 'new-fixture-token');
    assert.equal(await runtime.getUserAccessToken(), 'new-fixture-token');
    assert.equal((await runtime.getSession()).authenticated, true);
    assert.equal((await runtime.getSession()).authorized, false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("a new desktop runtime discards persisted tokens and always starts at the login gate", async () => {
  const directory = await fs.mkdtemp(path.join(process.cwd(), ".license-runtime-test-"));
  const previousUrl = process.env.LICENSE_CENTER_URL;
  process.env.LICENSE_CENTER_URL = "http://127.0.0.1:8000";
  const app = {
    isPackaged: false,
    getName: () => "旺崽助手",
    getVersion: () => "1.0.0",
    getPath: () => directory,
  };
  try {
    const firstRuntime = createLicenseRuntime({
      app,
      safeStorage,
      desktopRoot: path.join(directory, "isolated-app-root"),
      resourcesPath: "",
      fetchImpl: async () => jsonResponse({
        access_token: "persisted-access-token",
        refresh_token: "persisted-refresh-token",
        user: { id: 71, email: "restart@example.com" },
      }),
    });
    const loggedIn = await firstRuntime.request({
      method: "POST",
      path: "/api/auth/login",
      body: { email: "restart@example.com", password: "DesktopPass123!" },
    });
    assert.equal(loggedIn.ok, true);
    assert.equal((await firstRuntime.getSession()).authenticated, true);

    let restartFetchCount = 0;
    const restartedRuntime = createLicenseRuntime({
      app,
      safeStorage,
      desktopRoot: path.join(directory, "isolated-app-root"),
      resourcesPath: "",
      fetchImpl: async () => {
        restartFetchCount += 1;
        throw new Error("startup must not refresh an old session");
      },
    });
    const restartedSession = await restartedRuntime.getSession();
    assert.equal(restartedSession.authenticated, false);
    assert.equal(restartedSession.authorized, false);
    assert.equal(restartFetchCount, 0);
    const sessionBytes = await fs.readFile(
      path.join(directory, "license", "license-session.bin"),
      "utf8",
    );
    assert.equal(sessionBytes.includes("persisted-access-token"), false);
    assert.equal(sessionBytes.includes("persisted-refresh-token"), false);
  } finally {
    if (previousUrl === undefined) delete process.env.LICENSE_CENTER_URL;
    else process.env.LICENSE_CENTER_URL = previousUrl;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("remembered credentials stay encrypted in Main and are cleared after password rejection", async () => {
  const directory = await fs.mkdtemp(path.join(process.cwd(), ".license-runtime-test-"));
  const previousUrl = process.env.LICENSE_CENTER_URL;
  process.env.LICENSE_CENTER_URL = "http://127.0.0.1:8000";
  const requests = [];
  const responses = [
    jsonResponse({
      access_token: "remembered-access-token",
      refresh_token: "remembered-refresh-token",
      user: { id: 72, email: "saved@example.com" },
    }),
    jsonResponse({ detail: "Invalid username or password" }, 401),
  ];
  const app = {
    isPackaged: false,
    getName: () => "旺崽助手",
    getVersion: () => "1.0.0",
    getPath: () => directory,
  };
  try {
    const firstRuntime = createLicenseRuntime({
      app,
      safeStorage,
      desktopRoot: path.join(directory, "isolated-app-root"),
      resourcesPath: "",
      fetchImpl: async () => {
        throw new Error("remembering credentials does not call the network");
      },
    });
    assert.deepEqual(
      await firstRuntime.saveRememberedLogin({
        email: "Saved@Example.com",
        password: "DesktopPass123!",
      }),
      { remembered: true, email: "saved@example.com", persistent: true },
    );

    const restartedRuntime = createLicenseRuntime({
      app,
      safeStorage,
      desktopRoot: path.join(directory, "isolated-app-root"),
      resourcesPath: "",
      fetchImpl: async (url, options) => {
        requests.push({ url, body: JSON.parse(options.body) });
        return responses.shift();
      },
    });
    const publicRemembered = await restartedRuntime.getRememberedLogin();
    assert.deepEqual(publicRemembered, {
      remembered: true,
      email: "saved@example.com",
      persistent: true,
    });
    assert.equal("password" in publicRemembered, false);

    const loggedIn = await restartedRuntime.loginWithRememberedCredentials();
    assert.equal(loggedIn.ok, true);
    assert.equal(requests[0].url.endsWith("/api/auth/login"), true);
    assert.equal(requests[0].body.email, "saved@example.com");
    assert.equal(requests[0].body.password, "DesktopPass123!");
    assert.equal((await restartedRuntime.getSession()).authenticated, true);

    await restartedRuntime.beginLogin();
    const rejected = await restartedRuntime.loginWithRememberedCredentials();
    assert.equal(rejected.status, 401);
    assert.deepEqual(await restartedRuntime.getRememberedLogin(), {
      remembered: false,
      email: "",
      persistent: true,
    });
  } finally {
    if (previousUrl === undefined) delete process.env.LICENSE_CENTER_URL;
    else process.env.LICENSE_CENTER_URL = previousUrl;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("seals card registration to the packaged project and adopts the activated entitlement", async () => {
  const directory = await fs.mkdtemp(path.join(process.cwd(), ".license-runtime-test-"));
  const previousUrl = process.env.LICENSE_CENTER_URL;
  process.env.LICENSE_CENTER_URL = "http://127.0.0.1:8000";
  let capturedBody;
  try {
    const runtime = createLicenseRuntime({
      app: {
        isPackaged: false,
        getName: () => "旺崽助手",
        getVersion: () => "1.0.0",
        getPath: () => directory,
      },
      safeStorage,
      desktopRoot: path.join(directory, "isolated-app-root"),
      resourcesPath: "",
      fetchImpl: async (url, options) => {
        assert.equal(url.endsWith("/api/auth/register"), true);
        capturedBody = JSON.parse(options.body);
        return jsonResponse({
          access_token: "registered-user-access",
          refresh_token: "registered-refresh-token",
          user: { id: 51, email: "desktop@example.com" },
          project_code: "wangzai_desktop",
          entitlement: {
            valid: true,
            access_token: "registered-license-access",
            permissions: ["orders.view"],
            expire: "2027-01-01T00:00:00Z",
          },
        }, 201);
      },
    });

    const result = await runtime.request({
      method: "POST",
      path: "/api/auth/register",
      body: {
        password: "DesktopPass123!",
        email: "desktop@example.com",
        card_key: "AAAA-BBBB-CCCC-DDDD",
        project_code: "attacker_project",
        device_code: "attacker-device",
        channel_code: "ATTACKER",
        distribution_token: "attacker-distribution-token",
      },
    });

    const runtimeConfig = await runtime.getRuntime();
    assert.equal(result.ok, true);
    assert.equal("access_token" in result.data, false);
    assert.equal("refresh_token" in result.data, false);
    assert.equal(capturedBody.project_code, "wangzai_desktop");
    assert.equal(capturedBody.device_code, runtimeConfig.deviceCode);
    assert.equal(capturedBody.device_name, "旺崽助手桌面端");
    assert.equal(capturedBody.version, "1.0.0");
    assert.equal(capturedBody.card_key, "AAAA-BBBB-CCCC-DDDD");
    assert.equal("channel_code" in capturedBody, false);
    assert.equal("distribution_token" in capturedBody, false);
    assert.deepEqual((await runtime.getSession()).user, {
      id: 51,
      email: "desktop@example.com",
    });
    assert.equal(result.data.entitlement.valid, true);
    assert.equal("access_token" in result.data.entitlement, false);
    assert.equal((await runtime.getSession()).authorized, true);
  } finally {
    if (previousUrl === undefined) delete process.env.LICENSE_CENTER_URL;
    else process.env.LICENSE_CENTER_URL = previousUrl;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("keeps raw tokens in the main process and clears rejected entitlements", async () => {
  const directory = await fs.mkdtemp(path.join(process.cwd(), ".license-runtime-test-"));
  const previousUrl = process.env.LICENSE_CENTER_URL;
  process.env.LICENSE_CENTER_URL = "http://127.0.0.1:8000";
  const responses = [];
  const requests = [];
  try {
    const runtime = createLicenseRuntime({
      app: {
        isPackaged: false,
        getName: () => "旺崽助手",
        getVersion: () => "1.0.0",
        getPath: () => directory,
      },
      safeStorage,
      desktopRoot: path.join(directory, "isolated-app-root"),
      resourcesPath: "",
      fetchImpl: async (url, options) => {
        requests.push({ url, options });
        return responses.shift();
      },
    });
    const runtimeConfig = await runtime.getRuntime();
    assert.equal("distributionToken" in runtimeConfig, false);
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
    const offlineToken = signedOfflineToken(privateKey, runtimeConfig.deviceCode);
    responses.push(
      jsonResponse({
        access_token: "test-user-token",
        refresh_token: "r".repeat(64),
        user: { id: 9, username: "phone-user" },
      }),
      jsonResponse({
        access_token: "test-license-token",
        offline_token: offlineToken,
        valid: true,
        expire: new Date(Date.now() + 86_400_000).toISOString(),
        offline_until: new Date(Date.now() + 3_600_000).toISOString(),
        permissions: ["orders.view"],
      }),
      jsonResponse({
        key_id: "test-key",
        public_key_pem: publicKey.export({ type: "spki", format: "pem" }),
      }),
      jsonResponse({ detail: "Token expired" }, 401),
      jsonResponse({
        access_token: "test-refreshed-user-token",
        refresh_token: "n".repeat(64),
      }),
      jsonResponse({
        access_token: "test-refreshed-license-token",
        offline_token: offlineToken,
        valid: true,
        expire: new Date(Date.now() + 86_400_000).toISOString(),
        offline_until: new Date(Date.now() + 3_600_000).toISOString(),
        permissions: ["orders.view"],
      }),
      jsonResponse({ detail: "License token expired" }, 401),
      jsonResponse({ detail: "User disabled" }, 401),
      jsonResponse({ detail: "Device is disabled" }, 403),
    );
    const verified = await runtime.request({
      method: "POST",
      path: "/api/auth/sms/verify",
      body: {
        phone: "13800138000",
        code: "123456",
        channel_code: "ATTACKER",
        distribution_token: "attacker-token-value",
      },
    });
    assert.equal(verified.ok, true);
    assert.equal("access_token" in verified.data, false);
    assert.equal((await runtime.getSession()).authenticated, true);
    const recoveryContext = await runtime.getRecoveryRemoteContext();
    assert.deepEqual(recoveryContext, {
      baseUrl: "http://127.0.0.1:8000",
      accessToken: "test-user-token",
    });
    assert.equal("accessToken" in (await runtime.getSession()), false);
    const verifyBody = JSON.parse(requests[0].options.body);
    assert.equal(verifyBody.project_code, "wangzai_desktop");
    assert.equal(verifyBody.device_code, runtimeConfig.deviceCode);
    assert.equal("channel_code" in verifyBody, false);
    assert.equal("distribution_token" in verifyBody, false);

    const activated = await runtime.request({
      method: "POST",
      path: "/api/license/activate",
      body: { card_key: "AAAA-BBBB-CCCC-DDDD" },
    });
    assert.equal(activated.ok, true);
    assert.equal("offline_token" in activated.data, false);
    assert.equal((await runtime.getSession()).authorized, true);
    const realNow = Date.now;
    const observedNow = realNow();
    Date.now = () => observedNow - 180_000;
    try {
      assert.equal((await runtime.getSession()).authorized, false);
    } finally {
      Date.now = realNow;
    }
    assert.equal((await runtime.getSession()).authorized, true);

    const heartbeat = await runtime.request({
      method: "POST",
      path: "/api/license/heartbeat",
      body: { project_code: "attacker-project", device_code: "attacker-device" },
    });
    assert.equal(heartbeat.ok, true);
    assert.equal(requests.at(-2).url.endsWith("/api/auth/refresh"), true);
    assert.equal(requests.at(-1).url.endsWith("/api/license/check"), true);
    assert.equal((await runtime.getSession()).authorized, true);

    const disabled = await runtime.request({
      method: "POST",
      path: "/api/license/heartbeat",
      body: {},
    });
    assert.equal(disabled.status, 401);
    assert.equal((await runtime.getSession()).authorized, false);

    const rejected = await runtime.request({
      method: "POST",
      path: "/api/license/check",
      body: { project_code: "wangzai_desktop" },
    });
    assert.equal(rejected.status, 403);
    assert.equal((await runtime.getSession()).authorized, false);
    await assert.rejects(
      runtime.request({ method: "GET", path: "https://example.test/private" }),
      /允许列表/,
    );
  } finally {
    if (previousUrl === undefined) delete process.env.LICENSE_CENTER_URL;
    else process.env.LICENSE_CENTER_URL = previousUrl;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("protected-compute rotates the device-bound license token through check with singleflight and stale-401 protection", async () => {
  const directory = await fs.mkdtemp(path.join(process.cwd(), ".license-runtime-test-"));
  const previousUrl = process.env.LICENSE_CENTER_URL;
  process.env.LICENSE_CENTER_URL = "http://127.0.0.1:8000";
  let checkCalls = 0;
  let refreshCalls = 0;
  const checkAuthorization = [];
  try {
    const runtime = createLicenseRuntime({
      app: {
        isPackaged: false,
        getName: () => "旺崽助手",
        getVersion: () => "1.0.0",
        getPath: () => directory,
      },
      safeStorage,
      desktopRoot: path.join(directory, "isolated-app-root"),
      resourcesPath: "",
      fetchImpl: async (url, options) => {
        if (url.endsWith("/api/auth/sms/verify")) {
          return jsonResponse({
            access_token: "current-user-access",
            refresh_token: "singleflight-refresh-secret",
            user: { id: 31 },
          });
        }
        if (url.endsWith("/api/license/activate")) {
          assert.equal(options.headers.Authorization, "Bearer current-user-access");
          return jsonResponse({
            access_token: "rejected-device-license-access",
            valid: true,
            expire: new Date(Date.now() + 86_400_000).toISOString(),
            offline_until: null,
            offline_token: null,
            permissions: ["profit.view"],
          });
        }
        if (url.endsWith("/api/license/check")) {
          checkCalls += 1;
          checkAuthorization.push(options.headers.Authorization);
          if (checkCalls === 1) {
            await new Promise((resolve) => setTimeout(resolve, 25));
            return jsonResponse({
              access_token: "renewed-device-license-access",
              valid: true,
              expire: new Date(Date.now() + 86_400_000).toISOString(),
              offline_until: null,
              offline_token: null,
              permissions: ["profit.view"],
            });
          }
          if (checkCalls === 2) {
            return jsonResponse({ detail: "User token expired" }, 401);
          }
          if (checkCalls === 3) {
            return jsonResponse({
              access_token: "final-device-license-access",
              valid: true,
              expire: new Date(Date.now() + 86_400_000).toISOString(),
              offline_until: null,
              offline_token: null,
              permissions: ["profit.view"],
            });
          }
        }
        if (url.endsWith("/api/auth/refresh")) {
          refreshCalls += 1;
          return jsonResponse({
            access_token: "renewed-user-access",
            refresh_token: "rotated-refresh-secret",
          });
        }
        return jsonResponse({ detail: "unexpected request" }, 500);
      },
    });
    assert.equal((await runtime.request({
      method: "POST",
      path: "/api/auth/sms/verify",
      body: { phone: "13800138000", code: "123456" },
    })).ok, true);
    assert.equal((await runtime.request({
      method: "POST",
      path: "/api/license/activate",
      body: { card_key: "AAAA-BBBB-CCCC-DDDD" },
    })).ok, true);
    assert.equal(
      await runtime.getProtectedComputeAccessToken(),
      "rejected-device-license-access",
    );

    const refreshed = await Promise.all([
      runtime.getProtectedComputeAccessToken({
        forceRefresh: true,
        rejectedAccessToken: "rejected-device-license-access",
      }),
      runtime.getProtectedComputeAccessToken({
        forceRefresh: true,
        rejectedAccessToken: "rejected-device-license-access",
      }),
    ]);
    assert.deepEqual(refreshed, [
      "renewed-device-license-access",
      "renewed-device-license-access",
    ]);
    assert.equal(checkCalls, 1);
    assert.equal(refreshCalls, 0);

    assert.equal(await runtime.getProtectedComputeAccessToken({
      forceRefresh: true,
      rejectedAccessToken: "rejected-device-license-access",
    }), "renewed-device-license-access");
    assert.equal(checkCalls, 1);

    assert.equal(await runtime.getProtectedComputeAccessToken({
      forceRefresh: true,
      rejectedAccessToken: "renewed-device-license-access",
    }), "final-device-license-access");
    assert.equal(checkCalls, 3);
    assert.equal(refreshCalls, 1);
    assert.deepEqual(checkAuthorization, [
      "Bearer current-user-access",
      "Bearer current-user-access",
      "Bearer renewed-user-access",
    ]);
    assert.doesNotMatch(
      JSON.stringify(await runtime.getSession()),
      /(?:current|renewed|final)-(?:user|device)-access|refresh-secret/u,
    );
  } finally {
    if (previousUrl === undefined) delete process.env.LICENSE_CENTER_URL;
    else process.env.LICENSE_CENTER_URL = previousUrl;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("keeps online-only grants volatile and preserves the fresh lease during a transient network failure", async () => {
  const directory = await fs.mkdtemp(path.join(process.cwd(), ".license-runtime-test-"));
  const previousUrl = process.env.LICENSE_CENTER_URL;
  process.env.LICENSE_CENTER_URL = "http://127.0.0.1:8000";
  const responses = [];
  const requests = [];
  const snapshots = [];
  const app = {
    isPackaged: false,
    getName: () => "旺崽助手",
    getVersion: () => "1.0.0",
    getPath: () => directory,
  };
  try {
    const runtime = createLicenseRuntime({
      app,
      safeStorage,
      desktopRoot: path.join(directory, "isolated-app-root"),
      resourcesPath: "",
      onSessionSnapshot: (snapshot) => snapshots.push(snapshot),
      onlineOnlyFreshnessMs: 50,
      fetchImpl: async (url, options) => {
        requests.push({ url, options });
        const next = responses.shift();
        if (next instanceof Error) throw next;
        return next;
      },
    });
    const runtimeConfig = await runtime.getRuntime();
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
    responses.push(
      jsonResponse({
        access_token: "online-only-user-token",
        refresh_token: "r".repeat(64),
        user: { id: 20 },
      }),
      jsonResponse({
        valid: true,
        access_token: "offline-enabled-license-token",
        offline_token: signedOfflineToken(privateKey, runtimeConfig.deviceCode),
        permissions: ["orders.view"],
        expire: new Date(Date.now() + 86_400_000).toISOString(),
      }),
      jsonResponse({
        key_id: "test-key",
        public_key_pem: publicKey.export({ type: "spki", format: "pem" }),
      }),
      jsonResponse({
        valid: true,
        access_token: "online-only-license-token",
        offline_until: null,
        offline_token: null,
        permissions: ["orders.view"],
        expire: new Date(Date.now() + 86_400_000).toISOString(),
      }),
      jsonResponse({
        valid: true,
        access_token: "renewed-online-only-license-token",
        offline_until: null,
        offline_token: null,
        permissions: ["orders.view"],
        expire: new Date(Date.now() + 86_400_000).toISOString(),
      }),
      new Error("network unavailable"),
    );

    await runtime.request({
      method: "POST",
      path: "/api/auth/sms/verify",
      body: { phone: "13800138000", code: "123456" },
    });
    assert.equal(
      (await runtime.request({ method: "POST", path: "/api/license/activate", body: {} })).ok,
      true,
    );
    assert.equal((await runtime.getSession()).authorized, true);

    const onlineOnly = await runtime.request({
      method: "POST",
      path: "/api/license/check",
      body: {},
    });
    assert.equal(onlineOnly.ok, true);
    assert.equal("offline_token" in onlineOnly.data, false);
    assert.equal((await runtime.getSession()).authorized, true);

    const restartedRuntime = createLicenseRuntime({
      app,
      safeStorage,
      desktopRoot: path.join(directory, "isolated-app-root"),
      resourcesPath: "",
      fetchImpl: async () => {
        throw new Error("restart must not make an online request for getSession");
      },
    });
    const restartedSession = await restartedRuntime.getSession();
    assert.equal(restartedSession.authenticated, false);
    assert.equal(restartedSession.authorized, false);

    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal((await runtime.getSession()).authorized, false);
    assert.equal(snapshots.at(-1).authorized, false);

    const renewed = await runtime.request({
      method: "POST",
      path: "/api/license/check",
      body: {},
    });
    assert.equal(renewed.ok, true);
    assert.equal((await runtime.getSession()).authorized, true);

    const heartbeat = await runtime.request({
      method: "POST",
      path: "/api/license/heartbeat",
      body: {},
    });
    assert.equal(heartbeat.status, 0);
    assert.equal((await runtime.getSession()).authorized, true);
    assert.equal(snapshots.at(-1).authorized, true);
    assert.match(snapshots.at(-1).authorizationScope, /^[a-f0-9]{64}$/u);
    assert.equal(Object.hasOwn(snapshots.at(-1), 'user'), false);
    assert.equal(requests.filter(({ url }) => url.endsWith("/api/license/public-key")).length, 1);
  } finally {
    if (previousUrl === undefined) delete process.env.LICENSE_CENTER_URL;
    else process.env.LICENSE_CENTER_URL = previousUrl;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("keeps the fresh online-only lease when the license server is overloaded, but not after a rejection", async () => {
  const directory = await fs.mkdtemp(path.join(process.cwd(), ".license-runtime-test-"));
  const previousUrl = process.env.LICENSE_CENTER_URL;
  process.env.LICENSE_CENTER_URL = "http://127.0.0.1:8000";
  const responses = [];
  const app = {
    isPackaged: false,
    getName: () => "旺崽助手",
    getVersion: () => "1.0.0",
    getPath: () => directory,
  };
  const onlineOnlyGrant = () => jsonResponse({
    valid: true,
    access_token: "online-only-license-token",
    offline_until: null,
    offline_token: null,
    permissions: ["orders.view"],
    expire: new Date(Date.now() + 86_400_000).toISOString(),
  });
  try {
    const runtime = createLicenseRuntime({
      app,
      safeStorage,
      desktopRoot: path.join(directory, "isolated-app-root"),
      resourcesPath: "",
      fetchImpl: async () => responses.shift(),
    });
    responses.push(
      jsonResponse({ access_token: "online-only-user-token", refresh_token: "r".repeat(64), user: { id: 21 } }),
      onlineOnlyGrant(),
    );
    await runtime.request({
      method: "POST",
      path: "/api/auth/sms/verify",
      body: { phone: "13800138000", code: "123456" },
    });
    assert.equal((await runtime.request({ method: "POST", path: "/api/license/activate", body: {} })).ok, true);
    assert.equal((await runtime.getSession()).authorized, true);

    for (const status of [429, 502, 503, 504]) {
      responses.push(jsonResponse({ detail: "busy" }, status));
      const heartbeat = await runtime.request({ method: "POST", path: "/api/license/heartbeat", body: {} });
      assert.equal(heartbeat.status, status);
      assert.equal((await runtime.getSession()).authorized, true, `HTTP ${status} must not drop the lease`);
    }

    responses.push(jsonResponse({ detail: "License has expired" }, 403));
    const rejected = await runtime.request({ method: "POST", path: "/api/license/heartbeat", body: {} });
    assert.equal(rejected.status, 403);
    assert.equal((await runtime.getSession()).authorized, false);
  } finally {
    if (previousUrl === undefined) delete process.env.LICENSE_CENTER_URL;
    else process.env.LICENSE_CENTER_URL = previousUrl;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("coalesces concurrent refresh-token rotation", async () => {
  const directory = await fs.mkdtemp(path.join(process.cwd(), ".license-runtime-test-"));
  const previousUrl = process.env.LICENSE_CENTER_URL;
  process.env.LICENSE_CENTER_URL = "http://127.0.0.1:8000";
  let refreshCount = 0;
  try {
    const runtime = createLicenseRuntime({
      app: {
        isPackaged: false,
        getName: () => "旺崽助手",
        getVersion: () => "1.0.0",
        getPath: () => directory,
      },
      safeStorage,
      desktopRoot: path.join(directory, "isolated-app-root"),
      resourcesPath: "",
      fetchImpl: async (url, options) => {
        const pathname = new URL(url).pathname;
        if (pathname === "/api/auth/sms/verify") {
          return jsonResponse({
            access_token: "test-old-user-token",
            refresh_token: "o".repeat(64),
            user: { id: 12 },
          });
        }
        if (pathname === "/api/auth/refresh") {
          refreshCount += 1;
          await new Promise((resolve) => setTimeout(resolve, 20));
          return jsonResponse({
            access_token: "test-new-user-token",
            refresh_token: "p".repeat(64),
          });
        }
        if (pathname.startsWith("/api/orders/")) {
          return options.headers.Authorization === "Bearer test-new-user-token"
            ? jsonResponse({ id: pathname.split("/").at(-1), status: "pending" })
            : jsonResponse({ detail: "Token expired" }, 401);
        }
        throw new Error(`Unexpected request: ${pathname}`);
      },
    });
    await runtime.request({
      method: "POST",
      path: "/api/auth/sms/verify",
      body: { phone: "13800138000", code: "123456" },
    });
    const results = await Promise.all([
      runtime.request({ path: "/api/orders/ORDER_A" }),
      runtime.request({ path: "/api/orders/ORDER_B" }),
    ]);
    assert.equal(refreshCount, 1);
    assert.equal(results.every((result) => result.ok), true);
  } finally {
    if (previousUrl === undefined) delete process.env.LICENSE_CENTER_URL;
    else process.env.LICENSE_CENTER_URL = previousUrl;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("keeps point package, wallet, ledger and spending scoped to the packaged project", async () => {
  const directory = await fs.mkdtemp(path.join(process.cwd(), ".license-runtime-test-"));
  const previousUrl = process.env.LICENSE_CENTER_URL;
  process.env.LICENSE_CENTER_URL = "http://127.0.0.1:8000";
  const requests = [];
  try {
    const runtime = createLicenseRuntime({
      app: {
        isPackaged: false,
        getName: () => "旺崽助手",
        getVersion: () => "1.0.0",
        getPath: () => directory,
      },
      safeStorage,
      desktopRoot: path.join(directory, "isolated-app-root"),
      resourcesPath: "",
      fetchImpl: async (url, options) => {
        requests.push({ url, options });
        return jsonResponse({ items: [], balance_points: 0 });
      },
    });

    await runtime.request({ path: "/api/points/packages?project_code=attacker" });
    await runtime.request({
      path: "/api/points/ledger?project_code=attacker&page=999999&page_size=9999",
      page: 3,
      pageSize: 40,
    });
    await runtime.request({
      method: "POST",
      path: "/api/points/spend",
      body: { project_code: "attacker", points: 50, idempotency_key: "spend-fixed" },
    });

    const packagesUrl = new URL(requests[0].url);
    assert.equal(packagesUrl.searchParams.get("project_code"), "wangzai_desktop");
    const ledgerUrl = new URL(requests[1].url);
    assert.equal(ledgerUrl.searchParams.get("project_code"), "wangzai_desktop");
    assert.equal(ledgerUrl.searchParams.get("page"), "3");
    assert.equal(ledgerUrl.searchParams.get("page_size"), "40");
    const spendBody = JSON.parse(requests[2].options.body);
    assert.equal(spendBody.project_code, "wangzai_desktop");
    assert.equal(spendBody.points, 50);
  } finally {
    if (previousUrl === undefined) delete process.env.LICENSE_CENTER_URL;
    else process.env.LICENSE_CENTER_URL = previousUrl;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("allows only the model preset read and write contract and pins it to the packaged project", async () => {
  const directory = await fs.mkdtemp(path.join(process.cwd(), ".license-runtime-test-"));
  const previousUrl = process.env.LICENSE_CENTER_URL;
  process.env.LICENSE_CENTER_URL = "http://127.0.0.1:8000";
  const requests = [];
  try {
    const runtime = createLicenseRuntime({
      app: {
        isPackaged: false,
        getName: () => "旺崽助手",
        getVersion: () => "1.0.0",
        getPath: () => directory,
      },
      safeStorage,
      desktopRoot: path.join(directory, "isolated-app-root"),
      resourcesPath: "",
      fetchImpl: async (url, options) => {
        requests.push({ url, options });
        return jsonResponse({ contract: "user-model-presets-v1", groups: [] });
      },
    });

    await runtime.request({
      method: "GET",
      path: "/api/model-presets?project_code=attacker&unexpected=1",
    });
    await runtime.request({
      method: "PUT",
      path: "/api/model-presets",
      body: {
        project_code: "attacker",
        groups: [
          {
            capability_kind: "text",
            enabled_models: ["gpt-5.6-sol"],
            default_model: "gpt-5.6-sol",
          },
        ],
      },
    });

    const readUrl = new URL(requests[0].url);
    assert.equal(readUrl.pathname, "/api/model-presets");
    assert.equal(readUrl.searchParams.get("project_code"), "wangzai_desktop");
    assert.equal(readUrl.searchParams.has("unexpected"), false);
    assert.equal(requests[0].options.method, "GET");
    assert.equal(requests[0].options.body, undefined);
    assert.equal(requests[0].options.headers["Content-Type"], undefined);

    const writeBody = JSON.parse(requests[1].options.body);
    assert.equal(requests[1].options.method, "PUT");
    assert.equal(writeBody.project_code, "wangzai_desktop");
    assert.equal(writeBody.groups[0].default_model, "gpt-5.6-sol");

    await assert.rejects(
      runtime.request({ method: "PUT", path: "/api/points/wallet", body: {} }),
      /不支持的 License Center 请求方法/,
    );
    await assert.rejects(
      runtime.request({ method: "DELETE", path: "/api/model-presets" }),
      /不支持的 License Center 请求方法/,
    );
  } finally {
    if (previousUrl === undefined) delete process.env.LICENSE_CENTER_URL;
    else process.env.LICENSE_CENTER_URL = previousUrl;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("allows the exact management cross-border contract and rejects neighboring Core V2 paths", async () => {
  const directory = await fs.mkdtemp(path.join(process.cwd(), ".license-runtime-test-"));
  const previousUrl = process.env.LICENSE_CENTER_URL;
  process.env.LICENSE_CENTER_URL = "http://127.0.0.1:8000";
  const requests = [];
  try {
    const runtime = createLicenseRuntime({
      app: {
        isPackaged: false,
        getName: () => "旺崽助手",
        getVersion: () => "1.0.0",
        getPath: () => directory,
      },
      safeStorage,
      desktopRoot: path.join(directory, "isolated-app-root"),
      resourcesPath: "",
      fetchImpl: async (url, options) => {
        requests.push({ url, options });
        const requestPath = new URL(url).pathname;
        if (requestPath === "/api/auth/login") {
          return jsonResponse({
            access_token: "management-user-token",
            refresh_token: "management-refresh-token",
            user: { id: 7, email: "cross-border@example.com" },
          });
        }
        if (requestPath === "/api/license/check") {
          return jsonResponse({
            valid: true,
            access_token: "management-license-token",
            permissions: ["logistics.read", "logistics.write"],
            expire: "2027-01-01T00:00:00Z",
          });
        }
        return jsonResponse({ ok: true });
      },
    });

    await runtime.request({
      method: "POST",
      path: "/api/auth/login",
      body: { email: "cross-border@example.com", password: "DesktopPass123!" },
    });
    const contracts = [
      ["GET", "/api/core-v2/cross-border/endpoints", undefined],
      ["POST", "/api/core-v2/cross-border/authorize", { account_ref: "account-1" }],
      ["POST", "/api/core-v2/cross-border/read", { authorization_ref: "opaque-grant" }],
      ["POST", "/api/core-v2/cross-border/write/preview", { authorization_ref: "opaque-grant" }],
      ["POST", "/api/core-v2/cross-border/write/confirm", { authorization_ref: "opaque-grant" }],
      ["POST", "/api/core-v2/cross-border/revoke", { authorization_ref: "opaque-grant" }],
    ];
    for (const [method, requestPath, body] of contracts) {
      const result = await runtime.request({ method, path: requestPath, body });
      assert.equal(result.ok, true);
    }

    assert.equal(new URL(requests[1].url).pathname, "/api/license/check");
    assert.equal(requests[1].options.headers.Authorization, "Bearer management-user-token");
    assert.deepEqual(
      requests.slice(2).map((request) => new URL(request.url).pathname),
      contracts.map(([, requestPath]) => requestPath),
    );
    requests.slice(2).forEach((request) => {
      assert.equal(request.options.headers.Authorization, "Bearer management-license-token");
    });
    await assert.rejects(
      runtime.request({ method: "POST", path: "/api/core-v2/cross-border/private", body: {} }),
      /允许列表/u,
    );
  } finally {
    if (previousUrl === undefined) delete process.env.LICENSE_CENTER_URL;
    else process.env.LICENSE_CENTER_URL = previousUrl;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("routes smart reply configuration through the device-bound license token", async () => {
  const directory = await fs.mkdtemp(path.join(process.cwd(), ".license-runtime-test-"));
  const previousUrl = process.env.LICENSE_CENTER_URL;
  process.env.LICENSE_CENTER_URL = "http://127.0.0.1:8000";
  const requests = [];
  const responses = [
    jsonResponse({
      access_token: "smart-user-token",
      refresh_token: "smart-refresh-token",
      user: { id: 81, email: "smart@example.com" },
    }),
    jsonResponse({
      valid: true,
      online_required: true,
      expire: new Date(Date.now() + 3600_000).toISOString(),
      permissions: ["orders.view"],
      shop_limit: 1,
      device_limit: 1,
      access_token: "smart-license-token",
      server_time: new Date().toISOString(),
    }),
    jsonResponse({
      ok: true,
      mode: "server",
      worker_running: true,
      callback_configured: true,
      configured_shop_count: 1,
      enabled_rule_count: 1,
      pending_task_count: 0,
    }),
  ];
  try {
    const runtime = createLicenseRuntime({
      app: {
        isPackaged: false,
        getName: () => "旺崽助手",
        getVersion: () => "1.0.0",
        getPath: () => directory,
      },
      safeStorage,
      desktopRoot: path.join(directory, "isolated-app-root"),
      resourcesPath: "",
      fetchImpl: async (url, options) => {
        requests.push({ url, options });
        return responses.shift();
      },
    });
    await runtime.request({
      method: "POST",
      path: "/api/auth/login",
      body: { email: "smart@example.com", password: "DesktopPass123!" },
    });
    await runtime.request({ method: "POST", path: "/api/license/check", body: {} });
    const status = await runtime.request({ method: "GET", path: "/api/smart-reply/status" });
    assert.equal(status.ok, true);
    assert.equal(requests[2].options.headers.Authorization, "Bearer smart-license-token");
    assert.equal(new URL(requests[2].url).pathname, "/api/smart-reply/status");
  } finally {
    if (previousUrl === undefined) delete process.env.LICENSE_CENTER_URL;
    else process.env.LICENSE_CENTER_URL = previousUrl;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("requires an exact shop-card ledger even when the account license is legacy", async () => {
  const directory = await fs.mkdtemp(path.join(process.cwd(), ".license-runtime-test-"));
  const previousUrl = process.env.LICENSE_CENTER_URL;
  process.env.LICENSE_CENTER_URL = "http://127.0.0.1:8000";
  try {
    const runtime = createLicenseRuntime({
      app: {
        isPackaged: false,
        getName: () => "旺崽助手",
        getVersion: () => "1.0.0",
        getPath: () => directory,
      },
      safeStorage,
      desktopRoot: path.join(directory, "isolated-app-root"),
      resourcesPath: "",
      fetchImpl: async (url) => {
        const pathname = new URL(url).pathname;
        if (pathname === "/api/auth/login") {
          return jsonResponse({
            access_token: "legacy-user-token",
            refresh_token: "legacy-refresh-token",
            user: { id: 93, email: "legacy@example.com" },
          });
        }
        if (pathname === "/api/license/check") {
          return jsonResponse({
            valid: true,
            online_required: true,
            license_role: "legacy",
            expire: "2027-08-01T11:52:51.838443Z",
            permissions: ["orders.view"],
            shop_limit: 5,
            device_limit: 1,
            access_token: "legacy-license-token",
            server_time: new Date().toISOString(),
          });
        }
        if (pathname === "/api/license/activate") {
          return jsonResponse({
            valid: true,
            online_required: true,
            license_role: "shop_standard_annual",
            expire: "2027-08-24T10:12:22.224280Z",
            permissions: ["orders.view"],
            shop_limit: 1,
            device_limit: 1,
            access_token: "add-on-shop-license-token",
            license_key: "add-on-shop-license-key",
            server_time: new Date().toISOString(),
          });
        }
        if (pathname === "/api/license/entitlements") {
          return jsonResponse([{
            license_id: 77,
            status: "active",
            expire_time: "2027-08-24T10:12:22.224280Z",
            shops: [{ shop_id: "4097603", status: "active" }],
          }]);
        }
        throw new Error(`Unexpected request: ${pathname}`);
      },
    });

    await runtime.request({
      method: "POST",
      path: "/api/auth/login",
      body: { email: "legacy@example.com", password: "DesktopPass123!" },
    });
    await runtime.request({ method: "POST", path: "/api/license/check", body: {} });
    await runtime.request({
      method: "POST",
      path: "/api/license/activate",
      body: { card_key: "AAAA-BBBB-CCCC-DDDD" },
    });

    const sessionAfterAddOnActivation = await runtime.getSession();
    assert.equal(sessionAfterAddOnActivation.entitlement.license_role, "legacy");
    assert.equal(sessionAfterAddOnActivation.entitlement.shop_limit, 5);

    await assert.rejects(
      runtime.assertOzonShopEntitled("4067587"),
      /当前 Ozon 店铺未绑定有效卡密或授权已到期/,
    );
    assert.deepEqual(await runtime.assertOzonShopEntitled("4097603"), {
      authorized: true,
      shopId: "4097603",
      expireAt: "2027-08-24T10:12:22.224Z",
    });
    assert.deepEqual(await runtime.getOzonShopEntitlementGrants(), [{
      clientId: "4097603",
      expireAt: "2027-08-24T10:12:22.224Z",
    }]);
  } finally {
    if (previousUrl === undefined) delete process.env.LICENSE_CENTER_URL;
    else process.env.LICENSE_CENTER_URL = previousUrl;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("does not use an intro account license as a legacy multi-shop fallback", async () => {
  const directory = await fs.mkdtemp(path.join(process.cwd(), ".license-runtime-test-"));
  const previousUrl = process.env.LICENSE_CENTER_URL;
  process.env.LICENSE_CENTER_URL = "http://127.0.0.1:8000";
  try {
    const runtime = createLicenseRuntime({
      app: {
        isPackaged: false,
        getName: () => "旺崽助手",
        getVersion: () => "1.0.0",
        getPath: () => directory,
      },
      safeStorage,
      desktopRoot: path.join(directory, "isolated-app-root"),
      resourcesPath: "",
      fetchImpl: async (url) => {
        const pathname = new URL(url).pathname;
        if (pathname === "/api/auth/login") {
          return jsonResponse({
            access_token: "ledger-user-token",
            refresh_token: "ledger-refresh-token",
            user: { id: 94, email: "ledger@example.com" },
          });
        }
        if (pathname === "/api/license/check") {
          return jsonResponse({
            valid: true,
            online_required: true,
            license_role: "shop_intro",
            expire: "2027-08-01T11:52:51.838443Z",
            permissions: ["orders.view"],
            shop_limit: 5,
            device_limit: 1,
            access_token: "ledger-license-token",
            server_time: new Date().toISOString(),
          });
        }
        if (pathname === "/api/license/entitlements") {
          return jsonResponse([{
            license_id: 77,
            status: "active",
            expire_time: "2027-08-01T11:52:51.838443Z",
            shops: [{ shop_id: "4616153", status: "active" }],
          }]);
        }
        throw new Error(`Unexpected request: ${pathname}`);
      },
    });

    await runtime.request({
      method: "POST",
      path: "/api/auth/login",
      body: { email: "ledger@example.com", password: "DesktopPass123!" },
    });
    await runtime.request({ method: "POST", path: "/api/license/check", body: {} });

    await assert.rejects(
      runtime.assertOzonShopEntitled("4067587"),
      /当前 Ozon 店铺未绑定有效卡密或授权已到期/,
    );
  } finally {
    if (previousUrl === undefined) delete process.env.LICENSE_CENTER_URL;
    else process.env.LICENSE_CENTER_URL = previousUrl;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

