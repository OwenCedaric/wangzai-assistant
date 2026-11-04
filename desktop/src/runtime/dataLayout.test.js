import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveDataLayout } from "./dataLayout.js";
import { createDesktopPaths } from "./desktopPaths.js";

test("resolveDataLayout derives every persistent path from one data root", () => {
  const layout = resolveDataLayout({
    dataRoot: "C:/runtime/profiles/shop-a",
    localApiRoot: "C:/runtime/local-api",
  });

  assert.equal(layout.dataRoot, path.resolve("C:/runtime/profiles/shop-a"));
  assert.equal(
    layout.databasePath,
    path.join(layout.dataRoot, "local-api-data", "wangzai-local-api.sqlite"),
  );
  assert.equal(layout.sharedDatabasePath, layout.databasePath);
  assert.equal(
    layout.shopDatabaseRoot,
    path.join(layout.dataRoot, "local-api-data", "shop-databases"),
  );
  assert.equal(
    layout.aggregateIndexPath,
    path.join(layout.dataRoot, "local-api-data", "shop-aggregate-index.sqlite"),
  );
  assert.equal(
    layout.shopDatabaseBackupRoot,
    path.join(layout.dataRoot, "backups", "shop-databases"),
  );
  assert.equal(
    layout.secretPath,
    path.join(layout.dataRoot, "local-api-data", "local-api-secret.key"),
  );
  assert.equal(
    layout.protectedComputeVersionStatePath,
    path.join(layout.dataRoot, "local-api-data", "protected-compute-version-state.enc"),
  );
  assert.equal(layout.localDataRoot, path.join(layout.dataRoot, "本地数据"));
  assert.equal(layout.logDirectory, path.join(layout.dataRoot, "logs"));
  assert.equal(layout.runtimeDirectory, path.join(layout.dataRoot, "runtime"));
  assert.equal(
    layout.profileLockPath,
    path.join(layout.dataRoot, "runtime", "profile.lock"),
  );
  assert.equal(layout.backupDirectory, path.join(layout.dataRoot, "backups"));
  assert.equal(layout.temporaryDirectory, path.join(layout.dataRoot, "tmp"));
  assert.equal(
    layout.legacySecretPath,
    path.resolve("C:/runtime/local-api/data/local-api-secret.key"),
  );
});

test("resolveDataLayout rejects an empty root instead of silently using cwd", () => {
  assert.throws(() => resolveDataLayout({ dataRoot: "" }), /dataRoot 不能为空/u);
});

test("desktop paths keeps an existing legacy key until a canonical key exists", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wangzai-layout-"));
  try {
    const app = {
      isPackaged: false,
      getPath(name) {
        assert.equal(name, "userData");
        return path.join(root, "profile");
      },
    };
    const paths = createDesktopPaths({
      app,
      desktopRoot: path.join(root, "desktop"),
      workspaceRoot: path.join(root, "workspace"),
    });
    const legacyKey = path.join(
      root,
      "workspace",
      "local-api",
      "data",
      "local-api-secret.key",
    );
    fs.mkdirSync(path.dirname(legacyKey), { recursive: true });
    fs.writeFileSync(legacyKey, "legacy-key\n", "utf8");

    assert.equal(paths.localApiDatabasePath(), paths.dataLayout().databasePath);
    assert.equal(paths.localApiShopDatabaseRoot(), paths.dataLayout().shopDatabaseRoot);
    assert.equal(paths.localApiAggregateIndexPath(), paths.dataLayout().aggregateIndexPath);
    assert.equal(paths.localApiShopDatabaseBackupRoot(), paths.dataLayout().shopDatabaseBackupRoot);
    assert.equal(paths.localApiSecretPath(), legacyKey);
    assert.equal(
      paths.protectedComputeVersionStatePath(),
      paths.dataLayout().protectedComputeVersionStatePath,
    );

    const canonicalKey = paths.dataLayout().secretPath;
    fs.mkdirSync(path.dirname(canonicalKey), { recursive: true });
    fs.writeFileSync(canonicalKey, "canonical-key\n", "utf8");
    assert.equal(paths.localApiSecretPath(), canonicalKey);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("desktop paths forwards an explicit secret path without deriving a second key", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wangzai-layout-"));
  const previous = process.env.LOCAL_API_SECRET_FILE;
  const configured = path.join(root, "profile", "test-secrets", "master.key");
  try {
    process.env.LOCAL_API_SECRET_FILE = configured;
    const paths = createDesktopPaths({
      app: { isPackaged: false, getPath: () => path.join(root, "profile") },
      desktopRoot: path.join(root, "desktop"),
      workspaceRoot: path.join(root, "workspace"),
    });
    assert.equal(paths.localApiSecretPath(), path.resolve(configured));
  } finally {
    if (previous === undefined) delete process.env.LOCAL_API_SECRET_FILE;
    else process.env.LOCAL_API_SECRET_FILE = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("desktop paths rejects DB, JSON and key overrides that escape the profile root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wangzai-layout-"));
  const previous = {
    json: process.env.WANGZAI_DESKTOP_LOCAL_DATA_DIR,
    database: process.env.LOCAL_API_DB_PATH,
    shopDatabaseRoot: process.env.LOCAL_API_SHOP_DB_ROOT,
    aggregateIndex: process.env.LOCAL_API_AGGREGATE_INDEX_PATH,
    shopDatabaseBackupRoot: process.env.LOCAL_API_SHOP_DB_BACKUP_ROOT,
    secret: process.env.LOCAL_API_SECRET_FILE,
  };
  try {
    const profileRoot = path.join(root, "profile");
    const paths = createDesktopPaths({
      app: { isPackaged: false, getPath: () => profileRoot },
      desktopRoot: path.join(root, "desktop"),
      workspaceRoot: path.join(root, "workspace"),
    });
    process.env.WANGZAI_DESKTOP_LOCAL_DATA_DIR = path.join(root, "outside-json");
    assert.throws(() => paths.localDataRoot(), /数据根内/u);
    process.env.LOCAL_API_DB_PATH = path.join(root, "outside.sqlite");
    assert.throws(() => paths.localApiDatabasePath(), /数据根内/u);
    process.env.LOCAL_API_SHOP_DB_ROOT = path.join(root, "outside-shop-databases");
    assert.throws(() => paths.localApiShopDatabaseRoot(), /数据根内/u);
    process.env.LOCAL_API_AGGREGATE_INDEX_PATH = path.join(root, "outside-aggregate.sqlite");
    assert.throws(() => paths.localApiAggregateIndexPath(), /数据根内/u);
    process.env.LOCAL_API_SHOP_DB_BACKUP_ROOT = path.join(root, "outside-shop-backups");
    assert.throws(() => paths.localApiShopDatabaseBackupRoot(), /数据根内/u);
    process.env.LOCAL_API_SECRET_FILE = path.join(root, "outside.key");
    assert.throws(() => paths.localApiSecretPath(), /数据根内/u);
  } finally {
    for (const [key, value] of Object.entries({
      WANGZAI_DESKTOP_LOCAL_DATA_DIR: previous.json,
      LOCAL_API_DB_PATH: previous.database,
      LOCAL_API_SHOP_DB_ROOT: previous.shopDatabaseRoot,
      LOCAL_API_AGGREGATE_INDEX_PATH: previous.aggregateIndex,
      LOCAL_API_SHOP_DB_BACKUP_ROOT: previous.shopDatabaseBackupRoot,
      LOCAL_API_SECRET_FILE: previous.secret,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("desktop paths rejects a cross-drive database override on Windows", {
  skip: process.platform !== "win32",
}, () => {
  const previous = process.env.LOCAL_API_DB_PATH;
  try {
    const profileRoot = "C:\\wangzai-profile";
    const paths = createDesktopPaths({
      app: { isPackaged: false, getPath: () => profileRoot },
      desktopRoot: "C:\\wangzai-workspace\\desktop",
      workspaceRoot: "C:\\wangzai-workspace",
    });
    process.env.LOCAL_API_DB_PATH = "G:\\wangzai-workspace\\local-api\\data\\wangzai-local-api.sqlite";
    assert.throws(() => paths.localApiDatabasePath(), /数据根内/u);
  } finally {
    if (previous === undefined) delete process.env.LOCAL_API_DB_PATH;
    else process.env.LOCAL_API_DB_PATH = previous;
  }
});

test("desktop paths never recreates a missing initialized database as an empty profile", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wangzai-layout-"));
  try {
    const paths = createDesktopPaths({
      app: { isPackaged: false, getPath: () => path.join(root, "profile") },
      desktopRoot: path.join(root, "desktop"),
      workspaceRoot: path.join(root, "workspace"),
    });
    const freshProfile = paths.ensureProfile();
    assert.equal(paths.assertCurrentProfileDatabaseAvailable(freshProfile).fresh, true);

    const databasePath = paths.localApiDatabasePath();
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    fs.writeFileSync(databasePath, "not-an-empty-replacement", "utf8");
    const initializedProfile = paths.markCurrentProfileDatabaseInitialized(freshProfile, {
      now: () => new Date("2026-07-12T01:02:03.000Z"),
    });
    fs.rmSync(databasePath);

    assert.throws(
      () => paths.assertCurrentProfileDatabaseAvailable(initializedProfile),
      /PROFILE_DATABASE_MISSING_RECOVERY_REQUIRED/u,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("desktop paths starts a missing initialized profile through a separate recovery shell database", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wangzai-layout-"));
  try {
    const paths = createDesktopPaths({
      app: { isPackaged: false, getPath: () => path.join(root, "profile") },
      desktopRoot: path.join(root, "desktop"),
      workspaceRoot: path.join(root, "workspace"),
    });
    const fresh = paths.ensureProfile();
    const activeDatabasePath = paths.localApiDatabasePath();
    fs.mkdirSync(path.dirname(activeDatabasePath), { recursive: true });
    fs.writeFileSync(activeDatabasePath, "previous-profile-database", "utf8");
    const initialized = paths.markCurrentProfileDatabaseInitialized(fresh);
    fs.rmSync(activeDatabasePath);

    const recovery = paths.resolveCurrentProfileDatabaseStartup(initialized);
    assert.equal(recovery.mode, "recovery");
    assert.equal(recovery.activeDatabasePath, activeDatabasePath);
    assert.equal(
      recovery.runtimeDatabasePath,
      path.join(path.dirname(activeDatabasePath), "recovery-shell.sqlite"),
    );
    assert.equal(fs.existsSync(activeDatabasePath), false);

    fs.writeFileSync(recovery.runtimeDatabasePath, "recovery-shell", "utf8");
    assert.equal(paths.resolveCurrentProfileDatabaseStartup().mode, "recovery");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
