import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./PurchaseSkuBindingPanel.jsx', () => ({
  PurchaseSkuBindingPanel: ({ initialOzonUrl, initialSourceUrl, scope, onSaved }) => (
    <div>
      <span data-testid="binding-ozon-url">{initialOzonUrl}</span>
      <span data-testid="binding-source-url">{initialSourceUrl}</span>
      <span data-testid="binding-scope">{JSON.stringify(scope)}</span>
      <button type="button" onClick={() => onSaved({
        binding: { shopId: scope.shopId, pairs: [{ ozonSkuId: scope.sku }] },
      })}>保存订单货源绑定</button>
    </div>
  ),
}));

import { AutomaticOrderBatchPage, automaticOrderBindingTarget } from './AutomaticOrderBatchPage.jsx';
import { automaticOrderSections } from '../services/automaticOrderWorkflowService.js';

function workflowFixture() {
  return {
    rows: [{
      id: 'shop-a:ORDER-1',
      posting: 'ORDER-1',
      shopId: 'shop-a',
      shopName: '测试店',
      paymentTime: '2026-08-27 12:00:00',
      rawStatus: 'awaiting_packaging',
      allBound: false,
      autoOrderSupported: false,
      purchaseManagementCanPurchase: true,
      workflow: { [automaticOrderSections.autoOrder]: 'blocked' },
      products: [{
        name: '测试商品',
        sku: '4258320268',
        productId: '4507629805',
        offerId: 'mz-1',
        exactBinding: null,
        savedSourceLink: { link: 'https://detail.1688.com/offer/900001.html' },
      }],
      purchase: { amount: null, orderNumber: '' },
    }],
    selectionBySection: { [automaticOrderSections.autoOrder]: new Set() },
    taskStates: {},
    loading: false,
    refresh: vi.fn().mockResolvedValue({}),
    toggleSelection: vi.fn(),
    selectAllReady: vi.fn(),
    executeSelected: vi.fn(),
    resumeRow: vi.fn(),
  };
}

describe('automatic-order inline source binding', () => {
  it('builds an exact binding target from the first unbound order product', () => {
    const target = automaticOrderBindingTarget(workflowFixture().rows[0]);
    expect(target).toMatchObject({
      posting: 'ORDER-1',
      ozonUrl: 'https://www.ozon.ru/product/4258320268/',
      sourceUrl: 'https://detail.1688.com/offer/900001.html',
      scope: { shopId: 'shop-a', productId: '4507629805', offerId: 'mz-1', sku: '4258320268' },
    });
  });

  it('opens the clicked order binding dialog and refreshes the automatic-order list after save', async () => {
    const workflow = workflowFixture();
    const bindingSaved = vi.fn();
    globalThis.addEventListener('wangzai:auto-order-binding-saved', bindingSaved);
    render(<AutomaticOrderBatchPage section={automaticOrderSections.autoOrder} workflow={workflow} />);

    fireEvent.click(screen.getByRole('button', { name: '绑定货源 ORDER-1' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByTestId('binding-ozon-url')).toHaveTextContent('https://www.ozon.ru/product/4258320268/');
    expect(screen.getByTestId('binding-source-url')).toHaveTextContent('https://detail.1688.com/offer/900001.html');
    expect(screen.getByTestId('binding-scope')).toHaveTextContent('"shopId":"shop-a"');

    fireEvent.click(screen.getByRole('button', { name: '保存订单货源绑定' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(workflow.refresh).toHaveBeenCalledTimes(1);
    expect(bindingSaved).toHaveBeenCalledTimes(1);
    globalThis.removeEventListener('wangzai:auto-order-binding-saved', bindingSaved);
  });

  it('renders the real Ozon awaiting_deliver state as waiting for shipment', () => {
    const workflow = workflowFixture();
    workflow.rows[0] = { ...workflow.rows[0], rawStatus: 'awaiting_deliver' };
    render(<AutomaticOrderBatchPage section={automaticOrderSections.autoOrder} workflow={workflow} />);

    expect(screen.getByText('等待发货')).toBeInTheDocument();
    expect(screen.queryByText('状态待确认')).not.toBeInTheDocument();
  });
});
