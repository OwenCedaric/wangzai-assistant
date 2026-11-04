import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function readSource(relativePath) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

describe('desktop renderer crash regressions', () => {
  it('keeps purchase-browser quick actions on the five completed login platforms', () => {
    const source = readSource('src/app/shell/PurchaseBrowserQuickActions.jsx');

    expect(source).toContain('QUICK_PURCHASE_ACCOUNT_PRESETS');
    expect(source).toContain('PURCHASE_ACCOUNT_PRESETS.filter');
    expect(source).toContain('savePurchaseAccount({');
    expect(source).not.toContain('disabled={busy || !account}');
  });

  it('never sends Error objects directly into sales-order JSX', () => {
    const pageSource = readSource('src/features/orders/sales/view/SalesOrdersPageView.jsx');
    const dialogSource = readSource('src/features/orders/sales/view/SalesOrderOperationDialog.jsx');

    expect(pageSource).toContain("String(salesNotice.message?.message || salesNotice.message || '')");
    expect(dialogSource).toContain('String(salesOperation.error?.message || salesOperation.error)');
  });
});
