import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSplitAppSource } from '../test/appSource.js';
import { attachSplitRelationFields, shouldIncludeOrderInBusinessFlow } from './orderSplitRelationRules.js';

const appSource = readSplitAppSource();
const afterSalesPageSource = readFileSync(
  join(process.cwd(), 'src', 'features', 'orders', 'afterSales', 'AfterSalesOrdersPage.jsx'),
  'utf8'
);

describe('order split relation page integration', () => {
  it('keeps sales display Ozon-driven while locking split parent actions', () => {
    expect(appSource).toContain('shouldShowOrderInOzonDisplayList(order, { keyword: keywordText })');
    expect(appSource).toContain('const detailSplitLocked = isSplitParentBusinessLocked(detailOrder);');
    expect(appSource).toContain(
      "const detailSplitLockReason = detailSplitLocked ? getSplitOrderLockReason(detailOrder) : '';"
    );
    expect(appSource).toContain('!detailSplitLocked');
  });

  it('excludes split parents from purchase and profit business flows', () => {
    // The range reader memoizes this predicate per immutable order snapshot.
    expect(appSource).toContain('businessFlow: shouldIncludeOrderInBusinessFlow(order),');
    expect(appSource).toContain('const matchSplitBusiness = description.businessFlow;');
    expect(appSource).toContain(
      'return matchSplitBusiness && matchFulfillment && matchKeyword && matchPaymentStart && matchPaymentEnd;'
    );
    expect(appSource).toContain('return shouldIncludeOrderInBusinessFlow(calculatedOrder) ? calculatedOrder : null;');
  });
  it('rejects locked split parents and keeps child/ordinary orders under the actual business predicate', () => {
    const child = attachSplitRelationFields({ id: 'child' }, { splitRole: 'child', splitParentPostingNumber: 'parent' });
    const parent = attachSplitRelationFields({ id: 'parent' }, { splitRole: 'parent', splitReadbackStatus: 'merged' });
    const incomplete = attachSplitRelationFields({ id: 'pending-parent' }, { splitRole: 'parent', splitReadbackStatus: 'partial' });
    const mismatch = attachSplitRelationFields({ id: 'mismatch-parent' }, { splitRole: 'parent', splitReadbackStatus: 'mismatch' });
    const ordinary = { id: 'ordinary' };
    expect([parent, incomplete, mismatch, child, ordinary].filter(order => shouldIncludeOrderInBusinessFlow(order)))
      .toEqual([child, ordinary]);
    expect(shouldIncludeOrderInBusinessFlow(parent, { keyword: 'parent' })).toBe(false);
    expect(shouldIncludeOrderInBusinessFlow(parent, { keyword: 'parent', allowSearchReveal: true })).toBe(true);
  });

  it('applies split parent display rule to after-sales rows', () => {
    const pageSource = afterSalesPageSource;

    expect(pageSource).toContain('const matchAfterSalesDisplay = pendingOnly');
    expect(pageSource).toContain('shouldShowAfterSalesOrderInList(order, { keyword: keywordText })');
    expect(pageSource).toContain(
      'return matchAfterSalesDisplay && matchFulfillment && matchKeyword && matchStart && matchEnd;'
    );
    expect(pageSource).toContain('order.splitParentPostingNumber');
    expect(pageSource).toContain('order.splitRelation?.parentPostingNumber');
  });

  it('preserves split relation fields through order normalizers', () => {
    expect(appSource.match(/return\s+attachSplitRelationFields\(\s*\{/g)).toHaveLength(3);
    expect(appSource.match(/return\s+attachSplitRelationFields\(\s*\{[\s\S]*?\},\s*item\s*\);/g)).toHaveLength(2);
    expect(appSource.match(/return\s+attachSplitRelationFields\(\s*\{[\s\S]*?\},\s*order\s*\);/g)).toHaveLength(1);
  });
});
