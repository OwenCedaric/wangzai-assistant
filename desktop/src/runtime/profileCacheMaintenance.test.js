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
import {
  applyProfileCacheMaintenance,
  inspectProfileCacheMaintenance,
} from "./profileCacheMaintenance.js";
import { PROFILE_CACHE_CLEAR_CONFIRMATION } from "./profileCacheReset.js";

const ORDINARY_CACHE_COMMAND =
  PROFILE_MAINTENANCE_COMMANDS.CLEAR_TRANSIENT_CACHE;

function writeFile(filePath, value = "cache") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, "utf8");
}

function createCanonicalFixture(databasePath) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  const ordinaryTables = [
    ...ORDINARY_CLEARABLE_CACHE_TABLES,
    ...PROTECTED_PROFILE_TABLES.filter(
      (tableName) => tableName !== "product_material_profiles",
    ),
    ...PROFILE_SCHEMA_TABLES,
  ];
  ordinaryTables.forEach((tableName) => {
    db.exec(
      `CREATE TABLE "${tableName}" (id TEXT PRIMARY KEY, payload TEXT NOT NULL DEFAULT '')`,
    );
  });
  db.exec(`
    CREATE TABLE product_material_profiles (
      id TEXT PRIMARY KEY,
      source TEXT,
      payload TEXT NOT NULL DEFAULT ''
    );
  `);
  ORDINARY_CLEARABLE_CACHE_TABLES.forEach((tableName, index) => {
    db.prepare(`INSERT INTO "${tableName}" (id, payload) VALUES (?, ?)`).run(
      `cache-${index}`,
      "delete-transient-only",
    );
  });
  PROTECTED_PROFILE_TABLES.forEach((tableName, index) => {
    if (tableName === "product_material_profiles") return;
    db.prepare(`INSERT INTO "${tableName}" (id, payload) VALUES (?, ?)`).run(
      `protected-${index}`,
      `keep-protected-${index}`,
    );
  });
  db.prepare(
    "INSERT INTO product_material_profiles (id, source, payload) VALUES (?, ?, ?)",
  ).run("automatic", "ozon-product-list-read", "keep-ozon-dimensions");
  db.prepare(
    "INSERT INTO product_material_profiles (id, source, payload) VALUES (?, ?, ?)",
  ).run("manual", "supplier-confirmed", "keep-manual-dimensions");
  db.prepare("INSERT INTO schema_migrations (id, payload) VALUES (?, ?)").run(
    "001",
    "keep-schema",
  );
  db.close();
}

function createRetiredWorkspaceDatabase(databasePath) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec("CREATE TABLE legacy_data (id TEXT PRIMARY KEY, payload TEXT)");
  db.prepare("INSERT INTO legacy_data (id, payload) VALUES (?, ?)").run(
    "legacy",
    "archived",
  );
  db.close();
}

test("ordinary cache maintenance clears only transient caches and preserves all business/storage worlds", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wangzai-profile-cache-clear-"));
  try {
    const dataRoot = path.join(root, "profile");
    const workspaceRoot = path.join(root, "workspace");
    const databasePath = path.join(
      dataRoot,
      "local-api-data",
      "wangzai-local-api.sqlite",
    );
    const retiredDatabasePath = path.join(
      workspaceRoot,
      "local-api",
      "data",
      "wangzai-local-api.sqlite",
    );
    const canonicalSecretPath = path.join(dataRoot, "local-api-data", "local-api-secret.key");
    const retiredSecretPath = path.join(workspaceRoot, "local-api", "data", "local-api-secret.key");
    const productMirrorPath = path.join(
      dataRoot,
      "本地数据",
      "商品资料",
      "ozon-local-data-layer.json",
    );
    const profitSnapshotPath = path.join(
      workspaceRoot,
      "本地数据",
      "分类缓存",
      "10-利润核算",
      "profit-local-cache-shop-a.json",
    );
    const profileReadLogPath = path.join(
      dataRoot,
      "本地数据",
      "分类缓存",
      "14-失败重试",
      "local-mirror-read-log.json",
    );
    const workspaceReadLogPath = path.join(
      workspaceRoot,
      "本地数据",
      "分类缓存",
      "14-失败重试",
      "local-mirror-read-log.json",
    );
    const localStoragePath = path.join(dataRoot, "Local Storage", "leveldb", "000001.ldb");
    const unknownLocalDataPath = path.join(
      dataRoot,
      "本地数据",
      "分类缓存",
      "14-失败重试",
      "future-resource.json",
    );
    const unknownProfilePath = path.join(
      dataRoot,
      "FutureCacheThatIsNotWhitelisted",
      "payload.bin",
    );

    createCanonicalFixture(databasePath);
    createRetiredWorkspaceDatabase(retiredDatabasePath);
    writeFile(canonicalSecretPath, "profile-key");
    writeFile(retiredSecretPath, "legacy-key");
    writeFile(productMirrorPath, '{"products":[{"offerId":"keep"}]}');
    writeFile(profitSnapshotPath, '{"profit":"keep"}');
    writeFile(profileReadLogPath, "profile-transient-log");
    writeFile(workspaceReadLogPath, "workspace-transient-log");
    writeFile(path.join(dataRoot, "Cache", "cache.bin"), "renderer-cache");
    writeFile(localStoragePath, "keep-local-storage");
    writeFile(unknownLocalDataPath, "keep-unknown-local-data");
    writeFile(unknownProfilePath, "keep-unknown-profile-resource");
    writeFile(
      path.join(workspaceRoot, "local-api", "data", "maintenance-runtime", "preview.json"),
      '{"keep":"migration-evidence"}',
    );

    const preview = inspectProfileCacheMaintenance({
      command: ORDINARY_CACHE_COMMAND,
      dataRoot,
      workspaceRoot,
      databasePath,
    });
    assert.equal(preview.lock.active, false);
    assert.equal(
      preview.database.totals.clearableRows,
      ORDINARY_CLEARABLE_CACHE_TABLES.length,
    );
    assert.equal(preview.files.clearable.profileCacheFiles.length, 1);
    assert.equal(preview.files.clearable.workspaceCacheFiles.length, 1);
    assert.equal(preview.files.clearable.electronCacheDirectories.length, 1);
    assert.equal(preview.files.unknownProtection.defaultAction, "protect-and-fingerprint");
    assert.ok(
      preview.files.protected.unknownResources.some(
        (entry) => entry.path === unknownLocalDataPath,
      ),
    );
    assert.ok(
      preview.files.protected.unknownResources.some(
        (entry) => entry.path === path.dirname(unknownProfilePath),
      ),
    );
    assert.ok(
      preview.files.protected.retiredWorkspaceFiles.some(
        (entry) => entry.path === retiredDatabasePath,
      ),
    );
    const protectedFileDigest = preview.files.protectedDigest;
    const protectedDatabaseDigest = preview.database.protectedDigest;

    const result = applyProfileCacheMaintenance({
      command: ORDINARY_CACHE_COMMAND,
      dataRoot,
      workspaceRoot,
      databasePath,
      confirmation: PROFILE_CACHE_CLEAR_CONFIRMATION,
      previewToken: preview.previewToken,
      now: new Date("2026-07-15T10:00:00.000Z"),
    });
    assert.equal(result.ok, true);
    assert.equal(
      result.databaseClear.deletedRows,
      ORDINARY_CLEARABLE_CACHE_TABLES.length,
    );
    assert.equal(result.after.database.totals.clearableRows, 0);
    assert.equal(result.databaseClear.before.protectedDigest, protectedDatabaseDigest);
    assert.equal(result.databaseClear.after.protectedDigest, protectedDatabaseDigest);
    assert.equal(result.protectedDigestBefore, protectedFileDigest);
    assert.equal(result.protectedDigestAfter, protectedFileDigest);
    assert.equal(fs.existsSync(profileReadLogPath), false);
    assert.equal(fs.existsSync(workspaceReadLogPath), false);
    assert.equal(fs.existsSync(path.join(dataRoot, "Cache")), false);
    assert.equal(fs.existsSync(retiredDatabasePath), true);
    assert.equal(fs.existsSync(retiredSecretPath), true);
    assert.equal(fs.existsSync(productMirrorPath), true);
    assert.equal(fs.existsSync(profitSnapshotPath), true);
    assert.equal(fs.existsSync(localStoragePath), true);
    assert.equal(fs.readFileSync(unknownLocalDataPath, "utf8"), "keep-unknown-local-data");
    assert.equal(
      fs.readFileSync(unknownProfilePath, "utf8"),
      "keep-unknown-profile-resource",
    );
    assert.equal(fs.readFileSync(canonicalSecretPath, "utf8"), "profile-key");
    assert.equal(fs.readFileSync(retiredSecretPath, "utf8"), "legacy-key");
    assert.equal(fs.readFileSync(localStoragePath, "utf8"), "keep-local-storage");
    assert.equal(fs.existsSync(result.reportPath), true);
    assert.equal(result.protectionBackupRemoved, true);
    assert.equal(result.backupRoot, null);
    assert.equal(result.canonicalBackup.databaseDestination, null);
    assert.equal(
      fs.existsSync(path.join(dataRoot, "backups", "profile-cache-clear-before-2026-07-15T10-00-00.000Z")),
      false,
    );
    assert.ok(
      result.cacheFileBackups.some(
        (entry) => entry.relativePath === "Cache" && entry.type === "directory",
      ),
    );
    assert.equal(
      fs.existsSync(path.join(dataRoot, "runtime", "profile.lock")),
      false,
    );

    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.match(
        db.prepare("SELECT payload FROM ozon_products").get()?.payload || "",
        /^keep-protected-/u,
      );
      assert.match(
        db.prepare("SELECT payload FROM ozon_finance_transactions").get()?.payload || "",
        /^keep-protected-/u,
      );
      assert.deepEqual(
        db
          .prepare("SELECT id, source, payload FROM product_material_profiles ORDER BY id")
          .all()
          .map((row) => ({ ...row })),
        [
          { id: "automatic", source: "ozon-product-list-read", payload: "keep-ozon-dimensions" },
          { id: "manual", source: "supplier-confirmed", payload: "keep-manual-dimensions" },
        ],
      );
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ordinary cache maintenance never promotes or deletes a legacy workspace secret", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wangzai-profile-key-preserve-"));
  try {
    const dataRoot = path.join(root, "profile");
    const workspaceRoot = path.join(root, "workspace");
    const databasePath = path.join(
      dataRoot,
      "local-api-data",
      "wangzai-local-api.sqlite",
    );
    const canonicalSecretPath = path.join(
      dataRoot,
      "local-api-data",
      "local-api-secret.key",
    );
    const legacySecretPath = path.join(
      workspaceRoot,
      "local-api",
      "data",
      "local-api-secret.key",
    );
    createCanonicalFixture(databasePath);
    writeFile(legacySecretPath, "legacy-active-key");

    const before = inspectProfileCacheMaintenance({
      command: ORDINARY_CACHE_COMMAND,
      dataRoot,
      workspaceRoot,
      databasePath,
    });
    const result = applyProfileCacheMaintenance({
      command: ORDINARY_CACHE_COMMAND,
      dataRoot,
      workspaceRoot,
      databasePath,
      confirmation: PROFILE_CACHE_CLEAR_CONFIRMATION,
      previewToken: before.previewToken,
      now: new Date("2026-07-15T11:00:00.000Z"),
    });

    assert.equal(fs.existsSync(canonicalSecretPath), false);
    assert.equal(fs.existsSync(legacySecretPath), true);
    assert.equal(fs.readFileSync(legacySecretPath, "utf8"), "legacy-active-key");
    assert.equal(result.canonicalBackup.secretBackup, null);
    assert.equal(result.protectedDigestBefore, before.files.protectedDigest);
    assert.equal(result.protectedDigestAfter, before.files.protectedDigest);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("four maintenance commands are isolated and apply requires an exact preview token", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wangzai-cache-command-boundary-"));
  try {
    const dataRoot = path.join(root, "profile");
    const workspaceRoot = path.join(root, "workspace");
    const databasePath = path.join(
      dataRoot,
      "local-api-data",
      "wangzai-local-api.sqlite",
    );
    const cachePath = path.join(
      dataRoot,
      "本地数据",
      "分类缓存",
      "14-失败重试",
      "local-mirror-read-log.json",
    );
    createCanonicalFixture(databasePath);
    writeFile(cachePath, "previewed-cache");

    const preview = inspectProfileCacheMaintenance({
      command: ORDINARY_CACHE_COMMAND,
      dataRoot,
      workspaceRoot,
      databasePath,
    });
    for (const command of [
      PROFILE_MAINTENANCE_COMMANDS.RELEASE_SPACE,
      PROFILE_MAINTENANCE_COMMANDS.REBUILD_DOMAIN,
      PROFILE_MAINTENANCE_COMMANDS.PERMANENT_DELETE,
    ]) {
      assert.throws(
        () =>
          inspectProfileCacheMaintenance({
            command,
            dataRoot,
            workspaceRoot,
            databasePath,
          }),
        /独立执行，不能进入普通清缓存/u,
      );
    }
    assert.throws(
      () =>
        applyProfileCacheMaintenance({
          command: ORDINARY_CACHE_COMMAND,
          dataRoot,
          workspaceRoot,
          databasePath,
          confirmation: PROFILE_CACHE_CLEAR_CONFIRMATION,
        }),
      /必须先预览并提交 previewToken/u,
    );

    writeFile(cachePath, "changed-after-preview");
    assert.throws(
      () =>
        applyProfileCacheMaintenance({
          command: ORDINARY_CACHE_COMMAND,
          dataRoot,
          workspaceRoot,
          databasePath,
          confirmation: PROFILE_CACHE_CLEAR_CONFIRMATION,
          previewToken: preview.previewToken,
        }),
      /previewToken 已失效/u,
    );
    assert.equal(fs.readFileSync(cachePath, "utf8"), "changed-after-preview");
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(
        Number(db.prepare("SELECT COUNT(*) AS count FROM ozon_response_cache").get()?.count),
        1,
      );
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("protected file readback mismatch automatically restores DB and every file stage", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wangzai-cache-file-rollback-"));
  try {
    const dataRoot = path.join(root, "profile");
    const workspaceRoot = path.join(root, "workspace");
    const databasePath = path.join(
      dataRoot,
      "local-api-data",
      "wangzai-local-api.sqlite",
    );
    const protectedPath = path.join(
      dataRoot,
      "本地数据",
      "商品资料",
      "ozon-local-data-layer.json",
    );
    const clearableFilePath = path.join(
      dataRoot,
      "本地数据",
      "分类缓存",
      "14-失败重试",
      "local-mirror-read-log.json",
    );
    const electronCachePath = path.join(dataRoot, "Cache", "renderer.bin");
    createCanonicalFixture(databasePath);
    writeFile(protectedPath, "protected-before");
    writeFile(clearableFilePath, "clearable-before");
    writeFile(electronCachePath, "electron-before");

    const preview = inspectProfileCacheMaintenance({
      command: ORDINARY_CACHE_COMMAND,
      dataRoot,
      workspaceRoot,
      databasePath,
    });
    let failure = null;
    try {
      applyProfileCacheMaintenance({
        command: ORDINARY_CACHE_COMMAND,
        dataRoot,
        workspaceRoot,
        databasePath,
        confirmation: PROFILE_CACHE_CLEAR_CONFIRMATION,
        previewToken: preview.previewToken,
        now: new Date("2026-07-15T12:00:00.000Z"),
        testHooks: {
          afterFileStage() {
            assert.equal(
              fs.existsSync(path.join(dataRoot, "runtime", "profile.lock")),
              true,
            );
            writeFile(protectedPath, "tampered-during-file-stage");
          },
        },
      });
    } catch (error) {
      failure = error;
    }

    assert.ok(failure);
    assert.match(failure.message, /已自动恢复到清理前状态/u);
    assert.equal(failure.rollback?.ok, true);
    assert.equal(fs.existsSync(failure.reportPath), true);
    assert.equal(fs.readFileSync(protectedPath, "utf8"), "protected-before");
    assert.equal(fs.readFileSync(clearableFilePath, "utf8"), "clearable-before");
    assert.equal(fs.readFileSync(electronCachePath, "utf8"), "electron-before");
    assert.equal(
      fs.existsSync(path.join(dataRoot, "runtime", "profile.lock")),
      false,
    );

    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(
        Number(db.prepare("SELECT COUNT(*) AS count FROM ozon_response_cache").get()?.count),
        1,
      );
      assert.match(
        db.prepare("SELECT payload FROM ozon_products").get()?.payload || "",
        /^keep-protected-/u,
      );
    } finally {
      db.close();
    }
    const restored = inspectProfileCacheMaintenance({
      command: ORDINARY_CACHE_COMMAND,
      dataRoot,
      workspaceRoot,
      databasePath,
    });
    assert.equal(restored.previewToken, preview.previewToken);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
