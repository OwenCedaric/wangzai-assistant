import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  ORDINARY_CLEARABLE_CACHE_TABLES,
  PROFILE_MAINTENANCE_COMMAND_CONTRACTS,
  PROFILE_MAINTENANCE_COMMANDS,
  PROFILE_SCHEMA_TABLES,
  PROTECTED_PROFILE_TABLES,
  assertCompleteProfileCacheTableClassification,
} from "./profileCachePolicy.js";
import {
  PROFILE_CACHE_CLEAR_CONFIRMATION,
  clearProfileTransientCache,
  inspectProfileCache,
} from "./profileCacheReset.js";
import { runMigrations } from "../../../local-api/src/db/database.js";
import { createShopProductStorage } from '../../../local-api/src/db/shopProductStorage.js';
import { DATA_DOMAIN_REGISTRY } from "../../../local-api/src/data/dataDomainRegistry.js";

function createFixtureDatabase() {
  const db = new DatabaseSync(":memory:");
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
  return db;
}

function seedEveryClassification(db) {
  ORDINARY_CLEARABLE_CACHE_TABLES.forEach((tableName, index) => {
    db.prepare(`INSERT INTO "${tableName}" (id, payload) VALUES (?, ?)`).run(
      `cache-${index}`,
      `cache-payload-${index}`,
    );
  });
  PROTECTED_PROFILE_TABLES.forEach((tableName, index) => {
    if (tableName === "product_material_profiles") return;
    db.prepare(`INSERT INTO "${tableName}" (id, payload) VALUES (?, ?)`).run(
      `protected-${index}`,
      `protected-payload-${index}`,
    );
  });
  db.prepare(
    "INSERT INTO product_material_profiles (id, source, payload) VALUES (?, ?, ?)",
  ).run("material-ozon", "ozon-product-list-read", "keep-ozon-dimensions");
  db.prepare(
    "INSERT INTO product_material_profiles (id, source, payload) VALUES (?, ?, ?)",
  ).run("material-manual", "supplier-confirmed", "keep-manual-dimensions");
  db.prepare(
    "INSERT INTO schema_migrations (id, payload) VALUES (?, ?)",
  ).run("001", "keep-schema");
}

test("ordinary cache policy classifies the complete current schema exactly once", () => {
  const classified = [
    ...ORDINARY_CLEARABLE_CACHE_TABLES,
    ...PROTECTED_PROFILE_TABLES,
    ...PROFILE_SCHEMA_TABLES,
  ];
  assert.equal(new Set(classified).size, classified.length);
  assert.equal(PROTECTED_PROFILE_TABLES.includes("data_backup_owner_imports"), true);
  assert.equal(PROTECTED_PROFILE_TABLES.includes("customer_service_push_view_markers"), true);
  assert.equal(PROTECTED_PROFILE_TABLES.includes("product_image_assets"), true);
  assert.equal(PROTECTED_PROFILE_TABLES.includes("product_image_usage_events"), true);
  assert.equal(PROTECTED_PROFILE_TABLES.includes("follow_seller_action_attempts"), true);
  assert.equal(PROTECTED_PROFILE_TABLES.includes("follow_seller_cases"), true);
  assert.equal(PROTECTED_PROFILE_TABLES.includes("follow_seller_login_preferences"), true);
  assert.equal(PROTECTED_PROFILE_TABLES.includes("follow_seller_patrol_runs"), true);
  assert.equal(PROTECTED_PROFILE_TABLES.includes("ozon_finance_balance_snapshots"), true);
  assert.equal(PROTECTED_PROFILE_TABLES.includes("ozon_finance_statement_reports"), true);
  assert.deepEqual(ORDINARY_CLEARABLE_CACHE_TABLES, [
    "ozon_response_cache",
    "ozon_cache_keys",
  ]);
  assert.equal(assertCompleteProfileCacheTableClassification(classified), true);
  assert.throws(
    () => assertCompleteProfileCacheTableClassification([...classified, "unclassified_new_table"]),
    /未分级=unclassified_new_table/u,
  );
});

test("profile maintenance commands have four unique confirmations and owners", () => {
  const commands = Object.values(PROFILE_MAINTENANCE_COMMANDS);
  assert.equal(commands.length, 4);
  assert.equal(new Set(commands).size, 4);
  const contracts = commands.map(
    (command) => PROFILE_MAINTENANCE_COMMAND_CONTRACTS[command],
  );
  assert.equal(new Set(contracts.map((contract) => contract.confirmation)).size, 4);
  assert.equal(new Set(contracts.map((contract) => contract.owner)).size, 4);
  assert.equal(
    PROFILE_MAINTENANCE_COMMAND_CONTRACTS[
      PROFILE_MAINTENANCE_COMMANDS.CLEAR_TRANSIENT_CACHE
    ].mayDeleteCanonicalFacts,
    false,
  );
});

test("ordinary cache policy is closed over the real migrated local-api schema", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys = ON");
    runMigrations(db);
    const tableNames = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((row) => String(row.name));
    assert.equal(assertCompleteProfileCacheTableClassification(tableNames), true);
    const preview = inspectProfileCache(db);
    assert.equal(preview.tableCount, tableNames.length);
    assert.equal(preview.quickCheck, "ok");
    assert.equal(preview.totals.clearableRows, 0);
  } finally {
    db.close();
  }
});

test("desktop clear whitelist exactly matches DataDomainRegistry ordinary-cache policy", () => {
  const registryClearableTables = DATA_DOMAIN_REGISTRY
    .filter((policy) => policy.ordinaryCacheClear === "delete")
    .map((policy) => policy.canonicalTable)
    .sort();
  assert.deepEqual(
    [...ORDINARY_CLEARABLE_CACHE_TABLES].sort(),
    registryClearableTables,
  );
});

test("ordinary cache clear preserves every canonical fact, Ozon dimension and setting byte-for-byte", () => {
  const db = createFixtureDatabase();
  try {
    seedEveryClassification(db);
    const preview = inspectProfileCache(db);
    assert.equal(preview.quickCheck, "ok");
    assert.equal(preview.totals.clearableRows, ORDINARY_CLEARABLE_CACHE_TABLES.length);
    assert.equal(preview.protected.product_material_profiles.rows, 2);
    const protectedDigest = preview.protectedDigest;

    assert.throws(
      () => clearProfileTransientCache(db, { confirmation: "wrong" }),
      /明确确认口令/u,
    );
    assert.equal(inspectProfileCache(db).protectedDigest, protectedDigest);

    const result = clearProfileTransientCache(db, {
      confirmation: PROFILE_CACHE_CLEAR_CONFIRMATION,
    });
    assert.equal(result.ok, true);
    assert.equal(result.deletedRows, ORDINARY_CLEARABLE_CACHE_TABLES.length);
    assert.equal(result.after.totals.clearableRows, 0);
    assert.equal(result.before.protectedDigest, protectedDigest);
    assert.equal(result.after.protectedDigest, protectedDigest);
    assert.deepEqual(
      db
        .prepare(
          "SELECT id, source, payload FROM product_material_profiles ORDER BY id",
        )
        .all()
        .map((row) => ({ ...row })),
      [
        {
          id: "material-manual",
          source: "supplier-confirmed",
          payload: "keep-manual-dimensions",
        },
        {
          id: "material-ozon",
          source: "ozon-product-list-read",
          payload: "keep-ozon-dimensions",
        },
      ],
    );
    assert.match(
      db.prepare("SELECT payload FROM ozon_products").get()?.payload || "",
      /^protected-payload-/u,
    );
    assert.match(
      db.prepare("SELECT payload FROM ozon_orders").get()?.payload || "",
      /^protected-payload-/u,
    );
    assert.match(
      db.prepare("SELECT payload FROM ozon_finance_transactions").get()?.payload || "",
      /^protected-payload-/u,
    );
    assert.match(
      db.prepare("SELECT payload FROM ozon_returns").get()?.payload || "",
      /^protected-payload-/u,
    );
    assert.match(
      db.prepare("SELECT payload FROM catalog_category_nodes").get()?.payload || "",
      /^protected-payload-/u,
    );
    for (const tableName of [
      "product_commission_facts",
      "product_dimension_facts",
      "shared_catalog_categories",
      "shop_identity_tombstones",
    ]) {
      assert.match(
        db.prepare(`SELECT payload FROM "${tableName}"`).get()?.payload || "",
        /^protected-payload-/u,
        `${tableName} must survive ordinary cache clear`,
      );
    }
    assert.equal(
      db.prepare("SELECT payload FROM schema_migrations").get()?.payload,
      "keep-schema",
    );
  } finally {
    db.close();
  }
});

test("protected fingerprint mismatch rolls the SQLite clear transaction back", () => {
  const db = createFixtureDatabase();
  try {
    seedEveryClassification(db);
    const before = inspectProfileCache(db);
    db.exec(`
      CREATE TRIGGER poison_protected_fact_after_cache_delete
      AFTER DELETE ON ozon_response_cache
      BEGIN
        UPDATE ozon_products SET payload = 'tampered';
      END;
    `);

    assert.throws(
      () => clearProfileTransientCache(db, {
        confirmation: PROFILE_CACHE_CLEAR_CONFIRMATION,
      }),
      /受保护数据发生变化：ozon_products/u,
    );
    const after = inspectProfileCache(db);
    assert.equal(after.protectedDigest, before.protectedDigest);
    assert.equal(after.totals.clearableRows, before.totals.clearableRows);
    assert.match(
      db.prepare("SELECT payload FROM ozon_products").get()?.payload || "",
      /^protected-payload-/u,
    );
  } finally {
    db.close();
  }
});

test('runtime-created product revision counters are preserved and fingerprinted, not treated as cache', () => {
  const db = createFixtureDatabase();
  try {
    seedEveryClassification(db);
    db.exec(`CREATE TABLE shop_product_storage_revisions (shop_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, updated_at TEXT NOT NULL);
      INSERT INTO shop_product_storage_revisions VALUES ('fixture-shop', 71, '2026-09-08');`);
    const before = inspectProfileCache(db);
    assert.equal(before.protected.shop_product_storage_revisions.rows, 1);
    const result = clearProfileTransientCache(db, { confirmation: PROFILE_CACHE_CLEAR_CONFIRMATION });
    assert.equal(result.ok, true);
    assert.equal(db.prepare('SELECT revision FROM shop_product_storage_revisions').get().revision, 71);
    assert.deepEqual(result.after.protected.shop_product_storage_revisions, before.protected.shop_product_storage_revisions);
  } finally { db.close(); }
});

test('the real runtime-created revision schema participates in cache protection after ordinary migrations', () => {
  const db = new DatabaseSync(':memory:');
  try {
    runMigrations(db);
    createShopProductStorage({ canonicalDb: db, shopDatabaseRouter: { resolve() { throw new Error('unused'); }, open() { throw new Error('unused'); } } });
    db.prepare('INSERT INTO shop_product_storage_revisions(shop_id, revision, updated_at) VALUES (?, ?, ?)').run('isolated-shop', 71, '2026-09-08');
    const result = clearProfileTransientCache(db, { confirmation: PROFILE_CACHE_CLEAR_CONFIRMATION });
    assert.equal(result.ok, true);
    assert.deepEqual(result.before.protected.shop_product_storage_revisions, result.after.protected.shop_product_storage_revisions);
  } finally { db.close(); }
});

test('revision counter tampering rolls back cache deletion and the counter change together', () => {
  const db = createFixtureDatabase();
  try {
    seedEveryClassification(db);
    db.exec(`CREATE TABLE shop_product_storage_revisions (shop_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, updated_at TEXT NOT NULL);
      INSERT INTO shop_product_storage_revisions VALUES ('fixture-shop', 71, '2026-09-08');
      CREATE TRIGGER poison_revision AFTER DELETE ON ozon_response_cache BEGIN UPDATE shop_product_storage_revisions SET revision = 99; END;`);
    assert.throws(() => clearProfileTransientCache(db, { confirmation: PROFILE_CACHE_CLEAR_CONFIRMATION }), /shop_product_storage_revisions/);
    assert.equal(db.prepare('SELECT revision FROM shop_product_storage_revisions').get().revision, 71);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ozon_response_cache').get().count, 1);
  } finally { db.close(); }
});

test('an optional known runtime table never permits unknown similarly-named tables', () => {
  const db = createFixtureDatabase();
  try {
    assert.equal(inspectProfileCache(db).ok, true);
    db.exec('CREATE TABLE shop_product_storage_revisions_extra (id TEXT)');
    assert.throws(() => inspectProfileCache(db), /未分级=shop_product_storage_revisions_extra/);
  } finally { db.close(); }
});
