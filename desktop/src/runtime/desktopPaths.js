import fs from "node:fs";
import path from "node:path";
import { resolveDataLayout } from "./dataLayout.js";
import {
  clearProfileDatabaseRecoveryRequired,
  ensureProfileMetadata,
  markProfileDatabaseInitialized,
  markProfileDatabaseRecoveryRequired,
} from "./profileMetadata.js";
import { acquireProfileLock } from "./profileLock.js";
import { createProfileMigrationPreview } from "./profileMigrationPreview.js";

export function createDesktopPaths({ app, desktopRoot, workspaceRoot }) {
  function ensureDirectory(directory) {
    fs.mkdirSync(directory, { recursive: true });
    return directory;
  }

  function frontendDistDirectory() {
    if (app.isPackaged) return path.join(process.resourcesPath, "frontend-dist");
    return path.join(workspaceRoot, "frontend", "dist");
  }

  function localApiRoot() {
    if (app.isPackaged) return path.join(process.resourcesPath, "local-api");
    return path.join(workspaceRoot, "local-api");
  }

  function localCacheAgentRoot() {
    if (app.isPackaged) return path.join(process.resourcesPath, "local-cache-agent");
    return path.join(workspaceRoot, "local-cache-agent");
  }

  function purchaseBridgeScriptPath() {
    if (app.isPackaged) {
      return path.join(
        process.resourcesPath,
        "bridge",
        "purchase-search-bridge.mjs",
      );
    }
    return path.join(
      workspaceRoot,
      "frontend",
      "scripts",
      "purchase-search-bridge.mjs",
    );
  }

  function purchaseBridgeWorkingDirectory() {
    if (app.isPackaged) return path.join(process.resourcesPath, "bridge");
    return path.join(workspaceRoot, "frontend");
  }

  function categoryTreePath() {
    if (app.isPackaged) {
      return path.join(
        process.resourcesPath,
        "local-api",
        "assets",
        "ozonCategoryTree.zh.json",
      );
    }
    return path.join(
      workspaceRoot,
      "local-api",
      "assets",
      // local-api-owned packaged seed; Renderer never reads this file.
      "ozonCategoryTree.zh.json",
    );
  }

  function desktopDataRoot() {
    return ensureDirectory(app.getPath("userData"));
  }

  function isDescendantPath(root, candidate) {
    const relative = path.relative(root, candidate);
    // On Windows path.relative() returns an absolute path when root and
    // candidate are on different drives (for example C: -> G:).  An absolute
    // relative result is never a descendant.  Without this guard an external
    // workspace SQLite path can accidentally bypass the profile boundary and
    // create two independent runtime databases.
    return (
      relative === "" ||
      (!path.isAbsolute(relative) &&
        !relative.startsWith(`..${path.sep}`) &&
        relative !== "..")
    );
  }

  function assertProfilePath(name, configuredPath, { allowLegacy = false } = {}) {
    const candidate = path.resolve(configuredPath);
    const layout = dataLayout();
    if (isDescendantPath(layout.dataRoot, candidate)) return candidate;
    if (allowLegacy && candidate === layout.legacySecretPath) return candidate;
    throw new Error(`${name} 必须位于当前 profile 数据根内`);
  }

  function dataLayout() {
    return resolveDataLayout({
      dataRoot: desktopDataRoot(),
      localApiRoot: localApiRoot(),
    });
  }

  function localDataRoot() {
    const configuredDirectory = String(
      process.env.WANGZAI_DESKTOP_LOCAL_DATA_DIR || "",
    ).trim();
    return ensureDirectory(
      configuredDirectory
        ? assertProfilePath("WANGZAI_DESKTOP_LOCAL_DATA_DIR", configuredDirectory)
        : dataLayout().localDataRoot,
    );
  }

  function localApiDataDirectory() {
    return ensureDirectory(dataLayout().localApiDataRoot);
  }

  function localApiDatabasePath() {
    const configuredPath = String(process.env.LOCAL_API_DB_PATH || "").trim();
    return configuredPath
      ? assertProfilePath("LOCAL_API_DB_PATH", configuredPath)
      : dataLayout().databasePath;
  }

  function localApiShopDatabaseRoot() {
    const configuredPath = String(process.env.LOCAL_API_SHOP_DB_ROOT || "").trim();
    return configuredPath
      ? assertProfilePath("LOCAL_API_SHOP_DB_ROOT", configuredPath)
      : dataLayout().shopDatabaseRoot;
  }

  function localApiAggregateIndexPath() {
    const configuredPath = String(
      process.env.LOCAL_API_AGGREGATE_INDEX_PATH || "",
    ).trim();
    return configuredPath
      ? assertProfilePath("LOCAL_API_AGGREGATE_INDEX_PATH", configuredPath)
      : dataLayout().aggregateIndexPath;
  }

  function localApiShopDatabaseBackupRoot() {
    const configuredPath = String(
      process.env.LOCAL_API_SHOP_DB_BACKUP_ROOT || "",
    ).trim();
    return configuredPath
      ? assertProfilePath("LOCAL_API_SHOP_DB_BACKUP_ROOT", configuredPath)
      : dataLayout().shopDatabaseBackupRoot;
  }

  function localApiSecretPath() {
    const configuredPath = String(
      process.env.LOCAL_API_SECRET_FILE || "",
    ).trim();
    if (configuredPath) {
      return assertProfilePath("LOCAL_API_SECRET_FILE", configuredPath, {
        allowLegacy: true,
      });
    }

    const layout = dataLayout();
    if (fs.existsSync(layout.secretPath)) return layout.secretPath;
    if (layout.legacySecretPath && fs.existsSync(layout.legacySecretPath)) {
      return layout.legacySecretPath;
    }
    return layout.secretPath;
  }

  function protectedComputeVersionStatePath() {
    return dataLayout().protectedComputeVersionStatePath;
  }

  function ensureProfile() {
    return ensureProfileMetadata(dataLayout());
  }

  function recoveryShellDatabasePath(activeDatabasePath = localApiDatabasePath()) {
    return path.join(path.dirname(activeDatabasePath), "recovery-shell.sqlite");
  }

  function resolveCurrentProfileDatabaseStartup(profile = ensureProfile()) {
    const activeDatabasePath = localApiDatabasePath();
    const recovery = (currentProfile) =>
      Object.freeze({
        mode: "recovery",
        profile: currentProfile,
        activeDatabasePath,
        runtimeDatabasePath: recoveryShellDatabasePath(activeDatabasePath),
      });
    if (profile.databaseLifecycle === "recovery-required") return recovery(profile);
    if (fs.existsSync(activeDatabasePath)) {
      return Object.freeze({
        mode: "normal",
        profile,
        activeDatabasePath,
        runtimeDatabasePath: activeDatabasePath,
      });
    }
    if (profile.databaseLifecycle === "new") {
      return Object.freeze({
        mode: "fresh",
        profile,
        activeDatabasePath,
        runtimeDatabasePath: activeDatabasePath,
      });
    }
    return recovery(markProfileDatabaseRecoveryRequired(dataLayout(), profile));
  }

  function assertCurrentProfileDatabaseAvailable(profile = ensureProfile()) {
    const startup = resolveCurrentProfileDatabaseStartup(profile);
    if (startup.mode === "recovery") {
      throw new Error(`PROFILE_DATABASE_MISSING_RECOVERY_REQUIRED:${startup.activeDatabasePath}`);
    }
    return Object.freeze({
      databasePath: startup.activeDatabasePath,
      fresh: startup.mode === "fresh",
    });
  }

  function markCurrentProfileDatabaseInitialized(profile = ensureProfile(), options) {
    return markProfileDatabaseInitialized(dataLayout(), profile, options);
  }

  function markCurrentProfileDatabaseRecoveryRequired(profile = ensureProfile(), options) {
    return markProfileDatabaseRecoveryRequired(dataLayout(), profile, options);
  }

  function clearCurrentProfileDatabaseRecoveryRequired(profile = ensureProfile()) {
    return clearProfileDatabaseRecoveryRequired(dataLayout(), profile);
  }

  function acquireCurrentProfileLock(profile = ensureProfile()) {
    return acquireProfileLock({ layout: dataLayout(), profile });
  }

  function getMigrationPreview() {
    return createProfileMigrationPreview({
      layout: dataLayout(),
      workspaceRoot,
      localApiRoot: localApiRoot(),
    });
  }

  function logDirectory() {
    return ensureDirectory(dataLayout().logDirectory);
  }

  return Object.freeze({
    desktopRoot,
    workspaceRoot,
    ensureDirectory,
    frontendDistDirectory,
    localApiRoot,
    localCacheAgentRoot,
    purchaseBridgeScriptPath,
    purchaseBridgeWorkingDirectory,
    categoryTreePath,
    desktopDataRoot,
    dataLayout,
    localDataRoot,
    localApiDataDirectory,
    localApiDatabasePath,
    localApiShopDatabaseRoot,
    localApiAggregateIndexPath,
    localApiShopDatabaseBackupRoot,
    localApiSecretPath,
    protectedComputeVersionStatePath,
    ensureProfile,
    recoveryShellDatabasePath,
    resolveCurrentProfileDatabaseStartup,
    assertCurrentProfileDatabaseAvailable,
    markCurrentProfileDatabaseInitialized,
    markCurrentProfileDatabaseRecoveryRequired,
    clearCurrentProfileDatabaseRecoveryRequired,
    acquireCurrentProfileLock,
    getMigrationPreview,
    logDirectory,
  });
}
