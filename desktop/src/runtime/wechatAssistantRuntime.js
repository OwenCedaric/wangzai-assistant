import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import {
  createWechatAssistantActionRelay,
  WECHAT_ASSISTANT_OPERATION_IDS,
} from "./wechatAssistantActionRelay.js";
import { createWechatAssistantModelRelay } from "./wechatAssistantModelRelay.js";
import { createWechatAssistantReadonly } from "./wechatAssistantReadonly.js";
import { assertWechatAssistantPointsAvailable } from "./wechatAssistantPoints.js";
import { cleanText, publicDiagnosticLogs, publicErrorMessage, redactText } from "./wechatAssistantLogFormat.js";
export { classifyWechatAssistantGatewayLine, formatWechatAssistantPublicLogLine } from "./wechatAssistantLogFormat.js";
import { classifyWechatAssistantGatewayLine } from "./wechatAssistantLogFormat.js";
import {
  atomicJsonWrite,
  delay,
  findAvailableLoopbackPort,
  portIsOpen,
  processIsAlive,
  safeJsonRead,
} from "./wechatAssistantProcessUtils.js";

const CONFIG_VERSION = 5;
const GATEWAY_PORT = 18791;
const AUTO_RESTART_DELAY_MS = 2_000;
const AUTO_START_FAILURE_COOLDOWN_MS = 30_000;
const CHANNEL_RECOVERY_DELAY_MS = 300;
const CHANNEL_RECOVERY_COOLDOWN_MS = 30_000;
const CHANNEL_RECOVERY_MAX_COOLDOWN_MS = 5 * 60_000;
const CHANNEL_RECOVERY_SAFE_POINT_POLL_MS = 250;
const MAX_LOG_LINES = 160;
const POINTS_STATUS_TTL_MS = 15_000;
const OPERATION_ID_SET = new Set(WECHAT_ASSISTANT_OPERATION_IDS);

function normalizeSettings(input = {}, previous = {}) {
  const assistantName = String(input.assistantName ?? previous.assistantName ?? "旺崽微信助理").trim().slice(0, 60);
  const assistantStyle = String(input.assistantStyle ?? previous.assistantStyle ?? "brief").trim().slice(0, 40);
  const modelSource = String(input.modelSource ?? previous.modelSource ?? "builtin-points").trim();
  const modelAccountId = String(input.modelAccountId ?? previous.modelAccountId ?? "").trim().slice(0, 160);
  const modelName = String(input.modelName ?? previous.modelName ?? "gpt-5.6-terra").trim().slice(0, 160);
  const autoStartEnabled = input.autoStartEnabled ?? previous.autoStartEnabled ?? true;
  const requestedToolAccessMode = String(input.toolAccessMode ?? previous.toolAccessMode ?? "read-only").trim();
  const toolAccessMode = requestedToolAccessMode === "confirm-write" ? "direct-write" : requestedToolAccessMode;
  const requestedOperationActions = input.allowedOperationActions ?? previous.allowedOperationActions ?? [];
  const allowedOperationActions = [...new Set(
    (Array.isArray(requestedOperationActions) ? requestedOperationActions : [])
      .map((value) => String(value || "").trim())
      .filter((value) => OPERATION_ID_SET.has(value)),
  )];
  if (!["builtin-points", "saved-api"].includes(modelSource)) throw new Error("模型来源无效。");
  if (!["read-only", "direct-write"].includes(toolAccessMode)) throw new Error("小龙虾操作权限无效。");
  if (modelSource === "saved-api" && !modelAccountId) throw new Error("请选择已保存的模型接口。");
  if (modelName && !/^[\w./:@-]+$/u.test(modelName)) throw new Error("主模型名称格式不正确。");
  return {
    assistantName: assistantName || "旺崽微信助理",
    assistantStyle,
    modelSource,
    modelAccountId,
    modelName,
    autoStartEnabled: autoStartEnabled !== false,
    toolAccessMode,
    allowedOperationActions,
  };
}

export function createWechatAssistantRuntime({
  app,
  safeStorage,
  paths,
  desktopRoot,
  workspaceRoot,
  appendLog = () => undefined,
  spawnProcess = spawn,
  executablePath = process.execPath,
  gatewayPort = GATEWAY_PORT,
  portProbe = portIsOpen,
  allocateGatewayPort = findAvailableLoopbackPort,
  autoRestartDelayMs = AUTO_RESTART_DELAY_MS,
  autoStartFailureCooldownMs = AUTO_START_FAILURE_COOLDOWN_MS,
  channelRecoveryDelayMs = CHANNEL_RECOVERY_DELAY_MS,
  channelRecoveryCooldownMs = CHANNEL_RECOVERY_COOLDOWN_MS,
} = {}) {
  const root = path.join(paths.dataLayout().dataRoot, "wechat-assistant");
  const stateDir = path.join(root, "openclaw-state");
  const workspaceDir = path.join(stateDir, "workspace");
  const settingsPath = path.join(root, "settings.secure.json");
  const pluginRegistrationPath = path.join(root, "plugin-registration.json");
  const configPath = path.join(stateDir, "openclaw.json");
  const runtimeRoot = app.isPackaged
    ? path.join(path.dirname(process.execPath), "openclaw-runtime")
    : path.join(desktopRoot, "openclaw-runtime");
  const workspaceBundleRoot = app.isPackaged
    ? path.join(path.dirname(process.execPath), "openclaw-workspace")
    : path.join(desktopRoot, "resources", "openclaw-workspace");
  const projectRuntimeRoot = app.isPackaged ? process.resourcesPath : workspaceRoot;
  const cliPath = path.join(runtimeRoot, "node_modules", "openclaw", "openclaw.mjs");
  const pluginPath = path.join(runtimeRoot, "node_modules", "@tencent-weixin", "openclaw-weixin");
  const logs = [];
  let gatewayChild = null;
  let activeGatewayPort = Number(gatewayPort) || GATEWAY_PORT;
  let gatewayPid = null;
  let gatewayStartPromise = null;
  let gatewayPhase = "stopped";
  let gatewayError = "";
  let licenseAuthorized = false;
  let authorizationScope = "";
  let authorizationRevision = 0;
  let authorizationTransition = null;
  let gatewayAuthorizationToken = randomBytes(32).toString("hex");
  let autoStartPromise = null;
  let autoStartNextAllowedAtMs = 0;
  let autoRestartTimer = null;
  let channelRecoveryTimer = null;
  let channelRecoveryPromise = null;
  let channelRecoveryGeneration = 0;
  let loginChild = null;
  let loginPhase = "idle";
  let loginMessage = "";
  let qrDataUrl = "";
  let verifyCodeRequired = false;
  let executeModelRequestHandler = null;
  let executeBusinessRequestHandler = null;
  let getPointsWalletHandler = null;
  let pointsCheckPromise = null;
  let pointsStatus = {
    required: true,
    phase: "unknown",
    balancePoints: null,
    reservedPoints: null,
    availablePoints: null,
    checkedAt: "",
    checkedAtMs: 0,
    error: "",
  };
  let modelRelay = null;
  let actionRelay = null;
  let actionRelayRevision = -1;
  let activeModelRequests = 0;
  let modelChannel = {
    phase: "idle",
    source: "",
    model: "",
    strategy: "",
    pendingRequests: 0,
    lastRequestAt: "",
    lastSuccessAt: "",
    lastFailureAt: "",
    code: "",
    error: "",
    retrySafe: false,
    outcome: "",
  };
  let channelRecovery = {
    phase: "idle",
    kind: "",
    attempt: 0,
    reason: "",
    lastFailureAt: "",
    lastRecoveredAt: "",
    nextAllowedAtMs: 0,
    error: "",
  };

  function log(scope, message) {
    const cleaned = redactText(message).trim();
    if (!cleaned) return;
    for (const line of cleaned.split("\n")) {
      const entry = `${new Date().toLocaleTimeString("zh-CN", { hour12: false })} [${scope}] ${line}`;
      logs.push(entry);
      if (logs.length > MAX_LOG_LINES) logs.splice(0, logs.length - MAX_LOG_LINES);
      try {
        const pendingWrite = appendLog("wechat-assistant", `${entry}\n`);
        if (pendingWrite && typeof pendingWrite.catch === "function") pendingWrite.catch(() => undefined);
      } catch {
        // Diagnostic persistence must never interrupt the assistant command path.
      }
      observeGatewayOutput(scope, line);
    }
  }

  function modelStrategy(settings = readStoredSettings()) {
    return settings.modelSource === "builtin-points" ? "managed-safe-failover" : "single-saved-api";
  }

  function noteModelRequestStarted() {
    const settings = readStoredSettings();
    activeModelRequests += 1;
    modelChannel = {
      ...modelChannel,
      phase: "requesting",
      source: settings.modelSource,
      model: settings.modelName,
      strategy: modelStrategy(settings),
      pendingRequests: activeModelRequests,
      lastRequestAt: new Date().toISOString(),
      code: "",
      error: "",
      retrySafe: false,
      outcome: "pending",
    };
  }

  function noteModelRequestSettled() {
    activeModelRequests = Math.max(0, activeModelRequests - 1);
    modelChannel = {
      ...modelChannel,
      phase: activeModelRequests > 0 ? "requesting" : modelChannel.phase,
      pendingRequests: activeModelRequests,
    };
  }

  function noteModelChannelResult(channel = {}) {
    const settings = readStoredSettings();
    modelChannel = {
      ...modelChannel,
      phase: "ready",
      source: String(channel?.source || settings.modelSource),
      model: String(channel?.model || settings.modelName),
      strategy: String(channel?.strategy || modelStrategy(settings)),
      lastSuccessAt: new Date().toISOString(),
      code: "",
      error: "",
      retrySafe: false,
      outcome: "success",
    };
  }

  function noteModelChannelFailure(error) {
    const settings = readStoredSettings();
    modelChannel = {
      ...modelChannel,
      phase: error?.outcome === "unknown" ? "outcome-unknown" : "error",
      source: String(error?.channelSource || settings.modelSource),
      model: settings.modelName,
      strategy: modelStrategy(settings),
      lastFailureAt: new Date().toISOString(),
      code: String(error?.code || "WANGZAI_MODEL_REQUEST_FAILED"),
      error: redactText(error?.publicMessage || error?.message || "模型请求失败。"),
      retrySafe: error?.retrySafe === true,
      outcome: String(error?.outcome || "unknown"),
    };
  }

  function observeGatewayOutput(scope, line) {
    const event = classifyWechatAssistantGatewayLine(scope, line);
    if (!event) return;
    const now = new Date().toISOString();
    if (event.type === "wechat-monitor-started") {
      channelRecovery = { ...channelRecovery, phase: "ready", reason: "", error: "" };
      return;
    }
    if (event.type === "wechat-send-outcome-unknown") {
      channelRecovery = {
        ...channelRecovery,
        phase: "send-outcome-unknown",
        kind: "wechat-send",
        reason: "微信回信结果未知；为防止重复回复，本次不自动重发。",
        lastFailureAt: now,
      };
      return;
    }
    if (event.type === "wechat-poll-failure") {
      channelRecovery = {
        ...channelRecovery,
        phase: event.terminal ? "scheduled" : "degraded",
        kind: "wechat-poll",
        reason: "微信收信通道连续连接失败。",
        lastFailureAt: now,
      };
      if (event.terminal) scheduleChannelRecovery("wechat-poll", "微信收信通道连续失败");
      return;
    }
    if (event.type === "local-model-relay-failure") {
      modelChannel = {
        ...modelChannel,
        phase: "repairing",
        lastFailureAt: now,
        code: "LOCAL_MODEL_RELAY_UNREACHABLE",
        error: "小龙虾连接到了已失效的本机模型端口，正在刷新通道。",
        retrySafe: true,
        outcome: "not-dispatched",
      };
      scheduleChannelRecovery("model-relay", "本机模型通道连接失效");
    }
  }

  function runtimeAvailable() {
    return fs.existsSync(cliPath) && fs.existsSync(pluginPath);
  }

  async function refreshPointsStatus(settings = readStoredSettings(), { force = false, requirePositive = false } = {}) {
    const revision = authorizationRevision;
    if (settings.modelSource !== "builtin-points") {
      pointsStatus = {
        required: false,
        phase: "not-required",
        balancePoints: null,
        reservedPoints: null,
        availablePoints: null,
        checkedAt: "",
        checkedAtMs: 0,
        error: "",
      };
      return pointsStatus;
    }
    if (typeof getPointsWalletHandler !== "function") {
      const error = new Error("积分账户校验尚未初始化，请重启旺崽助手。");
      pointsStatus = { ...pointsStatus, required: true, phase: "error", error: error.message };
      if (requirePositive) throw error;
      return pointsStatus;
    }
    const fresh = Date.now() - Number(pointsStatus.checkedAtMs || 0) < POINTS_STATUS_TTL_MS;
    if (!force && fresh && ["ready", "depleted"].includes(pointsStatus.phase)) {
      if (requirePositive) assertWechatAssistantPointsAvailable(pointsStatus);
      return pointsStatus;
    }
    const request = pointsCheckPromise || Promise.resolve()
      .then(() => getPointsWalletHandler())
      .then((wallet) => {
        if (revision !== authorizationRevision) return pointsStatus;
        const checkedAtMs = Date.now();
        pointsStatus = {
          required: true,
          phase: wallet.availablePoints > 0 ? "ready" : "depleted",
          balancePoints: wallet.balancePoints,
          reservedPoints: wallet.reservedPoints,
          availablePoints: wallet.availablePoints,
          checkedAt: wallet.checkedAt || new Date(checkedAtMs).toISOString(),
          checkedAtMs,
          error: wallet.availablePoints > 0 ? "" : "当前账户可用积分为 0。",
        };
        return pointsStatus;
      })
      .catch((error) => {
        if (revision !== authorizationRevision) return pointsStatus;
        pointsStatus = {
          ...pointsStatus,
          required: true,
          phase: "error",
          checkedAt: new Date().toISOString(),
          checkedAtMs: Date.now(),
          error: String(error?.publicMessage || error?.message || "积分账户核验失败。"),
        };
        return pointsStatus;
      })
      .finally(() => { if (pointsCheckPromise === request) pointsCheckPromise = null; });
    pointsCheckPromise = request;
    const result = await request;
    if (revision !== authorizationRevision && requirePositive) throw new Error("微信助理授权状态已变化。");
    if (requirePositive) {
      if (result.phase === "error") throw new Error(result.error || "积分账户核验失败。");
      assertWechatAssistantPointsAvailable(result);
    }
    return result;
  }

  function readPackageVersion(packagePath) {
    return String(safeJsonRead(packagePath, {})?.version || "");
  }

  function decrypt(value) {
    if (!value) return "";
    if (!safeStorage?.isEncryptionAvailable?.()) throw new Error("当前系统安全存储不可用，无法读取模型密钥。");
    return safeStorage.decryptString(Buffer.from(String(value), "base64"));
  }

  function encrypt(value) {
    if (!safeStorage?.isEncryptionAvailable?.()) throw new Error("当前系统安全存储不可用，不能保存模型密钥。");
    return safeStorage.encryptString(String(value)).toString("base64");
  }

  function readStoredSettings() {
    const stored = safeJsonRead(settingsPath, {});
    return {
      version: CONFIG_VERSION,
      ...normalizeSettings(stored),
      encryptedGatewayToken: String(stored.encryptedGatewayToken || ""),
      encryptedRelayToken: String(stored.encryptedRelayToken || ""),
      updatedAt: String(stored.updatedAt || ""),
    };
  }

  function ensureWorkspace() {
    fs.mkdirSync(workspaceDir, { recursive: true });
    if (fs.existsSync(workspaceBundleRoot)) fs.cpSync(workspaceBundleRoot, workspaceDir, { recursive: true, force: true });
  }

  async function ensureModelRelay(settings = readStoredSettings()) {
    if (!executeModelRequestHandler) throw new Error("模型安全转发尚未初始化，请重启旺崽助手。");
    if (!settings.encryptedRelayToken) throw new Error("请先保存模型配置。");
    if (!modelRelay) {
      modelRelay = createWechatAssistantModelRelay({
        token: decrypt(settings.encryptedRelayToken),
        getSettings: readStoredSettings,
        executeRequest: (request) => executeModelRequestHandler(request),
        executeReadonlyRequest: createWechatAssistantReadonly({ executeRequest: (request) => {
          if (!executeBusinessRequestHandler) throw new Error("权威只读数据通道尚未初始化。");
          return executeBusinessRequestHandler(request);
        } }),
        onConversationRequest: noteModelRequestStarted,
        onConversationSettled: noteModelRequestSettled,
        onChannelResult: noteModelChannelResult,
        onChannelFailure: noteModelChannelFailure,
        onBillingResult: (billing, { replayed = false } = {}) => {
          if (replayed) {
            void refreshPointsStatus(readStoredSettings(), { force: true }).catch(() => undefined);
            return;
          }
          const availablePoints = Number(billing?.pointsRemaining);
          if (!Number.isFinite(availablePoints) || availablePoints < 0) return;
          pointsStatus = {
            ...pointsStatus,
            required: true,
            phase: availablePoints > 0 ? "ready" : "depleted",
            availablePoints: Math.floor(availablePoints),
            checkedAt: new Date().toISOString(),
            checkedAtMs: Date.now(),
            error: availablePoints > 0 ? "" : "当前账户可用积分为 0。",
          };
        },
        log,
      });
      modelRelay.setAuthorization({ authorized: licenseAuthorized, ownerScope: authorizationScope });
    }
    await modelRelay.start();
    return modelRelay;
  }

  async function ensureActionRelay(settings = readStoredSettings()) {
    if (settings.toolAccessMode !== "direct-write") return null;
    if (!executeBusinessRequestHandler) throw new Error("旺崽业务操作桥尚未初始化，请重启旺崽助手。");
    if (!actionRelay || actionRelayRevision !== authorizationRevision) {
      const retired = actionRelay;
      if (retired) await retired.stop();
      const revision = authorizationRevision;
      const assertActionAuthorization = () => {
        if (!licenseAuthorized || revision !== authorizationRevision) throw Object.assign(
          new Error("授权状态已变化，请在原账号核对操作结果；不要重复提交。"), { code: "WECHAT_AUTHORIZATION_CHANGED", status: 409, outcomeUnknown: true },
        );
      };
      actionRelay = createWechatAssistantActionRelay({
        getSettings: () => licenseAuthorized && revision === authorizationRevision
          ? readStoredSettings() : { toolAccessMode: "read-only" },
        executeBusinessRequest: async (request) => {
          assertActionAuthorization();
          const result = await executeBusinessRequestHandler(request);
          assertActionAuthorization();
          return result;
        },
        log,
      });
      actionRelayRevision = revision;
    }
    await actionRelay.start();
    return actionRelay;
  }

  async function ensureRelays(settings = readStoredSettings()) {
    await ensureModelRelay(settings);
    await ensureActionRelay(settings);
  }

  async function saveSettings(input = {}) {
    const previous = readStoredSettings();
    const normalized = normalizeSettings(input, previous);
    const encryptedGatewayToken = previous.encryptedGatewayToken || encrypt(randomBytes(32).toString("hex"));
    const encryptedRelayToken = previous.encryptedRelayToken || encrypt(randomBytes(32).toString("hex"));
    if (!normalized.modelName) throw new Error("请选择主模型。");
    const saved = {
      version: CONFIG_VERSION,
      ...normalized,
      encryptedGatewayToken,
      encryptedRelayToken,
      updatedAt: new Date().toISOString(),
    };
    atomicJsonWrite(settingsPath, saved);
    if (saved.toolAccessMode === "read-only" && actionRelay) {
      await actionRelay.stop();
      actionRelay = null;
    }
    await ensureRelays(saved);
    writeOpenClawConfig(saved);
    log("config", "微信助理配置已安全保存；模型凭证与积分规则不会进入小龙虾配置。");
    return publicSettings(saved);
  }

  function publicSettings(settings = readStoredSettings()) {
    return {
      assistantName: settings.assistantName,
      assistantStyle: settings.assistantStyle,
      modelSource: settings.modelSource,
      modelAccountId: settings.modelAccountId,
      modelName: settings.modelName,
      autoStartEnabled: settings.autoStartEnabled !== false,
      toolAccessMode: settings.toolAccessMode,
      allowedOperationActions: settings.allowedOperationActions,
      updatedAt: settings.updatedAt,
    };
  }

  function writeOpenClawConfig(settings = readStoredSettings()) {
    if (!modelRelay?.baseUrl) throw new Error("本机模型安全转发尚未启动。");
    ensureWorkspace();
    fs.mkdirSync(stateDir, { recursive: true });
    const toolPath = path.join(workspaceDir, "tools", "wangzai-readonly-mcp.mjs");
    const operationToolPath = path.join(workspaceDir, "tools", "wangzai-operations-mcp.mjs");
    // OpenClaw intentionally starts stdio MCP servers with a minimal
    // environment, so Electron's Node mode and Wangzai-owned paths must be
    // declared explicitly. Secret values stay as runtime-only placeholders.
    const mcpProcessEnvironment = {
      ELECTRON_RUN_AS_NODE: "1",
      WANGZAI_OPENCLAW_RUNTIME_ROOT: "${WANGZAI_OPENCLAW_RUNTIME_ROOT}",
      WANGZAI_LOCAL_API_DB_PATH: "${WANGZAI_LOCAL_API_DB_PATH}",
      WANGZAI_DESKTOP_PROJECT_ROOT: "${WANGZAI_DESKTOP_PROJECT_ROOT}",
      WANGZAI_OPENCLAW_READONLY_RELAY_URL: "${WANGZAI_OPENCLAW_READONLY_RELAY_URL}",
      WANGZAI_OPENCLAW_READONLY_RELAY_TOKEN: "${WANGZAI_OPENCLAW_READONLY_RELAY_TOKEN}",
    };
    const mcpServers = {
      "wangzai-readonly": {
        command: executablePath,
        args: [toolPath],
        env: mcpProcessEnvironment,
        cwd: workspaceDir,
        // OpenClaw's legacy connectTimeout/timeout aliases are seconds, not ms.
        connectionTimeoutMs: 20_000,
        requestTimeoutMs: 30_000,
        supportsParallelToolCalls: false,
      },
    };
    if (settings.toolAccessMode === "direct-write") {
      if (!actionRelay?.baseUrl) throw new Error("本机业务操作桥尚未启动。");
      mcpServers["wangzai-operations"] = {
        command: executablePath,
        args: [operationToolPath],
        env: {
          ...mcpProcessEnvironment,
          WANGZAI_OPENCLAW_ACTION_RELAY_URL: "${WANGZAI_OPENCLAW_ACTION_RELAY_URL}",
          WANGZAI_OPENCLAW_ACTION_RELAY_TOKEN: "${WANGZAI_OPENCLAW_ACTION_RELAY_TOKEN}",
        },
        cwd: workspaceDir,
        connectionTimeoutMs: 20_000,
        requestTimeoutMs: 130_000,
        supportsParallelToolCalls: false,
      };
    } else {
      // The bundled source stays intact. Only the generated per-profile
      // workspace copy is hidden so read-only agents do not advertise writes.
      fs.rmSync(path.join(workspaceDir, "skills", "wangzai-operations"), { recursive: true, force: true });
    }
    const config = {
      meta: {
        lastTouchedVersion: readPackageVersion(path.join(runtimeRoot, "node_modules", "openclaw", "package.json")),
        lastTouchedAt: new Date().toISOString(),
      },
      plugins: {
        allow: ["openclaw-weixin"],
        load: { paths: [pluginPath] },
      },
      channels: { "openclaw-weixin": { replyProgressMessages: false } },
      gateway: { mode: "local", auth: { mode: "token", token: "${WANGZAI_OPENCLAW_GATEWAY_TOKEN}" } },
      models: {
        mode: "merge",
        providers: {
          wangzaiAssistant: {
            baseUrl: "${WANGZAI_OPENCLAW_MODEL_RELAY_URL}",
            apiKey: "${WANGZAI_OPENCLAW_MODEL_RELAY_TOKEN}",
            api: "openai-completions",
            models: [{ id: settings.modelName, name: settings.modelName, contextWindow: 128000, maxTokens: 4096 }],
          },
        },
      },
      agents: {
        defaults: {
          workspace: workspaceDir,
          model: { primary: `wangzaiAssistant/${settings.modelName}` },
          models: { [`wangzaiAssistant/${settings.modelName}`]: {} },
          compaction: { reserveTokensFloor: 24576 },
        },
      },
      tools: { deny: ["write", "edit", "apply_patch", "exec", "process"] },
      mcp: { servers: mcpServers },
    };
    atomicJsonWrite(configPath, config);
  }

  function processEnvironment() {
    const settings = readStoredSettings();
    const environment = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      WANGZAI_OPENCLAW_MODEL_RELAY_URL: modelRelay?.baseUrl || "",
      WANGZAI_OPENCLAW_MODEL_RELAY_TOKEN: modelRelay?.token || "",
      WANGZAI_OPENCLAW_GATEWAY_TOKEN: gatewayAuthorizationToken,
      WANGZAI_OPENCLAW_READONLY_RELAY_URL: modelRelay?.baseUrl || "",
      WANGZAI_OPENCLAW_READONLY_RELAY_TOKEN: modelRelay?.token || "",
      WANGZAI_OPENCLAW_RUNTIME_ROOT: runtimeRoot,
      WANGZAI_LOCAL_API_DB_PATH: paths.localApiDatabasePath(),
      WANGZAI_DESKTOP_PROJECT_ROOT: projectRuntimeRoot,
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    };
    if (settings.toolAccessMode === "direct-write" && actionRelay?.baseUrl) {
      environment.WANGZAI_OPENCLAW_ACTION_RELAY_URL = actionRelay.baseUrl;
      environment.WANGZAI_OPENCLAW_ACTION_RELAY_TOKEN = actionRelay.token;
    }
    return environment;
  }

  function spawnCli(args, scope, { writeConfig = true } = {}) {
    const revision = authorizationRevision;
    if (!runtimeAvailable()) throw new Error("内置小龙虾运行环境不完整，请重新安装旺崽助手。");
    if (writeConfig) writeOpenClawConfig();
    const child = spawnProcess(executablePath, [cliPath, ...args], {
      cwd: workspaceDir,
      env: processEnvironment(),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => { if (revision === authorizationRevision) log(scope, chunk); });
    child.stderr?.on("data", (chunk) => { if (revision === authorizationRevision) log(scope, chunk); });
    return child;
  }

  async function ensurePluginRegistered() {
    await ensureRelays();
    // Relay servers bind to ephemeral loopback ports on every desktop launch.
    // Refresh the generated config even when plugin registration is already
    // complete, otherwise OpenClaw can keep calling a dead port from the
    // previous process.
    writeOpenClawConfig();
    const pluginVersion = readPackageVersion(path.join(pluginPath, "package.json"));
    const registered = safeJsonRead(pluginRegistrationPath, {});
    if (
      registered.pluginPath === pluginPath
      && registered.pluginVersion === pluginVersion
      && fs.existsSync(path.join(stateDir, "state", "openclaw.sqlite"))
    ) return;
    log("setup", "正在登记内置腾讯微信组件（首次运行只执行一次）。");
    const child = spawnCli(["plugins", "install", "--link", pluginPath], "setup", { writeConfig: false });
    const exitCode = await Promise.race([
      new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => resolve(code));
      }),
      delay(90_000).then(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
        throw new Error("内置微信组件登记超时。");
      }),
    ]);
    if (exitCode !== 0) throw new Error(`内置微信组件登记失败（退出状态 ${exitCode ?? "未知"}）。`);
    atomicJsonWrite(pluginRegistrationPath, {
      pluginPath,
      pluginVersion,
      registeredAt: new Date().toISOString(),
    });
    log("setup", "内置腾讯微信组件已经就绪。");
  }

  async function waitForGateway(timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await portProbe(activeGatewayPort)) return true;
      if (!gatewayChild) return false;
      await delay(250);
    }
    return false;
  }

  async function startGatewayAttempt() {
    const revision = authorizationRevision;
    const assertAuthorization = () => {
      if (!licenseAuthorized || !authorizationScope || revision !== authorizationRevision) throw new Error("微信助理需要当前账号的有效授权，请先登录。");
    };
    assertAuthorization();
    const settings = readStoredSettings();
    try {
      await refreshPointsStatus(settings, { force: true, requirePositive: true });
    } catch (error) {
      if (settings.modelSource === "builtin-points" && gatewayChild) await stopGatewayProcess().catch(() => undefined);
      throw error;
    }
    assertAuthorization();
    let gatewayReachable = await portProbe(activeGatewayPort);
    if (gatewayReachable && gatewayChild) {
      gatewayPhase = "running";
      gatewayError = "";
      return { ok: true, alreadyRunning: true };
    }
    if (gatewayReachable && gatewayPid && processIsAlive(gatewayPid)) {
      gatewayPhase = "running";
      gatewayError = "";
      return { ok: true, alreadyRunning: true, recovered: true };
    }
    if (gatewayReachable) {
      const occupiedPort = activeGatewayPort;
      const fallbackPort = Number(await allocateGatewayPort()) || 0;
      if (!Number.isInteger(fallbackPort) || fallbackPort <= 0 || fallbackPort > 65_535) {
        throw new Error(`端口 ${occupiedPort} 已被占用，并且无法分配备用端口。`);
      }
      activeGatewayPort = fallbackPort;
      gatewayReachable = await portProbe(activeGatewayPort);
      if (gatewayReachable) throw new Error(`备用端口 ${activeGatewayPort} 也被占用，请重试。`);
      log("gateway", `默认端口 ${occupiedPort} 已被占用，已自动切换到本机端口 ${activeGatewayPort}。`);
    }
    await ensurePluginRegistered();
    assertAuthorization();
    gatewayPhase = "starting";
    gatewayError = "";
    const child = spawnCli(["gateway", "--port", String(activeGatewayPort)], "gateway", { writeConfig: false });
    gatewayChild = child;
    gatewayPid = Number(child.pid) || null;
    child.once("error", (error) => {
      if (gatewayChild !== child || revision !== authorizationRevision) return;
      gatewayError = redactText(error?.message || error);
      gatewayPhase = "error";
      if (gatewayChild === child) gatewayChild = null;
      if (gatewayPid && gatewayPid === Number(child.pid)) gatewayPid = null;
    });
    child.once("exit", (code, signal) => {
      if (gatewayChild !== child) return;
      if (gatewayChild === child) gatewayChild = null;
      if (gatewayPid && gatewayPid === Number(child.pid)) gatewayPid = null;
      if (gatewayPhase !== "stopping" && gatewayPhase !== "stopped") {
        gatewayPhase = code === 0 ? "stopped" : "error";
        gatewayError = code === 0 ? "" : `微信服务意外停止（退出状态 ${code ?? "未知"}，终止信号 ${signal || "未知"}）。`;
        scheduleAutomaticRestart("网关异常退出");
      }
    });
    const ready = await waitForGateway();
    if (!ready) {
      await stopGatewayProcess();
      throw new Error(gatewayError || "小龙虾网关启动超时，请查看诊断日志。");
    }
    gatewayPhase = "running";
    log("gateway", `网关已启动（本机端口 ${activeGatewayPort}）。`);
    return { ok: true };
  }

  function startGateway({ withinAuthorizationTransition = false } = {}) {
    if (authorizationTransition && !withinAuthorizationTransition) return authorizationTransition.then(() => startGateway());
    if (gatewayStartPromise) return gatewayStartPromise;
    gatewayStartPromise = startGatewayAttempt()
      .then((result) => {
        autoStartNextAllowedAtMs = 0;
        return result;
      })
      .finally(() => { gatewayStartPromise = null; });
    return gatewayStartPromise;
  }

  function automaticStartReady(settings = readStoredSettings()) {
    return settings.autoStartEnabled !== false
      && Boolean(settings.modelName && settings.encryptedRelayToken)
      && (settings.modelSource === "builtin-points" || Boolean(settings.modelAccountId));
  }

  function clearAutomaticRestart() {
    if (autoRestartTimer !== null) clearTimeout(autoRestartTimer);
    autoRestartTimer = null;
  }

  function clearChannelRecovery({ reset = true } = {}) {
    channelRecoveryGeneration += 1;
    if (channelRecoveryTimer !== null) clearTimeout(channelRecoveryTimer);
    channelRecoveryTimer = null;
    if (reset) {
      channelRecovery = {
        ...channelRecovery,
        phase: "idle",
        kind: "",
        attempt: 0,
        reason: "",
        nextAllowedAtMs: 0,
        error: "",
      };
    }
  }

  function recoveryCooldown(attempt) {
    const base = Math.max(1_000, Number(channelRecoveryCooldownMs) || CHANNEL_RECOVERY_COOLDOWN_MS);
    return Math.min(CHANNEL_RECOVERY_MAX_COOLDOWN_MS, base * (2 ** Math.max(0, attempt - 1)));
  }

  function scheduleChannelRecovery(kind, reason) {
    if (!licenseAuthorized || !gatewayChild || ["stopping", "stopped"].includes(gatewayPhase)) return;
    if (channelRecoveryPromise || channelRecoveryTimer !== null) return;
    const generation = channelRecoveryGeneration;
    const now = Date.now();
    const cooldownDelay = Math.max(0, Number(channelRecovery.nextAllowedAtMs || 0) - now);
    const recoveryDelay = Math.max(0, Number(channelRecoveryDelayMs) || 0);
    const waitMs = Math.max(recoveryDelay, cooldownDelay);
    channelRecovery = {
      ...channelRecovery,
      phase: waitMs > recoveryDelay ? "cooldown" : "scheduled",
      kind,
      reason,
      error: "",
    };
    channelRecoveryTimer = setTimeout(() => {
      channelRecoveryTimer = null;
      void beginChannelRecovery(generation, kind, reason);
    }, waitMs);
    channelRecoveryTimer.unref?.();
  }

  async function beginChannelRecovery(generation, kind, reason) {
    if (generation !== channelRecoveryGeneration || channelRecoveryPromise) return;
    if (!licenseAuthorized || !gatewayChild || ["stopping", "stopped"].includes(gatewayPhase)) return;
    const pendingBusinessActions = Number(actionRelay?.status?.pending || 0);
    if (activeModelRequests > 0 || pendingBusinessActions > 0) {
      channelRecovery = {
        ...channelRecovery,
        phase: "waiting-safe-point",
        reason: activeModelRequests > 0
          ? "正在等待当前模型请求结束，避免中断后产生重复扣费。"
          : "正在等待当前业务操作结束，避免中断后重复执行。",
      };
      channelRecoveryTimer = setTimeout(() => {
        channelRecoveryTimer = null;
        void beginChannelRecovery(generation, kind, reason);
      }, CHANNEL_RECOVERY_SAFE_POINT_POLL_MS);
      channelRecoveryTimer.unref?.();
      return;
    }

    let failed = false;
    const attempt = channelRecovery.attempt + 1;
    channelRecovery = {
      ...channelRecovery,
      phase: "recovering",
      kind,
      attempt,
      reason,
      error: "",
    };
    log("recovery", `${reason}，正在切换到新的本机连接；不会重发当前模型请求或业务操作。`);
    channelRecoveryPromise = (async () => {
      await stopGateway({ preserveRecovery: true });
      if (generation !== channelRecoveryGeneration || !licenseAuthorized) return;
      await startGateway();
      const recoveredAtMs = Date.now();
      channelRecovery = {
        ...channelRecovery,
        phase: "ready",
        reason: "",
        lastRecoveredAt: new Date(recoveredAtMs).toISOString(),
        nextAllowedAtMs: recoveredAtMs + recoveryCooldown(attempt),
        error: "",
      };
      if (kind === "model-relay") {
        modelChannel = {
          ...modelChannel,
          phase: "ready",
          code: "",
          error: "",
          retrySafe: false,
          outcome: "not-dispatched",
        };
      }
      log("recovery", "新连接已经接管，后续微信消息可正常处理。" );
    })()
      .catch((error) => {
        failed = true;
        const message = redactText(error?.message || error || "通道自动恢复失败。");
        const failedAtMs = Date.now();
        channelRecovery = {
          ...channelRecovery,
          phase: "error",
          error: message,
          nextAllowedAtMs: failedAtMs + recoveryCooldown(attempt),
        };
        log("recovery", `通道自动恢复失败：${message}`);
      })
      .finally(() => {
        channelRecoveryPromise = null;
        if (failed && generation === channelRecoveryGeneration) scheduleChannelRecovery(kind, reason);
      });
    return channelRecoveryPromise;
  }

  async function startAutomatically(reason = "账号授权完成", { withinAuthorizationTransition = false } = {}) {
    const revision = authorizationRevision;
    const settings = readStoredSettings();
    if (!licenseAuthorized) return { ok: true, skipped: "license-not-authorized" };
    if (!automaticStartReady(settings)) return { ok: true, skipped: "not-configured" };
    if (autoStartPromise) return autoStartPromise;
    if (Date.now() < autoStartNextAllowedAtMs) {
      return {
        ok: false,
        skipped: "failure-cooldown",
        retryAt: new Date(autoStartNextAllowedAtMs).toISOString(),
      };
    }
    autoStartPromise = startGateway({ withinAuthorizationTransition })
      .then((result) => {
        if (revision !== authorizationRevision) return { ok: false, stale: true };
        autoStartNextAllowedAtMs = 0;
        if (!result?.alreadyRunning) log("gateway", `${reason}，微信助理服务已自动启动。`);
        return result;
      })
      .catch((error) => {
        if (revision !== authorizationRevision) return { ok: false, stale: true };
        const message = redactText(error?.message || error || "自动启动失败。");
        gatewayError = message;
        gatewayPhase = "error";
        autoStartNextAllowedAtMs = Date.now() + Math.max(
          1_000,
          Number(autoStartFailureCooldownMs) || AUTO_START_FAILURE_COOLDOWN_MS,
        );
        log("gateway", `${reason}，自动启动失败：${message}`);
        clearAutomaticRestart();
        autoRestartTimer = setTimeout(() => {
          autoRestartTimer = null;
          void startAutomatically("自动恢复");
        }, Math.max(0, autoStartNextAllowedAtMs - Date.now()));
        autoRestartTimer.unref?.();
        return { ok: false, error: message };
      })
      .finally(() => { autoStartPromise = null; });
    return autoStartPromise;
  }

  function scheduleAutomaticRestart(reason) {
    clearAutomaticRestart();
    if (!licenseAuthorized || !automaticStartReady()) return;
    autoRestartTimer = setTimeout(() => {
      autoRestartTimer = null;
      void startAutomatically(reason);
    }, Math.max(0, Number(autoRestartDelayMs) || 0));
    autoRestartTimer.unref?.();
  }

  async function handleLicenseSession(snapshot = {}) {
    const next = snapshot.authorized === true && /^[a-f0-9]{64}$/u.test(String(snapshot.authorizationScope || ""))
      ? snapshot.authorizationScope : "";
    const unavailable = { ok: false, code: "WECHAT_AUTHORIZATION_SCOPE_REQUIRED", error: "无法识别当前授权账户，请重新登录。" };
    if (next === authorizationScope) return authorizationTransition || (snapshot.authorized === true && !next ? unavailable : next
      ? startAutomatically("旺崽账号登录完成") : { ok: true, skipped: "license-not-authorized" });
    authorizationScope = next;
    authorizationRevision += 1;
    const revision = authorizationRevision;
    licenseAuthorized = Boolean(next);
    modelRelay?.setAuthorization({ authorized: licenseAuthorized, ownerScope: next });
    gatewayAuthorizationToken = randomBytes(32).toString("hex");
    activeModelRequests = 0;
    modelChannel = { ...modelChannel, phase: "idle", pendingRequests: 0, lastRequestAt: "", lastSuccessAt: "", lastFailureAt: "", code: "", error: "", outcome: "" };
    pointsCheckPromise = null;
    pointsStatus = { ...pointsStatus, phase: "unknown", balancePoints: null, reservedPoints: null, availablePoints: null, checkedAt: "", checkedAtMs: 0, error: "" };
    autoStartNextAllowedAtMs = 0;
    clearAutomaticRestart();
    clearChannelRecovery();
    const retiredAction = actionRelay;
    actionRelay = null;
    actionRelayRevision = -1;
    const pending = (authorizationTransition || Promise.resolve()).catch(() => undefined).then(async () => {
      if (gatewayChild || gatewayPid || gatewayStartPromise || gatewayPhase === "running" || gatewayPhase === "starting") await stopGateway();
      await retiredAction?.stop();
      if (revision !== authorizationRevision) return { ok: false, stale: true };
      return licenseAuthorized ? startAutomatically("旺崽账号登录完成", { withinAuthorizationTransition: true })
        : snapshot.authorized === true ? unavailable : { ok: true, skipped: "license-not-authorized" };
    }).finally(() => { if (authorizationTransition === pending) authorizationTransition = null; });
    authorizationTransition = pending;
    return pending;
  }

  async function stopChild(child, timeoutMs = 5000) {
    if (!child || child.exitCode !== null) return;
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off?.("exit", finish);
        resolve();
      };
      const timer = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
        finish();
      }, timeoutMs);
      child.once("exit", finish);
      child.kill();
    });
  }

  async function stopGatewayProcess() {
    clearAutomaticRestart();
    const child = gatewayChild;
    const trackedPid = Number(child?.pid || gatewayPid) || null;
    gatewayPhase = "stopping";
    gatewayChild = null;
    await stopChild(child);
    if (await portProbe(activeGatewayPort) && trackedPid && processIsAlive(trackedPid)) {
      try { process.kill(trackedPid, "SIGKILL"); } catch { /* Process may have already exited. */ }
      const deadline = Date.now() + 2_500;
      while (Date.now() < deadline && await portProbe(activeGatewayPort)) await delay(100);
    }
    if (await portProbe(activeGatewayPort)) {
      gatewayPhase = "error";
      gatewayError = `端口 ${activeGatewayPort} 上的旧服务未能停止。`;
      throw new Error(gatewayError);
    }
    gatewayPid = null;
    gatewayPhase = "stopped";
    gatewayError = "";
    return { ok: true };
  }

  async function stopGateway({ preserveRecovery = false } = {}) {
    if (!preserveRecovery) clearChannelRecovery();
    const pendingStart = gatewayStartPromise;
    if (pendingStart) await pendingStart.catch(() => undefined);
    return stopGatewayProcess();
  }

  async function restartGateway({ preserveRecovery = false } = {}) {
    await stopGateway({ preserveRecovery });
    return startGateway();
  }

  function accountSummary() {
    const accountRegistry = safeJsonRead(path.join(stateDir, "openclaw-weixin", "accounts.json"), []);
    const ids = Array.isArray(accountRegistry) ? accountRegistry : [];
    return { count: ids.length, labels: ids.map((id) => `${String(id).slice(0, 6)}…${String(id).slice(-4)}`) };
  }

  async function createQrDataUrl(url) {
    const require = createRequire(path.join(runtimeRoot, "package.json"));
    const QRCode = require("qrcode");
    return QRCode.toDataURL(url, { errorCorrectionLevel: "M", margin: 2, width: 360 });
  }

  function handleLoginOutput(chunk) {
    const text = cleanText(chunk);
    if (/输入手机微信显示的数字|重新输入/u.test(text)) {
      verifyCodeRequired = true;
      loginPhase = "verify-code";
      loginMessage = "请填写手机微信显示的数字。";
    } else if (/正在验证/u.test(text)) {
      loginPhase = "scanned";
      loginMessage = "二维码已扫描，正在验证。";
    } else if (/已将此 OpenClaw 连接到微信|已连接过此 OpenClaw/u.test(text)) {
      loginPhase = "connected";
      loginMessage = "个人微信已连接。";
      verifyCodeRequired = false;
    } else if (/二维码.*过期|连接流程已停止|登录失败|failed/iu.test(text)) {
      loginPhase = "error";
      loginMessage = publicErrorMessage(redactText(text).split("\n").filter(Boolean).at(-1) || "微信绑定失败。");
    }
    const urls = text.match(/https?:\/\/[^\s\u001b]+/g) || [];
    const qrUrl = urls.find((value) => /qrcode|qrconnect|weixin|wechat|ilink/i.test(value)) || urls[0];
    if (qrUrl && !qrDataUrl) {
      void createQrDataUrl(qrUrl).then((dataUrl) => {
        qrDataUrl = dataUrl;
        loginPhase = "qr-ready";
        loginMessage = "请使用手机微信扫描二维码。";
      }).catch((error) => {
        loginPhase = "error";
        loginMessage = `二维码生成失败：${publicErrorMessage(error?.message || error)}`;
      });
    }
  }

  async function startLogin() {
    if (loginChild) await cancelLogin();
    loginPhase = "starting";
    loginMessage = "正在向微信申请二维码…";
    qrDataUrl = "";
    verifyCodeRequired = false;
    await ensurePluginRegistered();
    const child = spawnCli(["channels", "login", "--channel", "openclaw-weixin"], "wechat-login", { writeConfig: false });
    loginChild = child;
    child.stdout?.on("data", handleLoginOutput);
    child.stderr?.on("data", handleLoginOutput);
    child.once("error", (error) => {
      loginPhase = "error";
      loginMessage = publicErrorMessage(error?.message || error);
      if (loginChild === child) loginChild = null;
    });
    child.once("exit", (code) => {
      if (loginChild === child) loginChild = null;
      if (loginPhase === "connected" || accountSummary().count > 0) {
        loginPhase = "connected";
        loginMessage = "个人微信已连接。";
        qrDataUrl = "";
        void restartGateway().catch((error) => log("gateway", error?.message || error));
      } else if (loginPhase !== "canceled" && loginPhase !== "error") {
        loginPhase = "error";
        loginMessage = code === 0 ? "微信绑定未完成。" : "微信绑定进程意外停止，请重新生成二维码。";
      }
    });
    return { ok: true };
  }

  function submitVerifyCode(code) {
    const normalized = String(code || "").trim();
    if (!/^\d{4,8}$/.test(normalized)) throw new Error("请输入手机微信显示的 4–8 位数字。");
    if (!loginChild?.stdin?.writable) throw new Error("当前没有等待验证码的微信绑定流程。");
    loginChild.stdin.write(`${normalized}\n`);
    verifyCodeRequired = false;
    loginPhase = "scanned";
    loginMessage = "数字已提交，正在验证。";
    return { ok: true };
  }

  async function cancelLogin() {
    const child = loginChild;
    loginChild = null;
    await stopChild(child, 2000);
    loginPhase = "canceled";
    loginMessage = "已取消微信绑定。";
    qrDataUrl = "";
    verifyCodeRequired = false;
    return { ok: true };
  }

  async function testModel(input = {}) {
    if (input && Object.keys(input).length) await saveSettings(input);
    const settings = readStoredSettings();
    const pointWallet = await refreshPointsStatus(settings, { force: true, requirePositive: settings.modelSource === "builtin-points" });
    const relay = await ensureModelRelay(settings);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(`${relay.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${relay.token}` },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`模型接口返回异常状态 ${response.status}`);
      const payload = await response.json().catch(() => ({}));
      const ids = Array.isArray(payload?.data) ? payload.data.map((item) => String(item?.id || "")) : [];
      return {
        ok: true,
        modelListed: ids.includes(settings.modelName),
        message: ids.includes(settings.modelName)
          ? settings.modelSource === "builtin-points"
            ? `模型配置可用，当前可用 ${pointWallet.availablePoints} 积分；本次检测不调用模型、不扣积分。`
            : "模型配置可用；检测不会调用模型或扣积分。"
          : "模型配置未通过检查，请重新选择。",
      };
    } catch (error) {
      if (error?.name === "AbortError") throw new Error("模型连接测试超时。");
      throw new Error(redactText(error?.message || error));
    } finally {
      clearTimeout(timer);
    }
  }

  async function status() {
    const available = runtimeAvailable();
    const accounts = accountSummary();
    const gatewayReachable = await portProbe(activeGatewayPort);
    if (gatewayChild && gatewayReachable) {
      gatewayPhase = "running";
      gatewayError = "";
    }
    if (gatewayPhase === "running" && !gatewayReachable) gatewayPhase = gatewayChild ? "starting" : "stopped";
    const settings = readStoredSettings();
    if (activeModelRequests === 0 && modelChannel.phase === "idle") {
      modelChannel = {
        ...modelChannel,
        source: settings.modelSource,
        model: settings.modelName,
        strategy: modelStrategy(settings),
      };
    }
    await refreshPointsStatus(settings).catch(() => undefined);
    return {
      ok: true,
      runtimeAvailable: available,
      runtimeVersion: available ? readPackageVersion(path.join(runtimeRoot, "node_modules", "openclaw", "package.json")) : "",
      pluginVersion: available ? readPackageVersion(path.join(pluginPath, "package.json")) : "",
      configured: Boolean(settings.modelName && settings.encryptedRelayToken && (settings.modelSource === "builtin-points" || settings.modelAccountId)),
      settings: publicSettings(settings),
      gateway: {
        phase: gatewayPhase,
        reachable: gatewayReachable,
        port: activeGatewayPort,
        preferredPort: Number(gatewayPort) || GATEWAY_PORT,
        automaticRetryAt: autoStartNextAllowedAtMs
          ? new Date(autoStartNextAllowedAtMs).toISOString()
          : "",
        error: gatewayError ? publicErrorMessage(gatewayError) : "",
      },
      modelRelay: modelRelay?.status || { running: false, port: 0 },
      modelChannel: {
        ...modelChannel,
        pendingRequests: activeModelRequests,
        error: modelChannel.error ? publicErrorMessage(modelChannel.error) : "",
      },
      channelRecovery: {
        ...channelRecovery,
        error: channelRecovery.error ? publicErrorMessage(channelRecovery.error) : "",
        nextAllowedAt: channelRecovery.nextAllowedAtMs
          ? new Date(channelRecovery.nextAllowedAtMs).toISOString()
          : "",
        nextAllowedAtMs: undefined,
        safety: "never-retry-unknown-model-or-write-outcomes",
      },
      actionRelay: actionRelay?.status || { running: false, port: 0, pending: 0 },
      points: { ...pointsStatus, checkedAtMs: undefined },
      login: { phase: accounts.count > 0 && loginPhase === "idle" ? "connected" : loginPhase, message: loginMessage, qrDataUrl, verifyCodeRequired },
      accounts,
      readonlyToolAvailable: fs.existsSync(path.join(workspaceDir, "tools", "wangzai-readonly-mcp.mjs")) || fs.existsSync(path.join(workspaceBundleRoot, "tools", "wangzai-readonly-mcp.mjs")),
      operationToolAvailable: fs.existsSync(path.join(workspaceDir, "tools", "wangzai-operations-mcp.mjs")) || fs.existsSync(path.join(workspaceBundleRoot, "tools", "wangzai-operations-mcp.mjs")),
      logs: publicDiagnosticLogs(logs),
    };
  }

  async function command(input = {}) {
    const name = String(input.command || "status");
    try {
      let result;
      if (name === "status") return status();
      if (name === "save-settings") result = { ok: true, settings: await saveSettings(input.settings) };
      else if (name === "start") result = await startGateway();
      else if (name === "stop") result = await stopGateway();
      else if (name === "restart") result = await restartGateway();
      else if (name === "start-login") result = await startLogin();
      else if (name === "submit-verify-code") result = submitVerifyCode(input.code);
      else if (name === "cancel-login") result = await cancelLogin();
      else if (name === "test-model") result = await testModel(input.settings);
      else if (name === "logs") return { ok: true, logs: publicDiagnosticLogs(logs) };
      else throw new Error("不支持的微信助理命令。");
      return { ...result, status: await status() };
    } catch (error) {
      const diagnosticMessage = redactText(error?.message || error || "微信助理操作失败。");
      const message = publicErrorMessage(diagnosticMessage);
      log("error", diagnosticMessage);
      return { ok: false, error: message, status: await status().catch(() => null) };
    }
  }

  async function stop() {
    authorizationScope = "";
    authorizationRevision += 1;
    modelRelay?.setAuthorization({ authorized: false });
    licenseAuthorized = false;
    clearAutomaticRestart();
    clearChannelRecovery();
    await cancelLogin().catch(() => undefined);
    await stopGateway().catch(() => undefined);
    await modelRelay?.stop().catch(() => undefined);
    await actionRelay?.stop().catch(() => undefined);
  }

  function configure({ executeModelRequest, executeBusinessRequest, getPointsWallet } = {}) {
    if (typeof executeModelRequest === "function") executeModelRequestHandler = executeModelRequest;
    if (typeof executeBusinessRequest === "function") executeBusinessRequestHandler = executeBusinessRequest;
    if (typeof getPointsWallet === "function") getPointsWalletHandler = getPointsWallet;
  }

  return Object.freeze({ command, status, stop, configure, handleLicenseSession, paths: { root, stateDir, runtimeRoot, workspaceDir } });
}
