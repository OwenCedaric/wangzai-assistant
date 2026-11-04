import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { withManagedDevScratch } from "../../../tools/managed-dev-scratch.mjs";
import { createWechatAssistantRuntime } from "./wechatAssistantRuntime.js";

const desktopRoot = path.resolve(import.meta.dirname, "../..");
const workspaceRoot = path.resolve(desktopRoot, "..");
const runtimeDist = path.join(desktopRoot, "openclaw-runtime/node_modules/openclaw/dist");

async function installedMcpResolver() {
  const file = fs.readdirSync(runtimeDist).find((name) => /^agent-bundle-mcp-runtime-.*\.js$/u.test(name));
  assert.ok(file, "installed OpenClaw MCP transport implementation is required");
  const exports = await import(pathToFileURL(path.join(runtimeDist, file)).href);
  const resolver = Object.values(exports).find((value) => typeof value === "function" && value.name === "resolveMcpTransportConfig");
  assert.equal(typeof resolver, "function", "use the installed resolver, not a timeout-unit mock");
  return resolver;
}

test("installed MCP resolver treats legacy timeout aliases as seconds and canonical fields as milliseconds", async () => {
  const resolve = await installedMcpResolver();
  for (const requestMs of [30_000, 130_000]) {
    const server = { command: process.execPath, args: ["synthetic-mcp.mjs"] };
    const legacy = resolve("synthetic", { ...server, connectTimeout: 20_000, timeout: requestMs });
    assert.equal(legacy.connectionTimeoutMs, 20_000_000);
    assert.equal(legacy.requestTimeoutMs, requestMs * 1000);
    const canonical = resolve("synthetic", { ...server, connectionTimeoutMs: 20_000, requestTimeoutMs: requestMs });
    assert.equal(canonical.connectionTimeoutMs, 20_000);
    assert.equal(canonical.requestTimeoutMs, requestMs);
  }
});

test("desktop writes 20s connection and 30s/130s request limits without changing MCP targets or permissions", async () => {
  const resolve = await installedMcpResolver();
  await withManagedDevScratch({ workspaceRoot, purpose: "test-scratch" }, async (lease) => {
    const dataRoot = path.join(lease.directory, "synthetic-profile");
    fs.mkdirSync(dataRoot);
    const runtime = createWechatAssistantRuntime({
      app: { isPackaged: false },
      safeStorage: { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(value), decryptString: (value) => value.toString() },
      paths: { dataLayout: () => ({ dataRoot }), localApiDatabasePath: () => path.join(dataRoot, "must-not-open.sqlite") },
      desktopRoot,
      workspaceRoot,
      spawnProcess() { throw new Error("TIMEOUT_TEST_MUST_NOT_START_GATEWAY_OR_LOGIN"); },
    });
    try {
      runtime.configure({
        executeModelRequest: async () => { throw new Error("NO_MODEL_REQUEST_ALLOWED"); },
        executeBusinessRequest: async () => { throw new Error("NO_BUSINESS_REQUEST_ALLOWED"); },
        getPointsWallet: async () => ({ balancePoints: 100, reservedPoints: 0, availablePoints: 100, checkedAt: new Date().toISOString() }),
      });
      const saved = await runtime.command({ command: "save-settings", settings: { modelSource: "builtin-points", modelName: "timeout-fixture-model", toolAccessMode: "direct-write", allowedOperationActions: ["products:product.updatePrice"], autoStartEnabled: false } });
      assert.equal(saved.ok, true);
      const config = JSON.parse(fs.readFileSync(path.join(dataRoot, "wechat-assistant/openclaw-state/openclaw.json"), "utf8"));
      for (const [name, requestMs] of [["wangzai-readonly", 30_000], ["wangzai-operations", 130_000]]) {
        const server = config.mcp.servers[name];
        assert.equal(server.connectionTimeoutMs, 20_000);
        assert.equal(server.requestTimeoutMs, requestMs);
        assert.equal(Object.hasOwn(server, "connectTimeout"), false);
        assert.equal(Object.hasOwn(server, "timeout"), false);
        const effective = resolve(name, server);
        assert.equal(effective.connectionTimeoutMs, 20_000);
        assert.equal(effective.requestTimeoutMs, requestMs);
        assert.equal(server.command, process.execPath);
        assert.equal(path.basename(server.args[0]), name + "-mcp.mjs");
        assert.equal(server.supportsParallelToolCalls, false);
      }
      assert.deepEqual(config.plugins.allow, ["openclaw-weixin"]);
      assert.deepEqual(config.channels, { "openclaw-weixin": { replyProgressMessages: false } });
      assert.equal(config.models.providers.wangzaiAssistant.baseUrl, "${WANGZAI_OPENCLAW_MODEL_RELAY_URL}");
      assert.equal(config.agents.defaults.model.primary, "wangzaiAssistant/timeout-fixture-model");
      assert.equal(config.agents.defaults.compaction.reserveTokensFloor, 24576);
      assert.deepEqual(config.tools.deny, ["write", "edit", "apply_patch", "exec", "process"]);
      assert.deepEqual(saved.settings.allowedOperationActions, ["products:product.updatePrice"]);
      assert.equal(fs.existsSync(path.join(dataRoot, "must-not-open.sqlite")), false);
    } finally { await runtime.stop(); }
  });
});
