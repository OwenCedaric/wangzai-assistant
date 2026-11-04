import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(currentDirectory, "..");
const electronExecutable = path.join(
  desktopRoot,
  "node_modules",
  "electron",
  "dist",
  process.platform === "win32" ? "electron.exe" : "electron",
);
const phaseTimeoutMs = 90_000;
const includeBadInput = process.env.WANGZAI_LEGACY_RETIREMENT_INCLUDE_BAD === "1";
const includeFailureInjection = process.env.WANGZAI_LEGACY_RETIREMENT_INCLUDE_FAILURES === "1";
const includeMaximumFixture = process.env.WANGZAI_LEGACY_RETIREMENT_INCLUDE_MAX === "1";
const includeRecoveryFixture = process.env.WANGZAI_LEGACY_RETIREMENT_INCLUDE_RECOVERY === "1";
const keepIsolatedDataRoot = process.env.WANGZAI_LEGACY_RETIREMENT_KEEP_DATA === "1";
const MARKETING_ACTIVITY_CACHE_FIXTURE_ID = "marketing-activity-cache";
const MARKETING_FILE_SOURCE_PHASES = new Set([
  "seed",
  "bad",
  "write-error",
  "readback-error",
  "max",
  "recovery-failure",
]);
// All browser retirement keys are removed. Fixtures are retained only for
// historical explicit diagnostics; the default production verification must
// not seed retired browser values back into an isolated renderer.
const defaultFixtureIds = [];
const requestedFixtureIds = String(process.env.WANGZAI_LEGACY_RETIREMENT_FIXTURE_IDS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const fixtureIds = requestedFixtureIds.length > 0 ? requestedFixtureIds : defaultFixtureIds;

function normalizedLegacyKeyList(values) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean),
  )].sort();
}

function sameLegacyKeyList(left, right) {
  const normalizedLeft = normalizedLegacyKeyList(left);
  const normalizedRight = normalizedLegacyKeyList(right);
  return normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

function getRecoveryRestartCapability() {
  // Every listed fixture now has a canonical SQLite/profile-core reader.  A
  // recovery restart always gets a newly created empty local-data directory,
  // so this capability must never silently exempt a JSON-backed fixture.
  return Object.freeze({
    eligible: true,
    reason: "SQLITE_CANONICAL_READBACK",
  });
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function writeJson(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

/**
 * Test-only loopback implementation of the opaque recovery remote. It stores
 * only encrypted bytes plus opaque generation metadata. It records boolean
 * privacy assertions for both persisted object bytes and generation payloads;
 * plaintext fixture values, passphrases and capability tokens never reach test
 * logs. The expected bearer token is used only to authenticate the request and
 * is neither persisted nor echoed by this fixture remote.
 */
function createOpaqueRecoveryRemote({ accessToken }) {
  const objects = new Map();
  const generations = new Map();
  const plaintextMarkers = [
    "legacy-retirement-recovery-anchor",
    "test-legacy-retirement-recovery-api-key",
    "legacy-retirement-isolated-recovery-passphrase",
    "legacy-retirement-isolated-recovery-token",
  ];
  let plaintextMarkerObserved = false;
  const server = createHttpServer(async (request, response) => {
    try {
      if (request.headers.authorization !== `Bearer ${accessToken}`) {
        writeJson(response, 401, { error: "unauthorized" });
        return;
      }
      const url = new URL(request.url || "/", "http://127.0.0.1");
      const objectMatch = url.pathname.match(/^\/api\/recovery\/objects\/([A-Za-z0-9_-]+)$/u);
      if (request.method === "PUT" && objectMatch) {
        const bytes = await readRequestBody(request);
        const cipherSha256 = createHash("sha256").update(bytes).digest("hex");
        const cipherBytes = Number(request.headers["x-recovery-cipher-bytes"]);
        if (cipherSha256 !== request.headers["x-recovery-cipher-sha256"] || cipherBytes !== bytes.length) {
          writeJson(response, 400, { error: "cipher mismatch" });
          return;
        }
        plaintextMarkerObserved ||= plaintextMarkers.some((marker) => bytes.includes(Buffer.from(marker)));
        objects.set(objectMatch[1], bytes);
        writeJson(response, 200, { chunk_id: objectMatch[1], cipher_bytes: bytes.length, reused: false });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/recovery/generations") {
        writeJson(response, 200, [...generations.values()].map(({ object_refs: _refs, ...generation }) => generation));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/recovery/generations") {
        const commitText = (await readRequestBody(request)).toString("utf8");
        plaintextMarkerObserved ||= plaintextMarkers.some((marker) => commitText.includes(marker));
        const commit = JSON.parse(commitText);
        const active = [...generations.values()].find((item) => item.scope_key === commit.scope_key) || null;
        if ((active?.generation_id || null) !== (commit.expected_generation_id || null)) {
          writeJson(response, 409, { error: "generation conflict" });
          return;
        }
        const generationId = `legacy_retirement_generation_${String(generations.size + 1).padStart(6, "0")}`;
        const generation = {
          generation_id: generationId,
          scope_key: commit.scope_key,
          key_envelope: commit.key_envelope,
          manifest_chunk_id: commit.manifest_chunk_id,
          logical_cipher_bytes: commit.logical_cipher_bytes,
          object_refs: commit.object_refs,
        };
        if (active) generations.delete(active.generation_id);
        generations.set(generationId, generation);
        writeJson(response, 201, generation);
        return;
      }
      const generationMatch = url.pathname.match(/^\/api\/recovery\/generations\/([A-Za-z0-9_-]+)$/u);
      if (request.method === "GET" && generationMatch) {
        const generation = generations.get(generationMatch[1]);
        if (!generation) {
          writeJson(response, 404, { error: "missing" });
          return;
        }
        writeJson(response, 200, generation);
        return;
      }
      const downloadMatch = url.pathname.match(/^\/api\/recovery\/generations\/([A-Za-z0-9_-]+)\/objects\/([A-Za-z0-9_-]+)$/u);
      if (request.method === "GET" && downloadMatch) {
        const generation = generations.get(downloadMatch[1]);
        const ref = generation?.object_refs?.find((item) => item.chunk_id === downloadMatch[2]);
        const bytes = ref ? objects.get(downloadMatch[2]) : null;
        if (!bytes || !ref) {
          writeJson(response, 404, {
            error: `missing-generation-${Boolean(generation)}-ref-${Boolean(ref)}-object-${Boolean(bytes)}-generations-${generations.size}-requested-${downloadMatch[1]}-keys-${[...generations.keys()].join(',')}`,
          });
          return;
        }
        response.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "X-Recovery-Cipher-Sha256": ref.cipher_sha256,
          "X-Recovery-Cipher-Bytes": String(ref.cipher_bytes),
        });
        response.end(bytes);
        return;
      }
      writeJson(response, 404, { error: "route missing" });
    } catch {
      writeJson(response, 500, { error: "opaque remote failed" });
    }
  });
  return {
    server,
    getSummary: () => ({
      generationCount: generations.size,
      encryptedObjectCount: objects.size,
      plaintextMarkersAbsent: !plaintextMarkerObserved,
    }),
  };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function cleanupIsolatedDataRoot(dataRoot) {
  if (keepIsolatedDataRoot) {
    console.error(`[legacy-retirement] 保留隔离资料根用于故障诊断：${dataRoot}`);
    return;
  }
  await fs.rm(dataRoot, { recursive: true, force: true }).catch(() => undefined);
}

function isDescendantPath(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

async function readDirectoryEntries(directory) {
  try {
    return await fs.readdir(directory);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

/**
 * `WANGZAI_DESKTOP_LOCAL_DATA_DIR` must remain inside the Electron profile.
 * Create an explicit directory per test group so a phase can deliberately
 * reuse it (normal restart evidence) or require a fresh one (recovery restart
 * evidence) without accidentally falling back to `<userData>/本地数据`.
 */
async function createEmptyPhaseLocalDataDirectory(dataRoot, label) {
  const resolvedDataRoot = path.resolve(dataRoot);
  const parentDirectory = path.join(resolvedDataRoot, ".legacy-retirement-local-data");
  await fs.mkdir(parentDirectory, { recursive: true });
  const safeLabel = String(label || "phase").replaceAll(/[^a-z0-9-]/giu, "-");
  const localDataDir = await fs.mkdtemp(path.join(parentDirectory, `${safeLabel}-`));
  if (!isDescendantPath(resolvedDataRoot, localDataDir)) {
    throw new Error(`旧浏览器副本退役 local-data 目录越出隔离 profile：${localDataDir}`);
  }
  const entries = await readDirectoryEntries(localDataDir);
  if (entries.length) {
    throw new Error(`旧浏览器副本退役新建 local-data 目录并非空目录：${localDataDir}`);
  }
  return localDataDir;
}

async function verifyPhaseLocalDataDirectory({ dataRoot, localDataDir, requireEmptyAtStart = false }) {
  if (!localDataDir) throw new Error("旧浏览器副本退役阶段缺少显式 local-data 目录。");
  if (!isDescendantPath(dataRoot, localDataDir)) {
    throw new Error(`旧浏览器副本退役 local-data 目录不在隔离 profile 内：${localDataDir}`);
  }
  const entries = await readDirectoryEntries(localDataDir);
  const emptyAtStart = entries.length === 0;
  if (requireEmptyAtStart && !emptyAtStart) {
    throw new Error(`旧浏览器副本退役阶段要求全新空 local-data 目录：${localDataDir}`);
  }
  return emptyAtStart;
}

async function terminateChildTree(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const killer = spawn(
        "taskkill",
        ["/pid", String(child.pid), "/t", "/f"],
        {
          stdio: "ignore",
          windowsHide: true,
        },
      );
      killer.once("exit", resolve);
      killer.once("error", resolve);
    });
    return;
  }
  child.kill("SIGTERM");
}

function runElectronPhase({
  phase,
  fixtureId,
  dataRoot,
  localDataDir,
  localApiPort,
  bridgePort,
  recoveryRemote = null,
}) {
  return new Promise((resolve, reject) => {
    const shouldSeedMarketingFile =
      fixtureId === MARKETING_ACTIVITY_CACHE_FIXTURE_ID &&
      MARKETING_FILE_SOURCE_PHASES.has(phase);
    const child = spawn(electronExecutable, [".", "--legacy-retirement-test"], {
      cwd: desktopRoot,
      env: {
        ...process.env,
        WANGZAI_DESKTOP_DATA_DIR: dataRoot,
        WANGZAI_DESKTOP_LOCAL_DATA_DIR: localDataDir,
        WANGZAI_LEGACY_RETIREMENT_PHASE: phase,
        WANGZAI_LEGACY_RETIREMENT_FIXTURE_ID: fixtureId,
        LOCAL_API_PORT: String(localApiPort),
        PURCHASE_SEARCH_BRIDGE_PORT: String(bridgePort),
        LOCAL_API_DB_PATH: "",
        LOCAL_API_SECRET_FILE: "",
        // The main process accepts this only for the marketing fixture's source
        // phases. Explicitly override any caller environment in every other
        // phase so a restart can never manufacture a retired JSON source.
        WANGZAI_LEGACY_RETIREMENT_SEED_MARKETING_FILE: shouldSeedMarketingFile ? "1" : "0",
        ...(recoveryRemote
          ? {
            WANGZAI_LEGACY_RETIREMENT_RECOVERY_REMOTE_URL: recoveryRemote.baseUrl,
            WANGZAI_LEGACY_RETIREMENT_RECOVERY_REMOTE_TOKEN: recoveryRemote.accessToken,
          }
          : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timeoutMs = phase === "recovery-failure" ? 180_000 : phaseTimeoutMs;
    const timer = setTimeout(async () => {
      await terminateChildTree(child);
      settle(
        reject,
        new Error(
          `旧浏览器副本退役 Electron ${phase} 阶段超时。stdout=${stdout.slice(-1200)} stderr=${stderr.slice(-1200)}`,
        ),
      );
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => settle(reject, error));
    child.once("exit", (code, signal) =>
      settle(resolve, { code, signal, stdout, stderr }),
    );
  });
}

function readPhaseRecord(log, phase, fixtureId) {
  const marker = "[legacy-retirement] ";
  const line = log
    .split(/\r?\n/u)
    .reverse()
    .find(
      (item) =>
        item.includes(marker) &&
        item.includes(`\"fixtureId\":\"${fixtureId}\"`) &&
        item.includes(`\"phase\":\"${phase}\"`),
    );
  if (!line)
    throw new Error(
      `未找到 ${phase} 阶段的旧浏览器副本退役记录。${log.slice(-4000)}`,
    );
  return JSON.parse(line.slice(line.indexOf(marker) + marker.length));
}

async function verifyPhase({
  phase,
  fixtureId,
  dataRoot,
  localDataDir,
  requireEmptyLocalDataAtStart = false,
  recoveryRemote = null,
}) {
  const localDataEmptyAtStart = await verifyPhaseLocalDataDirectory({
    dataRoot,
    localDataDir,
    requireEmptyAtStart: requireEmptyLocalDataAtStart,
  });
  const [localApiPort, bridgePort] = await Promise.all([
    findFreePort(),
    findFreePort(),
  ]);
  const result = await runElectronPhase({
    phase,
    fixtureId,
    dataRoot,
    localDataDir,
    localApiPort,
    bridgePort,
    recoveryRemote,
  });
  const mainLog = await fs
    .readFile(path.join(dataRoot, "logs", "desktop-main.log"), "utf8")
    .catch(() => "");
  const rendererLog = await fs
    .readFile(path.join(dataRoot, "logs", "desktop-renderer.log"), "utf8")
    .catch(() => "");
  if (result.code !== 0) {
    throw new Error(
      `旧浏览器副本退役 Electron ${phase} 阶段失败：exit=${result.code} signal=${result.signal || ""}\n${mainLog.slice(-4000)}\n${rendererLog.slice(-4000)}\n${result.stderr.slice(-2000)}`,
    );
  }
  const record = readPhaseRecord(mainLog, phase, fixtureId);
  const expectsRetention = ["bad", "write-error", "readback-error", "recovery-failure"].includes(phase);
  const isMarketingFixture = fixtureId === MARKETING_ACTIVITY_CACHE_FIXTURE_ID;
  const marketingFileSourcePhase =
    isMarketingFixture && MARKETING_FILE_SOURCE_PHASES.has(phase);
  const marketingFileRestartPhase =
    isMarketingFixture && ["restart", "max-restart", "recovery-restart"].includes(phase);
  const marketingFile = record.legacyMarketingFile;
  if (isMarketingFixture) {
    if (
      !marketingFile ||
      typeof marketingFile.seeded !== "boolean" ||
      typeof marketingFile.existsAtPhaseStart !== "boolean" ||
      typeof marketingFile.exists !== "boolean"
    ) {
      throw new Error(`旧浏览器副本退役 ${phase} 缺少营销旧 JSON 文件证据：${JSON.stringify(record)}`);
    }
    if (
      marketingFileSourcePhase &&
      (marketingFile.seeded !== true || marketingFile.existsAtPhaseStart !== true)
    ) {
      throw new Error(`旧浏览器副本退役 ${phase} 未在启动前写入营销旧 JSON 文件：${JSON.stringify(record)}`);
    }
    if (
      marketingFileRestartPhase &&
      (marketingFile.seeded !== false || marketingFile.existsAtPhaseStart !== false)
    ) {
      throw new Error(`旧浏览器副本退役 ${phase} 错误重建或复用了营销旧 JSON 文件：${JSON.stringify(record)}`);
    }
    if (marketingFile.exists !== expectsRetention) {
      throw new Error(
        `旧浏览器副本退役 ${phase} 营销旧 JSON 文件清理/保留断言失败：${JSON.stringify(record)}`,
      );
    }
  }
  const fault = record.fault || {};
  const declaredRecoveryRetainedKeys = normalizedLegacyKeyList(record.declaredRecoveryRetainedKeys);
  const requiredLegacyEntryKeys = normalizedLegacyKeyList(record.requiredLegacyEntryKeys);
  const unexpectedRetainedLegacyKeys = normalizedLegacyKeyList(record.unexpectedRetainedLegacyKeys);
  const requiresExplicitTargetRetention =
    ["write-error", "readback-error", "recovery-failure"].includes(phase) &&
    declaredRecoveryRetainedKeys.length > 0;
  const explicitTargetRetentionVerified = !requiresExplicitTargetRetention || (
    record.retentionScope === "explicit-target" &&
    sameLegacyKeyList(requiredLegacyEntryKeys, declaredRecoveryRetainedKeys) &&
    Array.isArray(record.unexpectedRetainedLegacyKeys) &&
    unexpectedRetainedLegacyKeys.length === 0
  );
  if (
    expectsRetention
      ? (
        !record.requiredLegacyEntryCount ||
        record.requiredLegacyRetainedCount !== record.requiredLegacyEntryCount ||
        record.canonicalPresent ||
        !explicitTargetRetentionVerified
      )
      : (record.legacyPresent || !record.canonicalPresent)
  ) {
    throw new Error(
      `旧浏览器副本退役 ${phase} 阶段断言失败：${JSON.stringify(record)}`,
    );
  }
  if (phase === "recovery-failure") {
    const recovery = record.recovery || {};
    if (
      recovery.generationCreated !== true ||
      recovery.stagedGenerationCount < 1 ||
      recovery.restagedGenerationCount < 1 ||
      recovery.failureActivationObserved !== true ||
      recovery.successfulActivationObserved !== true ||
      recovery.requiredLegacyCount !== record.requiredLegacyEntryCount ||
      recovery.legacyRetainedAfterFailedActivation !== record.requiredLegacyEntryCount ||
      recovery.canonicalBeforeRecovery?.canonicalPresent !== true ||
      recovery.canonicalBeforeRecovery?.legacyRetainedCount !== record.requiredLegacyEntryCount ||
      recovery.canonicalAfterActivation?.canonicalPresent !== true ||
      recovery.canonicalAfterActivation?.legacyRetainedCount !== record.requiredLegacyEntryCount ||
      fault.mode !== "recovery-failure" ||
      fault.targetConfigured !== true ||
      fault.targetWriteSucceeded < 1 ||
      fault.targetReadAttempted < 1 ||
      fault.targetReadRejected < 1 ||
      fault.recoveryActivationRejected !== 1 ||
      fault.recoveryActivationAttempted < 2 ||
      fault.recoveryCanonicalReadbackEnabled !== true
    ) {
      throw new Error(`旧浏览器副本退役 recovery-failure 没有完成真实 staging/回滚证据：${JSON.stringify(record)}`);
    }
  }
  if (
    ["max", "max-restart"].includes(phase) &&
    record.maxVerification?.verified !== true
  ) {
    throw new Error(
      `旧浏览器副本退役 ${phase} 阶段没有完成最大量全量回读：${JSON.stringify(record)}`,
    );
  }
  if (
    phase === "write-error" &&
    (
      fault.mode !== phase ||
      fault.targetConfigured !== true ||
      fault.targetWriteAttempted < 1 ||
      fault.targetWriteRejected < 1
    )
  ) {
    throw new Error(`旧浏览器副本退役 write-error 没有拦截 fixture canonical 写入：${JSON.stringify(record)}`);
  }
  if (
    phase === "readback-error" &&
    (
      fault.mode !== phase ||
      fault.targetConfigured !== true ||
      fault.targetWriteSucceeded < 1 ||
      fault.targetReadAttempted < 1 ||
      fault.targetReadRejected < 1
    )
  ) {
    throw new Error(`旧浏览器副本退役 readback-error 没有完成 canonical 写入后回读失败：${JSON.stringify(record)}`);
  }
  if (
    phase === "recovery-restart" &&
    (
      localDataEmptyAtStart !== true ||
      fault.mode !== "" ||
      record.canonicalPresent !== true ||
      record.legacyPresent !== false ||
      Number(record.browserLegacyClearCount || 0) < Number(record.legacyEntryCount || 0)
    )
  ) {
    throw new Error(`旧浏览器副本退役 recovery-restart 未在空 local-data / 清空浏览器旧副本条件下完成 canonical 回读：${JSON.stringify(record)}`);
  }
  return {
    fixtureId,
    phase,
    legacyPresent: record.legacyPresent,
    legacyEntryCount: record.legacyEntryCount,
    legacyRetainedCount: record.legacyRetainedCount,
    requiredLegacyEntryCount: record.requiredLegacyEntryCount,
    requiredLegacyRetainedCount: record.requiredLegacyRetainedCount,
    retentionScope: String(record.retentionScope || ""),
    declaredRecoveryRetainedKeys,
    requiredLegacyEntryKeys,
    unexpectedRetainedLegacyKeys,
    canonicalPresent: record.canonicalPresent,
    responseStatus: record.responseStatus,
    browserLegacyClearCount: Number(record.browserLegacyClearCount || 0),
    localData: {
      explicit: true,
      emptyAtStart: localDataEmptyAtStart,
    },
    legacyMarketingFile: isMarketingFixture
      ? {
        seeded: marketingFile.seeded,
        existsAtPhaseStart: marketingFile.existsAtPhaseStart,
        exists: marketingFile.exists,
      }
      : null,
    maxVerification: record.maxVerification || null,
    fault,
    recovery: record.recovery || null,
  };
}

async function verifyFixture(fixtureId) {
  const dataRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "wangzai-legacy-retirement-"),
  );
  try {
    const localDataDir = await createEmptyPhaseLocalDataDirectory(dataRoot, "seed-restart");
    const seed = await verifyPhase({
      phase: "seed",
      fixtureId,
      dataRoot,
      localDataDir,
      requireEmptyLocalDataAtStart: true,
    });
    const restart = await verifyPhase({
      phase: "restart",
      fixtureId,
      dataRoot,
      localDataDir,
    });
    return { fixtureId, phases: [seed, restart] };
  } finally {
    await cleanupIsolatedDataRoot(dataRoot);
  }
}

async function verifyBadFixture(fixtureId) {
  const dataRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "wangzai-legacy-retirement-bad-"),
  );
  try {
    const localDataDir = await createEmptyPhaseLocalDataDirectory(dataRoot, "bad");
    return {
      fixtureId,
      phases: [await verifyPhase({
        phase: "bad",
        fixtureId,
        dataRoot,
        localDataDir,
        requireEmptyLocalDataAtStart: true,
      })],
    };
  } finally {
    await cleanupIsolatedDataRoot(dataRoot);
  }
}

async function verifyFailureFixture(fixtureId, phase) {
  const dataRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), `wangzai-legacy-retirement-${phase}-`),
  );
  try {
    const localDataDir = await createEmptyPhaseLocalDataDirectory(dataRoot, phase);
    return {
      fixtureId,
      phases: [await verifyPhase({
        phase,
        fixtureId,
        dataRoot,
        localDataDir,
        requireEmptyLocalDataAtStart: true,
      })],
    };
  } finally {
    await cleanupIsolatedDataRoot(dataRoot);
  }
}

async function verifyMaximumFixture(fixtureId) {
  const dataRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "wangzai-legacy-retirement-max-"),
  );
  try {
    const localDataDir = await createEmptyPhaseLocalDataDirectory(dataRoot, "max-restart");
    const maximum = await verifyPhase({
      phase: "max",
      fixtureId,
      dataRoot,
      localDataDir,
      requireEmptyLocalDataAtStart: true,
    });
    const restart = await verifyPhase({
      phase: "max-restart",
      fixtureId,
      dataRoot,
      localDataDir,
    });
    return { fixtureId, phases: [maximum, restart] };
  } finally {
    await cleanupIsolatedDataRoot(dataRoot);
  }
}

async function verifyRecoveryFixture(fixtureId, recoveryRemote) {
  const capability = getRecoveryRestartCapability(fixtureId);
  if (!capability.eligible) {
    return {
      fixtureId,
      skipped: true,
      recoveryRestart: {
        status: "unsupported",
        reason: capability.reason,
      },
      phases: [],
    };
  }
  const dataRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "wangzai-legacy-retirement-recovery-"),
  );
  try {
    const sourceLocalDataDir = await createEmptyPhaseLocalDataDirectory(dataRoot, "recovery-source");
    const failedActivation = await verifyPhase({
      phase: "recovery-failure",
      fixtureId,
      dataRoot,
      localDataDir: sourceLocalDataDir,
      requireEmptyLocalDataAtStart: true,
      recoveryRemote,
    });
    // The active SQLite family remains in this profile after activation, but
    // its old local-data JSON must never be available to recovery-restart.
    const restartLocalDataDir = await createEmptyPhaseLocalDataDirectory(dataRoot, "recovery-restart");
    if (path.resolve(sourceLocalDataDir) === path.resolve(restartLocalDataDir)) {
      throw new Error("旧浏览器副本退役 recovery-restart 错误复用了 source local-data 目录。");
    }
    const restart = await verifyPhase({
      phase: "recovery-restart",
      fixtureId,
      dataRoot,
      localDataDir: restartLocalDataDir,
      requireEmptyLocalDataAtStart: true,
    });
    return {
      fixtureId,
      phases: [failedActivation, restart],
      recoveryRestart: {
        status: "verified",
        sourceLocalDataReused: false,
        emptyLocalDataAtStart: restart.localData.emptyAtStart === true,
      },
    };
  } finally {
    await cleanupIsolatedDataRoot(dataRoot);
  }
}

try {
  const recoveryAccessToken = "legacy-retirement-isolated-recovery-token";
  const opaqueRecoveryRemote = includeRecoveryFixture
    ? createOpaqueRecoveryRemote({ accessToken: recoveryAccessToken })
    : null;
  let recoveryRemote = null;
  if (opaqueRecoveryRemote) {
    const port = await listen(opaqueRecoveryRemote.server);
    recoveryRemote = {
      baseUrl: `http://127.0.0.1:${port}`,
      accessToken: recoveryAccessToken,
    };
  }
  try {
    const fixtures = [];
    for (const fixtureId of fixtureIds)
      fixtures.push(await verifyFixture(fixtureId));
    const badFixtures = [];
    if (includeBadInput) {
      for (const fixtureId of fixtureIds)
        badFixtures.push(await verifyBadFixture(fixtureId));
    }
    const failureFixtures = [];
    if (includeFailureInjection) {
      for (const phase of ["write-error", "readback-error"])
        for (const fixtureId of fixtureIds)
          failureFixtures.push(await verifyFailureFixture(fixtureId, phase));
    }
    const maximumFixtures = [];
    if (includeMaximumFixture) {
      for (const fixtureId of fixtureIds)
        maximumFixtures.push(await verifyMaximumFixture(fixtureId));
    }
    const recoveryFixtures = [];
    const recoverySkippedFixtures = [];
    if (includeRecoveryFixture) {
      for (const fixtureId of fixtureIds) {
        const recoveryFixture = await verifyRecoveryFixture(fixtureId, recoveryRemote);
        if (recoveryFixture.skipped) recoverySkippedFixtures.push(recoveryFixture);
        else recoveryFixtures.push(recoveryFixture);
      }
    }
    const recoveryRemoteSummary = opaqueRecoveryRemote?.getSummary() || null;
    if (
      recoveryRemoteSummary &&
      recoveryRemoteSummary.plaintextMarkersAbsent !== true
    ) {
      throw new Error("旧浏览器副本退役 recovery remote 检测到明文 fixture 标记。");
    }
    if (
      recoveryFixtures.length > 0 &&
      (
        recoveryRemoteSummary?.generationCount < 1 ||
        recoveryRemoteSummary?.encryptedObjectCount < 1
      )
    ) {
      throw new Error(`旧浏览器副本退役 recovery remote 缺少加密 generation/object 证据：${JSON.stringify(recoveryRemoteSummary)}`);
    }
    console.log(
      JSON.stringify({
        ok: true,
        fixtures,
        badFixtures,
        failureFixtures,
        maximumFixtures,
        recoveryFixtures,
        recoverySkippedFixtures,
        recoveryRemote: recoveryRemoteSummary,
        isolatedData: true,
      }),
    );
  } finally {
    if (opaqueRecoveryRemote?.server.listening) await close(opaqueRecoveryRemote.server);
  }
} catch (error) {
  console.error(error?.stack || error);
  process.exitCode = 1;
}
