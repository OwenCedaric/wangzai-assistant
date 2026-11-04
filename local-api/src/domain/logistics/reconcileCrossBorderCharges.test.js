import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createMigratedTestDb } from '../../../test/testDb.js';
import { createPurchaseOrderOverrideRepository } from '../../db/repositories/purchaseOrderOverrideRepository.js';

test('production reconciler backs the shared accounting rules and rewrites every affected order once', () => {
  const root = mkdtempSync(join(tmpdir(), 'wangzai-charge-reconcile-'));
  const databasePath = join(root, 'fixture.sqlite');
  const outputDir = join(root, 'output');
  const db = createMigratedTestDb(databasePath);
  try {
    const timestamp = '2026-08-11T00:00:00.000Z';
    const recordInsert = db.prepare(`
      INSERT INTO cross_border_charge_records (
        id, tenant_id, user_id, profile_id, browser_account_ref, external_account_ref,
        cross_border_account_id, shop_id, collection_number, posting_number, purchase_order_number,
        direction, amount_cny, balance_after_cny, reason, occurred_at, warehouse, service_company,
        source_record_hash, raw_json, created_at, updated_at
      ) VALUES (?, 'tenant-a', 'user-a', 'default', 'browser-a', '', 'bus-a', 'shop-a', ?, 'ORDER-1', '',
        'expense', ?, ?, ?, ?, 'warehouse-a', 'GUOO', ?, '{}', ?, ?)
    `);
    [
      ['r1', '483558', 0.1, 64.9, '支付订单系统服务费', '1'],
      ['r2', '484189', 0.1, 64.8, '支付订单系统服务费', '2'],
      ['r3', '484189', 0.1, 60.2, '退还订单系统服务费', '3'],
      ['r4', '484189', 1.5, 60.1, '订单发货费用', '4'],
      ['r5', '484189', 1.5, 61.7, '取消发货,退回费用', '5'],
      ['r6', '484189', 1.5, 60.2, '订单发货费用', '6'],
    ].forEach(([id, collection, amount, balance, reason, occurredAt]) => {
      recordInsert.run(id, collection, amount, balance, reason, occurredAt, `legacy-${id}`, timestamp, timestamp);
    });
    const linkInsert = db.prepare(`
      INSERT INTO cross_border_charge_links (
        id, tenant_id, user_id, profile_id, browser_account_ref, external_account_ref,
        cross_border_account_id, shop_id, collection_number, posting_number, ozon_order_key,
        purchase_order_number, service_name, warehouse, actual_fee_cny, ledger_net_cny,
        currency, match_status, confidence, evidence_json, source_hash, last_seen_at, created_at, updated_at
      ) VALUES (?, 'tenant-a', 'user-a', 'default', 'browser-a', '', 'bus-a', 'shop-a', ?,
        'ORDER-1', 'ORDER-1', '', '', 'warehouse-a', ?, ?, 'CNY', 'exact', 100, ?, ?, ?, ?, ?)
    `);
    linkInsert.run(
      'l1', '483558', 0.1, 0.1, JSON.stringify({ internalOrderId: 'internal-1' }),
      'old-link-1', timestamp, timestamp, timestamp,
    );
    linkInsert.run(
      'l2', '484189', 4.7, 4.7, JSON.stringify({ internalOrderId: 'internal-2' }),
      'old-link-2', timestamp, timestamp, timestamp,
    );
    createPurchaseOrderOverrideRepository(db).upsertOverride({
      shopId: 'shop-a',
      orderKey: 'ORDER-1',
      postingNumber: 'ORDER-1',
      actualCrossBorderBusFeeCny: 0.1,
      actualCrossBorderBusFeeSource: 'cross-border-bus-ledger',
    });
    db.prepare(`
      INSERT INTO profile_settings (namespace, value_json, created_at, updated_at)
      VALUES ('fee-settings', ?, ?, ?)
    `).run(JSON.stringify({
      activeId: 'bus',
      plans: [{
        id: 'bus',
        name: '跨境巴士费用',
        settings: {
          platform: 'crossBorderBus',
          rechargeAmount: '300',
          giftAmount: '100',
          rechargeRateHistory: [{
            id: 'rate-300-100',
            effectiveAt: '2026-01-01T00:00:00.000Z',
            rechargeAmount: '300',
            giftAmount: '100',
          }],
        },
      }],
    }), timestamp, timestamp);
  } finally {
    db.close();
  }

  try {
    const result = spawnSync(process.execPath, [
      resolve('scripts/reconcile-cross-border-charges.mjs'),
      '--apply',
      '--skip-backup',
      `--database=${databasePath}`,
      `--output-dir=${outputDir}`,
    ], { cwd: resolve('.'), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(readFileSync(join(outputDir, 'cross-border-charge-reconciliation.json'), 'utf8'));
    assert.equal(report.summary.globalConserved, true);
    assert.equal(report.summary.correctedDirectionCount, 2);
    assert.equal(report.summary.exactOrderCount, 1);
    assert.equal(report.orders[0].ledgerNetCny, 1.6);
    assert.equal(report.orders[0].cashNetCny, 1.2);
    assert.equal(report.orders[0].newActualFeeCny, 1.2);

    const verified = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(verified.prepare("SELECT COUNT(*) total FROM cross_border_charge_records WHERE direction='income'").get().total, 2);
      assert.equal(verified.prepare('SELECT COUNT(*) total FROM cross_border_charge_records').get().total, 6);
      assert.equal(verified.prepare('SELECT COUNT(*) total FROM cross_border_charge_links').get().total, 2);
      const override = createPurchaseOrderOverrideRepository(verified).getOverride({ shopId: 'shop-a', orderKey: 'ORDER-1' });
      assert.equal(override.actualCrossBorderBusFeeCny, 1.2);
      assert.equal(override.crossBorderChargeEvidence.ledgerNetCny, 1.6);
      assert.equal(override.crossBorderChargeEvidence.cashNetCny, 1.2);
      assert.deepEqual(override.crossBorderChargeEvidence.collectionNumbers, ['483558', '484189']);
    } finally {
      verified.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
