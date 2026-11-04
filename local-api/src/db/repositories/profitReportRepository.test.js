import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  createProfitReportRepository,
  normalizeFinanceBalance,
  normalizeFinanceBalanceReportDetail,
  normalizeFinanceStatementDetail,
} from './profitReportRepository.js';

test('normalizes Ozon cash-flow statement amounts without turning missing values into zero', () => {
  const row = normalizeFinanceStatementDetail({
    begin_balance_amount: 100,
    end_balance_amount: 130,
    invoice_transfer: 30,
    loan: -2,
    payments: { currency_code: 'RUB', payment: 10 },
    period: { id: 77, begin: '2026-08-01T00:00:00Z', end: '2026-08-15T23:59:59Z' },
    delivery: {
      total: 65,
      amount: 80,
      delivery_services: {
        total: -15,
        items: [
          { name: 'Sale commission', price: -8 },
          { name: 'Delivery service', price: -4 },
          { name: 'Promotion and advertising', price: -3 },
        ],
      },
    },
    return: { total: -12, amount: -10, return_services: { total: -2, items: [] } },
    services: { total: -5, items: [{ name: 'FBO placement', price: -5 }] },
    others: { total: -1, items: [{ name: 'Other accrual', price: -1 }] },
    rfbs: { partial_compensation: 4 },
  }, { shopId: 'shop-1' });

  assert.equal(row.beginBalanceAmount, 100);
  assert.equal(row.endBalanceAmount, 130);
  assert.equal(row.invoiceTransfer, 30);
  assert.equal(row.payment, 10);
  assert.equal(row.ordersAmount, 80);
  assert.equal(row.returnsAmount, -10);
  assert.equal(row.commissionAmount, -8);
  assert.equal(row.deliveryServiceFee, -4);
  assert.equal(row.promotionFee, -3);
  assert.equal(row.fboServiceFee, -5);
  assert.equal(row.otherAccrualsFee, -1);
  assert.equal(row.compensationAndRestitutionFee, 4);
  assert.equal(row.itemDeliveryAndReturnAmount, 53);
  assert.equal(row.agencyServiceFee, null);
  assert.equal(Object.hasOwn(row.availability, 'agencyServiceFee'), false);
});

test('normalizes balance flexibly and preserves unavailable balance', () => {
  assert.equal(normalizeFinanceBalance({ result: { current_balance: '42.50', currency: 'RUB' } }, { shopId: 'shop-1' }).balanceAmount, 42.5);
  const unavailable = normalizeFinanceBalance({ result: {} }, { shopId: 'shop-1' });
  assert.equal(unavailable.balanceAmount, null);
  assert.deepEqual(unavailable.availability, {});
});

test('normalizes the current Ozon finance balance contract into balance and statement amounts', () => {
  const payload = {
    total: {
      opening_balance: { value: 100, currency_code: 'RUB' },
      closing_balance: { value: 130, currency_code: 'RUB' },
      accrued: { value: 30, currency_code: 'RUB' },
      payments: [{ value: 5, currency_code: 'RUB' }, { value: 7, currency_code: 'RUB' }],
    },
    cashflows: {
      sales: { amount: { value: 80, currency_code: 'RUB' }, fee: { value: -8, currency_code: 'RUB' } },
      returns: { amount: { value: -10, currency_code: 'RUB' }, fee: { value: 1, currency_code: 'RUB' } },
      services: [
        { name: 'international_delivery_services', amount: { value: -4, currency_code: 'RUB' } },
        { name: 'agency_fee_ozon', amount: { value: -3, currency_code: 'RUB' } },
        { name: 'pay_per_click', amount: { value: -2, currency_code: 'RUB' } },
        { name: 'loans_and_factoring', amount: { value: -1, currency_code: 'RUB' } },
        { name: 'partial_compensation_to_buyers', amount: { value: 6, currency_code: 'RUB' } },
      ],
    },
  };
  const balance = normalizeFinanceBalance(payload, { shopId: 'shop-1' });
  assert.equal(balance.balanceAmount, 130);
  assert.equal(balance.currencyCode, 'RUB');
  const detail = normalizeFinanceBalanceReportDetail(payload, { shopId: 'shop-1', from: '2026-07-26', to: '2026-08-25' });
  const statement = normalizeFinanceStatementDetail(detail, { shopId: 'shop-1' });
  assert.equal(statement.beginBalanceAmount, 100);
  assert.equal(statement.endBalanceAmount, 130);
  assert.equal(statement.invoiceTransfer, 30);
  assert.equal(statement.payment, 12);
  assert.equal(statement.ordersAmount, 80);
  assert.equal(statement.returnsAmount, -10);
  assert.equal(statement.commissionAmount, -7);
  assert.equal(statement.deliveryServiceFee, -4);
  assert.equal(statement.agencyServiceFee, -3);
  assert.equal(statement.promotionFee, -2);
  assert.equal(statement.loan, -1);
  assert.equal(statement.compensationAndRestitutionFee, 6);
});

test('persists statement and balance snapshots and reads a report without exposing raw secrets', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(readFileSync(resolve('src/db/migrations/001_create_base_tables.sql'), 'utf8'));
  db.exec(readFileSync(resolve('src/db/migrations/004_create_ozon_scheduler_tables.sql'), 'utf8'));
  db.exec(readFileSync(resolve('src/db/migrations/096_create_profit_report_cache.sql'), 'utf8'));
  db.exec(readFileSync(resolve('src/db/migrations/097_scope_profit_report_balance_by_date.sql'), 'utf8'));
  db.prepare("INSERT INTO shops (id, name, alias, status) VALUES ('shop-1', 'Ozon Shop', '主店', 'active')").run();
  const repository = createProfitReportRepository(db);
  repository.upsertStatements({
    shopId: 'shop-1',
    rows: [{ period: { id: 1, begin: '2026-08-01', end: '2026-08-15' }, payments: { currency_code: 'RUB', payment: 8 }, invoice_transfer: 20 }],
  });
  repository.upsertBalance({ shopId: 'shop-1', from: '2026-08-01', to: '2026-08-31', payload: { result: { balance: 55, currency: 'RUB', accessToken: 'must-not-be-public' } } });
  const report = repository.readReport({ shopId: 'shop-1', from: '2026-08-01', to: '2026-08-31' });
  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0].shopName, '主店');
  assert.equal(report.rows[0].invoiceTransfer, 20);
  assert.equal(report.balances[0].balanceAmount, 55);
  assert.equal(report.balances[0].dateFrom, '2026-08-01');
  assert.equal(Object.hasOwn(report.balances[0], 'raw'), false);
  db.close();
});

test('repairs confirmed Ozon balance cache into scoped balance and statement rows', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  for (const name of ['001_create_base_tables.sql', '004_create_ozon_scheduler_tables.sql', '096_create_profit_report_cache.sql', '097_scope_profit_report_balance_by_date.sql']) {
    db.exec(readFileSync(resolve('src/db/migrations', name), 'utf8'));
  }
  db.prepare("INSERT INTO shops (id, name, status) VALUES ('shop-1', 'Ozon Shop', 'active')").run();
  const payload = {
    total: {
      opening_balance: { value: 10, currency_code: 'RUB' },
      closing_balance: { value: 20, currency_code: 'RUB' },
      accrued: { value: 12, currency_code: 'RUB' },
      payments: [{ value: 3, currency_code: 'RUB' }],
    },
    cashflows: {
      sales: { amount: { value: 30, currency_code: 'RUB' }, fee: { value: -4, currency_code: 'RUB' } },
      returns: { amount: { value: -2, currency_code: 'RUB' }, fee: { value: 1, currency_code: 'RUB' } },
      services: [{ name: 'agency_fee_ozon', amount: { value: -1, currency_code: 'RUB' } }],
    },
  };
  db.prepare(`
    INSERT INTO ozon_response_cache (id, domain, shop_id, endpoint_key, cache_key, status, updated_at, payload_json)
    VALUES ('cache-1', 'profit-report', 'shop-1', 'profitReport.balance', 'profit-report:balance:shop-1:2026-07-26:2026-08-25', 'confirmed', '2026-08-25T00:00:00Z', ?)
  `).run(JSON.stringify(payload));
  const repository = createProfitReportRepository(db);
  const repaired = repository.repairCachedBalanceReports();
  assert.equal(repaired.scopes, 1);
  const report = repository.readReport({ shopId: 'shop-1', from: '2026-07-26', to: '2026-08-25' });
  assert.equal(report.balances[0].balanceAmount, 20);
  assert.equal(report.rows[0].ordersAmount, 30);
  assert.equal(report.rows[0].agencyServiceFee, -1);
  assert.equal(repository.repairCachedBalanceReports().changed, 0);
  db.close();
});
