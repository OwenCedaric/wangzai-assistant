import pageModelSource from './model/usePurchaseOrdersPageModel.jsx?raw';
import pageViewSource from './view/PurchaseOrdersPageView.jsx?raw';
import supplierStateSource from './model/usePurchaseSupplierFullSyncState.jsx?raw';
import { describe, expect, it } from 'vitest';

describe('拍单管理全量采购信息同步规则', () => {
  it('拍单管理统一使用同步物流入口', () => {
    expect(pageViewSource).toContain("onClick={handleFullSupplierSync}");
    expect(pageViewSource).toContain("'同步物流'");
    expect(pageViewSource).not.toContain("'全量同步'");
    expect(pageViewSource).not.toContain('筛选拍单');
    expect(pageViewSource).toContain('visible={purchaseOrderSyncRunning}');
    expect(pageViewSource).not.toContain('visible={purchasePageBusy}');
  });

  it('页面模型从完整订单数据集执行同步并返回进度', () => {
    expect(pageModelSource).toContain('usePurchaseSupplierFullSyncState({');
    expect(pageModelSource).toMatch(/usePurchaseSupplierFullSyncState\(\{\s*purchaseOrders,/u);
    expect(pageModelSource).toContain('purchaseSupplierSync,');
    expect(pageModelSource).toContain('handleFullSupplierSync,');
    expect(supplierStateSource).toContain('syncUnifiedPurchaseLogistics(purchaseOrders');
  });
});
