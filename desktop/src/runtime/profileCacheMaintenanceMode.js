import { createHash } from "node:crypto";
import path from "node:path";
import {
  applyProfileCacheMaintenance,
  inspectProfileCacheMaintenance,
} from "./profileCacheMaintenance.js";
import {
  PROFILE_MAINTENANCE_COMMANDS,
  assertProfileMaintenanceCommandBoundary,
} from "./profileCachePolicy.js";
import { PROFILE_CACHE_CLEAR_CONFIRMATION } from "./profileCacheReset.js";
import { acquireProfileLock } from "./profileLock.js";

export const PROFILE_CACHE_MAINTENANCE_MODE_VERSION =
  "profile-cache-maintenance-startup-mode-v1";

const COMMAND = PROFILE_MAINTENANCE_COMMANDS.CLEAR_TRANSIENT_CACHE;
const RESTART = Object.freeze({
  required: true,
  kind: "normal-application-restart",
  continueStartup: false,
});

function errorPayload(error, fallbackCode) {
  return {
    code: String(error?.code || fallbackCode),
    name: String(error?.name || "Error"),
    message: String(error?.message || error || "未知错误"),
  };
}

function maintenanceResult(payload) {
  return {
    version: PROFILE_CACHE_MAINTENANCE_MODE_VERSION,
    command: COMMAND,
    restartRequired: true,
    requiresNormalRestart: true,
    continueStartup: false,
    restart: RESTART,
    ...payload,
  };
}

function readRuntimeState(options) {
  if (
    typeof options.isLocalApiStarted !== "function" ||
    typeof options.isBridgeStarted !== "function"
  ) {
    const error = new Error(
      "启动维护模式必须由 main 提供 local-api 与 bridge 的实时启动状态回调",
    );
    error.code = "PROFILE_CACHE_MAINTENANCE_RUNTIME_STATE_REQUIRED";
    throw error;
  }
  return {
    localApiStarted: Boolean(options.isLocalApiStarted()),
    bridgeStarted: Boolean(options.isBridgeStarted()),
  };
}

function assertRuntimeStopped(options) {
  const state = readRuntimeState(options);
  if (state.localApiStarted || state.bridgeStarted) {
    const started = [
      state.localApiStarted ? "local-api" : "",
      state.bridgeStarted ? "bridge" : "",
    ].filter(Boolean);
    const error = new Error(
      `普通清缓存只能在服务启动前执行；已启动：${started.join(", ")}`,
    );
    error.code = "PROFILE_CACHE_MAINTENANCE_SERVICES_ALREADY_STARTED";
    throw error;
  }
  return state;
}

function acquireModeLock(dataRoot, acquireLock) {
  const normalizedRoot = path.resolve(String(dataRoot || "").trim());
  if (!String(dataRoot || "").trim()) {
    const error = new Error("启动维护模式缺少 dataRoot");
    error.code = "PROFILE_CACHE_MAINTENANCE_DATA_ROOT_REQUIRED";
    throw error;
  }
  const dataRootFingerprint = createHash("sha256")
    .update(normalizedRoot.toLowerCase())
    .digest("hex");
  return acquireLock({
    layout: {
      profileLockPath: path.join(normalizedRoot, "runtime", "profile.lock"),
    },
    profile: {
      profileId: "profile-cache-maintenance-startup-mode",
      dataRootFingerprint,
    },
  });
}

function bytesLabel(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function createConfirmationDialog(preview) {
  const clearableFileBytes = Number(preview?.totals?.clearableFileBytes) || 0;
  const databaseRows = Number(preview?.totals?.databaseClearableRows) || 0;
  const protectedTables = Object.keys(preview?.database?.protected || {}).length;
  const protectedFileBytes = Number(preview?.totals?.protectedFileBytes) || 0;
  const unknownProtected = Number(preview?.totals?.unknownProtectedResources) || 0;
  return {
    type: "warning",
    title: "普通清缓存只读预览",
    message: "已完成只读预览。是否仅清除登记的临时缓存？",
    detail: [
      `SQLite 临时缓存：${databaseRows} 行`,
      `临时缓存文件：${bytesLabel(clearableFileBytes)}`,
      `受保护 SQLite 表：${protectedTables} 个`,
      `受保护文件：${bytesLabel(protectedFileBytes)}`,
      `未知资源（默认保护）：${unknownProtected} 个`,
      "不会执行释放空间、领域重建或永久删除，也不会删除商品、订单、佣金、设置或账号数据。",
      "操作结束后必须正常重启应用。",
    ].join("\n"),
    buttons: ["确认仅清除临时缓存", "取消"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    checkboxLabel: "我已核对预览，并确认只执行普通清缓存",
    checkboxChecked: false,
  };
}

function previewSummary(preview) {
  return {
    mode: preview.mode,
    previewToken: preview.previewToken,
    totals: preview.totals,
    protectedDatabaseDigest: preview.database?.protectedDigest || null,
    protectedFileDigest: preview.files?.protectedDigest || null,
  };
}

/**
 * Runs before local-api and purchase bridge startup. The native dialog is
 * injected by main so this module remains testable without importing Electron.
 */
export async function runProfileCacheMaintenanceMode(options = {}, dependencies = {}) {
  const inspect = dependencies.inspectProfileCacheMaintenance
    || inspectProfileCacheMaintenance;
  const apply = dependencies.applyProfileCacheMaintenance
    || applyProfileCacheMaintenance;
  const acquireLock = dependencies.acquireProfileLock || acquireProfileLock;
  let lock = null;
  let preview = null;
  try {
    const requestedCommand = String(options.command || COMMAND).trim();
    assertProfileMaintenanceCommandBoundary(requestedCommand, COMMAND);
    assertRuntimeStopped(options);
    if (typeof options.showMessageBox !== "function") {
      const error = new Error("启动维护模式缺少 Electron 原生 showMessageBox");
      error.code = "PROFILE_CACHE_MAINTENANCE_NATIVE_DIALOG_REQUIRED";
      throw error;
    }

    lock = acquireModeLock(options.dataRoot, acquireLock);
    assertRuntimeStopped(options);
    preview = await inspect({
      command: COMMAND,
      dataRoot: options.dataRoot,
      workspaceRoot: options.workspaceRoot,
      databasePath: options.databasePath,
    });
    const dialogResult = await options.showMessageBox(
      createConfirmationDialog(preview),
    );
    const explicitlyConfirmed = Number(dialogResult?.response) === 0
      && dialogResult?.checkboxChecked === true;
    if (!explicitlyConfirmed) {
      return maintenanceResult({
        ok: true,
        completed: false,
        cancelled: true,
        status: "cancelled",
        reason: Number(dialogResult?.response) === 0
          ? "explicit-checkbox-not-confirmed"
          : "native-dialog-cancelled",
        mutationStarted: false,
        preview: previewSummary(preview),
        lock: { path: lock.lockPath, heldForEntireMode: true },
      });
    }

    assertRuntimeStopped(options);
    if (typeof options.assertBeforeMutation === "function") {
      await options.assertBeforeMutation();
    }
    const applied = await apply({
      command: COMMAND,
      confirmation: PROFILE_CACHE_CLEAR_CONFIRMATION,
      previewToken: preview.previewToken,
      dataRoot: options.dataRoot,
      workspaceRoot: options.workspaceRoot,
      databasePath: options.databasePath,
      backupDirectory: options.backupDirectory,
      now: options.now,
      testHooks: options.testHooks,
      maintenanceLock: lock,
      assertBeforeMutation: options.assertBeforeMutation,
    });
    return maintenanceResult({
      ok: true,
      completed: true,
      cancelled: false,
      status: "completed",
      mutationStarted: true,
      preview: previewSummary(preview),
      maintenance: applied,
      reportPath: applied?.reportPath || null,
      rollbackVerified: false,
      lock: { path: lock.lockPath, heldForEntireMode: true },
    });
  } catch (error) {
    return maintenanceResult({
      ok: false,
      completed: false,
      cancelled: false,
      status: "failed",
      mutationStarted: Boolean(error?.reportPath || error?.rollback),
      preview: preview ? previewSummary(preview) : null,
      error: errorPayload(error, "PROFILE_CACHE_MAINTENANCE_MODE_FAILED"),
      reportPath: error?.reportPath || null,
      rollback: error?.rollback || null,
      rollbackError: error?.rollbackError
        ? errorPayload(
            error.rollbackError,
            "PROFILE_CACHE_MAINTENANCE_ROLLBACK_FAILED",
          )
        : null,
      rollbackVerified: Boolean(error?.rollback && !error?.rollbackError),
      lock: lock
        ? { path: lock.lockPath, heldForEntireMode: true }
        : { path: null, heldForEntireMode: false },
    });
  } finally {
    lock?.release();
  }
}
