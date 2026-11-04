import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath) {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8');
}

describe('purchase information direct workbench rules', () => {
  it('opens only a real purchase order and never falls back to the retained source link', () => {
    const salesView = source('src/features/orders/sales/view/SalesOrdersPageView.jsx');
    const salesModel = source('src/features/orders/sales/model/useSalesOrdersPageModel.jsx');
    const purchaseModel = source('src/features/orders/purchase/model/usePurchaseOrdersPageModel.jsx');
    const purchaseDialogs = source('src/features/orders/purchase/view/PurchaseOrdersDialogs.jsx');

    expect(salesView).toContain('onClick={openSalesPurchaseInfoWorkbench}');
    expect(salesModel).toContain('resolvePurchaseInfoOpenAction(detailOrder, detailPurchaseOverride)');
    expect(salesModel).toContain("showSalesWorkbenchNotice(action.message, 'info')");
    expect(salesModel).toContain('openSalesPurchaseLink(action.url, detailOrder');
    expect(salesModel).not.toContain('detailPurchaseInfoSupport.orderUrl\n      || detailPurchaseInfoSupport.sourceLink');
    expect(purchaseModel).toContain('resolvePurchaseInfoOpenAction(selectedOrder)');
    expect(purchaseModel).toContain("showPurchaseNotice(action.message, 'info')");
    expect(purchaseModel).toContain('openPurchaseOrderWorkbench(action.url)');
    expect(purchaseModel).not.toContain('support.orderUrl || support.sourceLink || selectedSourceLink');
    expect(salesView).not.toContain('PurchaseInfoDialog');
    expect(purchaseDialogs).not.toContain('PurchaseInfoDialog');
    expect(existsSync(resolve(process.cwd(), 'src/shared/ui/PurchaseInfoDialog.jsx'))).toBe(false);
  });
});
