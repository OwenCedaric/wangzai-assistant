import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  mergeOzonShopPurchaseBindingPreferences,
  migrateLegacyWorkspaceBusinessData,
} from "./legacyWorkspaceBusinessMigration.js";

function createFixtureDatabase(databasePath) {
  const db = new DatabaseSync(databasePath);
  db.exec(`
    CREATE TABLE purchase_order_overrides (
      id TEXT PRIMARY KEY,
      shop_id TEXT,
      order_key TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(shop_id, order_key)
    );
    CREATE TABLE cross_border_order_records (
      id TEXT PRIMARY KEY,
      shop_id TEXT NOT NULL DEFAULT '',
      record_key TEXT NOT NULL,
      platform_order TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(shop_id, record_key)
    );
    CREATE TABLE purchase_source_links (
      id TEXT PRIMARY KEY,
      shop_id TEXT NOT NULL DEFAULT '',
      order_key TEXT NOT NULL,
      slot_index INTEGER NOT NULL DEFAULT 0,
      url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(shop_id, order_key, slot_index)
    );
    CREATE TABLE product_source_links (
      id TEXT PRIMARY KEY,
      shop_id TEXT NOT NULL,
      product_key TEXT NOT NULL,
      slot_index INTEGER NOT NULL DEFAULT 0,
      url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(shop_id, product_key, slot_index)
    );
    CREATE TABLE sales_source_links (
      id TEXT PRIMARY KEY,
      shop_id TEXT NOT NULL,
      order_key TEXT NOT NULL,
      slot_index INTEGER NOT NULL DEFAULT 0,
      url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(shop_id, order_key, slot_index)
    );
    CREATE TABLE product_material_profiles (
      id TEXT PRIMARY KEY,
      shop_id TEXT NOT NULL,
      product_key TEXT NOT NULL,
      source TEXT NOT NULL,
      weight_kg REAL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(shop_id, product_key, source)
    );
    CREATE TABLE profile_settings (
      namespace TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

function insertShopPreferences(db, startedAt) {
  const now = "2026-07-15T00:00:00.000Z";
  db.prepare(
    "INSERT INTO profile_settings (namespace, value_json, created_at, updated_at) VALUES (?, ?, ?, ?)",
  ).run(
    "ozon-shop-preferences",
    JSON.stringify({
      version: 1,
      shops: [
        {
          id: "shop-1",
          shopAlias: "Ozon 1店",
          purchaseManagementStartedAt: startedAt,
          purchaseManagementResetAt: "",
        },
      ],
      activeShopId: "shop-1",
    }),
    now,
    now,
  );
}

test("legacy business migration inserts missing rows, preserves canonical conflicts, and restores the earliest binding", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wangzai-business-migration-"));
  try {
    const sourcePath = path.join(root, "legacy.sqlite");
    const targetPath = path.join(root, "canonical.sqlite");
    const markerPath = path.join(root, "runtime", "migration.json");
    const backupDirectory = path.join(root, "backups");
    const source = createFixtureDatabase(sourcePath);
    const target = createFixtureDatabase(targetPath);
    const now = "2026-07-12T00:00:00.000Z";

    source
      .prepare(
        "INSERT INTO purchase_order_overrides (id, shop_id, order_key, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("legacy-conflict", "shop-1", "order-conflict", "legacy", now, now);
    source
      .prepare(
        "INSERT INTO purchase_order_overrides (id, shop_id, order_key, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("legacy-missing", "shop-1", "order-missing", "restore-me", now, now);
    target
      .prepare(
        "INSERT INTO purchase_order_overrides (id, shop_id, order_key, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("canonical-conflict", "shop-1", "order-conflict", "canonical", now, now);
    source
      .prepare(
        "INSERT INTO cross_border_order_records (id, shop_id, record_key, platform_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("cross-1", "shop-1", "record-1", "order-missing", now, now);
    source
      .prepare(
        "INSERT INTO product_material_profiles (id, shop_id, product_key, source, weight_kg, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("material-1", "shop-1", "product-1", "cross-border-bus", 0.12, now, now);
    insertShopPreferences(source, "2026-07-12T12:07:41.130Z");
    insertShopPreferences(target, "2026-07-15T09:09:51.747Z");
    source.close();
    target.close();

    const preview = migrateLegacyWorkspaceBusinessData({
      sourceDatabasePath: sourcePath,
      targetDatabasePath: targetPath,
      markerPath,
      backupDirectory,
    });
    assert.equal(preview.mode, "preview");
    assert.equal(preview.tables.purchase_order_overrides.insertCount, 1);
    assert.equal(preview.tables.purchase_order_overrides.preservedCount, 1);
    assert.equal(preview.profileSettings.changed, true);

    const applied = migrateLegacyWorkspaceBusinessData({
      sourceDatabasePath: sourcePath,
      targetDatabasePath: targetPath,
      markerPath,
      backupDirectory,
      apply: true,
    });
    assert.equal(applied.mode, "apply");
    assert.equal(applied.tables.purchase_order_overrides.targetCountAfter, 2);
    assert.equal(fs.existsSync(applied.backupPath), true);
    assert.equal(fs.existsSync(markerPath), true);

    const readback = new DatabaseSync(targetPath, { readOnly: true });
    assert.equal(
      readback
        .prepare(
          "SELECT note FROM purchase_order_overrides WHERE shop_id = ? AND order_key = ?",
        )
        .get("shop-1", "order-conflict").note,
      "canonical",
    );
    assert.equal(
      readback
        .prepare(
          "SELECT note FROM purchase_order_overrides WHERE shop_id = ? AND order_key = ?",
        )
        .get("shop-1", "order-missing").note,
      "restore-me",
    );
    assert.equal(
      readback.prepare("SELECT COUNT(*) AS count FROM cross_border_order_records").get().count,
      1,
    );
    assert.equal(
      readback.prepare("SELECT COUNT(*) AS count FROM product_material_profiles").get().count,
      1,
    );
    const preferences = JSON.parse(
      readback
        .prepare(
          "SELECT value_json FROM profile_settings WHERE namespace = 'ozon-shop-preferences'",
        )
        .get().value_json,
    );
    assert.equal(
      preferences.shops[0].purchaseManagementStartedAt,
      "2026-07-12T12:07:41.130Z",
    );
    readback.close();

    const repeated = migrateLegacyWorkspaceBusinessData({
      sourceDatabasePath: sourcePath,
      targetDatabasePath: targetPath,
      markerPath,
      backupDirectory,
      apply: true,
    });
    assert.equal(repeated.mode, "already-applied");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("purchase binding merge respects an explicit reset newer than the legacy start", () => {
  const merged = mergeOzonShopPurchaseBindingPreferences(
    {
      shops: [
        {
          id: "shop-1",
          purchaseManagementStartedAt: "",
          purchaseManagementResetAt: "2026-07-13T00:00:00.000Z",
        },
      ],
    },
    {
      shops: [
        {
          id: "shop-1",
          purchaseManagementStartedAt: "2026-07-12T00:00:00.000Z",
        },
      ],
    },
  );

  assert.equal(merged.changed, false);
  assert.equal(merged.value.shops[0].purchaseManagementStartedAt, "");
});
