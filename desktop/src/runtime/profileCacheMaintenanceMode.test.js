import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  ORDINARY_CLEARABLE_CACHE_TABLES,
  PROFILE_MAINTENANCE_COMMANDS,
  PROFILE_SCHEMA_TABLES,
  PROTECTED_PROFILE_TABLES,
} from "./profileCachePolicy.js";
import { PROFILE_CACHE_CLEAR_CONFIRMATION } from "./profileCacheReset.js";
import { runProfileCacheMaintenanceMode } from "./profileCacheMaintenanceMode.js";

function createCanonicalFixture(databasePath) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  [
    ...ORDINARY_CLEARABLE_CACHE_TABLES,
    ...PROTECTED_PROFILE_TABLES.filter(
      (tableName) => tableName !== "product_material_profiles",
    ),
    ...PROFILE_SCHEMA_TABLES,
  ].forEach((tableName) => {
    db.exec(
      `CREATE TABLE "${tableName}" (id TEXT PRIMARY KEY, payload TEXT NOT NULL DEFAULT '')`,
    );
  });
  db.exec(`
    CREATE TABLE product_material_profiles (
      id TEXT PRIMARY KEY,
      source TEXT,
      payload TEXT NOT NULL DEFAULT ''
    )
  `);
  ORDINARY_CLEARABLE_CACHE_TABLES.forEach((tableName, index) => {
    db.prepare(`INSERT INTO "${tableName}" (id, payload) VALUES (?, ?)`)
      .run(`cache-${index}`, "delete-only");
  });
  PROTECTED_PROFILE_TABLES.forEach((tableName, index) => {
    if (tableName === "product_material_profiles") return;
    db.prepare(`INSERT INTO "${tableName}" (id, payload) VALUES (?, ?)`)
      .run(`protected-${index}`, `keep-${index}`);
  });
  db.prepare(
    "INSERT INTO product_material_profiles (id, source, payload) VALUES (?, ?, ?)",
  ).run("material", "supplier-confirmed", "keep-material");
  db.prepare("INSERT INTO schema_migrations (id, payload) VALUES (?, ?)")
    .run("001", "keep-schema");
  db.close();
}

function createPaths(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dataRoot = path.join(root, "profile");
  const workspaceRoot = path.join(root, "workspace");
  const databasePath = path.join(
    dataRoot,
    "local-api-data",
    "wangzai-local-api.sqlite",
  );
  fs.mkdirSync(workspaceRoot, { recursive: true });
  return { root, dataRoot, workspaceRoot, databasePath };
}

function stubPreview(token = "preview-token") {
  return {
    mode: "read-only-profile-transient-cache-preview",
    previewToken: token,
    totals: {
      databaseClearableRows: 2,
      clearableFileBytes: 32,
      protectedFileBytes: 64,
      unknownProtectedResources: 1,
    },
    database: { protected: { shops: {} }, protectedDigest: "database-digest" },
    files: { protectedDigest: "file-digest" },
  };
}

test("startup maintenance holds one profile lock through preview, native confirmation and apply", async () => {
  const paths = createPaths("wangzai-cache-mode-lock-");
  const lockPath = path.join(paths.dataRoot, "runtime", "profile.lock");
  let applyCalls = 0;
  try {
    const result = await runProfileCacheMaintenanceMode({
      ...paths,
      isLocalApiStarted: () => false,
      isBridgeStarted: () => false,
      showMessageBox: async (dialog) => {
        assert.equal(fs.existsSync(lockPath), true);
        assert.equal(dialog.defaultId, 1);
        assert.equal(dialog.cancelId, 1);
        assert.match(dialog.detail, /不会执行释放空间、领域重建或永久删除/u);
        return { response: 0, checkboxChecked: true };
      },
    }, {
      inspectProfileCacheMaintenance(options) {
        assert.equal(fs.existsSync(lockPath), true);
        assert.equal(options.command, "clear-transient-cache");
        return stubPreview();
      },
      applyProfileCacheMaintenance(options) {
        applyCalls += 1;
        assert.equal(fs.existsSync(lockPath), true);
        assert.equal(options.maintenanceLock.lockPath, lockPath);
        assert.equal(options.confirmation, PROFILE_CACHE_CLEAR_CONFIRMATION);
        assert.equal(options.previewToken, "preview-token");
        return { ok: true, reportPath: path.join(paths.dataRoot, "report.json") };
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, "completed");
    assert.equal(result.restartRequired, true);
    assert.equal(result.continueStartup, false);
    assert.equal(result.lock.heldForEntireMode, true);
    assert.equal(applyCalls, 1);
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    fs.rmSync(paths.root, { recursive: true, force: true });
  }
});

test("native cancel makes zero modifications and still requires a normal restart", async () => {
  const paths = createPaths("wangzai-cache-mode-cancel-");
  let applyCalls = 0;
  try {
    const result = await runProfileCacheMaintenanceMode({
      ...paths,
      isLocalApiStarted: () => false,
      isBridgeStarted: () => false,
      showMessageBox: async () => ({ response: 1, checkboxChecked: false }),
    }, {
      inspectProfileCacheMaintenance: () => stubPreview(),
      applyProfileCacheMaintenance: () => { applyCalls += 1; },
    });
    assert.equal(result.ok, true);
    assert.equal(result.cancelled, true);
    assert.equal(result.mutationStarted, false);
    assert.equal(result.requiresNormalRestart, true);
    assert.equal(applyCalls, 0);
    assert.equal(
      fs.existsSync(path.join(paths.dataRoot, "runtime", "profile.lock")),
      false,
    );
  } finally {
    fs.rmSync(paths.root, { recursive: true, force: true });
  }
});

test("mode fails closed before preview when local-api or bridge has started", async () => {
  for (const state of [
    { localApi: true, bridge: false },
    { localApi: false, bridge: true },
  ]) {
    const paths = createPaths("wangzai-cache-mode-running-");
    let inspections = 0;
    try {
      const result = await runProfileCacheMaintenanceMode({
        ...paths,
        isLocalApiStarted: () => state.localApi,
        isBridgeStarted: () => state.bridge,
        showMessageBox: async () => ({ response: 0, checkboxChecked: true }),
      }, {
        inspectProfileCacheMaintenance: () => { inspections += 1; },
      });
      assert.equal(result.ok, false);
      assert.equal(
        result.error.code,
        "PROFILE_CACHE_MAINTENANCE_SERVICES_ALREADY_STARTED",
      );
      assert.equal(result.mutationStarted, false);
      assert.equal(inspections, 0);
    } finally {
      fs.rmSync(paths.root, { recursive: true, force: true });
    }
  }
});

test("release, rebuild and permanent-delete commands cannot enter ordinary cache mode", async () => {
  for (const command of [
    PROFILE_MAINTENANCE_COMMANDS.RELEASE_SPACE,
    PROFILE_MAINTENANCE_COMMANDS.REBUILD_DOMAIN,
    PROFILE_MAINTENANCE_COMMANDS.PERMANENT_DELETE,
  ]) {
    const result = await runProfileCacheMaintenanceMode({
      command,
      isLocalApiStarted: () => false,
      isBridgeStarted: () => false,
    });
    assert.equal(result.ok, false);
    assert.match(result.error.message, /不能进入普通清缓存/u);
    assert.equal(result.mutationStarted, false);
  }
});

test("apply failure returns rollback structure, releases the mode lock and requires restart", async () => {
  const paths = createPaths("wangzai-cache-mode-failure-");
  const rollback = { ok: true, mode: "automatic-full-profile-cache-operation-rollback" };
  try {
    const result = await runProfileCacheMaintenanceMode({
      ...paths,
      isLocalApiStarted: () => false,
      isBridgeStarted: () => false,
      showMessageBox: async () => ({ response: 0, checkboxChecked: true }),
    }, {
      inspectProfileCacheMaintenance: () => stubPreview(),
      applyProfileCacheMaintenance() {
        const error = new Error("injected apply failure");
        error.rollback = rollback;
        error.reportPath = path.join(paths.dataRoot, "rollback-report.json");
        throw error;
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, "failed");
    assert.equal(result.rollbackVerified, true);
    assert.equal(result.rollback, rollback);
    assert.equal(result.restartRequired, true);
    assert.equal(
      fs.existsSync(path.join(paths.dataRoot, "runtime", "profile.lock")),
      false,
    );
  } finally {
    fs.rmSync(paths.root, { recursive: true, force: true });
  }
});

test("production mode calls the real inspect/apply pipeline under the startup lock", async () => {
  const paths = createPaths("wangzai-cache-mode-integration-");
  createCanonicalFixture(paths.databasePath);
  let mutationFenceCalls = 0;
  try {
    const result = await runProfileCacheMaintenanceMode({
      ...paths,
      isLocalApiStarted: () => false,
      isBridgeStarted: () => false,
      showMessageBox: async () => ({ response: 0, checkboxChecked: true }),
      assertBeforeMutation() {
        mutationFenceCalls += 1;
        const database = new DatabaseSync(paths.databasePath, { readOnly: true });
        try {
          assert.equal(
            database.prepare(
              `SELECT COUNT(*) AS total FROM "${ORDINARY_CLEARABLE_CACHE_TABLES[0]}"`,
            ).get().total,
            1,
          );
        } finally {
          database.close();
        }
      },
      now: new Date("2026-07-16T03:00:00.000Z"),
    });
    assert.equal(result.ok, true);
    assert.equal(result.completed, true);
    assert.equal(result.maintenance.lock.heldForEntireMutation, true);
    assert.equal(result.maintenance.protectedDigestBefore, result.maintenance.protectedDigestAfter);
    assert.equal(mutationFenceCalls, 2);
    const db = new DatabaseSync(paths.databasePath, { readOnly: true });
    try {
      for (const tableName of ORDINARY_CLEARABLE_CACHE_TABLES) {
        assert.equal(
          db.prepare(`SELECT COUNT(*) AS total FROM "${tableName}"`).get().total,
          0,
        );
      }
      assert.equal(
        db.prepare("SELECT COUNT(*) AS total FROM shops").get().total,
        1,
      );
    } finally {
      db.close();
    }
    assert.equal(
      fs.existsSync(path.join(paths.dataRoot, "runtime", "profile.lock")),
      false,
    );
  } finally {
    fs.rmSync(paths.root, { recursive: true, force: true });
  }
});
