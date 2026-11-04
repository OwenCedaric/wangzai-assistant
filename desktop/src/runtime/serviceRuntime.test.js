import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createServiceRuntime,
  ensureLocalApiSecretFile,
  resolveServiceStartTimeoutMs,
} from "./serviceRuntime.js";

test("packaged service startup allows slow first-run migrations without weakening development feedback", () => {
  assert.equal(resolveServiceStartTimeoutMs(false), 30_000);
  assert.equal(resolveServiceStartTimeoutMs(true), 90_000);
});

test("fresh profile creates one canonical local-api secret and never replaces it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wangzai-local-api-secret-"));
  const secretPath = path.join(root, "local-api-data", "local-api-secret.key");
  try {
    assert.equal(ensureLocalApiSecretFile(secretPath), path.resolve(secretPath));
    const first = fs.readFileSync(secretPath, "utf8");
    assert.match(first.trim(), /^[A-Za-z0-9_-]{43}$/u);
    assert.equal(ensureLocalApiSecretFile(secretPath), path.resolve(secretPath));
    assert.equal(fs.readFileSync(secretPath, "utf8"), first);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("invalid existing local-api secret fails closed without replacement", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wangzai-local-api-secret-invalid-"));
  const secretPath = path.join(root, "local-api-data", "local-api-secret.key");
  try {
    fs.mkdirSync(path.dirname(secretPath), { recursive: true });
    fs.writeFileSync(secretPath, "invalid-existing-key\n", "utf8");
    assert.throws(() => ensureLocalApiSecretFile(secretPath), /密钥文件无效/u);
    assert.equal(fs.readFileSync(secretPath, "utf8"), "invalid-existing-key\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function createPaths(
  root,
  { profile: profileOverride, startup: startupOverride } = {},
) {
  const dataRoot = path.join(root, "profile");
  const profile = profileOverride || {
    appId: "com.wangzai.assistant.desktop",
    profileId: "profile-runtime-test",
    dataRootFingerprint: "runtime-fingerprint",
  };
  return {
    ensureDirectory(directory) {
      fs.mkdirSync(directory, { recursive: true });
      return directory;
    },
    desktopDataRoot: () => dataRoot,
    ensureProfile: () => profile,
    resolveCurrentProfileDatabaseStartup: () =>
      startupOverride || {
        mode: "fresh",
        profile,
        activeDatabasePath: path.join(
          dataRoot,
          "local-api-data",
          "wangzai.sqlite",
        ),
        runtimeDatabasePath: path.join(
          dataRoot,
          "local-api-data",
          "wangzai.sqlite",
        ),
      },
    assertCurrentProfileDatabaseAvailable: () => ({
      databasePath: path.join(dataRoot, "local-api-data", "wangzai.sqlite"),
      fresh: true,
    }),
    markCurrentProfileDatabaseInitialized: () => ({
      ...profile,
      databaseInitializedAt: "2026-07-12T01:02:03.000Z",
      databaseLifecycle: "initialized",
    }),
    getMigrationPreview: () => ({ mode: "fresh-profile" }),
    localApiRoot: () => path.join(root, "local-api"),
    localCacheAgentRoot: () => path.join(root, "local-cache-agent"),
    localApiDataDirectory: () => path.join(dataRoot, "local-api-data"),
    localApiDatabasePath: () =>
      path.join(dataRoot, "local-api-data", "wangzai.sqlite"),
    localApiSecretPath: () =>
      path.join(dataRoot, "local-api-data", "secret.key"),
    protectedComputeVersionStatePath: () =>
      path.join(
        dataRoot,
        "local-api-data",
        "protected-compute-version-state.enc",
      ),
    categoryTreePath: () => path.join(root, "category-tree.json"),
    purchaseBridgeScriptPath: () =>
      path.join(root, "purchase-search-bridge.mjs"),
    purchaseBridgeWorkingDirectory: () => root,
  };
}

test("V2 starts only the encrypted customer-local cache agent instead of local-api", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wangzai-service-v2-"));
  const originalFetch = globalThis.fetch;
  const spawned = [];
  try {
    globalThis.fetch = async (url) => {
      assert.match(String(url), /^http:\/\/127\.0\.0\.1:\d+\/health$/u);
      return {
        ok: true,
        json: async () => ({ ok: true, service: "wangzai-local-cache-agent" }),
      };
    };
    const runtime = createServiceRuntime({
      paths: createPaths(root),
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (value) =>
          Buffer.from(value, "utf8").map((byte) => byte ^ 0x22),
        decryptString: (value) =>
          Buffer.from(value)
            .map((byte) => byte ^ 0x22)
            .toString("utf8"),
      },
      thinClientCore: {
        enabled: true,
        architecture: "v2",
        coreServiceUrl: "https://management.example.test",
      },
      supervisor: {
        appendLog() {},
        spawnElectronNodeScript(name, scriptPath, options) {
          spawned.push({ name, scriptPath, options });
          return { exitCode: null };
        },
        async stopChildProcesses() {},
      },
    });
    const started = await runtime.startLocalApi();
    assert.equal(started.localCacheAgent, true);
    assert.equal(started.remoteCore, undefined);
    assert.equal(started.coreServiceUrl, "https://management.example.test");
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].name, "local-cache-agent-v2");
    assert.equal(
      spawned.some((item) => item.name === "local-api"),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("service startup tears down owned children when a sibling service fails", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "wangzai-service-runtime-"),
  );
  const originalFetch = globalThis.fetch;
  const originalLocalApiPort = process.env.LOCAL_API_PORT;
  const originalBridgePort = process.env.PURCHASE_SEARCH_BRIDGE_PORT;
  let resolveLocalApiSpawned;
  const localApiSpawned = new Promise((resolve) => {
    resolveLocalApiSpawned = resolve;
  });
  const calls = { spawned: [], stopChildren: 0 };
  try {
    process.env.LOCAL_API_PORT = "48190";
    process.env.PURCHASE_SEARCH_BRIDGE_PORT = "48191";
    globalThis.fetch = async (url) => {
      if (String(url).endsWith("/health")) {
        await localApiSpawned;
        return {
          ok: true,
          json: async () => ({
            ok: true,
            service: "wangzai-local-api",
            runtime: {
              appId: "com.wangzai.assistant.desktop",
              profileId: "profile-runtime-test",
              dataRootFingerprint: "runtime-fingerprint",
              protocolVersion: "1",
            },
          }),
        };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    };
    const supervisor = {
      appendLog() {},
      spawnElectronNodeScript(name) {
        calls.spawned.push(name);
        if (name === "local-api") {
          resolveLocalApiSpawned();
          return { exitCode: null };
        }
        throw new Error("purchase bridge start failed");
      },
      async stopChildProcesses() {
        calls.stopChildren += 1;
      },
    };
    const runtime = createServiceRuntime({
      paths: createPaths(root),
      supervisor,
    });

    await assert.rejects(runtime.startAll(), /purchase bridge start failed/u);
    assert.deepEqual(calls.spawned, ["local-api", "purchase-search-bridge"]);
    assert.equal(calls.stopChildren, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalLocalApiPort === undefined) delete process.env.LOCAL_API_PORT;
    else process.env.LOCAL_API_PORT = originalLocalApiPort;
    if (originalBridgePort === undefined)
      delete process.env.PURCHASE_SEARCH_BRIDGE_PORT;
    else process.env.PURCHASE_SEARCH_BRIDGE_PORT = originalBridgePort;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('development bridge reuse preserves a callable license observer without claiming ownership', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wangzai-service-reused-bridge-'));
  const originalFetch = globalThis.fetch;
  const originalMode = process.env.WANGZAI_LICENSE_MODE;
  let spawns = 0;
  try {
    process.env.WANGZAI_LICENSE_MODE = 'observe';
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ ok: true, service: 'purchase-search-bridge', authorizationRequired: false }),
    });
    const runtime = createServiceRuntime({
      paths: createPaths(root),
      supervisor: {
        appendLog() {},
        spawnElectronNodeScript() { spawns += 1; throw new Error('reuse must not spawn'); },
        async stopChildProcesses() {},
      },
    });
    const bridge = await runtime.startPurchaseBridge();
    assert.equal(bridge.reused, true);
    assert.equal(spawns, 0);
    assert.equal(typeof bridge.updateLicenseState, 'function');
    assert.deepEqual(bridge.updateLicenseState({ mode: 'observe', authorized: false }), {
      updated: false,
      reason: 'development-bridge-not-owned',
    });
    assert.equal(Object.hasOwn(bridge, 'authToken'), false);
    assert.equal(Object.hasOwn(bridge, 'statePath'), false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalMode === undefined) delete process.env.WANGZAI_LICENSE_MODE;
    else process.env.WANGZAI_LICENSE_MODE = originalMode;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('enforced and packaged modes never reuse an unauthenticated development bridge', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wangzai-service-enforced-bridge-'));
  const blocker = net.createServer();
  const originalFetch = globalThis.fetch;
  const originalMode = process.env.WANGZAI_LICENSE_MODE;
  const originalPort = process.env.PURCHASE_SEARCH_BRIDGE_PORT;
  let healthReads = 0;
  try {
    await new Promise(resolve => blocker.listen({ host: '127.0.0.1', port: 0 }, resolve));
    process.env.PURCHASE_SEARCH_BRIDGE_PORT = String(blocker.address().port);
    globalThis.fetch = async () => {
      healthReads += 1;
      return { ok: true, json: async () => ({ ok: true, service: 'purchase-search-bridge' }) };
    };
    for (const isPackaged of [false, true]) {
      process.env.WANGZAI_LICENSE_MODE = isPackaged ? 'observe' : 'enforce';
      const runtime = createServiceRuntime({
        isPackaged,
        paths: createPaths(root),
        supervisor: {
          appendLog() {},
          spawnElectronNodeScript() { throw new Error('an occupied enforced port must fail closed'); },
          async stopChildProcesses() {},
        },
      });
      await assert.rejects(runtime.startPurchaseBridge(), /正式授权模式需要独占拍单插件端口/);
    }
    assert.equal(healthReads, 0, 'a public health response cannot waive bridge ownership');
  } finally {
    await new Promise(resolve => blocker.close(resolve));
    globalThis.fetch = originalFetch;
    if (originalMode === undefined) delete process.env.WANGZAI_LICENSE_MODE;
    else process.env.WANGZAI_LICENSE_MODE = originalMode;
    if (originalPort === undefined) delete process.env.PURCHASE_SEARCH_BRIDGE_PORT;
    else process.env.PURCHASE_SEARCH_BRIDGE_PORT = originalPort;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("local-api child crash fails on the selected port without retrying another port", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "wangzai-service-runtime-"),
  );
  const originalFetch = globalThis.fetch;
  const originalLocalApiPort = process.env.LOCAL_API_PORT;
  const calls = { spawned: [] };
  try {
    process.env.LOCAL_API_PORT = "48210";
    globalThis.fetch = async () => ({ ok: false, json: async () => null });
    const runtime = createServiceRuntime({
      paths: createPaths(root),
      supervisor: {
        appendLog() {},
        spawnElectronNodeScript(name, _scriptPath, options) {
          calls.spawned.push({ name, port: options.env.LOCAL_API_PORT });
          return { exitCode: 23 };
        },
        async stopChildProcesses() {},
      },
    });

    await assert.rejects(
      runtime.startLocalApi(),
      /local-api 启动失败，退出码：23/u,
    );
    assert.equal(calls.spawned.length, 1);
    assert.equal(calls.spawned[0].name, "local-api");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalLocalApiPort === undefined) delete process.env.LOCAL_API_PORT;
    else process.env.LOCAL_API_PORT = originalLocalApiPort;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("local-api receives only sealed protected-compute paths and pinned key metadata", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "wangzai-service-runtime-protected-"),
  );
  const originalFetch = globalThis.fetch;
  const originalLocalApiPort = process.env.LOCAL_API_PORT;
  const previousAmbient = {
    config: process.env.LOCAL_API_PROTECTED_COMPUTE_SIGNED_CONFIG_PATH,
    key: process.env.LOCAL_API_PROTECTED_COMPUTE_CONFIG_KEY_PATH,
    keyId: process.env.LOCAL_API_PROTECTED_COMPUTE_CONFIG_KEY_ID,
    fingerprint: process.env.LOCAL_API_PROTECTED_COMPUTE_CONFIG_KEY_SHA256,
    masterSecret: process.env.LOCAL_API_SECRET,
    shopLicenseEnforce: process.env.LOCAL_API_SHOP_LICENSE_ENFORCE,
  };
  const calls = [];
  try {
    process.env.LOCAL_API_PORT = "48215";
    process.env.LOCAL_API_PROTECTED_COMPUTE_SIGNED_CONFIG_PATH =
      "C:/attacker/config.json";
    process.env.LOCAL_API_PROTECTED_COMPUTE_CONFIG_KEY_PATH =
      "C:/attacker/key.pem";
    process.env.LOCAL_API_PROTECTED_COMPUTE_CONFIG_KEY_ID = "attacker-key";
    process.env.LOCAL_API_PROTECTED_COMPUTE_CONFIG_KEY_SHA256 = "0".repeat(64);
    process.env.LOCAL_API_SECRET = "attacker-master-secret";
    process.env.LOCAL_API_SHOP_LICENSE_ENFORCE = "0";
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        service: "wangzai-local-api",
        runtime: {
          appId: "com.wangzai.assistant.desktop",
          profileId: "profile-runtime-test",
          dataRootFingerprint: "runtime-fingerprint",
          protocolVersion: "1",
        },
      }),
    });
    const paths = createPaths(root);
    const protectedComputeConfig = {
      serverBaseUrl: "https://management.example.test",
      signedPublicConfigPath: path.join(root, "sealed", "config.json"),
      configurationPublicKeyPath: path.join(
        root,
        "sealed",
        "configuration-public.pem",
      ),
      configurationKeyId: "sealed-config-v1",
      configurationKeySha256: "a".repeat(64),
    };
    const runtime = createServiceRuntime({
      paths,
      isPackaged: true,
      protectedComputeConfig,
      supervisor: {
        appendLog() {},
        spawnElectronNodeScript(name, _scriptPath, options) {
          calls.push({ name, env: options.env });
          return { exitCode: null };
        },
        async stopChildProcesses() {},
      },
    });

    const started = await runtime.startLocalApi();
    assert.equal(started.coreServiceUrl, "https://management.example.test");
    const environment = calls[0].env;
    assert.equal(
      environment.LOCAL_API_PROTECTED_COMPUTE_SIGNED_CONFIG_PATH,
      protectedComputeConfig.signedPublicConfigPath,
    );
    assert.equal(
      environment.LOCAL_API_PROTECTED_COMPUTE_CONFIG_KEY_PATH,
      protectedComputeConfig.configurationPublicKeyPath,
    );
    assert.equal(
      environment.LOCAL_API_PROTECTED_COMPUTE_CONFIG_KEY_ID,
      "sealed-config-v1",
    );
    assert.equal(
      environment.LOCAL_API_PROTECTED_COMPUTE_CONFIG_KEY_SHA256,
      "a".repeat(64),
    );
    assert.equal(
      environment.LOCAL_API_PROTECTED_COMPUTE_VERSION_STATE_PATH,
      paths.protectedComputeVersionStatePath(),
    );
    assert.equal(environment.LOCAL_API_SECRET, "");
    assert.equal(environment.LOCAL_API_SHOP_LICENSE_ENFORCE, "1");
    assert.equal(environment.LOCAL_API_DEFER_CONTINUOUS_SYNC, "1");
    assert.equal(environment.LOCAL_API_CONTINUOUS_SYNC_START_DELAY_MS, "30000");
    assert.doesNotMatch(JSON.stringify(environment), /C:\/attacker/u);
    await runtime.stopAll();
  } finally {
    globalThis.fetch = originalFetch;
    if (originalLocalApiPort === undefined) delete process.env.LOCAL_API_PORT;
    else process.env.LOCAL_API_PORT = originalLocalApiPort;
    for (const [key, value] of Object.entries({
      LOCAL_API_PROTECTED_COMPUTE_SIGNED_CONFIG_PATH: previousAmbient.config,
      LOCAL_API_PROTECTED_COMPUTE_CONFIG_KEY_PATH: previousAmbient.key,
      LOCAL_API_PROTECTED_COMPUTE_CONFIG_KEY_ID: previousAmbient.keyId,
      LOCAL_API_PROTECTED_COMPUTE_CONFIG_KEY_SHA256:
        previousAmbient.fingerprint,
      LOCAL_API_SECRET: previousAmbient.masterSecret,
      LOCAL_API_SHOP_LICENSE_ENFORCE: previousAmbient.shopLicenseEnforce,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("recovery-required profile starts only the isolated recovery shell and disables continuous sync", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "wangzai-service-runtime-"),
  );
  const originalFetch = globalThis.fetch;
  const originalLocalApiPort = process.env.LOCAL_API_PORT;
  const calls = { spawned: [], markedInitialized: 0 };
  try {
    process.env.LOCAL_API_PORT = "48220";
    const profile = {
      appId: "com.wangzai.assistant.desktop",
      profileId: "profile-runtime-test",
      dataRootFingerprint: "runtime-fingerprint",
      databaseLifecycle: "recovery-required",
      databaseRecoveryRequiredAt: "2026-07-12T02:03:04.000Z",
    };
    const activeDatabasePath = path.join(
      root,
      "profile",
      "local-api-data",
      "wangzai.sqlite",
    );
    const recoveryShellPath = path.join(
      root,
      "profile",
      "local-api-data",
      "recovery-shell.sqlite",
    );
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        service: "wangzai-local-api",
        runtime: {
          appId: profile.appId,
          profileId: profile.profileId,
          dataRootFingerprint: profile.dataRootFingerprint,
          protocolVersion: "1",
        },
      }),
    });
    const paths = createPaths(root, {
      profile,
      startup: {
        mode: "recovery",
        profile,
        activeDatabasePath,
        runtimeDatabasePath: recoveryShellPath,
      },
    });
    paths.markCurrentProfileDatabaseInitialized = () => {
      calls.markedInitialized += 1;
      throw new Error("recovery shell must not mark the profile initialized");
    };
    const runtime = createServiceRuntime({
      paths,
      supervisor: {
        appendLog() {},
        spawnElectronNodeScript(name, _scriptPath, options) {
          calls.spawned.push({ name, env: options.env });
          return { exitCode: null };
        },
        async stopChildProcesses() {},
      },
    });

    const localApi = await runtime.startLocalApi();
    assert.equal(calls.spawned.length, 1);
    assert.equal(calls.spawned[0].env.LOCAL_API_DB_PATH, recoveryShellPath);
    assert.equal(calls.spawned[0].env.LOCAL_API_CONTINUOUS_SYNC, "0");
    assert.equal(
      "LOCAL_API_RESUME_AFTER_SUSPEND" in calls.spawned[0].env,
      false,
    );
    assert.equal(localApi.recoveryMode, true);
    assert.equal(localApi.activeDatabasePath, activeDatabasePath);
    assert.equal(calls.markedInitialized, 0);
    await runtime.stopAll();
  } finally {
    globalThis.fetch = originalFetch;
    if (originalLocalApiPort === undefined) delete process.env.LOCAL_API_PORT;
    else process.env.LOCAL_API_PORT = originalLocalApiPort;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("isolated visual runtime can disable continuous sync for a normal profile", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "wangzai-service-runtime-"),
  );
  const originalFetch = globalThis.fetch;
  const originalLocalApiPort = process.env.LOCAL_API_PORT;
  const calls = { spawned: [] };
  try {
    process.env.LOCAL_API_PORT = "48225";
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        service: "wangzai-local-api",
        runtime: {
          appId: "com.wangzai.assistant.desktop",
          profileId: "profile-runtime-test",
          dataRootFingerprint: "runtime-fingerprint",
          protocolVersion: "1",
        },
      }),
    });
    const runtime = createServiceRuntime({
      paths: createPaths(root),
      continuousSyncEnabled: false,
      supervisor: {
        appendLog() {},
        spawnElectronNodeScript(name, _scriptPath, options) {
          calls.spawned.push({ name, env: options.env });
          return { exitCode: null };
        },
        async stopChildProcesses() {},
      },
    });

    const localApi = await runtime.startLocalApi();
    assert.equal(calls.spawned.length, 1);
    assert.equal(calls.spawned[0].name, "local-api");
    assert.equal(calls.spawned[0].env.LOCAL_API_CONTINUOUS_SYNC, "0");
    assert.equal(
      "LOCAL_API_RESUME_AFTER_SUSPEND" in calls.spawned[0].env,
      false,
    );
    assert.equal(localApi.recoveryMode, false);
    await runtime.stopAll();
  } finally {
    globalThis.fetch = originalFetch;
    if (originalLocalApiPort === undefined) delete process.env.LOCAL_API_PORT;
    else process.env.LOCAL_API_PORT = originalLocalApiPort;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("local-api rejects a health response from a different profile before accepting the child", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "wangzai-service-runtime-"),
  );
  const originalFetch = globalThis.fetch;
  const originalLocalApiPort = process.env.LOCAL_API_PORT;
  const calls = { spawned: [] };
  try {
    process.env.LOCAL_API_PORT = "48230";
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        service: "wangzai-local-api",
        runtime: {
          appId: "com.wangzai.assistant.desktop",
          profileId: "foreign-profile",
          dataRootFingerprint: "runtime-fingerprint",
          protocolVersion: "1",
        },
      }),
    });
    const runtime = createServiceRuntime({
      paths: createPaths(root),
      supervisor: {
        appendLog() {},
        spawnElectronNodeScript(name, _scriptPath, options) {
          calls.spawned.push({ name, env: options.env });
          return { exitCode: 24 };
        },
        async stopChildProcesses() {},
      },
    });

    await assert.rejects(
      runtime.startLocalApi(),
      /local-api 启动失败，退出码：24/u,
    );
    assert.equal(calls.spawned.length, 1);
    assert.equal(
      calls.spawned[0].env.LOCAL_API_PROFILE_ID,
      "profile-runtime-test",
    );
    assert.equal(
      calls.spawned[0].env.LOCAL_API_DATA_ROOT_FINGERPRINT,
      "runtime-fingerprint",
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalLocalApiPort === undefined) delete process.env.LOCAL_API_PORT;
    else process.env.LOCAL_API_PORT = originalLocalApiPort;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("local-api never reuses a listener on the preferred port", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "wangzai-service-runtime-"),
  );
  const blocker = net.createServer();
  const originalFetch = globalThis.fetch;
  const originalLocalApiPort = process.env.LOCAL_API_PORT;
  const calls = { spawned: [], stopped: 0 };
  try {
    await new Promise((resolve) =>
      blocker.listen({ host: "127.0.0.1", port: 0 }, resolve),
    );
    const blockedPort = blocker.address().port;
    process.env.LOCAL_API_PORT = String(blockedPort);
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        service: "wangzai-local-api",
        runtime: {
          appId: "com.wangzai.assistant.desktop",
          profileId: "profile-runtime-test",
          dataRootFingerprint: "runtime-fingerprint",
          protocolVersion: "1",
        },
      }),
    });
    const runtime = createServiceRuntime({
      paths: createPaths(root),
      supervisor: {
        appendLog() {},
        spawnElectronNodeScript(name, _scriptPath, options) {
          calls.spawned.push({
            name,
            port: Number(options.env.LOCAL_API_PORT),
          });
          return { exitCode: null };
        },
        async stopChildProcesses() {
          calls.stopped += 1;
        },
      },
    });

    const localApi = await runtime.startLocalApi();
    assert.equal(calls.spawned.length, 1);
    assert.notEqual(calls.spawned[0].port, blockedPort);
    assert.equal(localApi.port, calls.spawned[0].port);
    await runtime.stopAll();
    assert.equal(calls.stopped, 1);
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
    globalThis.fetch = originalFetch;
    if (originalLocalApiPort === undefined) delete process.env.LOCAL_API_PORT;
    else process.env.LOCAL_API_PORT = originalLocalApiPort;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("purchase bridge rejects an unknown listener instead of reusing it", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "wangzai-service-runtime-"),
  );
  const blocker = net.createServer();
  const originalFetch = globalThis.fetch;
  const originalBridgePort = process.env.PURCHASE_SEARCH_BRIDGE_PORT;
  const originalLicenseMode = process.env.WANGZAI_LICENSE_MODE;
  const calls = { spawned: [], stopped: 0, healthChecks: 0 };
  try {
    await new Promise((resolve) =>
      blocker.listen({ host: "127.0.0.1", port: 0 }, resolve),
    );
    const blockedPort = blocker.address().port;
    process.env.PURCHASE_SEARCH_BRIDGE_PORT = String(blockedPort);
    delete process.env.WANGZAI_LICENSE_MODE;
    globalThis.fetch = async () => {
      calls.healthChecks += 1;
      if (calls.healthChecks === 1) {
        return {
          ok: true,
          json: async () => ({ ok: true, service: "foreign-bridge" }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          ok: true,
          service: "purchase-search-bridge",
          authorizationRequired: true,
        }),
      };
    };
    const runtime = createServiceRuntime({
      paths: createPaths(root),
      supervisor: {
        appendLog() {},
        spawnElectronNodeScript(name, _scriptPath, options) {
          calls.spawned.push({
            name,
            port: Number(options.env.PURCHASE_SEARCH_BRIDGE_PORT),
            authToken: options.env.PURCHASE_BRIDGE_AUTH_TOKEN,
          });
          return { exitCode: null };
        },
        async stopChildProcesses() {
          calls.stopped += 1;
        },
      },
    });

    const bridge = await runtime.startPurchaseBridge();
    assert.equal(calls.spawned.length, 1);
    assert.equal(calls.spawned[0].name, "purchase-search-bridge");
    assert.notEqual(calls.spawned[0].port, blockedPort);
    assert.equal(bridge.reused, false);
    assert.ok(calls.spawned[0].authToken);
    await runtime.stopAll();
    assert.equal(calls.stopped, 1);
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
    globalThis.fetch = originalFetch;
    if (originalBridgePort === undefined)
      delete process.env.PURCHASE_SEARCH_BRIDGE_PORT;
    else process.env.PURCHASE_SEARCH_BRIDGE_PORT = originalBridgePort;
    if (originalLicenseMode === undefined)
      delete process.env.WANGZAI_LICENSE_MODE;
    else process.env.WANGZAI_LICENSE_MODE = originalLicenseMode;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
