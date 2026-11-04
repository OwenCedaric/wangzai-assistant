import sourceLinkStateSource from './model/usePurchaseSourceLinkState.jsx?raw';
import pageViewSource from './view/PurchaseOrdersPageView.jsx?raw';
import { describe, expect, it } from 'vitest';

describe('purchase order shop selection scroll behavior', () => {
  it('resets the shop-filtered list without a special scroll branch', () => {
    expect(pageViewSource).toMatch(
      /setShop\(event\.target\.value\);\s*resetPurchaseOrderListState\(\);/u
    );
  });

  it('never makes list reset or pagination move the outer page', () => {
    expect(sourceLinkStateSource).not.toContain('scrollIntoView');
    expect(sourceLinkStateSource).not.toContain('scrollPurchaseOrdersToTop');
    expect(pageViewSource).not.toContain('scrollPurchaseOrdersToTop');
  });
});
