import { expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createProfitLedgerRow, mergeProfitLedgerRows, migrateProfitLedgerRowToCurrentVersion } from './profitLedgerService.js';
import { normalizeOzonProfitOrder, rebuildProfitLedgerWithManualOverride } from '../entities/profit/profitDisplayRules.jsx';
import { rebuildProfitLedgerForFinalZeroActualSales } from '../entities/profit/profitLedgerMapping.jsx';
import { readSavedFeePlanState, withReadonlyFeePlanState } from './feeSettingsRuntime.js';
import { withReadonlyProductMaterialProfiles } from './productMaterialProfileStore.js';
import { withReadonlyLogisticsPricingSettings } from './logisticsPricingSettingsRuntime.js';
import { createProfitCoreBatch, encodeProfitWire, readProfitCoreResults } from './profitCoreWire.js';

it('the complete server pipeline matches local normalization, ledger and both rebuild paths', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wangzai-private-pipeline-'));
  if (!fixtureRoot.startsWith(path.join(os.tmpdir(), 'wangzai-private-pipeline-'))) throw new Error('FIXTURE_SCOPE_INVALID');
  const instant = '2026-09-07T00:00:00.000Z';
  vi.useFakeTimers(); vi.setSystemTime(new Date(instant));
  try {
    const calls = [], expected = [];
    for (let i = 0; i < 32; i++) {
      const order = {
        id: `fixture-${i}`, postingNumber: `fixture-${i}`, shopId: `isolated-shop-${i % 5}`, shopClientId: `isolated-client-${i % 5}`,
        status: ['delivered', 'cancelled', 'returned', 'awaiting_packaging'][i % 4],
        amountValue: i % 7 ? i * 12.35 : 0, currencyCode: i % 2 ? 'RUB' : 'CNY',
        purchasePriceValue: i % 9 ? i / 3 : null,
        products: [{ offerId: `sku-${i}`, qty: i % 3 + 1, priceValue: i * 3.14 }],
      };
      const context = { orderKey: order.id, updatedAt: instant, fetchedAt: instant, rubToCnyRate: 0.0925,
        financeIndex: new Map(), financeLookupCheckedIndex: new Map([[order.id, i % 2 === 0]]),
        afterSalesIndex: new Map(), priceInfoMap: new Map(), purchaseLocalOverrides: {},
      };
      const feePlanState = { activeId: 'fixture-plan', plans: [{ id: 'fixture-plan', settings: {
        platform: 'crossBorderBus', labelFeeUnit: String(i % 3), rechargeAmount: '100', giftAmount: String(i % 2 ? 10 : 0),
      } }] };
      const ledger = withReadonlyFeePlanState(feePlanState, () => createProfitLedgerRow(order, context));
      const materialProfiles = { [`${order.shopId}:sku-${i}`]: { shopId: order.shopId, weight: '250', length: '20', width: '10', height: '10', applyToProduct: true } };
      const logisticsPricingSettings = { globalSelection: { providerId: i % 2 ? 'cel' : 'guoo', market: 'RU' } };
      for (const operation of ['ledger', 'normalize', 'rebuild-final', 'manual-override', 'merge-ledger', 'migrate-ledger']) {
        const input = { order: operation === 'manual-override' ? { ...order, profitLedger: ledger } : order,
          context, feePlanState, materialProfiles, logisticsPricingSettings, ledger, fieldId: 'sourcePurchaseCostCny', amountValue: i + 1.25 };
        input.cachedLedger = ledger;
        if (operation === 'migrate-ledger' && i % 2) input.ledger = { ...ledger, calculationVersion: 'profit-ledger-v12-explicit-no-forecast-evidence' };
        calls.push({ id: `case-${i}-${operation}`, operation, input });
        expected.push(withReadonlyFeePlanState(feePlanState, () => withReadonlyProductMaterialProfiles(materialProfiles,
          () => withReadonlyLogisticsPricingSettings(logisticsPricingSettings, () => {
          if (operation === 'ledger') return createProfitLedgerRow(input.order, context);
          if (operation === 'normalize') return normalizeOzonProfitOrder(input.order, context);
          if (operation === 'rebuild-final') return rebuildProfitLedgerForFinalZeroActualSales(input.order, ledger);
          if (operation === 'merge-ledger') return mergeProfitLedgerRows([input.cachedLedger], [input.ledger], { keepUnseenCached: false })[0];
          if (operation === 'migrate-ledger') return migrateProfitLedgerRowToCurrentVersion(input.ledger);
          return rebuildProfitLedgerWithManualOverride(input.order, input.fieldId, input.amountValue);
        }))));
      }
    }
    const output = path.join(fixtureRoot, 'core');
    const built = spawnSync(process.execPath, [path.resolve('../desktop/scripts/build-private-profit-core.mjs'), '--full-pipeline', `--output=${output}`], { encoding: 'utf8', windowsHide: true });
    expect(built.status, built.stderr).toBe(0);
    const batches = Array.from({ length: calls.length / 16 }, (_, i) => calls.slice(i * 16, i * 16 + 16));
    const moduleUrl = pathToFileURL(path.join(output, 'profit-core.mjs')).href;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import fs from 'node:fs'; const OriginalDate=Date; globalThis.Date=class extends OriginalDate { constructor(...a){ super(...(a.length?a:[${JSON.stringify(instant)}])); } static now(){return new OriginalDate(${JSON.stringify(instant)}).getTime();} }; const {executeProfitBatch}=await import(${JSON.stringify(moduleUrl)}); process.stdout.write(JSON.stringify(JSON.parse(fs.readFileSync(0,'utf8')).map(executeProfitBatch)));`],
    { input: JSON.stringify(batches.map(createProfitCoreBatch)), encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
    expect(result.status, result.stderr).toBe(0);
    const actual = JSON.parse(result.stdout).flatMap((response, i) => readProfitCoreResults(response, batches[i]));
    expect(encodeProfitWire(actual)).toEqual(encodeProfitWire(expected));
    const manifest = JSON.parse(fs.readFileSync(path.join(output, 'source-manifest.json'), 'utf8'));
    expect(manifest.sources.some(source => source.path === '../shared/profitCoreWire.js')).toBe(true);
    expect(manifest.sources.some(source => source.path === '../desktop/server-core/profitExecution.mjs')).toBe(true);
  } finally {
    vi.useRealTimers();
    fs.rmSync(fixtureRoot, { recursive: true });
  }
}, 30_000);

it('fee snapshots are restored after errors and async work is never started', () => {
  const previous = readSavedFeePlanState();
  expect(() => withReadonlyFeePlanState(null, () => { throw new Error('fixture-failure'); })).toThrow('fixture-failure');
  expect(readSavedFeePlanState().plans[0].settings).toEqual(previous.plans[0].settings);
  const callback = vi.fn(async () => true);
  expect(() => withReadonlyFeePlanState(null, callback)).toThrow('FEE_SNAPSHOT_ASYNC_FORBIDDEN');
  expect(callback).not.toHaveBeenCalled();
});
