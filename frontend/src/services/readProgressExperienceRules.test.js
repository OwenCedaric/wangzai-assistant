import { describe, expect, it } from 'vitest';
import { readProjectSource } from '../test/appSource';

const HIGH_FREQUENCY_READ_PAGES = [
  {
    name: '商品列表',
    path: 'src/features/products/view/ProductListPageView.jsx',
    ariaLabel: '商品读取进度',
  },
  {
    name: '销售订单',
    path: 'src/features/orders/sales/view/SalesOrdersPageView.jsx',
    ariaLabel: '销售订单读取进度',
  },
  {
    name: '售后订单',
    path: 'src/features/orders/afterSales/AfterSalesOrdersPage.jsx',
    ariaLabel: '售后订单读取进度',
  },
  {
    name: '拍单管理',
    path: 'src/features/orders/purchase/view/PurchaseOrdersPageView.jsx',
    ariaLabel: '拍单订单读取进度',
  },
  {
    name: '利润核算',
    path: 'src/features/profit/ProfitPage.jsx',
    ariaLabel: '利润核算读取进度',
  },
];

describe('read progress experience rules', () => {
  it('keeps high-frequency Ozon reads in the shared top progress panel', () => {
    for (const page of HIGH_FREQUENCY_READ_PAGES) {
      const source = readProjectSource(page.path);

      expect(source, page.name).toContain('ReadProgressPanel');
      expect(source, page.name).toContain(`ariaLabel="${page.ariaLabel}"`);
      expect(source, page.name).toContain('className="hero-actions"');
      expect(source, page.name).not.toContain('<LinearProgress className="order-sync-progress"');
      expect(source, page.name).not.toContain("from '@mui/material/LinearProgress'");
    }
  });

  it('keeps the shared progress component compact and layout-stable', () => {
    const source = readProjectSource('src/shared/ui/ReadProgressPanel.jsx');

    expect(source).toContain('width = 280');
    expect(source).toContain('const READ_PROGRESS_PANEL_HEIGHT = 44');
    expect(source).toContain('height: READ_PROGRESS_PANEL_HEIGHT');
    expect(source).toContain("height: '100%'");
    expect(source).toContain("boxSizing: 'border-box'");
    expect(source).not.toContain('minHeight: 40');
    expect(source).toContain("visibility: visible ? 'visible' : 'hidden'");
    expect(source).toContain("const progressVariant = running && !hasKnownTotal ? 'indeterminate' : 'determinate'");
    expect(source).toContain('variant={progressVariant}');
    expect(source).toContain("value={progressVariant === 'determinate' ? progressPercent : undefined}");
    expect(source).toContain('title={[statusText, progressText, errorText].filter(Boolean).join');
    expect(source).not.toContain('position: fixed');
    expect(source).not.toContain('Snackbar');
  });
});
