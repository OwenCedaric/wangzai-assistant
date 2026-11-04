import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const PROFILE_CACHE_MAINTENANCE_SMOKE_ARGUMENT =
  "--profile-cache-maintenance-smoke";
export const PROFILE_CACHE_MAINTENANCE_SMOKE_CONTRACT =
  "profile-cache-maintenance-packaged-smoke/v1";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/u;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const issuedCapabilities = new WeakSet();

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function exactFields(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (
    actual.length !== expected.length
    || actual.some((field, index) => field !== expected[index])
  ) {
    throw new Error(`${label} fields are invalid`);
  }
}

function boundedRegularFile(filePath, maximumBytes, label) {
  const stat = fs.lstatSync(filePath);
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.size < 1
    || stat.size > maximumBytes
  ) {
    throw new Error(`${label} must be a bounded regular file`);
  }
  if (stat.nlink !== 1) {
    throw new Error(`${label} must not be a hard link`);
  }
  return stat;
}

function comparablePath(value) {
  const normalized = path.normalize(String(value));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function pathsEqual(left, right) {
  return comparablePath(left) === comparablePath(right);
}

function assertOwnedPath(root, candidate, label, { allowRoot = false } = {}) {
  const relative = path.relative(root, candidate);
  if (
    path.isAbsolute(relative)
    || (!allowRoot && relative === "")
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
  ) {
    throw new Error(`${label} must stay inside the isolated smoke data root`);
  }
}

function canonicalDirectory(directoryPath, label) {
  const resolved = path.resolve(directoryPath);
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a non-link directory`);
  }
  const canonical = fs.realpathSync.native(resolved);
  if (!pathsEqual(canonical, resolved)) {
    throw new Error(`${label} must not traverse a junction or symbolic link`);
  }
  return canonical;
}

function canonicalRegularFile(filePath, maximumBytes, label) {
  const resolved = path.resolve(filePath);
  boundedRegularFile(resolved, maximumBytes, label);
  const canonical = fs.realpathSync.native(resolved);
  if (!pathsEqual(canonical, resolved)) {
    throw new Error(`${label} must not traverse a junction or symbolic link`);
  }
  return canonical;
}

function assertCanonicalChild(root, candidate, label) {
  assertOwnedPath(root, candidate, label);
  const relative = path.relative(root, candidate);
  if (relative.split(path.sep).includes("..")) {
    throw new Error(`${label} canonical path is invalid`);
  }
}

export function profileCacheMaintenanceSmokePaths(dataRoot) {
  const root = path.resolve(String(dataRoot || ""));
  const runtimeRoot = path.join(root, "runtime");
  return Object.freeze({
    dataRoot: root,
    markerPath: path.join(runtimeRoot, "profile-cache-maintenance-smoke.marker.json"),
    resultPath: path.join(runtimeRoot, "profile-cache-maintenance-smoke.result.json"),
  });
}

/**
 * Consume a one-shot package-smoke capability. This can never target the
 * normal Electron profile: the data root must be a timestamped child of the
 * workspace-owned `.desktop-runtime-test` directory, the executable must be
 * packaged, and both a random token and the exact pre-operation DB hash must
 * match a bounded, non-symlink marker that is removed before mutation.
 */
export function consumeProfileCacheMaintenanceSmokeCapability({
  enabled,
  isPackaged,
  isSmokeTest,
  dataRoot,
  databasePath,
  token,
}) {
  if (!enabled) return null;
  if (!isPackaged || !isSmokeTest || !TOKEN_PATTERN.test(String(token || ""))) {
    throw new Error("PROFILE_CACHE_MAINTENANCE_SMOKE_FENCE_INVALID");
  }
  const paths = profileCacheMaintenanceSmokePaths(dataRoot);
  const isolatedParent = path.dirname(paths.dataRoot);
  if (path.basename(isolatedParent) !== ".desktop-runtime-test") {
    throw new Error("PROFILE_CACHE_MAINTENANCE_SMOKE_DATA_ROOT_REJECTED");
  }
  const resolvedDatabase = path.resolve(String(databasePath || ""));
  const expectedDatabase = path.join(
    paths.dataRoot,
    "local-api-data",
    "wangzai-local-api.sqlite",
  );
  if (!pathsEqual(resolvedDatabase, expectedDatabase)) {
    throw new Error("PROFILE_CACHE_MAINTENANCE_SMOKE_DATABASE_PATH_REJECTED");
  }

  // Every existing path component used by the auto-confirm branch must be a
  // direct filesystem object.  A matching basename is not sufficient because
  // a parent junction could otherwise redirect the smoke run to a real user
  // profile while preserving the same visible path.
  const canonicalParent = canonicalDirectory(isolatedParent, "smoke owner directory");
  const canonicalRoot = canonicalDirectory(paths.dataRoot, "smoke data root");
  const canonicalRuntime = canonicalDirectory(
    path.dirname(paths.markerPath),
    "smoke runtime directory",
  );
  const canonicalDatabaseDirectory = canonicalDirectory(
    path.dirname(resolvedDatabase),
    "smoke database directory",
  );
  const canonicalMarker = canonicalRegularFile(
    paths.markerPath,
    16 * 1024,
    "smoke marker",
  );
  const canonicalDatabase = canonicalRegularFile(
    resolvedDatabase,
    1024 * 1024 * 1024,
    "smoke database",
  );
  if (
    !pathsEqual(path.dirname(canonicalRoot), canonicalParent)
    || path.basename(canonicalParent) !== ".desktop-runtime-test"
  ) {
    throw new Error("PROFILE_CACHE_MAINTENANCE_SMOKE_DATA_ROOT_REJECTED");
  }
  assertCanonicalChild(canonicalRoot, canonicalRuntime, "runtime directory");
  assertCanonicalChild(
    canonicalRoot,
    canonicalDatabaseDirectory,
    "database directory",
  );
  assertCanonicalChild(canonicalRoot, canonicalMarker, "markerPath");
  assertCanonicalChild(canonicalRoot, canonicalDatabase, "databasePath");

  const marker = JSON.parse(fs.readFileSync(canonicalMarker, "utf8"));
  exactFields(
    marker,
    ["contract", "databaseSha256", "tokenSha256"],
    "smoke marker",
  );
  if (
    marker.contract !== PROFILE_CACHE_MAINTENANCE_SMOKE_CONTRACT
    || !HASH_PATTERN.test(marker.databaseSha256 || "")
    || !HASH_PATTERN.test(marker.tokenSha256 || "")
    || marker.tokenSha256 !== sha256(String(token))
    || marker.databaseSha256 !== sha256(fs.readFileSync(canonicalDatabase))
  ) {
    throw new Error("PROFILE_CACHE_MAINTENANCE_SMOKE_CAPABILITY_MISMATCH");
  }
  if (fs.existsSync(paths.resultPath)) {
    throw new Error("PROFILE_CACHE_MAINTENANCE_SMOKE_RESULT_ALREADY_EXISTS");
  }
  fs.rmSync(canonicalMarker);
  const capability = Object.freeze({
    ...paths,
    dataRoot: canonicalRoot,
    resultPath: path.join(
      canonicalRuntime,
      "profile-cache-maintenance-smoke.result.json",
    ),
    databasePath: canonicalDatabase,
    databaseSha256: marker.databaseSha256,
  });
  issuedCapabilities.add(capability);
  return capability;
}

/**
 * Re-check the consumed capability immediately before the maintenance core
 * opens the database.  This closes the practical validation-to-mutation gap:
 * the owner directory, run directory, runtime directory, database directory
 * and database must still be the exact canonical objects that were attested,
 * and the read-only preview must not have changed the database bytes.
 */
export function revalidateProfileCacheMaintenanceSmokeCapability(capability) {
  if (!capability || !issuedCapabilities.has(capability)) {
    throw new Error("PROFILE_CACHE_MAINTENANCE_SMOKE_CAPABILITY_REQUIRED");
  }
  const canonicalRoot = canonicalDirectory(
    capability.dataRoot,
    "smoke data root",
  );
  const canonicalParent = canonicalDirectory(
    path.dirname(canonicalRoot),
    "smoke owner directory",
  );
  const canonicalRuntime = canonicalDirectory(
    path.dirname(capability.resultPath),
    "smoke runtime directory",
  );
  const canonicalDatabaseDirectory = canonicalDirectory(
    path.dirname(capability.databasePath),
    "smoke database directory",
  );
  const canonicalDatabase = canonicalRegularFile(
    capability.databasePath,
    1024 * 1024 * 1024,
    "smoke database",
  );
  if (
    path.basename(canonicalParent) !== ".desktop-runtime-test"
    || !pathsEqual(path.dirname(canonicalRoot), canonicalParent)
    || !pathsEqual(
      canonicalDatabase,
      path.join(
        canonicalRoot,
        "local-api-data",
        "wangzai-local-api.sqlite",
      ),
    )
  ) {
    throw new Error("PROFILE_CACHE_MAINTENANCE_SMOKE_DATA_ROOT_REJECTED");
  }
  assertCanonicalChild(canonicalRoot, canonicalRuntime, "runtime directory");
  assertCanonicalChild(
    canonicalRoot,
    canonicalDatabaseDirectory,
    "database directory",
  );
  assertCanonicalChild(canonicalRoot, canonicalDatabase, "databasePath");
  if (
    fs.existsSync(capability.markerPath)
    || fs.existsSync(capability.resultPath)
  ) {
    throw new Error("PROFILE_CACHE_MAINTENANCE_SMOKE_ONE_SHOT_STATE_INVALID");
  }
  if (sha256(fs.readFileSync(canonicalDatabase)) !== capability.databaseSha256) {
    throw new Error("PROFILE_CACHE_MAINTENANCE_SMOKE_DATABASE_CHANGED");
  }
  return capability;
}

export function writeProfileCacheMaintenanceSmokeResult(capability, result) {
  if (
    !capability?.resultPath
    || !capability?.dataRoot
    || !issuedCapabilities.has(capability)
  ) {
    throw new Error("PROFILE_CACHE_MAINTENANCE_SMOKE_CAPABILITY_REQUIRED");
  }
  const resultPath = path.resolve(capability.resultPath);
  const canonicalRoot = canonicalDirectory(
    path.resolve(capability.dataRoot),
    "smoke data root",
  );
  const canonicalRuntime = canonicalDirectory(
    path.dirname(resultPath),
    "smoke runtime directory",
  );
  assertCanonicalChild(canonicalRoot, canonicalRuntime, "runtime directory");
  assertOwnedPath(canonicalRoot, resultPath, "resultPath");
  if (fs.existsSync(resultPath)) {
    throw new Error("PROFILE_CACHE_MAINTENANCE_SMOKE_RESULT_ALREADY_EXISTS");
  }
  fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return resultPath;
}
