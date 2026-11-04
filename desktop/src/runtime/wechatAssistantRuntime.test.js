import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createProcessSupervisor } from "./processSupervisor.js";
import {
  classifyWechatAssistantGatewayLine,
  createWechatAssistantRuntime,
  formatWechatAssistantPublicLogLine,
} from "./wechatAssistantRuntime.js";

function testSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from([...String(value)].reverse().join(""), "utf8"),
    decryptString: (value) => [...value.toString("utf8")].reverse().join(""),
  };
}

test("classifies only safe gateway recovery signals", () => {
  assert.deepEqual(
    classifyWechatAssistantGatewayLine(
      "gateway",
      "[openclaw-weixin] weixin getUpdates error (3/3): TypeError: fetch failed code=ETIMEDOUT",
    ),
    { type: "wechat-poll-failure", terminal: true },
  );
  assert.deepEqual(
    classifyWechatAssistantGatewayLine(
      "gateway",
      "[provider-transport-fetch] [model-fetch] error provider=wangzaiAssistant causeCode=ECONNREFUSED message=fetch failed",
    ),
    { type: "local-model-relay-failure" },
  );
  assert.deepEqual(
    classifyWechatAssistantGatewayLine(
      "gateway",
      "sendMessageWeixin: failed to=user clientId=1 err=timeout",
    ),
    { type: "wechat-send-outcome-unknown" },
  );
  assert.equal(
    classifyWechatAssistantGatewayLine("gateway", "MODEL_CHANNEL_OUTCOME_UNKNOWN upstream failed"),
    null,
  );
  assert.equal(
    classifyWechatAssistantGatewayLine("setup", "weixin getUpdates error (3/3)"),
    null,
  );
});

test("public diagnostics translate known gateway failures and hide raw English internals", () => {
  const pricing = formatWechatAssistantPublicLogLine(
    "18:30:02 [gateway] embedded run agent end: isError=true model=gpt-5.6-terra error=503 所选模型没有当前功能的有效积分价格",
  );
  const fallback = formatWechatAssistantPublicLogLine(
    "18:30:02 [gateway] [model-fallback/decision] model fallback decision: decision=candidate_failed detail=503 所选模型没有当前功能的有效积分价格",
  );
  const monitor = formatWechatAssistantPublicLogLine(
    "18:30:03 [gateway] [openclaw-weixin] weixin monitor started",
  );
  const hidden = formatWechatAssistantPublicLogLine(
    "18:30:04 [gateway] [diagnostic] internal scheduler trace id=abc-123",
  );

  assert.equal(pricing, "18:30:02 【模型通道】当前模型暂未启用积分价格，本次没有调用模型，也不会扣积分；请联系管理员启用后重试。");
  assert.equal(fallback, pricing);
  assert.equal(monitor, "18:30:03 【微信通道】微信收信服务已启动。");
  assert.equal(hidden, "");
  assert.doesNotMatch(`${pricing}\n${monitor}`, /[A-Za-z]{3,}/u);
});

test("writes only the loopback relay placeholder to OpenClaw config", async (t) => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wangzai-wechat-runtime-test-"));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  const desktopRoot = path.resolve(import.meta.dirname, "../..");
  const workspaceRoot = path.resolve(desktopRoot, "..");
  const logDirectory = path.join(dataRoot, "logs");
  fs.mkdirSync(logDirectory, { recursive: true });
  const supervisor = createProcessSupervisor({ getLogDirectory: () => logDirectory });
  const runtime = createWechatAssistantRuntime({
    app: { isPackaged: false },
    safeStorage: testSafeStorage(),
    paths: {
      dataLayout: () => ({ dataRoot }),
      localApiDatabasePath: () => path.join(dataRoot, "local-api.sqlite"),
    },
    desktopRoot,
    workspaceRoot,
    appendLog: supervisor.appendLog,
  });
  runtime.configure({
    executeModelRequest: async () => ({ ok: true }),
    executeBusinessRequest: async () => ({ ok: true }),
    getPointsWallet: async () => ({ balancePoints: 100, reservedPoints: 0, availablePoints: 100, checkedAt: new Date().toISOString() }),
  });
  t.after(() => runtime.stop());

  const saved = await runtime.command({
    command: "save-settings",
    settings: {
      assistantName: "测试助理",
      assistantStyle: "audit",
      modelSource: "builtin-points",
      modelAccountId: "",
      modelName: "gpt-5.6-terra",
      toolAccessMode: "confirm-write",
      allowedOperationActions: [
        "products:product.updatePrice",
        "products:product.updateStock",
        "not-a-real-permission",
      ],
    },
  });

  assert.equal(saved.ok, true);
  assert.equal(saved.settings.modelSource, "builtin-points");
  assert.equal(saved.settings.autoStartEnabled, true);
  assert.equal(saved.settings.toolAccessMode, "direct-write");
  assert.deepEqual(saved.settings.allowedOperationActions, [
    "products:product.updatePrice",
    "products:product.updateStock",
  ]);
  assert.equal(Object.hasOwn(saved.settings, "apiKey"), false);
  assert.equal(Object.hasOwn(saved.settings, "apiBaseUrl"), false);
  const secureFile = fs.readFileSync(path.join(dataRoot, "wechat-assistant", "settings.secure.json"), "utf8");
  const openClawConfig = fs.readFileSync(path.join(dataRoot, "wechat-assistant", "openclaw-state", "openclaw.json"), "utf8");
  assert.equal(secureFile.includes("points_per_cny"), false);
  assert.match(openClawConfig, /\$\{WANGZAI_OPENCLAW_MODEL_RELAY_TOKEN\}/u);
  assert.match(openClawConfig, /\$\{WANGZAI_OPENCLAW_MODEL_RELAY_URL\}/u);
  assert.match(openClawConfig, /openai-completions/u);
  assert.match(openClawConfig, /gpt-5\.6-terra/u);
  assert.match(openClawConfig, /wangzai-readonly-mcp\.mjs/u);
  assert.match(openClawConfig, /wangzai-operations-mcp\.mjs/u);
  assert.match(openClawConfig, /"ELECTRON_RUN_AS_NODE": "1"/u);
  assert.match(openClawConfig, /\$\{WANGZAI_OPENCLAW_RUNTIME_ROOT\}/u);
  assert.match(openClawConfig, /\$\{WANGZAI_LOCAL_API_DB_PATH\}/u);
  assert.match(openClawConfig, /\$\{WANGZAI_DESKTOP_PROJECT_ROOT\}/u);
  assert.match(openClawConfig, /\$\{WANGZAI_OPENCLAW_ACTION_RELAY_URL\}/u);
  assert.match(openClawConfig, /\$\{WANGZAI_OPENCLAW_ACTION_RELAY_TOKEN\}/u);
  assert.match(openClawConfig, /"deny": \[\s*"write",\s*"edit",\s*"apply_patch",\s*"exec",\s*"process"/u);
  const operationTool = fs.readFileSync(path.join(dataRoot, "wechat-assistant", "openclaw-state", "workspace", "tools", "wangzai-operations-mcp.mjs"), "utf8");
  const operationSkill = fs.readFileSync(path.join(dataRoot, "wechat-assistant", "openclaw-state", "workspace", "skills", "wangzai-operations", "SKILL.md"), "utf8");
  assert.match(operationTool, /不需要微信二次确认/u);
  assert.equal(operationTool.includes("wangzai_confirm_operation"), false);
  assert.match(operationSkill, /授权后直接生效/u);
  assert.equal(operationSkill.includes("逐次确认"), false);

  const downgraded = await runtime.command({
    command: "save-settings",
    settings: { ...saved.settings, toolAccessMode: "read-only" },
  });
  assert.equal(downgraded.ok, true);
  const readOnlyConfig = fs.readFileSync(path.join(dataRoot, "wechat-assistant", "openclaw-state", "openclaw.json"), "utf8");
  assert.equal(readOnlyConfig.includes("wangzai-operations-mcp.mjs"), false);
  assert.equal(fs.existsSync(path.join(dataRoot, "wechat-assistant", "openclaw-state", "workspace", "skills", "wangzai-operations")), false);
  await supervisor.flushLogs();
  assert.match(fs.readFileSync(path.join(logDirectory, "wechat-assistant.log"), "utf8"), /配置已安全保存/u);
});

test("saved model-interface mode requires an existing account selection", async (t) => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wangzai-wechat-runtime-url-test-"));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  const desktopRoot = path.resolve(import.meta.dirname, "../..");
  const runtime = createWechatAssistantRuntime({
    app: { isPackaged: false },
    safeStorage: testSafeStorage(),
    paths: { dataLayout: () => ({ dataRoot }), localApiDatabasePath: () => "unused.sqlite" },
    desktopRoot,
    workspaceRoot: path.resolve(desktopRoot, ".."),
  });
  runtime.configure({ executeModelRequest: async () => ({ ok: true }) });
  t.after(() => runtime.stop());
  const result = await runtime.command({
    command: "save-settings",
    settings: { modelSource: "saved-api", modelAccountId: "", modelName: "custom-model" },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /已保存的模型接口/u);
});

test("built-in runtime refuses to start when the authenticated account has no available points", async (t) => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wangzai-wechat-runtime-points-test-"));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  const desktopRoot = path.resolve(import.meta.dirname, "../..");
  const runtime = createWechatAssistantRuntime({
    app: { isPackaged: false },
    safeStorage: testSafeStorage(),
    paths: { dataLayout: () => ({ dataRoot }), localApiDatabasePath: () => "unused.sqlite" },
    desktopRoot,
    workspaceRoot: path.resolve(desktopRoot, ".."),
  });
  runtime.configure({
    executeModelRequest: async () => ({ ok: true }),
    executeBusinessRequest: async () => ({ ok: true }),
    getPointsWallet: async () => ({ balancePoints: 0, reservedPoints: 0, availablePoints: 0, checkedAt: new Date().toISOString() }),
  });
  t.after(() => runtime.stop());
  await runtime.command({
    command: "save-settings",
    settings: { modelSource: "builtin-points", modelName: "gpt-5.6-terra" },
  });
  await runtime.handleLicenseSession({ authorized: true, authorizationScope: "a".repeat(64) });
  const result = await runtime.command({ command: "start" });
  assert.equal(result.ok, false);
  assert.match(result.error, /可用积分为 0/u);
  assert.equal(result.status.points.phase, "depleted");
});

test("authorized desktop sessions auto-start the saved assistant and recover an unexpected gateway exit", async (t) => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wangzai-wechat-runtime-autostart-test-"));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  const desktopRoot = path.resolve(import.meta.dirname, "../..");
  let gatewayLive = false;
  let gatewaySpawns = 0;
  let currentGatewayChild = null;
  let latestGatewayEnvironment = null;

  function fakeChild({ gateway = false } = {}) {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.exitCode = null;
    child.kill = (signal = "SIGTERM") => {
      if (child.exitCode !== null) return true;
      child.exitCode = 0;
      if (gateway) gatewayLive = false;
      queueMicrotask(() => child.emit("exit", 0, signal));
      return true;
    };
    return child;
  }

  const runtime = createWechatAssistantRuntime({
    app: { isPackaged: false },
    safeStorage: testSafeStorage(),
    paths: { dataLayout: () => ({ dataRoot }), localApiDatabasePath: () => "unused.sqlite" },
    desktopRoot,
    workspaceRoot: path.resolve(desktopRoot, ".."),
    gatewayPort: 28791,
    autoRestartDelayMs: 5,
    channelRecoveryDelayMs: 5,
    channelRecoveryCooldownMs: 5,
    portProbe: async () => gatewayLive,
    spawnProcess: (_executable, args, options) => {
      const gateway = args.includes("gateway");
      const child = fakeChild({ gateway });
      if (gateway) {
        gatewaySpawns += 1;
        gatewayLive = true;
        currentGatewayChild = child;
        latestGatewayEnvironment = options.env;
      } else {
        throw new Error(`unexpected setup process: ${args.join(" ")}`);
      }
      return child;
    },
  });
  runtime.configure({
    executeModelRequest: async () => ({ ok: true }),
    executeBusinessRequest: async () => ({ ok: true }),
  });
  t.after(() => runtime.stop());

  const saved = await runtime.command({
    command: "save-settings",
    settings: {
      modelSource: "saved-api",
      modelAccountId: "saved-api-1",
      modelName: "custom-chat-model",
      toolAccessMode: "read-only",
    },
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.settings.autoStartEnabled, true);

  const pluginPath = path.join(desktopRoot, "openclaw-runtime", "node_modules", "@tencent-weixin", "openclaw-weixin");
  const pluginVersion = JSON.parse(fs.readFileSync(path.join(pluginPath, "package.json"), "utf8")).version;
  fs.mkdirSync(path.join(runtime.paths.stateDir, "state"), { recursive: true });
  fs.writeFileSync(path.join(runtime.paths.stateDir, "state", "openclaw.sqlite"), "");
  fs.writeFileSync(path.join(runtime.paths.root, "plugin-registration.json"), JSON.stringify({ pluginPath, pluginVersion }));
  fs.writeFileSync(path.join(runtime.paths.stateDir, "openclaw.json"), JSON.stringify({ stale: true }));

  const [automatic, manualStart] = await Promise.all([
    runtime.handleLicenseSession({ authorized: true, authorizationScope: "a".repeat(64) }),
    runtime.command({ command: "start" }),
  ]);
  assert.equal(automatic.ok, true);
  assert.equal(manualStart.ok, true);
  assert.equal(gatewaySpawns, 1);
  const runningStatus = await runtime.status();
  assert.equal(runningStatus.gateway.phase, "running");
  assert.equal(
    latestGatewayEnvironment.WANGZAI_OPENCLAW_MODEL_RELAY_URL,
    `http://127.0.0.1:${runningStatus.modelRelay.port}/v1`,
  );
  const refreshedConfig = JSON.parse(fs.readFileSync(path.join(runtime.paths.stateDir, "openclaw.json"), "utf8"));
  assert.equal(refreshedConfig.stale, undefined);
  assert.equal(refreshedConfig.models.providers.wangzaiAssistant.baseUrl, "${WANGZAI_OPENCLAW_MODEL_RELAY_URL}");
  assert.equal(refreshedConfig.mcp.servers["wangzai-readonly"].env.ELECTRON_RUN_AS_NODE, "1");
  const repeatedSnapshot = await runtime.handleLicenseSession({ authorized: true, authorizationScope: "a".repeat(64) });
  assert.equal(repeatedSnapshot.alreadyRunning, true);
  assert.equal(gatewaySpawns, 1);

  gatewayLive = false;
  currentGatewayChild.exitCode = 1;
  currentGatewayChild.emit("exit", 1, null);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(gatewaySpawns, 2);
  const recoveredStatus = await runtime.status();
  assert.equal(recoveredStatus.gateway.phase, "running");
  assert.equal(recoveredStatus.gateway.error, "");

  let finishModelRequest;
  runtime.configure({
    executeModelRequest: async () => new Promise((resolve) => {
      finishModelRequest = () => resolve({
        response: {
          model: "custom-chat-model",
          choices: [{ message: { role: "assistant", content: "完成" }, finish_reason: "stop" }],
        },
        channel: { source: "saved-api", model: "custom-chat-model", strategy: "single-saved-api" },
      });
    }),
  });
  const secureSettings = JSON.parse(fs.readFileSync(path.join(runtime.paths.root, "settings.secure.json"), "utf8"));
  const relayToken = latestGatewayEnvironment.WANGZAI_OPENCLAW_MODEL_RELAY_TOKEN;
  assert.notEqual(relayToken, testSafeStorage().decryptString(Buffer.from(secureSettings.encryptedRelayToken, "base64")));
  const modelRequest = fetch(`${recoveredStatus.modelRelay.running ? `http://127.0.0.1:${recoveredStatus.modelRelay.port}/v1` : ""}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${relayToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "custom-chat-model",
      messages: [{ role: "user", content: "汇总今日销售数据" }],
    }),
  });
  for (let attempt = 0; attempt < 20 && !finishModelRequest; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(typeof finishModelRequest, "function");
  currentGatewayChild.stderr.write("[openclaw-weixin] weixin getUpdates error (3/3): TypeError: fetch failed code=ETIMEDOUT\n");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(gatewaySpawns, 2);
  assert.equal((await runtime.status()).channelRecovery.phase, "waiting-safe-point");
  finishModelRequest();
  assert.equal((await modelRequest).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 320));
  assert.equal(gatewaySpawns, 3);
  const channelRecoveredStatus = await runtime.status();
  assert.equal(channelRecoveredStatus.channelRecovery.phase, "ready");
  assert.equal(channelRecoveredStatus.channelRecovery.attempt, 1);
  assert.ok(channelRecoveredStatus.channelRecovery.lastRecoveredAt);
  assert.equal(channelRecoveredStatus.modelChannel.phase, "ready");

  await runtime.handleLicenseSession({ authorized: false });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(gatewaySpawns, 3);
  assert.equal((await runtime.status()).gateway.phase, "stopped");
});

test("gateway automatically switches to an available loopback port when the preferred port is occupied", async (t) => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wangzai-wechat-runtime-port-test-"));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  const desktopRoot = path.resolve(import.meta.dirname, "../..");
  let runningPort = 0;
  let spawnedPort = 0;
  const runtime = createWechatAssistantRuntime({
    app: { isPackaged: false },
    safeStorage: testSafeStorage(),
    paths: { dataLayout: () => ({ dataRoot }), localApiDatabasePath: () => "unused.sqlite" },
    desktopRoot,
    workspaceRoot: path.resolve(desktopRoot, ".."),
    gatewayPort: 18791,
    allocateGatewayPort: async () => 29876,
    portProbe: async (port) => port === 18791 || port === runningPort,
    spawnProcess: (_executable, args) => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.exitCode = null;
      spawnedPort = Number(args[args.indexOf("--port") + 1]);
      runningPort = spawnedPort;
      child.kill = (signal = "SIGTERM") => {
        if (child.exitCode !== null) return true;
        child.exitCode = 0;
        runningPort = 0;
        queueMicrotask(() => child.emit("exit", 0, signal));
        return true;
      };
      return child;
    },
  });
  runtime.configure({ executeModelRequest: async () => ({ ok: true }) });
  t.after(() => runtime.stop());
  await runtime.command({
    command: "save-settings",
    settings: { modelSource: "saved-api", modelAccountId: "saved-api-1", modelName: "custom-chat-model" },
  });
  const pluginPath = path.join(desktopRoot, "openclaw-runtime", "node_modules", "@tencent-weixin", "openclaw-weixin");
  const pluginVersion = JSON.parse(fs.readFileSync(path.join(pluginPath, "package.json"), "utf8")).version;
  fs.mkdirSync(path.join(runtime.paths.stateDir, "state"), { recursive: true });
  fs.writeFileSync(path.join(runtime.paths.stateDir, "state", "openclaw.sqlite"), "");
  fs.writeFileSync(path.join(runtime.paths.root, "plugin-registration.json"), JSON.stringify({ pluginPath, pluginVersion }));

  const result = await runtime.handleLicenseSession({ authorized: true, authorizationScope: "a".repeat(64) });
  assert.equal(result.ok, true);
  assert.equal(spawnedPort, 29876);
  const currentStatus = await runtime.status();
  assert.equal(currentStatus.gateway.port, 29876);
  assert.equal(currentStatus.gateway.preferredPort, 18791);
  assert.match(currentStatus.logs.join("\n"), /已自动切换到本机端口 29876/u);
});

test("repeated authorized session snapshots respect the automatic-start failure cooldown", async (t) => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wangzai-wechat-runtime-cooldown-test-"));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  const desktopRoot = path.resolve(import.meta.dirname, "../..");
  let spawnAttempts = 0;
  const runtime = createWechatAssistantRuntime({
    app: { isPackaged: false },
    safeStorage: testSafeStorage(),
    paths: { dataLayout: () => ({ dataRoot }), localApiDatabasePath: () => "unused.sqlite" },
    desktopRoot,
    workspaceRoot: path.resolve(desktopRoot, ".."),
    gatewayPort: 28791,
    autoStartFailureCooldownMs: 60_000,
    portProbe: async () => false,
    spawnProcess: () => {
      spawnAttempts += 1;
      throw new Error("模拟启动失败");
    },
  });
  runtime.configure({ executeModelRequest: async () => ({ ok: true }) });
  t.after(() => runtime.stop());
  await runtime.command({
    command: "save-settings",
    settings: { modelSource: "saved-api", modelAccountId: "saved-api-1", modelName: "custom-chat-model" },
  });
  const pluginPath = path.join(desktopRoot, "openclaw-runtime", "node_modules", "@tencent-weixin", "openclaw-weixin");
  const pluginVersion = JSON.parse(fs.readFileSync(path.join(pluginPath, "package.json"), "utf8")).version;
  fs.mkdirSync(path.join(runtime.paths.stateDir, "state"), { recursive: true });
  fs.writeFileSync(path.join(runtime.paths.stateDir, "state", "openclaw.sqlite"), "");
  fs.writeFileSync(path.join(runtime.paths.root, "plugin-registration.json"), JSON.stringify({ pluginPath, pluginVersion }));

  const first = await runtime.handleLicenseSession({ authorized: true, authorizationScope: "a".repeat(64) });
  const repeated = await runtime.handleLicenseSession({ authorized: true, authorizationScope: "a".repeat(64) });
  assert.equal(first.ok, false);
  assert.equal(repeated.skipped, "failure-cooldown");
  assert.equal(spawnAttempts, 1);
  const currentStatus = await runtime.status();
  assert.ok(currentStatus.gateway.automaticRetryAt);
  assert.equal(currentStatus.logs.filter((line) => line.includes("自动启动失败")).length, 1);
  await runtime.handleLicenseSession({ authorized: false });
});
