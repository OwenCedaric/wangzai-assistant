import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { ensureMigrationTable, listMigrationFiles, runMigrations } from './database.js';

function executeMigration(db, migration) {
  db.exec(readFileSync(migration.path, 'utf8').replace(/^\uFEFF/u, ''));
  db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)')
    .run(migration.version, migration.fileName);
}

test('migration 092 normalizes only obsolete follow-seller verification states without losing recovery data', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON;');
    ensureMigrationTable(db);
    const migrations = listMigrationFiles();
    migrations
      .filter((migration) => migration.version < '092_normalize_follow_seller_verification_status')
      .forEach((migration) => executeMigration(db, migration));

    db.prepare("INSERT INTO shops (id, name, status) VALUES ('shop-status', '状态迁移测试店铺', 'active')").run();
    const insert = db.prepare(`
      INSERT INTO follow_seller_cases (
        id, shop_id, offer_id, sku, status, stage,
        write_payload_json, write_result_json, ozon_job_id, ozon_task_id,
        follow_count_before, sellers_json, last_error_code, last_error_message,
        created_at, updated_at
      ) VALUES (
        ?, 'shop-status', ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        '2026-08-17T00:00:00.000Z', '2026-08-18T00:00:00.000Z'
      )
    `);
    const legacyRows = [
      ['case-review', 'awaiting_support_review', 'waiting_support_reply'],
      ['case-verify', 'awaiting_verification', 'ready_for_follow_check'],
      ['case-evidence', 'evidence_required', 'support_requested_evidence'],
      ['case-mismatch', 'readback_mismatch', 'ready_for_follow_check'],
    ];
    legacyRows.forEach(([id, status, stage], index) => insert.run(
      id,
      `OFFER-${index + 1}`,
      `SKU-${index + 1}`,
      status,
      stage,
      JSON.stringify({ evidenceId: `evidence-${index + 1}`, speech: '保留证据话术' }),
      JSON.stringify({ ok: true, submissionStarted: true }),
      `ticket-${index + 1}`,
      `message-${index + 1}`,
      3,
      JSON.stringify([{ sku: `FOLLOWER-${index + 1}` }]),
      `OLD-${index + 1}`,
      `旧状态诊断 ${index + 1}`,
    ));
    insert.run(
      'case-failed',
      'OFFER-FAILED',
      'SKU-FAILED',
      'submission_failed',
      'submission_failed',
      JSON.stringify({ evidenceId: 'evidence-failed' }),
      JSON.stringify({ ok: false }),
      'ticket-failed',
      'message-failed',
      2,
      JSON.stringify([{ sku: 'FOLLOWER-FAILED' }]),
      'SUBMIT-FAILED',
      '提交失败',
    );

    assert.deepEqual(runMigrations(db), [
      '092_normalize_follow_seller_verification_status',
      '093_add_account_removal_foreign_key_indexes',
      '094_add_cross_border_expires_token',
      '095_guard_ozon_order_identity',
      '096_create_profit_report_cache',
      '097_scope_profit_report_balance_by_date',
      '098_enforce_product_id_identity',
      '099_add_ozon_push_endpoint_bindings',
      '111_add_cross_border_server_authorization',
      '112_create_profit_ledger_owner_routes',
    ]);
    const normalized = db.prepare(`
      SELECT id, status, stage, write_payload_json, write_result_json,
             ozon_job_id, ozon_task_id, follow_count_before, sellers_json,
             last_error_code, last_error_message
        FROM follow_seller_cases
       WHERE id <> 'case-failed'
       ORDER BY id
    `).all().map((row) => ({ ...row }));
    assert.equal(normalized.length, 4);
    normalized.forEach((row) => {
      assert.equal(row.status, 'verification_ready');
      assert.equal(row.stage, 'awaiting_manual_verification');
      assert.match(row.write_payload_json, /evidence-/u);
      assert.match(row.write_result_json, /submissionStarted/u);
      assert.match(row.ozon_job_id, /^ticket-/u);
      assert.match(row.ozon_task_id, /^message-/u);
      assert.equal(row.follow_count_before, 3);
      assert.match(row.sellers_json, /FOLLOWER-/u);
      assert.match(row.last_error_code, /^OLD-/u);
      assert.match(row.last_error_message, /^旧状态诊断/u);
    });

    assert.deepEqual(
      { ...db.prepare(`
        SELECT status, stage, write_payload_json, write_result_json,
               ozon_job_id, ozon_task_id, follow_count_before, sellers_json,
               last_error_code, last_error_message
          FROM follow_seller_cases
         WHERE id = 'case-failed'
      `).get() },
      {
        status: 'submission_failed',
        stage: 'submission_failed',
        write_payload_json: JSON.stringify({ evidenceId: 'evidence-failed' }),
        write_result_json: JSON.stringify({ ok: false }),
        ozon_job_id: 'ticket-failed',
        ozon_task_id: 'message-failed',
        follow_count_before: 2,
        sellers_json: JSON.stringify([{ sku: 'FOLLOWER-FAILED' }]),
        last_error_code: 'SUBMIT-FAILED',
        last_error_message: '提交失败',
      },
    );
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 112);
    assert.deepEqual(runMigrations(db), []);
  } finally {
    db.close();
  }
});
