import { createHash } from "node:crypto";
import {
  ORDINARY_CLEARABLE_CACHE_TABLES,
  PROFILE_MAINTENANCE_COMMAND_CONTRACTS,
  PROFILE_MAINTENANCE_COMMANDS,
  PROFILE_CACHE_POLICY_VERSION,
  PROFILE_SCHEMA_TABLES,
  PROTECTED_PROFILE_TABLES,
  OPTIONAL_PROTECTED_PROFILE_TABLES,
  assertCompleteProfileCacheTableClassification,
} from "./profileCachePolicy.js";

export const PROFILE_CACHE_CLEAR_CONFIRMATION =
  PROFILE_MAINTENANCE_COMMAND_CONTRACTS[
    PROFILE_MAINTENANCE_COMMANDS.CLEAR_TRANSIENT_CACHE
  ].confirmation;

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function listProfileTables(db) {
  return db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((row) => String(row.name));
}

function tableColumns(db, tableName) {
  return db
    .prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`)
    .all()
    .map((row) => String(row.name));
}

function normalizeFingerprintValue(value) {
  if (typeof value === "bigint") return { type: "bigint", value: value.toString() };
  if (Buffer.isBuffer(value)) return { type: "buffer", value: value.toString("base64") };
  if (Array.isArray(value)) return value.map(normalizeFingerprintValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, normalizeFingerprintValue(nested)]),
    );
  }
  return value;
}

function tableFingerprint(db, tableName) {
  const columns = tableColumns(db, tableName);
  if (!columns.length) throw new Error(`${tableName} 没有可用于保护校验的字段`);
  const rows = db
    .prepare(
      `SELECT ${columns.map(quoteIdentifier).join(", ")} FROM ${quoteIdentifier(tableName)}`,
    )
    .all()
    .map((row) => JSON.stringify(normalizeFingerprintValue(row)))
    .sort();
  const hash = createHash("sha256");
  rows.forEach((row) => hash.update(row).update("\n"));
  return { rows: rows.length, sha256: hash.digest("hex") };
}

function fingerprintSetDigest(fingerprints) {
  const hash = createHash("sha256");
  Object.entries(fingerprints)
    .sort(([left], [right]) => left.localeCompare(right))
    .forEach(([tableName, fingerprint]) => {
      hash
        .update(tableName)
        .update("\0")
        .update(String(fingerprint.rows))
        .update("\0")
        .update(fingerprint.sha256)
        .update("\n");
    });
  return hash.digest("hex");
}

function readQuickCheck(db) {
  return String(db.prepare("PRAGMA quick_check").get()?.quick_check || "");
}

export function inspectProfileCache(db) {
  if (!db) throw new Error("inspectProfileCache requires db");
  const tables = listProfileTables(db);
  assertCompleteProfileCacheTableClassification(tables);

  const clearable = Object.fromEntries(
    ORDINARY_CLEARABLE_CACHE_TABLES.map((tableName) => [
      tableName,
      tableFingerprint(db, tableName),
    ]),
  );
  const protectedTables = Object.fromEntries(
    [...PROTECTED_PROFILE_TABLES, ...OPTIONAL_PROTECTED_PROFILE_TABLES.filter(tableName => tables.includes(tableName))].map((tableName) => [
      tableName,
      tableFingerprint(db, tableName),
    ]),
  );
  const schema = Object.fromEntries(
    PROFILE_SCHEMA_TABLES.map((tableName) => [
      tableName,
      tableFingerprint(db, tableName),
    ]),
  );

  return {
    ok: true,
    mode: "read-only-transient-cache-preview",
    policyVersion: PROFILE_CACHE_POLICY_VERSION,
    quickCheck: readQuickCheck(db),
    tableCount: tables.length,
    clearable,
    protected: protectedTables,
    schema,
    protectedDigest: fingerprintSetDigest({ ...protectedTables, ...schema }),
    totals: {
      clearableRows: Object.values(clearable).reduce((sum, entry) => sum + entry.rows, 0),
      protectedRows:
        Object.values(protectedTables).reduce((sum, entry) => sum + entry.rows, 0) +
        Object.values(schema).reduce((sum, entry) => sum + entry.rows, 0),
    },
  };
}

function assertFingerprintsUnchanged(before, after, label) {
  for (const [tableName, fingerprint] of Object.entries(before)) {
    const current = after[tableName];
    if (
      !current ||
      current.rows !== fingerprint.rows ||
      current.sha256 !== fingerprint.sha256
    ) {
      throw new Error(`${label}受保护数据发生变化：${tableName}`);
    }
  }
}

function assertClearResult(before, after) {
  if (after.quickCheck !== "ok") {
    throw new Error(`缓存清理后 SQLite quick_check 失败：${after.quickCheck || "unknown"}`);
  }
  const remaining = Object.entries(after.clearable)
    .filter(([, entry]) => entry.rows !== 0)
    .map(([tableName, entry]) => `${tableName}=${entry.rows}`);
  if (remaining.length) {
    throw new Error(`瞬时缓存没有清空：${remaining.join(", ")}`);
  }
  assertFingerprintsUnchanged(before.protected, after.protected, "规范事实/用户配置/运行状态");
  assertFingerprintsUnchanged(before.schema, after.schema, "schema 元数据");
  if (before.protectedDigest !== after.protectedDigest) {
    throw new Error("缓存清理前后受保护数据总指纹不一致");
  }
}

export function clearProfileTransientCache(
  db,
  { confirmation = "" } = {},
) {
  if (!db) throw new Error("clearProfileTransientCache requires db");
  if (confirmation !== PROFILE_CACHE_CLEAR_CONFIRMATION) {
    throw new Error("普通清缓存缺少明确确认口令");
  }

  const before = inspectProfileCache(db);
  if (before.quickCheck !== "ok") {
    throw new Error(`缓存清理前 SQLite quick_check 失败：${before.quickCheck || "unknown"}`);
  }

  const deleted = {};
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const tableName of ORDINARY_CLEARABLE_CACHE_TABLES) {
      const result = db.prepare(`DELETE FROM ${quoteIdentifier(tableName)}`).run();
      deleted[tableName] = Number(result.changes) || 0;
    }

    const after = inspectProfileCache(db);
    assertClearResult(before, after);
    db.exec("COMMIT");
    return {
      ok: true,
      mode: "confirmed-transient-cache-clear",
      policyVersion: PROFILE_CACHE_POLICY_VERSION,
      deleted,
      deletedRows: Object.values(deleted).reduce((sum, count) => sum + count, 0),
      before,
      after,
    };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
