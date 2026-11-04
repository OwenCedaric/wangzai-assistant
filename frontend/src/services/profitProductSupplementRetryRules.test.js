import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const profitPageSource = readFileSync(
  join(process.cwd(), 'src/features/profit/ProfitPage.jsx'),
  'utf8'
);
const productMirrorSource = readFileSync(
  join(process.cwd(), 'src/entities/product/productLocalMirror.jsx'),
  'utf8'
);

describe('profit product supplement retry rules', () => {
  it('retries failed local product supplementation instead of permanently locking the first attempt', () => {
    expect(profitPageSource).not.toContain(
      'profitLocalProductSupplementRef.current === profitVisibleImageScopeKey'
    );
    expect(profitPageSource).toContain(
      'PROFIT_PRODUCT_SUPPLEMENT_RETRY_DELAYS_MS = Object.freeze([2_000, 5_000, 15_000, 30_000, 60_000])'
    );
    expect(profitPageSource).toContain('setProfitProductSupplementRetryRevision((revision) => revision + 1)');
  });

  it('keeps retrying until images, estimated commission and product material are all available', () => {
    const start = profitPageSource.indexOf('function getProfitProductSupplementGapCount');
    const end = profitPageSource.indexOf('function getProfitProductSupplementRetryDelay', start);
    const source = profitPageSource.slice(start, end);
    expect(source).toContain('hasOzonOrderRowProductImage');
    expect(source).toContain('hasOzonOrderRowEstimatedCommission');
    expect(source).toContain('hasProfitOrderProductMaterialGap');
  });

  it('does not let a slow remote profit refresh block local product supplementation or ledger persistence', () => {
    const supplementStart = profitPageSource.indexOf('const supplementBatch = selectProfitProductSupplementBatch({');
    const supplementEnd = profitPageSource.indexOf('const persistProfitLedgerOrders = React.useCallback', supplementStart);
    const supplementSource = profitPageSource.slice(supplementStart, supplementEnd);
    expect(supplementSource).toContain('getGapCount: getProfitProductSupplementGapCount');
    expect(supplementSource).toContain('deferredCount');
    expect(supplementSource).toContain('readOzonLocalProductEntityRows(');
    expect(supplementSource).toContain('readProfitOrderCanonicalDependencyRows(');
    expect(supplementSource).toContain('enableSkuFallback: true');
    expect(supplementSource).toContain('requireImages: true');
    expect(supplementSource).not.toContain('readProfitProductSummarySupport(');
    expect(supplementSource).not.toContain('profitSync.loading');
    expect(productMirrorSource).toContain('enableSkuFallback: options.enableSkuFallback === true');

    const persistStart = profitPageSource.indexOf(
      'persistProfitLedgerOrders(profitRows, profitSync.data?.errors ?? []).catch'
    );
    const persistEffectStart = profitPageSource.lastIndexOf('React.useEffect(() => {', persistStart);
    const persistEffectEnd = profitPageSource.indexOf('const shopOptions =', persistStart);
    const persistSource = profitPageSource.slice(persistEffectStart, persistEffectEnd);
    expect(persistSource).not.toContain('profitSync.loading');
  });

  it('does not turn page-only image enrichment into a full ledger feedback rewrite', () => {
    expect(profitPageSource).toContain(
      'createProfitLedgerHash(createProfitLedgerPersistenceComparableRow(row))'
    );
    const persistCallbackStart = profitPageSource.indexOf('const persistProfitLedgerOrders = React.useCallback');
    const persistCallbackEnd = profitPageSource.indexOf('React.useEffect(() => {', persistCallbackStart);
    const persistCallbackSource = profitPageSource.slice(persistCallbackStart, persistCallbackEnd);
    expect(persistCallbackSource).not.toContain('setProfitLedgerRows(');
    expect(profitPageSource).toContain('const { profitSummaryCards, profitTabs } = React.useMemo(() => {');
  });
});
