import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const LEGACY_WORKSPACE_BUSINESS_MIGRATION_ID =
  "legacy-workspace-business-v1";

const BUSINESS_TABLES = Object.freeze([
  {
    name: "purchase_order_overrides",
    identity: ["shop_id", "order_key"],
  },
  {
    name: "cross_border_order_records",
    identity: ["shop_id", "record_key"],
  },
  {
    name: "purchase_source_links",
    identity: ["shop_id", "order_key", "slot_index"],
  },
  {
    name: "product_source_links",
    identity: ["shop_id", "product_key", "slot_index"],
  },
  {
    name: "sales_source_links",
    identity: ["shop_id", "order_key", "slot_index"],
  },
  {
    name: "product_material_profiles",
    identity: ["shop_id", "product_key", "source"],
  },
]);

function requiredPath(value, fieldName) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${fieldName} 不能为空`);
  return path.resolve(normalized);
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function tableExists(db, tableName) {
  return Boolean(
    db
      .prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
      )
      .get(tableName)?.present,
  );
}

function readTableColumns(db, tableName) {
  return db
    .prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`)
    .all()
    .map((row) => String(row.name));
}

function readIntegrityStatus(db) {
  return String(db.prepare("PRAGMA quick_check").get()?.quick_check || "");
}

function assertDatabaseReady(db, label) {
  const integrity = readIntegrityStatus(db);
  if (integrity !== "ok") {
    throw new Error(`${label} SQLite quick_check 失败：${integrity || "unknown"}`);
  }
  for (const table of BUSINESS_TABLES) {
    if (!tableExists(db, table.name)) {
      throw new Error(`${label} 缺少业务表：${table.name}`);
    }
  }
  if (!tableExists(db, "profile_settings")) {
    throw new Error(`${label} 缺少业务表：profile_settings`);
  }
}

function rowIdentity(row, columns) {
  return JSON.stringify(
    columns.map((column) => {
      const value = row[column];
      return value === undefined ? null : value;
    }),
  );
}

function readRows(db, tableName, columns) {
  const selectColumns = columns.map(quoteIdentifier).join(", ");
  return db
    .prepare(
      `SELECT ${selectColumns} FROM ${quoteIdentifier(tableName)}`,
    )
    .all();
}

function createTablePlan(source, target, table) {
  const sourceColumns = readTableColumns(source, table.name);
  const targetColumnSet = new Set(readTableColumns(target, table.name));
  const commonColumns = sourceColumns.filter((column) =>
    targetColumnSet.has(column),
  );
  const missingIdentityColumns = table.identity.filter(
    (column) => !commonColumns.includes(column),
  );
  if (missingIdentityColumns.length) {
    throw new Error(
      `${table.name} 缺少身份字段：${missingIdentityColumns.join(", ")}`,
    );
  }

  const sourceRows = readRows(source, table.name, commonColumns);
  const targetRows = readRows(target, table.name, commonColumns);
  const targetByIdentity = new Map(
    targetRows.map((row) => [rowIdentity(row, table.identity), row]),
  );
  const targetById = new Map(
    targetRows
      .filter((row) => row.id !== undefined && row.id !== null)
      .map((row) => [String(row.id), row]),
  );
  const insertRows = [];
  let preservedCount = 0;

  for (const row of sourceRows) {
    const identity = rowIdentity(row, table.identity);
    if (targetByIdentity.has(identity)) {
      preservedCount += 1;
      continue;
    }
    if (
      row.id !== undefined &&
      row.id !== null &&
      targetById.has(String(row.id))
    ) {
      throw new Error(
        `${table.name} 主键冲突且业务身份不同：${String(row.id)}`,
      );
    }
    insertRows.push(row);
  }

  return {
    ...table,
    columns: commonColumns,
    sourceCount: sourceRows.length,
    targetCountBefore: targetRows.length,
    preservedCount,
    insertRows,
  };
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function timestamp(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function earlierValidTimestamp(left, right) {
  const leftTimestamp = timestamp(left);
  const rightTimestamp = timestamp(right);
  if (leftTimestamp === null) return rightTimestamp === null ? "" : right;
  if (rightTimestamp === null) return left;
  return leftTimestamp <= rightTimestamp ? left : right;
}

export function mergeOzonShopPurchaseBindingPreferences(
  canonicalValue = {},
  legacyValue = {},
) {
  const canonical =
    canonicalValue && typeof canonicalValue === "object"
      ? structuredClone(canonicalValue)
      : {};
  const legacy =
    legacyValue && typeof legacyValue === "object" ? legacyValue : {};
  const canonicalShops = Array.isArray(canonical.shops)
    ? canonical.shops
    : [];
  const legacyShops = Array.isArray(legacy.shops) ? legacy.shops : [];

  if (!canonicalShops.length && legacyShops.length) {
    canonical.version = canonical.version || legacy.version || 1;
    canonical.shops = legacyShops.map((shop) => {
      const sanitized = { ...(shop || {}) };
      delete sanitized.apiKey;
      delete sanitized.api_key;
      return sanitized;
    });
    canonical.activeShopId = canonical.activeShopId || legacy.activeShopId || "";
    canonical.defaultWarehouseIds =
      canonical.defaultWarehouseIds || legacy.defaultWarehouseIds || {};
    return { value: canonical, changed: true };
  }

  const legacyById = new Map(
    legacyShops
      .filter((shop) => shop?.id)
      .map((shop) => [String(shop.id), shop]),
  );
  let changed = false;
  canonical.shops = canonicalShops.map((shop) => {
    const legacyShop = legacyById.get(String(shop?.id || ""));
    if (!legacyShop) return shop;
    const canonicalStart = String(shop?.purchaseManagementStartedAt || "");
    const legacyStart = String(
      legacyShop?.purchaseManagementStartedAt || "",
    );
    if (!legacyStart) return shop;

    const canonicalReset = timestamp(shop?.purchaseManagementResetAt);
    const legacyStartTimestamp = timestamp(legacyStart);
    if (
      !canonicalStart &&
      canonicalReset !== null &&
      legacyStartTimestamp !== null &&
      canonicalReset >= legacyStartTimestamp
    ) {
      return shop;
    }

    const mergedStart = earlierValidTimestamp(canonicalStart, legacyStart);
    if (!mergedStart || mergedStart === canonicalStart) return shop;
    changed = true;
    return {
      ...shop,
      purchaseManagementStartedAt: mergedStart,
    };
  });

  return { value: canonical, changed };
}

function createProfileSettingsPlan(source, target) {
  const namespace = "ozon-shop-preferences";
  const sourceRow = source
    .prepare(
      "SELECT namespace, value_json, created_at, updated_at FROM profile_settings WHERE namespace = ?",
    )
    .get(namespace);
  const targetRow = target
    .prepare(
      "SELECT namespace, value_json, created_at, updated_at FROM profile_settings WHERE namespace = ?",
    )
    .get(namespace);
  if (!sourceRow) {
    return { namespace, sourcePresent: false, changed: false, valueJson: "" };
  }

  const merged = mergeOzonShopPurchaseBindingPreferences(
    parseJsonObject(targetRow?.value_json),
    parseJsonObject(sourceRow.value_json),
  );
  return {
    namespace,
    sourcePresent: true,
    targetPresent: Boolean(targetRow),
    changed: merged.changed,
    valueJson: JSON.stringify(merged.value),
    createdAt: targetRow?.created_at || sourceRow.created_at,
  };
}

function insertRows(target, plan) {
  if (!plan.insertRows.length) return;
  const columns = plan.columns.map(quoteIdentifier).join(", ");
  const placeholders = plan.columns.map(() => "?").join(", ");
  const statement = target.prepare(
    `INSERT INTO ${quoteIdentifier(plan.name)} (${columns}) VALUES (${placeholders})`,
  );
  for (const row of plan.insertRows) {
    statement.run(...plan.columns.map((column) => row[column] ?? null));
  }
}

function saveProfileSettingsPlan(target, plan, now) {
  if (!plan.changed) return;
  target
    .prepare(
      `INSERT INTO profile_settings (namespace, value_json, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(namespace) DO UPDATE SET
         value_json = excluded.value_json,
         updated_at = excluded.updated_at`,
    )
    .run(plan.namespace, plan.valueJson, plan.createdAt || now, now);
}

function verifyInsertedRows(target, plans) {
  for (const plan of plans) {
    if (!plan.insertRows.length) continue;
    const currentRows = readRows(target, plan.name, plan.columns);
    const currentByIdentity = new Map(
      currentRows.map((row) => [rowIdentity(row, plan.identity), row]),
    );
    for (const sourceRow of plan.insertRows) {
      const identity = rowIdentity(sourceRow, plan.identity);
      const readback = currentByIdentity.get(identity);
      if (!readback) {
        throw new Error(`${plan.name} 回读缺少记录：${identity}`);
      }
      for (const column of plan.columns) {
        if ((readback[column] ?? null) !== (sourceRow[column] ?? null)) {
          throw new Error(
            `${plan.name} 回读字段不一致：${identity} / ${column}`,
          );
        }
      }
    }
  }
}

function createBackup(target, backupDirectory) {
  fs.mkdirSync(backupDirectory, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const backupPath = path.join(
    backupDirectory,
    `${LEGACY_WORKSPACE_BUSINESS_MIGRATION_ID}-before-${stamp}.sqlite`,
  );
  const escapedBackupPath = backupPath.replaceAll("'", "''");
  target.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  target.exec(`VACUUM INTO '${escapedBackupPath}'`);
  return backupPath;
}

function fileDescriptor(filePath) {
  const stat = fs.statSync(filePath);
  return {
    path: filePath,
    bytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
  };
}

function defaultMarkerPath(targetDatabasePath) {
  const dataRoot = path.resolve(path.dirname(targetDatabasePath), "..");
  return path.join(
    dataRoot,
    "runtime",
    `${LEGACY_WORKSPACE_BUSINESS_MIGRATION_ID}.json`,
  );
}

function defaultBackupDirectory(targetDatabasePath) {
  const dataRoot = path.resolve(path.dirname(targetDatabasePath), "..");
  return path.join(dataRoot, "backups");
}

export function migrateLegacyWorkspaceBusinessData({
  sourceDatabasePath,
  targetDatabasePath,
  markerPath = "",
  backupDirectory = "",
  apply = false,
  force = false,
} = {}) {
  const sourcePath = requiredPath(sourceDatabasePath, "sourceDatabasePath");
  const targetPath = requiredPath(targetDatabasePath, "targetDatabasePath");
  if (sourcePath.toLowerCase() === targetPath.toLowerCase()) {
    throw new Error("legacy 与 canonical 数据库不能是同一路径");
  }
  if (!fs.existsSync(sourcePath)) throw new Error(`legacy 数据库不存在：${sourcePath}`);
  if (!fs.existsSync(targetPath)) throw new Error(`canonical 数据库不存在：${targetPath}`);

  const resolvedMarkerPath = markerPath
    ? requiredPath(markerPath, "markerPath")
    : defaultMarkerPath(targetPath);
  const resolvedBackupDirectory = backupDirectory
    ? requiredPath(backupDirectory, "backupDirectory")
    : defaultBackupDirectory(targetPath);
  if (apply && !force && fs.existsSync(resolvedMarkerPath)) {
    return {
      ok: true,
      migrationId: LEGACY_WORKSPACE_BUSINESS_MIGRATION_ID,
      mode: "already-applied",
      markerPath: resolvedMarkerPath,
      previous: parseJsonObject(fs.readFileSync(resolvedMarkerPath, "utf8")),
    };
  }

  const source = new DatabaseSync(sourcePath, { readOnly: true });
  const target = new DatabaseSync(targetPath, { readOnly: !apply });
  let backupPath = "";
  try {
    source.exec("PRAGMA foreign_keys = ON");
    target.exec("PRAGMA foreign_keys = ON");
    target.exec("PRAGMA busy_timeout = 10000");
    assertDatabaseReady(source, "legacy");
    assertDatabaseReady(target, "canonical");

    const plans = BUSINESS_TABLES.map((table) =>
      createTablePlan(source, target, table),
    );
    const profileSettingsPlan = createProfileSettingsPlan(source, target);
    const reportBase = {
      ok: true,
      migrationId: LEGACY_WORKSPACE_BUSINESS_MIGRATION_ID,
      mode: apply ? "apply" : "preview",
      source: fileDescriptor(sourcePath),
      target: fileDescriptor(targetPath),
      markerPath: resolvedMarkerPath,
      tables: Object.fromEntries(
        plans.map((plan) => [
          plan.name,
          {
            sourceCount: plan.sourceCount,
            targetCountBefore: plan.targetCountBefore,
            insertCount: plan.insertRows.length,
            preservedCount: plan.preservedCount,
          },
        ]),
      ),
      profileSettings: {
        namespace: profileSettingsPlan.namespace,
        sourcePresent: profileSettingsPlan.sourcePresent,
        targetPresent: profileSettingsPlan.targetPresent || false,
        changed: profileSettingsPlan.changed,
      },
    };
    if (!apply) return reportBase;

    backupPath = createBackup(target, resolvedBackupDirectory);
    const now = new Date().toISOString();
    target.exec("BEGIN IMMEDIATE");
    try {
      plans.forEach((plan) => insertRows(target, plan));
      saveProfileSettingsPlan(target, profileSettingsPlan, now);
      verifyInsertedRows(target, plans);
      if (readIntegrityStatus(target) !== "ok") {
        throw new Error("canonical SQLite 写入后 quick_check 失败");
      }
      target.exec("COMMIT");
    } catch (error) {
      target.exec("ROLLBACK");
      throw error;
    }
    target.exec("PRAGMA wal_checkpoint(TRUNCATE)");

    const report = {
      ...reportBase,
      appliedAt: now,
      backupPath,
      targetAfter: fileDescriptor(targetPath),
      tables: Object.fromEntries(
        plans.map((plan) => [
          plan.name,
          {
            ...reportBase.tables[plan.name],
            targetCountAfter: target
              .prepare(
                `SELECT COUNT(*) AS count FROM ${quoteIdentifier(plan.name)}`,
              )
              .get().count,
          },
        ]),
      ),
    };
    fs.mkdirSync(path.dirname(resolvedMarkerPath), { recursive: true });
    fs.writeFileSync(
      resolvedMarkerPath,
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    );
    return report;
  } catch (error) {
    error.backupPath = backupPath;
    throw error;
  } finally {
    source.close();
    target.close();
  }
}

export { BUSINESS_TABLES };
