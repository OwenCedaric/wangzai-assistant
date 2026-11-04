import assert from "node:assert/strict";
import {
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createProcessSupervisor,
  redactProcessLogText,
} from "./processSupervisor.js";

test("process supervisor redacts credentials before serialized diagnostic persistence", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "wangzai-process-log-"));
  const logDirectory = path.join(root, "logs");
  mkdirSync(logDirectory, { recursive: true });
  try {
    const supervisor = createProcessSupervisor({ getLogDirectory: () => logDirectory });
    supervisor.appendLog(
      "local-api",
      'authorization=Bearer abcdefghijklmnop apiKey="raw-api-secret" password=hunter2\n',
    );
    supervisor.appendLog("local-api", "owner=shop-a status=ok\n");
    supervisor.appendLog("local-cache-agent-v2", "cache agent ready\n");
    supervisor.appendLog("desktop-renderer", 'console password=renderer-secret\n');
    supervisor.appendLog("wechat-assistant", "wechat assistant ready\n");
    await supervisor.flushLogs();
    const persisted = readFileSync(path.join(logDirectory, "local-api.log"), "utf8");
    assert.equal(persisted.includes("abcdefghijklmnop"), false);
    assert.equal(persisted.includes("raw-api-secret"), false);
    assert.equal(persisted.includes("hunter2"), false);
    assert.match(persisted, /authorization=\[REDACTED\]/u);
    assert.match(persisted, /apiKey="\[REDACTED\]"/u);
    assert.match(persisted, /password=\[REDACTED\]/u);
    assert.match(persisted, /owner=shop-a status=ok/u);
    const cacheAgentPersisted = readFileSync(path.join(logDirectory, "local-cache-agent-v2.log"), "utf8");
    assert.match(cacheAgentPersisted, /cache agent ready/u);
    const rendererPersisted = readFileSync(path.join(logDirectory, "desktop-renderer.log"), "utf8");
    assert.equal(rendererPersisted.includes("renderer-secret"), false);
    assert.match(rendererPersisted, /password=\[REDACTED\]/u);
    const wechatAssistantPersisted = readFileSync(path.join(logDirectory, "wechat-assistant.log"), "utf8");
    assert.match(wechatAssistantPersisted, /wechat assistant ready/u);
    assert.throws(() => supervisor.appendLog("unregistered-child", "secret=value"), /DESKTOP_PROCESS_LOG_NAME_INVALID/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("process log redaction removes private keys, JWTs, and encrypted secret envelopes", () => {
  const source = [
    "-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----",
    "eyJabcdefgh.ijklmnopq.rstuvwxyz",
    "secretbox:v1:nonce_material:tag_material:cipher_material",
  ].join("\n");
  const redacted = redactProcessLogText(source);
  assert.equal(redacted.includes("private-material"), false);
  assert.equal(redacted.includes("eyJabcdefgh"), false);
  assert.equal(redacted.includes("cipher_material"), false);
});

test("process supervisor keeps a bounded redacted startup diagnostic in memory", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "wangzai-process-diagnostic-"));
  const logDirectory = path.join(root, "logs");
  mkdirSync(logDirectory, { recursive: true });
  try {
    const supervisor = createProcessSupervisor({ getLogDirectory: () => logDirectory });
    const fixturePath = path.join(root, "child-fixture.cjs");
    writeFileSync(fixturePath, 'console.log("child ready");\n', "utf8");
    const child = supervisor.spawnElectronNodeScript(
      "local-api",
      fixturePath,
      {
        cwd: root,
        env: {
          WANGZAI_DIAGNOSTIC_FIXTURE: "1",
        },
      },
    );
    await new Promise((resolve) => child.once("exit", resolve));
    await supervisor.flushLogs();
    const diagnostic = supervisor.getChildDiagnostic("local-api");
    assert.equal(diagnostic.status, "exited");
    assert.equal(diagnostic.exitCode, 0);
    assert.match(diagnostic.recentOutput, /exited code=0/u);
    assert.ok(diagnostic.recentOutput.length <= 8_192);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("process logs rotate cleanly through more than ten write cycles", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "wangzai-process-log-rotation-"));
  const logDirectory = path.join(root, "logs");
  mkdirSync(logDirectory, { recursive: true });
  try {
    const supervisor = createProcessSupervisor({
      getLogDirectory: () => logDirectory,
      maxLogFileBytes: 256,
      logRotationCount: 3,
    });
    for (let index = 0; index < 12; index += 1) {
      supervisor.appendLog("desktop-main", `${index}:${"x".repeat(90)}\n`);
    }
    await supervisor.flushLogs();
    assert.equal(existsSync(path.join(logDirectory, "desktop-main.log")), true);
    assert.equal(existsSync(path.join(logDirectory, "desktop-main.log.1")), true);
    assert.equal(existsSync(path.join(logDirectory, "desktop-main.log.3")), true);
    assert.equal(existsSync(path.join(logDirectory, "desktop-main.log.4")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("one oversized process log chunk cannot bypass the byte and rotation limits", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "wangzai-process-large-log-"));
  try {
    const supervisor = createProcessSupervisor({
      getLogDirectory: () => root,
      maxLogFileBytes: 256,
      logRotationCount: 3,
    });
    supervisor.appendLog("desktop-main", `${"日志🙂".repeat(500)} latest-marker\n`);
    await supervisor.flushLogs();
    const files = readdirSync(root).filter(name => name.startsWith("desktop-main.log"));
    assert.equal(files.length, 4);
    for (const name of files) {
      assert.ok(statSync(path.join(root, name)).size <= 256, `${name} exceeded the byte budget`);
      assert.doesNotMatch(readFileSync(path.join(root, name), "utf8"), /\uFFFD/u);
    }
    assert.match(readFileSync(path.join(root, "desktop-main.log"), "utf8"), /latest-marker/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("large process log writes retain redaction across file boundaries and preserve other files", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "wangzai-process-large-secret-log-"));
  try {
    writeFileSync(path.join(root, "keep-evidence.log"), "keep existing evidence");
    const supervisor = createProcessSupervisor({
      getLogDirectory: () => root,
      maxLogFileBytes: 256,
      logRotationCount: 2,
    });
    supervisor.appendLog("local-api", "initial\n");
    supervisor.appendLog("local-api", `${'apiKey="fixture-only-secret"\n'.repeat(50)}tail\n`);
    await supervisor.flushLogs();
    const files = readdirSync(root).filter(name => name.startsWith("local-api.log"));
    assert.equal(files.length, 3);
    for (const name of files) {
      assert.ok(statSync(path.join(root, name)).size <= 256);
      assert.equal(readFileSync(path.join(root, name), "utf8").includes("fixture-only-secret"), false);
    }
    assert.equal(readFileSync(path.join(root, "keep-evidence.log"), "utf8"), "keep existing evidence");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("process log write errors do not reject shutdown or poison later diagnostic writes", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "wangzai-process-log-error-"));
  try {
    const blockedDirectory = path.join(root, "not-a-directory");
    writeFileSync(blockedDirectory, "keep fixture");
    let logDirectory = blockedDirectory;
    const supervisor = createProcessSupervisor({ getLogDirectory: () => logDirectory });
    await assert.doesNotReject(supervisor.appendLog("desktop-main", "cannot persist here\n"));
    logDirectory = root;
    await assert.doesNotReject(supervisor.appendLog("desktop-main", "logging recovered\n"));
    await assert.doesNotReject(supervisor.stopChildProcesses());
    assert.equal(readFileSync(blockedDirectory, "utf8"), "keep fixture");
    assert.match(readFileSync(path.join(root, "desktop-main.log"), "utf8"), /logging recovered/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid process log limits are rejected before any file can be touched", () => {
  const getLogDirectory = () => { throw new Error("must not resolve a log path"); };
  for (const maxLogFileBytes of [0, 1, -1, NaN, Infinity, 1.5]) {
    assert.throws(() => createProcessSupervisor({ getLogDirectory, maxLogFileBytes }), /BYTE_LIMIT_INVALID/u);
  }
  for (const logRotationCount of [0, -1, NaN, Infinity, 1.5, 11]) {
    assert.throws(() => createProcessSupervisor({ getLogDirectory, logRotationCount }), /ROTATION_COUNT_INVALID/u);
  }
});

test("process log rotation refuses junction directories and linked managed paths without following them", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "wangzai-process-log-links-"));
  try {
    const outside = path.join(root, "outside-fixture");
    const direct = path.join(root, "direct");
    const junction = path.join(root, "junction");
    mkdirSync(outside);
    mkdirSync(direct);
    const protectedFile = path.join(outside, "desktop-main.log");
    writeFileSync(protectedFile, "preserve linked fixture");
    symlinkSync(outside, junction, process.platform === "win32" ? "junction" : "dir");
    const throughJunction = createProcessSupervisor({ getLogDirectory: () => junction });
    await assert.doesNotReject(throughJunction.appendLog("desktop-main", "must not follow\n"));
    assert.equal(readFileSync(protectedFile, "utf8"), "preserve linked fixture");

    linkSync(protectedFile, path.join(direct, "desktop-main.log"));
    const throughHardLink = createProcessSupervisor({ getLogDirectory: () => direct });
    await assert.doesNotReject(throughHardLink.appendLog("desktop-main", "must not append\n"));
    assert.equal(readFileSync(protectedFile, "utf8"), "preserve linked fixture");

    symlinkSync(outside, path.join(direct, "local-api.log.1"), process.platform === "win32" ? "junction" : "dir");
    await assert.doesNotReject(throughHardLink.appendLog("local-api", "must not rotate a linked slot\n"));
    assert.equal(existsSync(path.join(direct, "local-api.log")), false);
    assert.equal(readFileSync(protectedFile, "utf8"), "preserve linked fixture");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
