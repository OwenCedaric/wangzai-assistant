import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { createProfitLedgerRow, PROFIT_LEDGER_CALCULATION_VERSION } from './profitLedgerService.js';

it('the private Node execution candidate matches the unchanged ledger engine for all synthetic cases', () => {
  const cases = Array.from({ length: 1024 }, (_, i) => ({
    order: {
      id: `isolated-order-${i}`, shopId: `isolated-shop-${i % 5}`, shopClientId: `isolated-client-${i % 5}`,
      amountValue: i % 11 ? i / 7 : null, currencyCode: i % 2 ? 'CNY' : 'RUB',
      purchasePriceValue: i % 13 ? i / 29 : null,
      status: ['delivered', 'cancelled', 'returned', 'awaiting_packaging'][i % 4],
      raw: { status: ['delivered', 'cancelled', 'returned', 'awaiting_packaging'][i % 4] },
      products: [{ offerId: `fixture-sku-${i}`, qty: i % 4 + 1, priceValue: i / 31 }],
      partialCompensationOnly: i % 7 === 0, hasFinanceRefund: i % 19 === 0,
      buyerCompensationCny: i % 7 === 0 ? 1.23 : null,
    },
    context: {
      orderKey: `isolated-order-${i}`, updatedAt: '2026-09-07T00:00:00Z',
      actualFinanceStatus: ['confirmed', 'provisional', ''][i % 3], hasActualFinance: i % 2 === 0,
      financeLookupChecked: i % 3 === 0, hasRefundLoss: i % 17 === 0,
      allowZeroPurchaseCost: i % 5 === 0, rubToCnyRate: 0.0925,
      estimatedExchangeRate: { mode: 'daily', date: '2026-09-05', rubToCnyRate: 0.0925, source: 'fixture-estimate' },
      actualExchangeRate: { mode: 'daily', date: '2026-09-06', rubToCnyRate: 0.1, source: 'fixture-actual' },
      amounts: {
        sourcePurchaseCostCny: i % 13 ? i / 29 : null,
        actualCommissionFeeCny: i % 9 ? i / 100 : null, actualPenaltyFeeCny: i % 4 ? 0 : 7.64,
        actualAcquiringFeeCny: 0, actualDeliveryServiceFeeCny: 0,
        actualLogisticsFeeCny: 0, crossBorderBusFeeCny: i % 3 ? 1.23 : null,
        estimatedCrossBorderBusFeeCny: 2.5, estimatedCommissionFeeCny: 1.5,
      },
    },
  }));
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'wangzai-private-core-diff-'));
  if (!temporary.startsWith(path.join(os.tmpdir(), 'wangzai-private-core-diff-'))) throw new Error('FIXTURE_CLEANUP_SCOPE_INVALID');
  try {
  const outputDirectory = path.join(temporary, 'core');
  const built = spawnSync(process.execPath, [path.resolve(process.cwd(), '../desktop/scripts/build-private-profit-core.mjs'), `--output=${outputDirectory}`], { encoding: 'utf8', windowsHide: true });
  expect(built.status, built.stderr).toBe(0);
  const moduleUrl = pathToFileURL(path.join(outputDirectory, 'profit-core.mjs')).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import fs from 'node:fs'; import {createProfitLedgerRow,PROFIT_LEDGER_CALCULATION_VERSION} from ${JSON.stringify(moduleUrl)};
    const cases=JSON.parse(fs.readFileSync(0,'utf8'));process.stdout.write(JSON.stringify({version:PROFIT_LEDGER_CALCULATION_VERSION,rows:cases.map(item=>createProfitLedgerRow(item.order,item.context))}));`],
  { input: JSON.stringify(cases), encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  expect(result.status, result.stderr).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output.version).toBe(PROFIT_LEDGER_CALCULATION_VERSION);
  expect(output.rows).toEqual(JSON.parse(JSON.stringify(cases.map(item => createProfitLedgerRow(item.order, item.context)))));
  } finally {
    fs.rmSync(temporary, { recursive: true, force: false });
  }
});
