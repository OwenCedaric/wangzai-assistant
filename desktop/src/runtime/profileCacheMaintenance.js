import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { finalizeSuccessfulProfileCacheMaintenance, safeProfileMaintenanceTimestamp, writeProfileMaintenanceJson } from "./profileCacheMaintenanceReport.js";
import { DatabaseSync } from "node:sqlite";
import {
  ORDINARY_CLEARABLE_ELECTRON_CACHE_DIRECTORIES,
  ORDINARY_CLEARABLE_LOCAL_DATA_FILES,
  PROFILE_MAINTENANCE_COMMANDS,
  PROTECTED_ELECTRON_STORAGE_DIRECTORIES,
  PROTECTED_LOCAL_DATA_FILES,
  PROTECTED_RETIRED_WORKSPACE_DIRECTORIES,
  PROTECTED_RETIRED_WORKSPACE_FILES,
  assertProfileMaintenanceCommandBoundary,
} from "./profileCachePolicy.js";
import {
  PROFILE_CACHE_CLEAR_CONFIRMATION,
  clearProfileTransientCache,
  inspectProfileCache,
} from "./profileCacheReset.js";
import { acquireProfileLock } from "./profileLock.js";

export const PROFILE_CACHE_MAINTENANCE_VERSION =
  "profile-cache-maintenance-v4";

const ORDINARY_CACHE_COMMAND =
  PROFILE_MAINTENANCE_COMMANDS.CLEAR_TRANSIENT_CACHE;

function requiredAbsolutePath(value, fieldName) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${fieldName} 不能为空`);
  return path.resolve(normalized);
}

function normalizeRelativePath(value) {
  return String(value || "").split(path.sep).join("/");
}

function normalizedPathKey(value) {
  return path.resolve(value).toLowerCase();
}

function isDescendantPath(root, candidate) {
  const relativePath = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relativePath === "" ||
    (!relativePath.startsWith(`..${path.sep}`) &&
      relativePath !== ".." &&
      !path.isAbsolute(relativePath))
  );
}

function resolveOwnedPath(root, relativePath, label) {
  const candidate = path.resolve(root, ...String(relativePath).split("/"));
  if (!isDescendantPath(root, candidate)) {
    throw new Error(`${label} 超出允许目录：${relativePath}`);
  }
  return candidate;
}

function nodeType(stat) {
  if (stat.isDirectory()) return "directory";
  if (stat.isFile()) return "file";
  if (stat.isSymbolicLink()) return "symlink";
  return "other";
}

function pathBytes(targetPath) {
  if (!fs.existsSync(targetPath)) return 0;
  const stat = fs.lstatSync(targetPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return stat.size;
  return fs
    .readdirSync(targetPath, { withFileTypes: true })
    .reduce((sum, entry) => sum + pathBytes(path.join(targetPath, entry.name)), 0);
}

function pathFingerprint(targetPath) {
  const hash = createHash("sha256");
  const root = path.resolve(targetPath);
  const visit = (currentPath) => {
    const stat = fs.lstatSync(currentPath);
    const relativePath =
      normalizeRelativePath(path.relative(root, currentPath)) || ".";
    if (stat.isSymbolicLink()) {
      hash
        .update("L\0")
        .update(relativePath)
        .update("\0")
        .update(fs.readlinkSync(currentPath))
        .update("\n");
      return;
    }
    if (stat.isDirectory()) {
      hash.update("D\0").update(relativePath).update("\n");
      fs.readdirSync(currentPath, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name))
        .forEach((entry) => visit(path.join(currentPath, entry.name)));
      return;
    }
    if (stat.isFile()) {
      hash
        .update("F\0")
        .update(relativePath)
        .update("\0")
        .update(String(stat.size))
        .update("\0")
        .update(fs.readFileSync(currentPath))
        .update("\n");
      return;
    }
    hash
      .update("O\0")
      .update(relativePath)
      .update("\0")
      .update(String(stat.mode))
      .update("\n");
  };
  visit(root);
  return hash.digest("hex");
}

function safeStat(targetPath, { fingerprint = false } = {}) {
  if (!fs.existsSync(targetPath)) return null;
  const stat = fs.lstatSync(targetPath);
  return {
    exists: true,
    path: targetPath,
    type: nodeType(stat),
    bytes: pathBytes(targetPath),
    modifiedAt: stat.mtime.toISOString(),
    ...(fingerprint ? { sha256: pathFingerprint(targetPath) } : {}),
  };
}

function absentPathState(entry) {
  return {
    ...entry,
    exists: false,
    type: "absent",
    bytes: 0,
    modifiedAt: null,
    sha256: null,
  };
}

function materializePaths(
  items,
  { fingerprint = false, includeMissing = false } = {},
) {
  const seen = new Set();
  const result = [];
  items.forEach((item) => {
    const key = normalizedPathKey(item.path);
    if (seen.has(key)) return;
    seen.add(key);
    const state = safeStat(item.path, { fingerprint });
    if (state) result.push({ ...item, ...state });
    else if (includeMissing) result.push(absentPathState(item));
  });
  return result;
}

function listSnapshotVariants(root, scope) {
  const directories = [
    {
      relativeDirectory: "本地数据/分类缓存/09-售后订单",
      prefix: "after-sales-display-snapshots",
    },
    {
      relativeDirectory: "本地数据/分类缓存/10-利润核算",
      prefix: "profit-local-cache",
    },
  ];
  const files = [];
  directories.forEach(({ relativeDirectory, prefix }) => {
    const directory = resolveOwnedPath(
      root,
      relativeDirectory,
      `${scope}受保护快照目录`,
    );
    if (!fs.existsSync(directory) || !fs.lstatSync(directory).isDirectory()) return;
    fs.readdirSync(directory, { withFileTypes: true }).forEach((entry) => {
      if (
        !entry.isFile() ||
        !entry.name.startsWith(prefix) ||
        !entry.name.endsWith(".json")
      ) {
        return;
      }
      files.push({
        scope,
        root,
        relativePath: `${relativeDirectory}/${entry.name}`,
        path: path.join(directory, entry.name),
      });
    });
  });
  return files;
}

function listExactPaths(
  root,
  scope,
  relativePaths,
  label,
  { fingerprint = false, includeMissing = false } = {},
) {
  return materializePaths(
    relativePaths.map((relativePath) => ({
      scope,
      root,
      relativePath: normalizeRelativePath(relativePath),
      path: resolveOwnedPath(root, relativePath, label),
    })),
    { fingerprint, includeMissing },
  );
}

function listProtectedLocalFiles(root, scope) {
  const exact = PROTECTED_LOCAL_DATA_FILES.map((relativePath) => ({
    scope,
    root,
    relativePath,
    path: resolveOwnedPath(root, relativePath, `${scope}受保护业务文件`),
  }));
  const declared = materializePaths(exact, {
    fingerprint: true,
    includeMissing: true,
  });
  const variants = materializePaths(listSnapshotVariants(root, scope), {
    fingerprint: true,
  });
  return materializePaths([...declared, ...variants], {
    fingerprint: true,
    includeMissing: true,
  });
}

function readJsonObject(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function isProcessRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function inspectProfileLock(dataRoot) {
  const lockPath = resolveOwnedPath(dataRoot, "runtime/profile.lock", "profile lock");
  const lock = readJsonObject(lockPath);
  const pid = Number(lock.pid);
  return {
    path: lockPath,
    exists: fs.existsSync(lockPath),
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    active: isProcessRunning(pid),
  };
}

function resolveMaintenanceContext(options = {}) {
  const dataRoot = requiredAbsolutePath(options.dataRoot, "dataRoot");
  const workspaceRoot = requiredAbsolutePath(options.workspaceRoot, "workspaceRoot");
  const databasePath = requiredAbsolutePath(
    options.databasePath ||
      path.join(dataRoot, "local-api-data", "wangzai-local-api.sqlite"),
    "databasePath",
  );
  if (!isDescendantPath(dataRoot, databasePath)) {
    throw new Error("canonical databasePath 必须位于 desktop dataRoot 内");
  }
  if (!fs.existsSync(databasePath)) {
    throw new Error(`canonical SQLite 不存在：${databasePath}`);
  }
  return { dataRoot, workspaceRoot, databasePath };
}

function openProfileDatabase(databasePath, { readOnly = false } = {}) {
  const db = new DatabaseSync(databasePath, readOnly ? { readOnly: true } : {});
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

function checkpointDatabase(databasePath) {
  const db = openProfileDatabase(databasePath);
  try {
    const quickCheck = String(
      db.prepare("PRAGMA quick_check").get()?.quick_check || "",
    );
    if (quickCheck !== "ok") {
      throw new Error(
        `canonical SQLite quick_check 失败：${quickCheck || "unknown"}`,
      );
    }
    const checkpoint = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() || {};
    if (Number(checkpoint.busy) > 0) {
      throw new Error("canonical SQLite 正在被占用，无法执行普通清缓存");
    }
    return { quickCheck, checkpoint: { ...checkpoint } };
  } finally {
    db.close();
  }
}

function inspectDatabase(databasePath) {
  const db = openProfileDatabase(databasePath, { readOnly: true });
  try {
    return inspectProfileCache(db);
  } finally {
    db.close();
  }
}

function flattenGroups(groups) {
  return Object.entries(groups).flatMap(([group, entries]) =>
    entries.map((entry) => ({ ...entry, group })),
  );
}

function protectedCollectionDigest(groups) {
  const hash = createHash("sha256");
  flattenGroups(groups)
    .sort((left, right) =>
      `${left.group}:${left.scope}:${left.relativePath}`.localeCompare(
        `${right.group}:${right.scope}:${right.relativePath}`,
      ),
    )
    .forEach((entry) => {
      hash
        .update(entry.group)
        .update("\0")
        .update(entry.scope)
        .update("\0")
        .update(entry.relativePath)
        .update("\0")
        .update(entry.type)
        .update("\0")
        .update(String(entry.bytes || 0))
        .update("\0")
        .update(String(entry.sha256 || ""))
        .update("\n");
    });
  return hash.digest("hex");
}

function clearableCollectionDigest(groups) {
  const hash = createHash("sha256");
  flattenGroups(groups)
    .sort((left, right) =>
      `${left.group}:${left.scope}:${left.relativePath}`.localeCompare(
        `${right.group}:${right.scope}:${right.relativePath}`,
      ),
    )
    .forEach((entry) => {
      hash
        .update(entry.group)
        .update("\0")
        .update(entry.scope)
        .update("\0")
        .update(entry.relativePath)
        .update("\0")
        .update(entry.type)
        .update("\0")
        .update(String(entry.bytes || 0))
        .update("\0")
        .update(String(entry.sha256 || ""))
        .update("\n");
    });
  return hash.digest("hex");
}

function isExactPathInSet(candidate, pathSet) {
  return pathSet.has(normalizedPathKey(candidate));
}

function containsKnownDescendant(candidate, paths) {
  return paths.some(
    (knownPath) =>
      normalizedPathKey(candidate) !== normalizedPathKey(knownPath) &&
      isDescendantPath(candidate, knownPath),
  );
}

function listUnknownInManagedRoot({
  containerPath,
  root,
  scope,
  knownPaths = [],
  skippedPaths = [],
}) {
  if (!fs.existsSync(containerPath) || !fs.lstatSync(containerPath).isDirectory()) {
    return [];
  }
  const knownSet = new Set(knownPaths.map(normalizedPathKey));
  const skippedSet = new Set(skippedPaths.map(normalizedPathKey));
  const navigationPaths = [...knownPaths, ...skippedPaths];
  const unknown = [];

  const visit = (candidate) => {
    if (
      isExactPathInSet(candidate, knownSet) ||
      isExactPathInSet(candidate, skippedSet)
    ) {
      return;
    }
    const stat = fs.lstatSync(candidate);
    if (stat.isDirectory() && containsKnownDescendant(candidate, navigationPaths)) {
      fs.readdirSync(candidate, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name))
        .forEach((entry) => visit(path.join(candidate, entry.name)));
      return;
    }
    unknown.push({
      scope,
      root,
      relativePath: normalizeRelativePath(path.relative(root, candidate)),
      path: candidate,
    });
  };

  fs.readdirSync(containerPath, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .forEach((entry) => visit(path.join(containerPath, entry.name)));
  return materializePaths(unknown, { fingerprint: true });
}

function listUnsafeNodes(entries) {
  const unsafe = [];
  const visited = new Set();
  const visit = (currentPath, owner) => {
    const key = normalizedPathKey(currentPath);
    if (visited.has(key) || !fs.existsSync(currentPath)) return;
    visited.add(key);
    const stat = fs.lstatSync(currentPath);
    const type = nodeType(stat);
    if (type === "symlink" || type === "other") {
      unsafe.push({
        owner: owner.relativePath,
        path: currentPath,
        type,
        reason: "普通清缓存拒绝跟随或复制符号链接/特殊文件",
      });
      return;
    }
    if (!stat.isDirectory()) return;
    fs.readdirSync(currentPath, { withFileTypes: true }).forEach((entry) =>
      visit(path.join(currentPath, entry.name), owner),
    );
  };
  entries.filter((entry) => entry.exists).forEach((entry) => visit(entry.path, entry));
  return unsafe;
}

function inspectProfileFileResources({ dataRoot, workspaceRoot, databasePath }) {
  const clearableState = {
    profileCacheFiles: listExactPaths(
      dataRoot,
      "profile",
      ORDINARY_CLEARABLE_LOCAL_DATA_FILES,
      "profile 瞬时缓存文件",
      { fingerprint: true, includeMissing: true },
    ),
    workspaceCacheFiles: listExactPaths(
      workspaceRoot,
      "workspace",
      ORDINARY_CLEARABLE_LOCAL_DATA_FILES,
      "workspace 瞬时缓存文件",
      { fingerprint: true, includeMissing: true },
    ),
    electronCacheDirectories: listExactPaths(
      dataRoot,
      "profile",
      ORDINARY_CLEARABLE_ELECTRON_CACHE_DIRECTORIES,
      "Electron 瞬时缓存目录",
      { fingerprint: true, includeMissing: true },
    ),
  };
  const clearable = Object.fromEntries(
    Object.entries(clearableState).map(([group, entries]) => [
      group,
      entries.filter((entry) => entry.exists),
    ]),
  );

  const protectedGroups = {
    profileLocalFiles: listProtectedLocalFiles(dataRoot, "profile"),
    workspaceLocalFiles: listProtectedLocalFiles(workspaceRoot, "workspace"),
    electronStorageDirectories: listExactPaths(
      dataRoot,
      "profile",
      PROTECTED_ELECTRON_STORAGE_DIRECTORIES,
      "Electron 受保护存储目录",
      { fingerprint: true, includeMissing: true },
    ),
    retiredWorkspaceFiles: listExactPaths(
      workspaceRoot,
      "workspace",
      PROTECTED_RETIRED_WORKSPACE_FILES,
      "旧工作区受保护文件",
      { fingerprint: true, includeMissing: true },
    ),
    retiredWorkspaceDirectories: listExactPaths(
      workspaceRoot,
      "workspace",
      PROTECTED_RETIRED_WORKSPACE_DIRECTORIES,
      "旧工作区受保护目录",
      { fingerprint: true, includeMissing: true },
    ),
    canonicalSecrets: listExactPaths(
      dataRoot,
      "profile",
      ["local-api-data/local-api-secret.key"],
      "canonical secret",
      { fingerprint: true, includeMissing: true },
    ),
  };

  const knownProfilePaths = [
    ...flattenGroups(clearableState),
    ...flattenGroups(protectedGroups).filter((entry) => entry.scope === "profile"),
  ].map((entry) => entry.path);
  const knownWorkspacePaths = [
    ...flattenGroups(clearableState),
    ...flattenGroups(protectedGroups).filter((entry) => entry.scope === "workspace"),
  ].map((entry) => entry.path);

  const dataLocalRoot = resolveOwnedPath(dataRoot, "本地数据", "profile 本地数据根");
  const workspaceLocalRoot = resolveOwnedPath(
    workspaceRoot,
    "本地数据",
    "workspace 本地数据根",
  );
  const canonicalDataRoot = resolveOwnedPath(
    dataRoot,
    "local-api-data",
    "canonical 数据根",
  );
  const runtimeRoot = resolveOwnedPath(dataRoot, "runtime", "profile runtime 根");
  const retiredDataRoot = resolveOwnedPath(
    workspaceRoot,
    "local-api/data",
    "旧工作区数据根",
  );
  const profileLockPath = resolveOwnedPath(
    dataRoot,
    "runtime/profile.lock",
    "profile lock",
  );
  const backupRoot = resolveOwnedPath(dataRoot, "backups", "profile 备份根");

  const unknownResources = materializePaths(
    [
      ...listUnknownInManagedRoot({
        containerPath: dataRoot,
        root: dataRoot,
        scope: "profile",
        knownPaths: knownProfilePaths,
        skippedPaths: [dataLocalRoot, canonicalDataRoot, runtimeRoot, backupRoot],
      }),
      ...listUnknownInManagedRoot({
        containerPath: dataLocalRoot,
        root: dataRoot,
        scope: "profile",
        knownPaths: knownProfilePaths,
      }),
      ...listUnknownInManagedRoot({
        containerPath: canonicalDataRoot,
        root: dataRoot,
        scope: "profile",
        knownPaths: knownProfilePaths,
        skippedPaths: [databasePath, `${databasePath}-wal`, `${databasePath}-shm`],
      }),
      ...listUnknownInManagedRoot({
        containerPath: runtimeRoot,
        root: dataRoot,
        scope: "profile",
        skippedPaths: [profileLockPath],
      }),
      ...listUnknownInManagedRoot({
        containerPath: workspaceLocalRoot,
        root: workspaceRoot,
        scope: "workspace",
        knownPaths: knownWorkspacePaths,
      }),
      ...listUnknownInManagedRoot({
        containerPath: retiredDataRoot,
        root: workspaceRoot,
        scope: "workspace",
        knownPaths: knownWorkspacePaths,
      }),
    ],
    { fingerprint: true },
  );
  protectedGroups.unknownResources = unknownResources;

  const snapshotEntries = [
    ...flattenGroups(clearableState),
    ...flattenGroups(protectedGroups),
  ];
  const blockedResources = listUnsafeNodes(snapshotEntries);
  return {
    clearable,
    clearableState,
    clearableDigest: clearableCollectionDigest(clearableState),
    protected: protectedGroups,
    protectedDigest: protectedCollectionDigest(protectedGroups),
    unknownProtection: {
      defaultAction: "protect-and-fingerprint",
      resources: unknownResources.length,
    },
    blockedResources,
  };
}

function createPreviewToken(preview) {
  const hash = createHash("sha256");
  const append = (value) => hash.update(String(value ?? "")).update("\n");
  append(preview.command);
  append(preview.version);
  append(normalizedPathKey(preview.dataRoot));
  append(normalizedPathKey(preview.workspaceRoot));
  append(normalizedPathKey(preview.databasePath));
  append(preview.database.policyVersion);
  append(preview.database.quickCheck);
  append(preview.database.protectedDigest);
  Object.entries(preview.database.clearable)
    .sort(([left], [right]) => left.localeCompare(right))
    .forEach(([tableName, fingerprint]) => {
      append(tableName);
      append(fingerprint.rows);
      append(fingerprint.sha256);
    });
  append(preview.files.clearableDigest);
  append(preview.files.protectedDigest);
  preview.files.blockedResources
    .map((entry) => `${normalizedPathKey(entry.path)}:${entry.type}`)
    .sort()
    .forEach(append);
  return hash.digest("hex");
}

export function inspectProfileCacheMaintenance(options = {}) {
  const command = String(options.command || ORDINARY_CACHE_COMMAND).trim();
  const commandContract = assertProfileMaintenanceCommandBoundary(
    command,
    ORDINARY_CACHE_COMMAND,
  );
  const context = resolveMaintenanceContext(options);
  const lock = inspectProfileLock(context.dataRoot);
  const database = inspectDatabase(context.databasePath);
  const files = inspectProfileFileResources(context);

  const preview = {
    ok: true,
    mode: "read-only-profile-transient-cache-preview",
    command,
    commandContract,
    version: PROFILE_CACHE_MAINTENANCE_VERSION,
    ...context,
    lock,
    database,
    files,
    totals: {
      databaseClearableRows: database.totals.clearableRows,
      clearableFileBytes: Object.values(files.clearable)
        .flat()
        .reduce((sum, entry) => sum + entry.bytes, 0),
      protectedFileBytes: Object.values(files.protected)
        .flat()
        .reduce((sum, entry) => sum + entry.bytes, 0),
      unknownProtectedResources: files.unknownProtection.resources,
    },
  };
  return { ...preview, previewToken: createPreviewToken(preview) };
}

function copyPathWithParents(sourcePath, destinationPath) {
  const stat = fs.lstatSync(sourcePath);
  const type = nodeType(stat);
  if (type !== "file" && type !== "directory") {
    throw new Error(`无法为 ${type} 创建可恢复副本：${sourcePath}`);
  }
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  if (type === "directory") {
    fs.cpSync(sourcePath, destinationPath, {
      recursive: true,
      force: false,
      errorOnExist: true,
      dereference: false,
      preserveTimestamps: true,
    });
  } else {
    fs.copyFileSync(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
  }
  return safeStat(destinationPath, { fingerprint: true });
}

function copyFileWithParents(sourcePath, destinationPath) {
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.copyFileSync(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
  return pathBytes(destinationPath);
}

function backupCanonicalProfile(preview, backupRoot) {
  const databaseDestination = resolveOwnedPath(
    backupRoot,
    "canonical/wangzai-local-api.sqlite",
    "canonical SQLite 保护副本",
  );
  const databaseBytes = copyFileWithParents(
    preview.databasePath,
    databaseDestination,
  );
  const backupCheck = checkpointDatabase(databaseDestination);
  const secretPath = resolveOwnedPath(
    preview.dataRoot,
    "local-api-data/local-api-secret.key",
    "canonical secret",
  );
  let secretBackup = null;
  if (fs.existsSync(secretPath)) {
    const destination = resolveOwnedPath(
      backupRoot,
      "canonical/local-api-secret.key",
      "canonical secret 保护副本",
    );
    secretBackup = {
      destination,
      bytes: copyFileWithParents(secretPath, destination),
    };
  }
  return {
    databaseDestination,
    databaseBytes,
    databaseQuickCheck: backupCheck.quickCheck,
    secretBackup,
  };
}

function uniqueSnapshotEntries(entries) {
  const byPath = new Map();
  entries.forEach((entry) => {
    const key = normalizedPathKey(entry.path);
    const current = byPath.get(key);
    if (current && current.category !== entry.category) {
      throw new Error(`缓存资源同时被分到 clearable/protected：${entry.path}`);
    }
    if (!current) byPath.set(key, entry);
  });
  return [...byPath.values()];
}

function createFilesystemSnapshot(preview, backupRoot) {
  const entries = uniqueSnapshotEntries([
    ...flattenGroups(preview.files.clearableState).map((entry) => ({
      ...entry,
      category: "clearable",
    })),
    ...flattenGroups(preview.files.protected).map((entry) => ({
      ...entry,
      category: "protected",
    })),
  ]);
  const backups = [];
  entries
    .filter((entry) => entry.exists)
    .forEach((entry) => {
      const destination = resolveOwnedPath(
        backupRoot,
        `filesystem/${entry.category}/${entry.scope}/${entry.relativePath}`,
        "普通清缓存文件事务副本",
      );
      const copied = copyPathWithParents(entry.path, destination);
      if (copied.sha256 !== entry.sha256) {
        throw new Error(`文件事务副本指纹不一致：${entry.path}`);
      }
      backups.push({
        path: entry.path,
        category: entry.category,
        scope: entry.scope,
        relativePath: entry.relativePath,
        destination,
        bytes: copied.bytes,
        sha256: copied.sha256,
        type: copied.type,
      });
    });
  return {
    policy: "restore-entire-before-state-on-any-post-mutation-failure",
    entries,
    backups,
  };
}

function removeOwnedPath(root, targetPath, label) {
  if (!isDescendantPath(root, targetPath)) {
    throw new Error(`${label} 超出允许目录：${targetPath}`);
  }
  const before = safeStat(targetPath);
  if (!before) return { path: targetPath, removed: false, bytes: 0 };
  fs.rmSync(targetPath, {
    recursive: before.type === "directory",
    force: true,
  });
  if (fs.existsSync(targetPath)) {
    throw new Error(`${label} 清理后仍然存在：${targetPath}`);
  }
  return {
    path: targetPath,
    removed: true,
    bytes: before.bytes,
    type: before.type,
  };
}

let restoreSequence = 0;

function restorePathAtomically(entry, backup) {
  if (!isDescendantPath(entry.root, entry.path)) {
    throw new Error(`恢复目标超出受管根目录：${entry.path}`);
  }
  if (!entry.exists) {
    return removeOwnedPath(entry.root, entry.path, "恢复缺失态");
  }
  if (!backup || !fs.existsSync(backup.destination)) {
    throw new Error(`缺少文件恢复副本：${entry.path}`);
  }
  const backupState = safeStat(backup.destination, { fingerprint: true });
  if (!backupState || backupState.sha256 !== entry.sha256) {
    throw new Error(`文件恢复副本校验失败：${entry.path}`);
  }
  restoreSequence += 1;
  const temporaryPath = `${entry.path}.profile-cache-restore-${process.pid}-${restoreSequence}`;
  if (!isDescendantPath(entry.root, temporaryPath)) {
    throw new Error(`文件恢复临时路径越界：${temporaryPath}`);
  }
  fs.rmSync(temporaryPath, { recursive: true, force: true });
  copyPathWithParents(backup.destination, temporaryPath);
  const temporaryState = safeStat(temporaryPath, { fingerprint: true });
  if (!temporaryState || temporaryState.sha256 !== entry.sha256) {
    fs.rmSync(temporaryPath, { recursive: true, force: true });
    throw new Error(`文件恢复临时副本校验失败：${entry.path}`);
  }
  fs.rmSync(entry.path, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(entry.path), { recursive: true });
  fs.renameSync(temporaryPath, entry.path);
  const restored = safeStat(entry.path, { fingerprint: true });
  if (!restored || restored.sha256 !== entry.sha256) {
    throw new Error(`文件恢复后指纹不一致：${entry.path}`);
  }
  return { path: entry.path, restored: true, bytes: restored.bytes };
}

function restoreCanonicalDatabase(canonicalBackup, databasePath) {
  const backupPath = canonicalBackup.databaseDestination;
  if (!fs.existsSync(backupPath)) throw new Error("canonical SQLite 恢复副本不存在");
  const temporaryPath = `${databasePath}.profile-cache-restore-${process.pid}`;
  fs.rmSync(temporaryPath, { force: true });
  fs.copyFileSync(backupPath, temporaryPath, fs.constants.COPYFILE_EXCL);
  const temporaryCheck = checkpointDatabase(temporaryPath);
  fs.rmSync(`${temporaryPath}-wal`, { force: true });
  fs.rmSync(`${temporaryPath}-shm`, { force: true });
  fs.rmSync(`${databasePath}-wal`, { force: true });
  fs.rmSync(`${databasePath}-shm`, { force: true });
  fs.rmSync(databasePath, { force: true });
  fs.renameSync(temporaryPath, databasePath);
  const restoredCheck = checkpointDatabase(databasePath);
  return {
    restored: true,
    databasePath,
    temporaryQuickCheck: temporaryCheck.quickCheck,
    restoredQuickCheck: restoredCheck.quickCheck,
  };
}

function restoreFilesystemSnapshot(snapshot, currentFiles) {
  const backupByPath = new Map(
    snapshot.backups.map((entry) => [normalizedPathKey(entry.path), entry]),
  );
  const baselineByPath = new Map(
    snapshot.entries.map((entry) => [normalizedPathKey(entry.path), entry]),
  );
  const currentEntries = currentFiles
    ? uniqueSnapshotEntries([
        ...flattenGroups(currentFiles.clearableState).map((entry) => ({
          ...entry,
          category: "clearable",
        })),
        ...flattenGroups(currentFiles.protected).map((entry) => ({
          ...entry,
          category: "protected",
        })),
      ])
    : [];
  const removedNewProtected = [];
  currentEntries
    .filter(
      (entry) =>
        entry.exists &&
        entry.category === "protected" &&
        !baselineByPath.has(normalizedPathKey(entry.path)),
    )
    .sort((left, right) => right.path.length - left.path.length)
    .forEach((entry) => {
      removedNewProtected.push(
        removeOwnedPath(entry.root, entry.path, "回滚新增未知受保护资源"),
      );
    });

  const restored = [];
  snapshot.entries
    .slice()
    .sort((left, right) => left.path.length - right.path.length)
    .forEach((entry) => {
      restored.push(
        restorePathAtomically(entry, backupByPath.get(normalizedPathKey(entry.path))),
      );
    });
  return { restored, removedNewProtected };
}

function acquireMaintenanceLock(dataRoot) {
  const lockPath = resolveOwnedPath(dataRoot, "runtime/profile.lock", "profile lock");
  const dataRootFingerprint = createHash("sha256")
    .update(normalizedPathKey(dataRoot))
    .digest("hex");
  return acquireProfileLock({
    layout: { profileLockPath: lockPath },
    profile: {
      profileId: "profile-cache-maintenance",
      dataRootFingerprint,
    },
  });
}

function resolveMaintenanceLock(dataRoot, providedLock) {
  if (!providedLock) {
    return { lock: acquireMaintenanceLock(dataRoot), owned: true };
  }
  const expectedPath = resolveOwnedPath(
    dataRoot,
    "runtime/profile.lock",
    "profile lock",
  );
  if (
    path.resolve(String(providedLock.lockPath || "")) !== expectedPath ||
    typeof providedLock.release !== "function"
  ) {
    throw new Error("普通清缓存外部 profile 锁无效");
  }
  const inspected = inspectProfileLock(dataRoot);
  if (!inspected.exists || !inspected.active || inspected.pid !== process.pid) {
    throw new Error("普通清缓存外部 profile 锁并非当前进程持有");
  }
  return { lock: providedLock, owned: false };
}

function assertReadback(before, databaseClear, after) {
  if (after.database.totals.clearableRows !== 0) {
    throw new Error(
      `普通清缓存回读失败，仍有 ${after.database.totals.clearableRows} 行瞬时缓存`,
    );
  }
  if (
    Object.values(after.files.clearable).some((entries) => entries.length > 0)
  ) {
    throw new Error("普通清缓存回读失败，仍有受管瞬时缓存文件");
  }
  if (before.files.protectedDigest !== after.files.protectedDigest) {
    throw new Error("普通清缓存前后受保护文件/未知资源总指纹不一致");
  }
  if (before.database.protectedDigest !== after.database.protectedDigest) {
    throw new Error("普通清缓存前后受保护 SQLite 总指纹不一致");
  }
  if (
    databaseClear.before.protectedDigest !==
    databaseClear.after.protectedDigest
  ) {
    throw new Error("普通清缓存事务内受保护 SQLite 总指纹不一致");
  }
}

function performRollback({
  before,
  canonicalBackup,
  filesystemSnapshot,
  context,
}) {
  let currentFiles = null;
  try {
    currentFiles = inspectProfileFileResources(context);
  } catch {
    currentFiles = null;
  }
  const database = restoreCanonicalDatabase(
    canonicalBackup,
    before.databasePath,
  );
  const filesystem = restoreFilesystemSnapshot(filesystemSnapshot, currentFiles);
  const verified = inspectProfileCacheMaintenance({
    command: ORDINARY_CACHE_COMMAND,
    ...context,
  });
  if (verified.previewToken !== before.previewToken) {
    throw new Error("自动回滚后 previewToken 未恢复到清理前状态");
  }
  return {
    ok: true,
    mode: "automatic-full-profile-cache-operation-rollback",
    database,
    filesystem,
    verifiedPreviewToken: verified.previewToken,
    protectedDatabaseDigest: verified.database.protectedDigest,
    protectedFileDigest: verified.files.protectedDigest,
  };
}

export function applyProfileCacheMaintenance(options = {}) {
  const command = String(options.command || "").trim();
  const contract = assertProfileMaintenanceCommandBoundary(
    command,
    ORDINARY_CACHE_COMMAND,
  );
  if (options.confirmation !== contract.confirmation) {
    throw new Error("普通清缓存缺少明确确认口令");
  }
  const requestedPreviewToken = String(options.previewToken || "").trim();
  if (!requestedPreviewToken) {
    throw new Error("普通清缓存必须先预览并提交 previewToken");
  }

  const context = resolveMaintenanceContext(options);
  const lockLease = resolveMaintenanceLock(
    context.dataRoot,
    options.maintenanceLock,
  );
  const maintenanceLock = lockLease.lock;
  let backupRoot = null;
  try {
    if (typeof options.assertBeforeMutation === "function") {
      const fenceResult = options.assertBeforeMutation();
      if (fenceResult && typeof fenceResult.then === "function") {
        throw new Error("普通清缓存 mutation fence 必须同步完成");
      }
    }
    const checkpoint = checkpointDatabase(context.databasePath);
    const before = inspectProfileCacheMaintenance({ command, ...context });
    if (before.previewToken !== requestedPreviewToken) {
      throw new Error("普通清缓存 previewToken 已失效，请重新预览后确认");
    }
    if (before.files.blockedResources.length) {
      throw new Error(
        `普通清缓存发现不可安全复制的资源：${before.files.blockedResources
          .map((entry) => entry.path)
          .join(", ")}`,
      );
    }

    const backupDirectory = requiredAbsolutePath(
      options.backupDirectory || path.join(before.dataRoot, "backups"),
      "backupDirectory",
    );
    if (!isDescendantPath(before.dataRoot, backupDirectory)) {
      throw new Error("普通清缓存保护副本目录必须位于 desktop dataRoot 内");
    }
    backupRoot = path.join(
      backupDirectory,
      `profile-cache-clear-before-${safeProfileMaintenanceTimestamp(options.now || new Date())}`,
    );
    if (fs.existsSync(backupRoot)) {
      throw new Error(`普通清缓存保护副本目录已存在：${backupRoot}`);
    }
    fs.mkdirSync(backupRoot, { recursive: true });

    const canonicalBackup = backupCanonicalProfile(before, backupRoot);
    const filesystemSnapshot = createFilesystemSnapshot(before, backupRoot);
    const afterBackup = inspectProfileCacheMaintenance({ command, ...context });
    if (afterBackup.previewToken !== before.previewToken) {
      throw new Error("普通清缓存制作保护副本期间源数据发生变化，已中止");
    }

    let databaseClear = null;
    let removed = null;
    let mutationStarted = false;
    try {
      mutationStarted = true;
      const db = openProfileDatabase(before.databasePath);
      try {
        databaseClear = clearProfileTransientCache(db, {
          confirmation: PROFILE_CACHE_CLEAR_CONFIRMATION,
        });
      } finally {
        db.close();
      }

      removed = {
        profileCacheFiles: before.files.clearable.profileCacheFiles.map((entry) =>
          removeOwnedPath(before.dataRoot, entry.path, "profile 瞬时缓存文件"),
        ),
        workspaceCacheFiles: before.files.clearable.workspaceCacheFiles.map(
          (entry) =>
            removeOwnedPath(
              before.workspaceRoot,
              entry.path,
              "workspace 瞬时缓存文件",
            ),
        ),
        electronCacheDirectories:
          before.files.clearable.electronCacheDirectories.map((entry) =>
            removeOwnedPath(
              before.dataRoot,
              entry.path,
              "Electron 瞬时缓存目录",
            ),
          ),
      };

      if (typeof options.testHooks?.afterFileStage === "function") {
        options.testHooks.afterFileStage({ before, databaseClear, removed });
      }

      const after = inspectProfileCacheMaintenance({ command, ...context });
      assertReadback(before, databaseClear, after);

      const report = {
        ok: true,
        mode: "confirmed-profile-transient-cache-clear",
        command,
        commandContract: contract,
        version: PROFILE_CACHE_MAINTENANCE_VERSION,
        completedAt: (options.now || new Date()).toISOString(),
        previewToken: before.previewToken,
        checkpoint,
        lock: {
          path: maintenanceLock.lockPath,
          heldForEntireMutation: true,
        },
        backupRoot,
        canonicalBackup,
        filesystemSnapshot: {
          policy: filesystemSnapshot.policy,
          entries: filesystemSnapshot.entries.length,
          backups: filesystemSnapshot.backups,
        },
        cacheFileBackups: filesystemSnapshot.backups.filter(
          (entry) => entry.category === "clearable",
        ),
        protectedFileBackups: filesystemSnapshot.backups.filter(
          (entry) => entry.category === "protected",
        ),
        databaseClear,
        removed,
        protectedDigestBefore: before.files.protectedDigest,
        protectedDigestAfter: after.files.protectedDigest,
        protectedDatabaseDigestBefore: before.database.protectedDigest,
        protectedDatabaseDigestAfter: after.database.protectedDigest,
        after,
        protectionBackupRemoved: false,
      };
      const finalized = finalizeSuccessfulProfileCacheMaintenance({
        dataRoot: before.dataRoot,
        backupRoot,
        report,
        canonicalBackup,
        now: options.now || new Date(),
      });
      return { ...finalized.completedReport, reportPath: finalized.reportPath };
    } catch (error) {
      if (!mutationStarted) throw error;
      let rollback = null;
      let rollbackError = null;
      try {
        rollback = performRollback({
          before,
          canonicalBackup,
          filesystemSnapshot,
          context,
        });
      } catch (caught) {
        rollbackError = caught;
      }
      const failureReport = {
        ok: false,
        mode: "profile-transient-cache-clear-rolled-back",
        command,
        version: PROFILE_CACHE_MAINTENANCE_VERSION,
        failedAt: new Date().toISOString(),
        previewToken: before.previewToken,
        backupRoot,
        error: {
          name: error?.name || "Error",
          message: error?.message || String(error),
        },
        rollback,
        rollbackError: rollbackError
          ? {
              name: rollbackError?.name || "Error",
              message: rollbackError?.message || String(rollbackError),
            }
          : null,
      };
      const reportPath = path.join(
        backupRoot,
        "cache-clear-rollback-report.json",
      );
      writeProfileMaintenanceJson(reportPath, failureReport);
      const wrapped = new Error(
        rollbackError
          ? `普通清缓存失败且自动恢复未完成：${error.message}；${rollbackError.message}`
          : `普通清缓存失败，已自动恢复到清理前状态：${error.message}`,
        { cause: error },
      );
      wrapped.rollback = rollback;
      wrapped.rollbackError = rollbackError;
      wrapped.reportPath = reportPath;
      throw wrapped;
    }
  } finally {
    if (lockLease.owned) maintenanceLock.release();
  }
}
