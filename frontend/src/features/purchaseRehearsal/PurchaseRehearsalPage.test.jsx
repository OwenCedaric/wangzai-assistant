import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PurchaseRehearsalPage } from './PurchaseRehearsalPage.jsx';

describe('PurchaseRehearsalPage real UI workflow with virtual orders', () => {
  beforeEach(() => {
    globalThis.__WANGZAI_AUTO_ORDER_E2E__ = { enabled: true };
  });

  afterEach(() => {
    delete globalThis.__WANGZAI_AUTO_ORDER_E2E__;
  });

  it('runs purchase, stock and forecast from the actual page and records errors without crashing', async () => {
    render(<PurchaseRehearsalPage shops={[]} isActive />);

    expect(await screen.findByText('虚拟订单测试模式')).toBeInTheDocument();
    expect(screen.queryByText('拍单预演')).not.toBeInTheDocument();
    expect(screen.getByText('VIRTUAL-ORDER-SUCCESS-1')).toBeInTheDocument();
    expect(screen.getAllByText('等待备货').length).toBeGreaterThan(0);
    expect(screen.queryByText('awaiting_packaging')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: '选择订单 VIRTUAL-ORDER-SUCCESS-1' }));
    fireEvent.click(screen.getByRole('button', { name: '一键拍单并付款' }));
    expect((await screen.findAllByText('虚拟采购订单已创建并完成付款回读。')).length).toBeGreaterThan(0);
    expect(screen.getByText('VPO-VIRTUAL-ORDER-SUCCESS-1')).toBeInTheDocument();

    const selector = screen.getByRole('group', { name: '自动拍单页面选择' });
    fireEvent.click(within(selector).getByRole('button', { name: '一键备货' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '选择订单 VIRTUAL-ORDER-SUCCESS-1' }));
    fireEvent.click(screen.getAllByRole('button', { name: '一键备货' }).at(-1));
    expect((await screen.findAllByText('虚拟 Ozon 备货已回读确认。')).length).toBeGreaterThan(0);

    fireEvent.click(within(selector).getByRole('button', { name: '一键预报' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '选择订单 VIRTUAL-ORDER-SUCCESS-1' }));
    fireEvent.click(screen.getAllByRole('button', { name: '一键预报' }).at(-1));
    expect((await screen.findAllByText('虚拟跨境巴士预报已创建并回查确认。')).length).toBeGreaterThan(0);

    fireEvent.click(within(selector).getByRole('button', { name: '真自动拍单' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '选择订单 VIRTUAL-ORDER-PRICE-ERROR' }));
    fireEvent.click(screen.getByRole('button', { name: '一键拍单并付款' }));
    expect((await screen.findAllByText('货源价格发生变化，已停止付款。')).length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getByText('处理失败')).toBeInTheDocument());
  });
});
