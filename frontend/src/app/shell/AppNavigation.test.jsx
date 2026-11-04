import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  appendWorkspaceTabUnique,
  createWorkspaceTab,
  deduplicateWorkspaceTabs,
  isTabOutsideHorizontalViewport,
  navGroups,
  Sidebar,
} from './AppNavigation';
import navigationSource from './AppNavigation.jsx?raw';

const globalStyles = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');

describe('workspace tab viewport guard', () => {
  it('atomically rejects rapid duplicate workspace tabs', () => {
    const dashboard = createWorkspaceTab('dashboard');
    const salesOrders = createWorkspaceTab('sales-orders');
    let tabs = [dashboard];

    for (let index = 0; index < 50; index += 1) {
      tabs = appendWorkspaceTabUnique(tabs, salesOrders);
    }

    expect(tabs.map((tab) => tab.id)).toEqual(['dashboard', 'sales-orders']);
  });

  it('deduplicates a corrupted tab snapshot before any page tree is rendered', () => {
    const dashboard = createWorkspaceTab('dashboard');
    const salesOrders = createWorkspaceTab('sales-orders');
    const repaired = deduplicateWorkspaceTabs([
      dashboard,
      salesOrders,
      { ...salesOrders },
      { ...salesOrders },
      null,
    ]);

    expect(repaired).toEqual([dashboard, salesOrders]);
  });

  it('keeps the packaged browser internal instead of exposing a standalone workspace', () => {
    const pageIds = navGroups.flatMap((group) =>
      group.items.flatMap((item) => [item.id, ...(item.children || []).map((child) => child.id)])
    );
    expect(pageIds).toContain('purchase-orders');
    expect(pageIds).toContain('pending-orders');
    expect(pageIds).toContain('print-shipping');
    expect(pageIds).toContain('purchase-rehearsal');
    expect(pageIds).toContain('data-backup');
    expect(pageIds).toContain('points-packages');
    expect(pageIds).toContain('follow-seller-defense');
    expect(pageIds).toContain('shipping');
    expect(pageIds).toContain('profit-report');
    expect(createWorkspaceTab('points-packages')).toMatchObject({
      id: 'points-packages',
      label: '积分套餐',
      fixed: false,
    });
    expect(createWorkspaceTab('data-backup')).toMatchObject({
      id: 'data-backup',
      label: '数据备份',
      fixed: false,
    });
    expect(createWorkspaceTab('pending-orders')).toMatchObject({
      id: 'pending-orders',
      label: '待处理单',
      fixed: false,
    });
    expect(createWorkspaceTab('print-shipping')).toMatchObject({
      id: 'print-shipping',
      label: '打单发货',
      fixed: false,
    });
    expect(createWorkspaceTab('purchase-rehearsal')).toMatchObject({
      id: 'purchase-rehearsal',
      label: '自动拍单',
      fixed: false,
    });
    expect(createWorkspaceTab('customer-consultation')).toMatchObject({
      id: 'customer-consultation',
      label: '在线客服',
      fixed: false,
    });
    expect(createWorkspaceTab('smart-reply')).toMatchObject({
      id: 'smart-reply',
      label: '智能回复',
      fixed: false,
    });
    expect(pageIds).not.toContain('purchase-browser');
    expect(createWorkspaceTab('purchase-browser')).toBeNull();
    expect(navigationSource).not.toContain('内置拍单浏览器');
  });

  it('does not request a smooth scroll while the active tab is already visible', () => {
    expect(isTabOutsideHorizontalViewport({ left: 120, right: 300 }, { left: 80, right: 640 })).toBe(false);
  });

  it('requests scroll only for a tab outside the horizontal viewport', () => {
    expect(isTabOutsideHorizontalViewport({ left: 60, right: 180 }, { left: 80, right: 640 })).toBe(true);
    expect(isTabOutsideHorizontalViewport({ left: 610, right: 700 }, { left: 80, right: 640 })).toBe(true);
  });

  it('uses an intersection observation instead of forcing workspace layout from the active-tab frame', () => {
    expect(navigationSource).toContain('new window.IntersectionObserver(');
    expect(navigationSource).toContain('entry.intersectionRatio >= 0.99');
    expect(navigationSource).toContain('{ root: tabList, threshold: 0.99 }');
  });

  it('only scrolls the horizontal workspace tab strip and never the active business page', () => {
    expect(navigationSource).not.toContain('scrollIntoView');
    expect(navigationSource).toContain('tabList.scrollTo({ left: nextScrollLeft, behavior: \'smooth\' })');
  });

  it('keeps parent navigation compact and exposes an accessible animated submenu', async () => {
    const onNavigate = vi.fn();
    const { rerender } = render(
      <Sidebar currentPage="dashboard" open onClose={vi.fn()} onNavigate={onNavigate} />
    );
    const ordersButton = screen.getByRole('button', { name: '订单管理' });
    expect(ordersButton).toHaveAttribute('aria-expanded', 'true');
    expect(ordersButton).toHaveAttribute('aria-controls', 'sidebar-subnav-orders');
    fireEvent.click(screen.getByRole('button', { name: '销售订单' }));
    expect(onNavigate).toHaveBeenCalledWith('sales-orders');
    fireEvent.click(screen.getByRole('button', { name: '待处理单' }));
    expect(onNavigate).toHaveBeenCalledWith('pending-orders');
    fireEvent.click(screen.getByRole('button', { name: '打单发货' }));
    expect(onNavigate).toHaveBeenCalledWith('print-shipping');
    fireEvent.click(screen.getByRole('button', { name: '自动拍单' }));
    expect(onNavigate).toHaveBeenCalledWith('purchase-rehearsal');

    fireEvent.click(ordersButton);
    expect(ordersButton).toHaveAttribute('aria-expanded', 'false');

    const customerServiceButton = screen.getByRole('button', { name: '客服咨询' });
    expect(customerServiceButton).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(customerServiceButton);
    expect(customerServiceButton).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByRole('button', { name: '在线客服' }));
    expect(onNavigate).toHaveBeenCalledWith('customer-consultation');
    fireEvent.click(screen.getByRole('button', { name: '智能回复' }));
    expect(onNavigate).toHaveBeenCalledWith('smart-reply');

    rerender(
      <Sidebar currentPage="sales-orders" open onClose={vi.fn()} onNavigate={onNavigate} />
    );
    await waitFor(() => expect(ordersButton).toHaveAttribute('aria-expanded', 'true'));
  });

  it('keeps an icon rail available while the workspace owns the expand control', () => {
    render(
      <Sidebar
        currentPage="dashboard"
        open={false}
        onClose={vi.fn()}
        onNavigate={vi.fn()}
      />
    );

    expect(screen.queryByRole('button', { name: '展开导航栏' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '订单管理' })).not.toHaveAttribute('aria-expanded');
  });

  it('reserves a stable thin scrollbar and keeps the expand arrow next to its label', () => {
    expect(globalStyles).toContain('scrollbar-gutter: stable');
    expect(globalStyles).toContain('.nav-parent .MuiListItemText-root');
    expect(globalStyles).toContain('flex: 1 1 auto');
    expect(globalStyles).toContain('.nav-expand-icon.is-expanded');
  });

  it('uses the original blue active navigation treatment', () => {
    expect(globalStyles).toMatch(
      /\.nav-item\s*\{[^}]*min-height:\s*48px !important;[^}]*margin-bottom:\s*4px !important;[^}]*border-radius:\s*8px !important;/su
    );
    expect(globalStyles).toMatch(
      /\.nav-item \.MuiListItemIcon-root\s*\{[^}]*min-width:\s*42px;/su
    );
    expect(globalStyles).toMatch(
      /\.nav-item\.Mui-selected\s*\{[^}]*background:\s*#5d87ff !important;[^}]*color:\s*#fff !important;[^}]*box-shadow:\s*0 8px 18px rgba\(93, 135, 255, 0\.24\) !important;/su
    );
  });

  it('keeps all navigation entries in one unclassified list', () => {
    expect(navGroups).toHaveLength(1);
    expect(navGroups[0].title).toBe('');
    expect(navGroups[0].items.map((item) => item.label)).toEqual([
      '旺崽汇总',
      '商品列表',
      '订单管理',
      '利润核算',
      '营销活动',
      '付费推广',
      '数据分析',
      '智能工具',
      '采集核价',
      '积分套餐',
      '剔除跟卖',
      '客服咨询',
      '仓储物流',
      '数据备份',
    ]);
  });

  it('keeps automatic ordering as the final order-management secondary entry', () => {
    const orders = navGroups[0].items.find((item) => item.id === 'orders');
    expect(orders.children.at(-1)).toEqual({ id: 'purchase-rehearsal', label: '自动拍单' });
    expect(navGroups[0].items.some((item) => item.id === 'purchase-rehearsal')).toBe(false);
  });

  it('exposes order profit and profit report as the two profit-accounting secondary entries', () => {
    const profit = navGroups[0].items.find((item) => item.id === 'profit-accounting');
    expect(profit.children).toEqual([
      { id: 'shipping', label: '订单利润' },
      { id: 'profit-report', label: '利润报表' },
    ]);
    expect(createWorkspaceTab('shipping')).toMatchObject({ label: '订单利润' });
    expect(createWorkspaceTab('profit-report')).toMatchObject({ label: '利润报表' });
  });

  it('centers the original blue secondary navigation cards', () => {
    expect(globalStyles).toMatch(
      /\.subnav-list\s*\{[^}]*gap:\s*6px;[^}]*margin:\s*4px 0 12px;[^}]*padding:\s*6px 0;/su
    );
    expect(globalStyles).toMatch(
      /\.subnav-item\s*\{[^}]*width:\s*166px;[^}]*min-height:\s*38px;[^}]*align-items:\s*center;[^}]*justify-content:\s*center;[^}]*justify-self:\s*center;[^}]*padding:\s*0 14px;[^}]*text-align:\s*center;/su
    );
    expect(globalStyles).toMatch(/\.subnav-item\.active\s*\{[^}]*background:\s*#ecf2ff;[^}]*color:\s*#5d87ff;/su);
  });
});
