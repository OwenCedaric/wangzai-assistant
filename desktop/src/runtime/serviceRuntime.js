import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createPurchaseBridgeStateStore } from "./purchaseBridgeState.js";
import { createLocalCacheAgentRuntime } from "./localCacheAgentRuntime.js";

const DEFAULT_LOCAL_API_PORT = 3790;
const DEFAULT_PURCHASE_BRIDGE_PORT = 3788;
const DEVELOPMENT_SERVICE_START_TIMEOUT_MS = 30_000;
const PACKAGED_SERVICE_START_TIMEOUT_MS = 90_000;
const SERVICE_POLL_INTERVAL_MS = 160;
const SERVICE_PROGRESS_LOG_INTERVAL_MS = 5_000;
const LOCAL_API_ALLOWED_ORIGINS =
  "app://wangzai,null,http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:5188,http://localhost:5188,http://127.0.0.1:5191,http://localhost:5191";
const LOCAL_API_TOKEN_HEADER = "x-wangzai-local-api-token";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizePort(value, fallback) {
  const port = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : fallback;
}

export function ensureLocalApiSecretFile(filePath) {
  const resolvedPath = path.resolve(String(filePath || ""));
  if (!String(filePath || "").trim()) {
    throw new Error("local-api profile 密钥路径不能为空");
  }
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  try {
    fs.writeFileSync(
      resolvedPath,
      `${crypto.randomBytes(32).toString("base64url")}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const stored = fs.readFileSync(resolvedPath, "utf8").trim();
  if (!/^[A-Za-z0-9_-]{43}$/u.test(stored)) {
    throw new Error("local-api profile 密钥文件无效，拒绝覆盖现有文件");
  }
  return resolvedPath;
}

async function probeJson(url, timeoutMs = 1200) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    return response.ok ? payload : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function isHealthyService(url, expectedService, expectedRuntime = null) {
  const payload = await probeJson(url);
  const serviceMatches = Boolean(
    payload?.ok && (!expectedService || payload.service === expectedService),
  );
  if (!serviceMatches) return false;
  return (
    !expectedRuntime ||
    Object.entries(expectedRuntime).every(
      ([key, value]) => payload?.runtime?.[key] === value,
    )
  );
}

function isLoopbackPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function findAvailableLoopbackPort(preferredPort, attempts = 40) {
  for (let offset = 0; offset < attempts; offset += 1) {
    const candidate = preferredPort + offset;
    if (candidate > 65_535) break;
    if (await isLoopbackPortAvailable(candidate)) return candidate;
  }
  throw new Error(
    `找不到可用的本机端口（从 ${preferredPort} 开始检查了 ${attempts} 个端口）`,
  );
}

async function waitForHealthyService({
  name,
  child,
  healthUrl,
  expectedService,
  expectedRuntime,
  timeoutMs,
  supervisor,
}) {
  const startedAt = Date.now();
  let nextProgressLogAt = SERVICE_PROGRESS_LOG_INTERVAL_MS;
  while (Date.now() - startedAt < timeoutMs) {
    if (await isHealthyService(healthUrl, expectedService, expectedRuntime))
      return;
    const childDiagnostic = supervisor?.getChildDiagnostic?.(name);
    const exited =
      child?.exitCode !== null ||
      child?.signalCode != null ||
      childDiagnostic?.status === "exited" ||
      childDiagnostic?.status === "failed";
    if (exited) {
      const exitCode = child?.exitCode ?? childDiagnostic?.exitCode ?? "未知";
      const signal = child?.signalCode || childDiagnostic?.signal || "";
      const suffix = signal ? `，信号：${signal}` : "";
      throw new Error(`${name} 启动失败，退出码：${exitCode}${suffix}`);
    }
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= nextProgressLogAt) {
      supervisor?.appendLog?.(
        "desktop-main",
        `[runtime] waiting for ${name} elapsedMs=${elapsedMs} health=${healthUrl}\n`,
      );
      nextProgressLogAt += SERVICE_PROGRESS_LOG_INTERVAL_MS;
    }
    await delay(SERVICE_POLL_INTERVAL_MS);
  }
  const diagnostic = supervisor?.getChildDiagnostic?.(name);
  supervisor?.appendLog?.(
    "desktop-main",
    `[runtime] ${name} readiness timeout diagnostic=${JSON.stringify(diagnostic || {})}\n`,
  );
  throw new Error(`${name} 在 ${timeoutMs / 1000} 秒内未就绪：${healthUrl}`);
}

export function resolveServiceStartTimeoutMs(isPackaged) {
  return isPackaged
    ? PACKAGED_SERVICE_START_TIMEOUT_MS
    : DEVELOPMENT_SERVICE_START_TIMEOUT_MS;
}

export function createServiceRuntime({
  paths,
  supervisor,
  isPackaged = false,
  continuousSyncEnabled = true,
  protectedComputeConfig = null,
  thinClientCore = null,
  safeStorage = null,
}) {
  let localApiRuntime = null;
  const serviceStartTimeoutMs = resolveServiceStartTimeoutMs(isPackaged);
  const purchaseBridgeState = createPurchaseBridgeStateStore({
    directory: paths.ensureDirectory(
      path.join(paths.desktopDataRoot(), "runtime"),
    ),
  });

  async function startLocalApi() {
    if (
      thinClientCore?.enabled === true &&
      thinClientCore?.architecture === "v2"
    ) {
      const profile = paths.ensureProfile();
      const agentRoot = paths.localCacheAgentRoot();
      const agent = createLocalCacheAgentRuntime({
        supervisor,
        safeStorage,
        dataRoot: paths.ensureDirectory(
          path.join(paths.desktopDataRoot(), "local-cache-agent-v2"),
        ),
        scriptPath: path.join(agentRoot, "src", "server.js"),
        preferredPort: normalizePort(
          process.env.WANGZAI_CACHE_AGENT_PORT,
          3792,
        ),
        startTimeoutMs: serviceStartTimeoutMs,
      });
      const started = await agent.start();
      localApiRuntime = {
        ...started,
        localCacheAgent: true,
        coreServiceUrl: thinClientCore.coreServiceUrl,
        purchaseBrowserToken: started.authToken,
        profile,
        migrationPreview: paths.getMigrationPreview(),
        recoveryMode: false,
        cacheDirectory: "",
        activeDatabasePath: started.databasePath,
      };
      supervisor.appendLog(
        "desktop-main",
        `[runtime] local cache agent v2 ready ${started.baseUrl}\n`,
      );
      return localApiRuntime;
    }
    if (thinClientCore?.enabled === true) {
      const profile = paths.ensureProfile();
      const baseUrl = String(thinClientCore.coreServiceUrl || "").replace(
        /\/$/u,
        "",
      );
      const clientId = String(thinClientCore.clientId || "").trim();
      if (!baseUrl || !clientId) throw new Error("薄客户端核心服务配置不完整");
      const health = await probeJson(`${baseUrl}/health`, 8_000);
      if (
        health?.ok !== true ||
        health?.service !== "wangzai-test-core-gateway"
      ) {
        throw new Error(`测试核心服务器不可用：${baseUrl}`);
      }
      const profileToken = `${clientId}:${profile.profileId}`;
      localApiRuntime = {
        baseUrl,
        port: Number(new URL(baseUrl).port) || 443,
        reused: true,
        remoteCore: true,
        authToken: profileToken,
        purchaseBrowserToken: profileToken,
        profile,
        migrationPreview: paths.getMigrationPreview(),
        recoveryMode: false,
        cacheDirectory: paths.ensureDirectory(
          path.join(paths.desktopDataRoot(), "thin-client-cache"),
        ),
        activeDatabasePath: "",
        databasePath: "",
      };
      supervisor.appendLog(
        "desktop-main",
        `[runtime] thin core ready ${baseUrl}\n`,
      );
      return localApiRuntime;
    }
    const requestedProfile = paths.ensureProfile();
    const databaseStartup =
      paths.resolveCurrentProfileDatabaseStartup(requestedProfile);
    const profile = databaseStartup.profile;
    const recoveryMode = databaseStartup.mode === "recovery";
    const migrationPreview = paths.getMigrationPreview();
    const preferredPort = normalizePort(
      process.env.LOCAL_API_PORT,
      DEFAULT_LOCAL_API_PORT,
    );
    // 始终启动桌面端自己的 local-api，避免误用指向另一份数据库的开发服务。
    const port = await findAvailableLoopbackPort(preferredPort);
    const baseUrl = `http://127.0.0.1:${port}`;
    const healthUrl = `${baseUrl}/health`;
    const localApiRoot = paths.localApiRoot();
    const scriptPath = path.join(localApiRoot, "src", "server.js");
    const configPath = path.join(
      localApiRoot,
      "config",
      "local-api.config.json",
    );
    paths.localApiDataDirectory();
    const dbPath = databaseStartup.runtimeDatabasePath;
    const shopDatabaseRoot = typeof paths.localApiShopDatabaseRoot === "function"
      ? paths.localApiShopDatabaseRoot()
      : path.join(path.dirname(dbPath), "shop-databases");
    const aggregateIndexPath = typeof paths.localApiAggregateIndexPath === "function"
      ? paths.localApiAggregateIndexPath()
      : path.join(path.dirname(dbPath), "shop-aggregate-index.sqlite");
    const shopDatabaseBackupRoot = typeof paths.localApiShopDatabaseBackupRoot === "function"
      ? paths.localApiShopDatabaseBackupRoot()
      : path.join(path.dirname(path.dirname(dbPath)), "backups", "shop-databases");
    const secretPath = ensureLocalApiSecretFile(paths.localApiSecretPath());
    const logDirectory =
      typeof paths.logDirectory === "function"
        ? paths.logDirectory()
        : path.join(path.dirname(dbPath), "logs");
    const expectedRuntime = {
      appId: profile.appId || "com.wangzai.assistant.desktop",
      profileId: profile.profileId,
      dataRootFingerprint: profile.dataRootFingerprint,
      protocolVersion: "1",
    };
    // 此 capability token 只存在主进程和 local-api 子进程环境中，不暴露给渲染层。
    const authToken = crypto.randomBytes(32).toString("base64url");
    const purchaseBrowserToken = crypto.randomBytes(32).toString("base64url");
    const shopLicenseEnforcementEnabled =
      isPackaged ||
      String(process.env.WANGZAI_LICENSE_MODE || "").toLowerCase() ===
        "enforce";
    const protectedComputeEnvironment = {
      // These values are always overwritten, including when empty, so an
      // untrusted parent-process environment cannot replace sealed package
      // resources or their pinned configuration key.
      LOCAL_API_PROTECTED_COMPUTE_SIGNED_CONFIG_PATH: String(
        protectedComputeConfig?.signedPublicConfigPath || "",
      ),
      LOCAL_API_PROTECTED_COMPUTE_CONFIG_KEY_PATH: String(
        protectedComputeConfig?.configurationPublicKeyPath || "",
      ),
      LOCAL_API_PROTECTED_COMPUTE_CONFIG_KEY_ID: String(
        protectedComputeConfig?.configurationKeyId || "",
      ),
      LOCAL_API_PROTECTED_COMPUTE_CONFIG_KEY_SHA256: String(
        protectedComputeConfig?.configurationKeySha256 || "",
      ),
      LOCAL_API_PROTECTED_COMPUTE_VERSION_STATE_PATH: protectedComputeConfig
        ? String(paths.protectedComputeVersionStatePath())
        : "",
    };

    const child = supervisor.spawnElectronNodeScript("local-api", scriptPath, {
      cwd: localApiRoot,
      env: {
        LOCAL_API_HOST: "127.0.0.1",
        LOCAL_API_PORT: String(port),
        LOCAL_API_CONFIG_PATH: configPath,
        LOCAL_API_DB_PATH: dbPath,
        LOCAL_API_SHOP_DB_ROOT: shopDatabaseRoot,
        LOCAL_API_AGGREGATE_INDEX_PATH: aggregateIndexPath,
        LOCAL_API_SHOP_DB_BACKUP_ROOT: shopDatabaseBackupRoot,
        // Desktop profiles always use their canonical file-backed key. An
        // inherited plaintext master-secret override would make the
        // authenticated version high-water mark unstable across launches.
        LOCAL_API_SECRET: "",
        LOCAL_API_SECRET_FILE: secretPath,
        LOCAL_API_LOG_DIRECTORY: logDirectory,
        LOCAL_API_APP_ID: expectedRuntime.appId,
        LOCAL_API_PROFILE_ID: expectedRuntime.profileId,
        LOCAL_API_DATA_ROOT_FINGERPRINT: expectedRuntime.dataRootFingerprint,
        LOCAL_API_PROTOCOL_VERSION: expectedRuntime.protocolVersion,
        // Recovery shell must only expose the explicit recovery operation. It
        // never runs normal background Ozon work against a scratch database.
        LOCAL_API_CONTINUOUS_SYNC:
          recoveryMode || continuousSyncEnabled === false ? "0" : "1",
        // The HTTP server must become healthy before startup sync can queue
        // large profile-wide jobs. Otherwise the desktop never reaches main
        // window creation when an existing profile has a heavy sync backlog.
        LOCAL_API_DEFER_CONTINUOUS_SYNC:
          recoveryMode || continuousSyncEnabled === false ? "0" : "1",
        // Give first-screen SQLite reads a quiet window before the initial
        // multi-shop Ozon warmup starts competing for the local database.
        LOCAL_API_CONTINUOUS_SYNC_START_DELAY_MS: "30000",
        LOCAL_API_AUTH_TOKEN: authToken,
        // In packaged/enforced mode every outbound Ozon request must match
        // an active server-issued shop-card grant held only in local-api memory.
        LOCAL_API_SHOP_LICENSE_ENFORCE: shopLicenseEnforcementEnabled
          ? "1"
          : "0",
        // A second capability protects task claim/receipt routes from the
        // generic renderer local-api proxy. It remains in the two main-owned
        // processes only.
        LOCAL_API_PURCHASE_BROWSER_TOKEN: purchaseBrowserToken,
        ...protectedComputeEnvironment,
        WANGZAI_OZON_CATEGORY_TREE_PATH: paths.categoryTreePath(),
        LOCAL_API_ALLOWED_ORIGINS:
          process.env.LOCAL_API_ALLOWED_ORIGINS || LOCAL_API_ALLOWED_ORIGINS,
      },
    });

    await waitForHealthyService({
      name: "local-api",
      child,
      healthUrl,
      expectedService: "wangzai-local-api",
      expectedRuntime,
      timeoutMs: serviceStartTimeoutMs,
      supervisor,
    });
    const initializedProfile = recoveryMode
      ? profile
      : paths.markCurrentProfileDatabaseInitialized(profile);
    supervisor.appendLog(
      "desktop-main",
      `[runtime] local-api ready ${baseUrl}\n`,
    );
    localApiRuntime = {
      baseUrl,
      port,
      reused: false,
      authToken,
      secretPath,
      coreServiceUrl: String(
        protectedComputeConfig?.serverBaseUrl || "",
      ).trim(),
      purchaseBrowserToken,
      profile: initializedProfile,
      migrationPreview,
      recoveryMode,
      activeDatabasePath: databaseStartup.activeDatabasePath,
      databasePath: dbPath,
    };
    return localApiRuntime;
  }

  async function startPurchaseBridge() {
    const preferredPort = normalizePort(
      process.env.PURCHASE_SEARCH_BRIDGE_PORT,
      DEFAULT_PURCHASE_BRIDGE_PORT,
    );
    const preferredBaseUrl = `http://127.0.0.1:${preferredPort}`;
    const preferredHealthUrl = `${preferredBaseUrl}/health`;

    const mustOwnProtectedBridge =
      isPackaged ||
      String(process.env.WANGZAI_LICENSE_MODE || "").toLowerCase() ===
        "enforce";
    // 开发观察模式可复用独立 bridge；正式授权模式必须启动带 capability 的实例。
    if (
      !mustOwnProtectedBridge &&
      (await isHealthyService(preferredHealthUrl, "purchase-search-bridge"))
    ) {
      supervisor.appendLog(
        "desktop-main",
        `[runtime] reuse purchase bridge ${preferredBaseUrl}\n`,
      );
      return {
        baseUrl: preferredBaseUrl,
        port: preferredPort,
        reused: true,
        // This development-only listener is not owned or authenticated by the
        // desktop. Preserve the runtime callback contract without claiming to
        // update a foreign process's license policy or sharing its capability.
        updateLicenseState: () => ({ updated: false, reason: 'development-bridge-not-owned' }),
      };
    }

    if (
      mustOwnProtectedBridge &&
      !(await isLoopbackPortAvailable(preferredPort))
    ) {
      throw new Error(
        `正式授权模式需要独占拍单插件端口 ${preferredPort}，请先关闭占用该端口的旧服务`,
      );
    }
    const port = mustOwnProtectedBridge
      ? preferredPort
      : await findAvailableLoopbackPort(preferredPort);
    const baseUrl = `http://127.0.0.1:${port}`;
    const healthUrl = `${baseUrl}/health`;
    const child = supervisor.spawnElectronNodeScript(
      "purchase-search-bridge",
      paths.purchaseBridgeScriptPath(),
      {
        cwd: paths.purchaseBridgeWorkingDirectory(),
        env: {
          PURCHASE_SEARCH_BRIDGE_PORT: String(port),
          PURCHASE_BRIDGE_AUTH_TOKEN: purchaseBridgeState.authToken,
          PURCHASE_BRIDGE_LICENSE_STATE_PATH: purchaseBridgeState.statePath,
        },
      },
    );

    await waitForHealthyService({
      name: "purchase-search-bridge",
      child,
      healthUrl,
      expectedService: "purchase-search-bridge",
      timeoutMs: serviceStartTimeoutMs,
      supervisor,
    });
    const bridgeHealth = await probeJson(healthUrl);
    if (!bridgeHealth?.authorizationRequired) {
      throw new Error("拍单插件服务未启用桌面端授权保护");
    }
    supervisor.appendLog(
      "desktop-main",
      `[runtime] purchase bridge ready ${baseUrl}\n`,
    );
    return {
      baseUrl,
      port,
      reused: false,
      authToken: purchaseBridgeState.authToken,
      statePath: purchaseBridgeState.statePath,
      updateLicenseState: purchaseBridgeState.updateLicenseState,
    };
  }

  async function startAll() {
    try {
      const [localApi, purchaseBridge] = await Promise.all([
        startLocalApi(),
        startPurchaseBridge(),
      ]);
      return { localApi, purchaseBridge };
    } catch (error) {
      // 两个服务并发启动；任一失败时必须收回已启动的 sibling，不能让它
      // 继续占用 profile 的 DB、端口或 capability。保留原始启动错误，清理失败
      // 只写入主进程日志，避免把真正的故障原因掩盖掉。
      try {
        await stopAll();
      } catch (cleanupError) {
        supervisor.appendLog(
          "desktop-main",
          `[runtime] startup cleanup failed: ${cleanupError?.stack || cleanupError}\n`,
        );
      }
      throw error;
    }
  }

  async function stopAll() {
    if (
      localApiRuntime?.authToken &&
      localApiRuntime?.remoteCore !== true &&
      localApiRuntime?.localCacheAgent !== true
    ) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1_500);
      try {
        await fetch(`${localApiRuntime.baseUrl}/api/internal/shutdown`, {
          method: "POST",
          headers: { [LOCAL_API_TOKEN_HEADER]: localApiRuntime.authToken },
          signal: controller.signal,
        });
      } catch {
        // supervisor 会在下面的限定时间内结束未响应的 child。
      } finally {
        clearTimeout(timer);
      }
      await delay(80);
    }
    await supervisor.stopChildProcesses();
    localApiRuntime = null;
  }

  return Object.freeze({
    startAll,
    startLocalApi,
    startPurchaseBridge,
    stopAll,
  });
}
