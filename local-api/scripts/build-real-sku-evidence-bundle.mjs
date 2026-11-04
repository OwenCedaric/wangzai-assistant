import { createHash } from "node:crypto";
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const localApiRoot = resolve(scriptDir, "..");
const workspaceRoot = resolve(localApiRoot, "..");
const evidenceDirectory = resolve(localApiRoot, "evidence");
const artifactPath = resolve(
  evidenceDirectory,
  "mzr-20260520-638834907-9348.real-ozon.json",
);
const proofPath = resolve(
  evidenceDirectory,
  "mzr-20260520-638834907-9348.target-only.proofdb",
);
const manifestPath = resolve(
  evidenceDirectory,
  "mzr-20260520-638834907-9348.evidence-manifest.json",
);
const sourceFlagIndex = process.argv.indexOf("--source");
const sourcePath = sourceFlagIndex >= 0
  ? resolve(process.cwd(), process.argv[sourceFlagIndex + 1])
  : resolve(workspaceRoot, ".tmp/sku-real-readonly-proof.sqlite");

const RETAINED_TABLES = new Set([
  "schema_migrations",
  "shops",
  "ozon_products",
  "ozon_response_cache",
]);
const ACCOUNT_TABLE_PATTERN = /(?:account|integration|profile_settings)/iu;
const SENSITIVE_COLUMN_PATTERN = /(?:api.?key|secret|password|cookie|credential|authorization|client_id|access_token|refresh_token)/iu;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function quoteSqlText(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function stableRowHash(row) {
  return sha256(Buffer.from(JSON.stringify(row), "utf8"));
}

function collectSensitiveValues(db, tables) {
  const values = [];
  for (const table of tables) {
    const accountTable = ACCOUNT_TABLE_PATTERN.test(table);
    const columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all();
    for (const column of columns) {
      const sensitiveColumn = SENSITIVE_COLUMN_PATTERN.test(column.name);
      if (!accountTable && !sensitiveColumn) continue;
      const rows = db.prepare(
        `SELECT ${quoteIdentifier(column.name)} AS value FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(column.name)} IS NOT NULL`,
      ).all();
      for (const { value } of rows) {
        const buffer = Buffer.isBuffer(value)
          ? value
          : Buffer.from(String(value), "utf8");
        const minimumLength = sensitiveColumn ? 8 : 20;
        if (buffer.length >= minimumLength) {
          values.push({ label: `${table}.${column.name}`, buffer });
        }
      }
    }
  }
  return values;
}

function readTargetRow(db, selector) {
  return db.prepare(`
    SELECT * FROM ozon_products
    WHERE shop_id = ? AND offer_id = ?
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(selector.shopId, selector.offerId);
}

function inspectProofDatabase(filePath, evidence, expectedTargetHash) {
  const db = new DatabaseSync(filePath, { readOnly: true });
  try {
    db.exec("PRAGMA query_only = ON");
    assert(db.prepare("PRAGMA quick_check").get()?.quick_check === "ok", "compact proof quick_check failed");
    assert(
      Number(db.prepare("PRAGMA user_version").get()?.user_version)
        === Number(evidence.sourceSnapshot.databaseUserVersion),
      "compact proof user_version changed",
    );
    const tables = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all().map(({ name }) => name);
    for (const table of tables) {
      const count = Number(
        db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`).get()?.count,
      );
      if (!RETAINED_TABLES.has(table)) {
        assert(count === 0, `compact proof retained rows in ${table}`);
      }
    }
    assert(db.prepare("SELECT COUNT(*) AS count FROM shops").get().count === 1, "compact proof must retain one redacted shop");
    const shop = db.prepare(`
      SELECT id, name, alias, client_id, api_key_encrypted, status
      FROM shops
    `).get();
    assert(shop.id === evidence.selector.shopId, "compact proof retained the wrong shop");
    assert(shop.name === "Redacted Ozon evidence shop", "compact proof shop name is not redacted");
    assert(shop.alias === null, "compact proof shop alias was retained");
    assert(shop.client_id === null, "compact proof retained an Ozon Client-Id");
    assert(shop.api_key_encrypted === null, "compact proof retained an Ozon API key");
    assert(shop.status === "inactive", "compact proof shop must be inactive");
    assert(db.prepare("SELECT COUNT(*) AS count FROM ozon_products").get().count === 1, "compact proof must retain one product row");
    const target = readTargetRow(db, evidence.selector);
    assert(target, "compact proof target SKU is missing");
    assert(stableRowHash(target) === expectedTargetHash, "compact proof target row changed");
    assert(db.prepare("SELECT COUNT(*) AS count FROM ozon_response_cache").get().count === 1, "compact proof must retain one synthetic transient cache row");
    return {
      quickCheck: "ok",
      databaseUserVersion: Number(db.prepare("PRAGMA user_version").get()?.user_version),
      targetRowSha256: expectedTargetHash,
      retainedRows: {
        shops: 1,
        ozonProducts: 1,
        syntheticOzonResponseCache: 1,
        schemaMigrations: Number(
          db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()?.count,
        ),
        allOtherTables: 0,
      },
      credentialsRetained: false,
    };
  } finally {
    db.close();
  }
}

async function main() {
  assert(existsSync(sourcePath), `original read-only source snapshot is missing: ${sourcePath}`);
  const evidence = JSON.parse(readFileSync(artifactPath, "utf8"));
  const origin = evidence.sourceSnapshot?.origin || evidence.sourceSnapshot;
  assert(origin?.kind === "desktop-runtime-profile-sqlite-copy", "evidence origin snapshot metadata is missing");
  assert(statSync(sourcePath).size === origin.sizeBytes, "original source snapshot size changed");
  assert(await sha256File(sourcePath) === origin.sha256, "original source snapshot SHA-256 changed");

  mkdirSync(evidenceDirectory, { recursive: true });
  const workRoot = mkdtempSync(resolve(workspaceRoot, ".tmp/sku-compact-proof-"));
  const workPath = resolve(workRoot, "source-copy.sqlite");
  copyFileSync(sourcePath, workPath);

  let targetRowSha256;
  let sensitiveValues;
  try {
    const db = new DatabaseSync(workPath);
    try {
      db.exec("PRAGMA foreign_keys = OFF; PRAGMA secure_delete = ON; PRAGMA journal_mode = DELETE;");
      const tables = db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name
      `).all().map(({ name }) => name);
      sensitiveValues = collectSensitiveValues(db, tables);
      const targetBefore = readTargetRow(db, evidence.selector);
      assert(targetBefore, "target SKU is absent from the original source snapshot");
      targetRowSha256 = stableRowHash(targetBefore);

      db.exec("BEGIN IMMEDIATE");
      for (const table of tables) {
        if (!RETAINED_TABLES.has(table)) {
          db.exec(`DELETE FROM ${quoteIdentifier(table)}`);
        }
      }
      db.prepare("DELETE FROM shops WHERE id <> ?").run(evidence.selector.shopId);
      db.prepare(`
        UPDATE shops
        SET name = 'Redacted Ozon evidence shop',
            alias = NULL,
            client_id = NULL,
            api_key_encrypted = NULL,
            status = 'inactive'
        WHERE id = ?
      `).run(evidence.selector.shopId);
      db.prepare("DELETE FROM ozon_products WHERE shop_id <> ? OR offer_id <> ?")
        .run(evidence.selector.shopId, evidence.selector.offerId);
      db.exec("DELETE FROM ozon_response_cache");
      db.prepare(`
        INSERT INTO ozon_response_cache (
          id, domain, shop_id, endpoint_key, cache_key,
          payload_hash, response_hash, remote_hash, status, is_stale,
          stale_reason, expires_at, last_seen_at, updated_at, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', 0, NULL, NULL, ?, ?, ?)
      `).run(
        "real-sku-evidence-transient-cache",
        "products",
        evidence.selector.shopId,
        "evidence.synthetic",
        "real-sku-evidence:transient",
        sha256("redacted-transient-payload"),
        sha256("redacted-transient-response"),
        sha256("redacted-transient-remote"),
        evidence.capturedAt,
        evidence.capturedAt,
        JSON.stringify({ redacted: true, purpose: "ordinary-cache-clear-proof" }),
      );
      db.exec("COMMIT");
      assert(db.prepare("PRAGMA quick_check").get()?.quick_check === "ok", "sanitized work copy quick_check failed");

      rmSync(proofPath, { force: true });
      db.exec(`VACUUM INTO ${quoteSqlText(proofPath)}`);
    } finally {
      db.close();
    }

    const proofBytes = readFileSync(proofPath);
    for (const sensitive of sensitiveValues) {
      assert(
        proofBytes.indexOf(sensitive.buffer) < 0,
        `compact proof still contains redacted sensitive value from ${sensitive.label}`,
      );
    }

    const proofSizeBytes = statSync(proofPath).size;
    const proofSha256 = await sha256File(proofPath);
    const originalSource = evidence.sourceSnapshot?.origin || evidence.sourceSnapshot;
    evidence.sourceSnapshot = {
      kind: "redacted-target-only-sqlite-proof",
      relativePath: `evidence/${basename(proofPath)}`,
      databaseUserVersion: originalSource.databaseUserVersion,
      sizeBytes: proofSizeBytes,
      sha256: proofSha256,
      targetRowSha256,
      origin: originalSource,
      redaction: {
        method: "copy-delete-scrub-vacuum-into",
        builder: "local-api/scripts/build-real-sku-evidence-bundle.mjs",
        retainedShopCredentials: false,
        retainedTargetProducts: 1,
        retainedSyntheticCacheRows: 1,
        retainedOtherBusinessRows: 0,
      },
    };
    evidence.durableProof = {
      manifestRelativePath: `evidence/${basename(manifestPath)}`,
      releaseGate: "required-no-skip",
      proofScope: "persisted-real-ozon-mapped-facts-and-normalized-migration",
      limitation: "The historical raw HTTP envelope was not retained; this compact proof preserves the exact persisted target row and its endpoint/contract/mapper/response-hash provenance without credentials or other business rows.",
    };
    writeFileSync(artifactPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");

    const proofInspection = inspectProofDatabase(
      proofPath,
      evidence,
      targetRowSha256,
    );
    const artifactBytes = readFileSync(artifactPath);
    const manifest = {
      bundleVersion: 1,
      evidenceId: evidence.evidenceId,
      generatedAt: new Date().toISOString(),
      artifact: {
        relativePath: relative(localApiRoot, artifactPath).replaceAll("\\", "/"),
        sizeBytes: artifactBytes.length,
        sha256: sha256(artifactBytes),
      },
      sourceProof: {
        relativePath: relative(localApiRoot, proofPath).replaceAll("\\", "/"),
        sizeBytes: proofSizeBytes,
        sha256: proofSha256,
        databaseUserVersion: evidence.sourceSnapshot.databaseUserVersion,
        targetRowSha256,
      },
      inspection: proofInspection,
      releaseGate: {
        missingArtifact: "fail",
        missingSourceProof: "fail",
        hashMismatch: "fail",
        testSkipAllowed: false,
      },
    };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({
      ok: true,
      artifactPath,
      proofPath,
      manifestPath,
      proofSizeBytes,
      proofSha256,
      targetRowSha256,
      credentialsRetained: false,
    }, null, 2)}\n`);
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
