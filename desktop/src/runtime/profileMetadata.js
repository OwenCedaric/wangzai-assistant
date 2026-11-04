import crypto from "node:crypto";
import fs from "node:fs";

export const PROFILE_SCHEMA_VERSION = 1;
export const RUNTIME_PROTOCOL_VERSION = "1";
export const DESKTOP_APP_ID = "com.wangzai.assistant.desktop";

function fingerprint(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

export function createDataRootFingerprint(dataRoot) {
  return fingerprint(`wangzai-data-root:v1:${String(dataRoot || "")}`);
}

export function createProfileMetadata({ dataRoot, createdAt, profileId }) {
  const normalizedRoot = String(dataRoot || "").trim();
  if (!normalizedRoot) throw new Error("profile dataRoot 不能为空");
  const normalizedProfileId = String(profileId || "").trim();
  if (!normalizedProfileId) throw new Error("profileId 不能为空");
  return Object.freeze({
    schemaVersion: PROFILE_SCHEMA_VERSION,
    profileId: normalizedProfileId,
    createdAt: new Date(createdAt).toISOString(),
    dataRootFingerprint: createDataRootFingerprint(normalizedRoot),
    // 空值只允许用于首次建库前。成功 health 后会写成不可逆的初始化时间，
    // 这样已初始化 profile 丢失主库时不会静默创建一个“看起来正常”的空数据库。
    databaseInitializedAt: "",
    // 恢复 shell 使用独立 SQLite；该标记存在时，即使 recovery shell 已创建，
    // 也绝不能把它误判成业务主库并开放普通页面。
    databaseRecoveryRequiredAt: "",
  });
}

function normalizeDatabaseInitializedAt(profile) {
  const value = String(profile?.databaseInitializedAt || "").trim();
  if (!value) return "";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error("profile.json 的 databaseInitializedAt 无效");
  }
  return new Date(timestamp).toISOString();
}

function normalizeDatabaseRecoveryRequiredAt(profile) {
  const value = String(profile?.databaseRecoveryRequiredAt || "").trim();
  if (!value) return "";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error("profile.json 的 databaseRecoveryRequiredAt 无效");
  }
  return new Date(timestamp).toISOString();
}

function assertProfileMatchesLayout(profile, layout) {
  if (!profile || typeof profile !== "object") {
    throw new Error("profile.json 格式无效");
  }
  if (profile.schemaVersion !== PROFILE_SCHEMA_VERSION) {
    throw new Error(`不支持的 profile schemaVersion: ${profile.schemaVersion}`);
  }
  if (!String(profile.profileId || "").trim()) {
    throw new Error("profile.json 缺少 profileId");
  }
  if (profile.dataRootFingerprint !== createDataRootFingerprint(layout.dataRoot)) {
    throw new Error("profile.json 与当前数据根不匹配");
  }
  const databaseInitializedAt = normalizeDatabaseInitializedAt(profile);
  const databaseRecoveryRequiredAt = normalizeDatabaseRecoveryRequiredAt(profile);
  const hasDatabaseInitializationMarker = Object.hasOwn(
    profile,
    "databaseInitializedAt",
  );
  return Object.freeze({
    schemaVersion: profile.schemaVersion,
    profileId: String(profile.profileId),
    createdAt: String(profile.createdAt || ""),
    dataRootFingerprint: profile.dataRootFingerprint,
    databaseInitializedAt,
    databaseRecoveryRequiredAt,
    databaseLifecycle: databaseRecoveryRequiredAt
      ? "recovery-required"
      : databaseInitializedAt
      ? "initialized"
      : hasDatabaseInitializationMarker
        ? "new"
        : "legacy-unmarked",
  });
}

function readPersistedProfile(layout) {
  return JSON.parse(fs.readFileSync(layout.profilePath, "utf8"));
}

function replacePersistedProfile(layout, profile) {
  const temporaryPath = `${layout.profilePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(profile, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    fs.renameSync(temporaryPath, layout.profilePath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

/**
 * 只在 dataRoot 内创建或读取 profile.json。任何不匹配都显式失败，避免
 * 静默把另一份数据目录当成当前 profile。
 */
export function ensureProfileMetadata(layout, {
  now = () => new Date(),
  createId = crypto.randomUUID,
} = {}) {
  if (fs.existsSync(layout.profilePath)) {
    return assertProfileMatchesLayout(readPersistedProfile(layout), layout);
  }

  fs.mkdirSync(layout.dataRoot, { recursive: true });
  const profile = createProfileMetadata({
    dataRoot: layout.dataRoot,
    createdAt: now(),
    profileId: createId(),
  });
  const temporaryPath = `${layout.profilePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(profile, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  try {
    fs.renameSync(temporaryPath, layout.profilePath);
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    if (!fs.existsSync(layout.profilePath)) throw error;
  }
  return assertProfileMatchesLayout(
    readPersistedProfile(layout),
    layout,
  );
}

/**
 * 仅在 local-api 已经通过当前 profile 的 health 握手后调用。标记一旦写入，
 * 下次若主库不存在，启动层必须进入恢复路径而不是让 SQLite 自动产生空库。
 */
export function markProfileDatabaseInitialized(
  layout,
  expectedProfile,
  { now = () => new Date() } = {},
) {
  if (!fs.existsSync(layout.profilePath)) {
    throw new Error("profile.json 不存在，不能标记数据库初始化");
  }
  const persisted = readPersistedProfile(layout);
  const current = assertProfileMatchesLayout(persisted, layout);
  if (
    expectedProfile &&
    (current.profileId !== expectedProfile.profileId ||
      current.dataRootFingerprint !== expectedProfile.dataRootFingerprint)
  ) {
    throw new Error("profile.json 在数据库初始化期间发生变化");
  }
  if (current.databaseInitializedAt) return current;

  const initializedAt = new Date(now()).toISOString();
  replacePersistedProfile(layout, {
    ...persisted,
    databaseInitializedAt: initializedAt,
  });
  return assertProfileMatchesLayout(readPersistedProfile(layout), layout);
}

function assertExpectedProfile(current, expectedProfile, action) {
  if (
    expectedProfile &&
    (current.profileId !== expectedProfile.profileId ||
      current.dataRootFingerprint !== expectedProfile.dataRootFingerprint)
  ) {
    throw new Error(`profile.json 在${action}期间发生变化`);
  }
}

/**
 * 已初始化/历史 profile 丢失业务主库时，持久记录恢复状态。该状态不能由
 * recovery shell 的存在自动清除，只有原子恢复激活成功才允许显式清除。
 */
export function markProfileDatabaseRecoveryRequired(
  layout,
  expectedProfile,
  { now = () => new Date() } = {},
) {
  if (!fs.existsSync(layout.profilePath)) {
    throw new Error("profile.json 不存在，不能标记数据库恢复状态");
  }
  const persisted = readPersistedProfile(layout);
  const current = assertProfileMatchesLayout(persisted, layout);
  assertExpectedProfile(current, expectedProfile, "标记数据库恢复");
  if (current.databaseRecoveryRequiredAt) return current;

  replacePersistedProfile(layout, {
    ...persisted,
    databaseRecoveryRequiredAt: new Date(now()).toISOString(),
  });
  return assertProfileMatchesLayout(readPersistedProfile(layout), layout);
}

export function clearProfileDatabaseRecoveryRequired(layout, expectedProfile) {
  if (!fs.existsSync(layout.profilePath)) {
    throw new Error("profile.json 不存在，不能清除数据库恢复状态");
  }
  const persisted = readPersistedProfile(layout);
  const current = assertProfileMatchesLayout(persisted, layout);
  assertExpectedProfile(current, expectedProfile, "清除数据库恢复");
  if (!current.databaseRecoveryRequiredAt) return current;

  replacePersistedProfile(layout, {
    ...persisted,
    databaseRecoveryRequiredAt: "",
  });
  return assertProfileMatchesLayout(readPersistedProfile(layout), layout);
}
