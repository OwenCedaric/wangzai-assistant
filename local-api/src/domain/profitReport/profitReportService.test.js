import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import test from 'node:test';

import { createProfitReportService } from './profitReportService.js';

test('sends YYYY-MM-DD dates to Ozon balance and cash-flow report endpoints', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  for (const name of [
    '001_create_base_tables.sql',
    '004_create_ozon_scheduler_tables.sql',
    '005_complete_ozon_scheduler_foundation.sql',
    '096_create_profit_report_cache.sql',
    '097_scope_profit_report_balance_by_date.sql',
  ]) db.exec(readFileSync(resolve('src/db/migrations', name), 'utf8'));
  db.prepare("INSERT INTO shops (id, name, status) VALUES ('shop-1', 'Ozon Shop', 'active')").run();

  const calls = [];
  let backgroundTask;
  const service = createProfitReportService({
    db,
    backgroundRunner(task) { backgroundTask = task; },
    ozonScheduler: {
      async executeReadOnly(input) {
        calls.push(input);
        if (input.endpointKey === 'profitReport.balance') {
          return {
            ok: true,
            data: {
              total: {
                opening_balance: { value: 10, currency_code: 'RUB' },
                closing_balance: { value: 20, currency_code: 'RUB' },
                accrued: { value: 12, currency_code: 'RUB' },
                payments: [{ value: 3, currency_code: 'RUB' }],
              },
              cashflows: {
                sales: { amount: { value: 30, currency_code: 'RUB' }, fee: { value: -4, currency_code: 'RUB' } },
                returns: { amount: { value: -2, currency_code: 'RUB' }, fee: { value: 1, currency_code: 'RUB' } },
                services: [{ name: 'pay_per_click', amount: { value: -1, currency_code: 'RUB' } }],
              },
            },
          };
        }
        return { ok: false, error: { message: 'cash-flow statement unavailable' } };
      },
    },
  });

  const accepted = service.startSync({ shopId: 'shop-1', from: '2026-07-26', to: '2026-08-25' });
  assert.equal(accepted.accepted, true);
  await backgroundTask();
  assert.deepEqual(calls[0].params, { date_from: '2026-07-26', date_to: '2026-08-25' });
  assert.deepEqual(calls[1].params.date, {
    from: '2026-07-26T00:00:00.000Z',
    to: '2026-08-25T00:00:00.000Z',
  });
  const report = service.readCache({ shopId: 'shop-1' });
  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0].invoiceTransfer, 12);
  assert.equal(report.rows[0].ordersAmount, 30);
  assert.equal(report.rows[0].commissionAmount, -3);
  assert.equal(report.balances[0].balanceAmount, 20);
  db.close();
});
