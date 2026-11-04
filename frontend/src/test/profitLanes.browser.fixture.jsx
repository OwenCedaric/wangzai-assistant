import React from 'react';
import { createRoot } from 'react-dom/client';
import { useProfitCalculationLanes } from '../features/profit/model/useProfitCalculationLanes.js';
import { useProfitCalculationLanes as useBaselineLanes } from '../features/profit/model/__fixtures__/useProfitCalculationLanes.baseline.js';
import { createProfitLedgerRow } from '../services/profitLedgerService.js';

// Real Chromium/React/ledger code, synthetic input only. This is deliberately
// separate from the licensed application and does not bypass its login gate.
const NativeDate = Date;
globalThis.Date = class extends NativeDate {
  constructor(...args) { super(...(args.length ? args : ['2026-09-06T00:00:00Z'])); }
  static now() { return new NativeDate('2026-09-06T00:00:00Z').getTime(); }
};
const count = Number(new URL(location.href).searchParams.get('orders') || 2000);
const requestedMode = new URL(location.href).searchParams.get('mode') || 'both';
if (!['baseline', 'candidate', 'both'].includes(requestedMode)) throw new Error('FIXTURE_MODE_INVALID');
if (!Number.isSafeInteger(count) || count < 10 || count > 200000) throw new Error('FIXTURE_COUNT_INVALID');
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls++; throw new Error('FIXTURE_NETWORK_FORBIDDEN'); };
const shops = Array.from({ length: 10 }, (_, i) => ({ id: `fixture-shop-${i}`, clientId: `fixture-client-${i}` }));
const initialRows = Array.from({ length: count }, (_, i) => ({ id: `fixture-order-${i}`, shopId: shops[i % 10].id,
  shopClientId: shops[i % 10].clientId, amountValue: 100 + i % 20, currencyCode: i % 3 ? 'CNY' : 'RUB',
  paymentDate: '2026-09-01T00:00:00Z', purchasePriceValue: 10, products: [{ offerId: `sku-${i}`, qty: 1 }] }));
const inputs = { readableShops: shops, profitLocalFinanceContexts: { byShopId: new Map(), byClientId: new Map() },
  profitImageMap: new Map(), profitFinanceRows: {}, profitLedgerRows: {},
  profitLocalInputs: { purchaseLocalOverrides: {}, productSourceLinks: {} }, ratingPenaltyIndex: new Map() };
const context = { hasActualFinance: true, exchangeRate: { rubToCnyRate: 0.08, source: 'synthetic-test' },
  amounts: { sourcePurchaseCostCny: 10, actualCommissionFeeCny: 2, actualPenaltyFeeCny: 0,
    actualAcquiringFeeCny: 0, actualDeliveryServiceFeeCny: 0, actualLogisticsFeeCny: 0,
    crossBorderBusFeeCny: 1, logisticsFeeCny: 3 } };
const calculate = row => ({ ...row, ledgerHash: createProfitLedgerRow(row, context).fieldHash });
const updatedRows = initialRows.map((row, index) => index === 9 ? { ...row, amountValue: 200 } : { ...row });
const reference = initialRows.map(row => calculate(row).ledgerHash);
const updatedReference = reference.slice();
updatedReference[9] = calculate(updatedRows[9]).ledgerHash;
const evidence = { kind: 'isolated-rendered-hook-not-full-client', orders: count, shops: 10, stages: [], complete: false };
let active = null, previousFrame = 0;
requestAnimationFrame(function frame(time) {
  if (active && previousFrame) { active.frames++; active.maxFrameGapMs = Math.max(active.maxFrameGapMs, time - previousFrame); }
  previousFrame = time;
  requestAnimationFrame(frame);
});
new PerformanceObserver(list => {
  if (active) for (const item of list.getEntries()) { active.longTasks++; active.maxLongTaskMs = Math.max(active.maxLongTaskMs, item.duration); }
}).observe({ type: 'longtask', buffered: false });

function Case({ mode, onDone }) {
  const useLanes = mode === 'baseline' ? useBaselineLanes : useProfitCalculationLanes;
  const [baseRows, setBaseRows] = React.useState(initialRows);
  const stage = React.useRef('cold'), calls = React.useRef(0);
  const calculateRow = React.useCallback(row => { calls.current++; return calculate(row); }, []);
  const progress = useLanes({ ...inputs, isActive: true, baseProfitRows: baseRows, calculateProfitRow: calculateRow });
  React.useEffect(() => {
    if (progress.errors.length) throw new Error('FIXTURE_CALCULATION_ERROR');
    const expected = stage.current === 'cold' ? reference : updatedReference;
    if (progress.rows.length !== count || progress.rows[9].ledgerHash !== expected[9]) return;
    const currentStage = stage.current;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (stage.current !== currentStage) return;
      const matched = progress.rows.every((row, index) => row.ledgerHash === expected[index]);
      const visibleRows = document.querySelectorAll('tbody tr').length;
      if (!matched || visibleRows !== 20) throw new Error('FIXTURE_LEDGER_OR_DOM_MISMATCH');
      evidence.stages.push({ ...active, durationMs: performance.now() - active.startedAt,
        calculatedRows: calls.current, matchedLedgerHashes: count, visibleRows });
      window.profitFixture.progress({ mode, stage: currentStage, matched, visibleRows });
      if (currentStage === 'cold') {
        stage.current = 'warm'; calls.current = 0;
        active = metric(mode, 'warm'); setBaseRows(updatedRows);
      } else { stage.current = 'done'; active = null; onDone(); }
    }));
  }, [progress.rows, progress.errors, mode, onDone]);
  return <><h1>隔离计算验证：{mode}</h1><p>10 店铺 / {count} 条合成订单；仅展示前 20 条</p>
    <table><thead><tr><th>店铺</th><th>订单</th><th>计算结果指纹</th></tr></thead>
      <tbody>{progress.rows.slice(0, 20).map(row => <tr key={row.id}><td>{row.shopId}</td><td>{row.id}</td><td>{row.ledgerHash}</td></tr>)}</tbody></table></>;
}
function metric(mode, stage) { return { mode, stage, startedAt: performance.now(), frames: 0, maxFrameGapMs: 0, longTasks: 0, maxLongTaskMs: 0 }; }
const root = createRoot(document.getElementById('root'));
const run = mode => new Promise(resolve => { active = metric(mode, 'cold'); root.render(<Case key={mode} mode={mode} onDone={resolve} />); });
// Exclude common fixture generation from either measured implementation.
await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
if (requestedMode !== 'candidate') await run('baseline');
if (requestedMode !== 'baseline') await run('candidate');
evidence.complete = true; evidence.networkCalls = networkCalls;
window.profitFixture.finish(evidence);
