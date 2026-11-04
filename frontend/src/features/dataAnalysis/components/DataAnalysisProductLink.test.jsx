import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DataAnalysisProductLink } from './DataAnalysisProductLink.jsx';

const { openOzonProductPage } = vi.hoisted(() => ({ openOzonProductPage: vi.fn() }));

vi.mock('../../../services/ozonProductPageLink.js', () => ({
  buildOzonProductPageUrl: vi.fn(() => 'https://www.ozon.ru/product/123456789/'),
  getOzonProductPageErrorMessage: vi.fn(() => '打开失败'),
  openOzonProductPage,
}));

describe('DataAnalysisProductLink', () => {
  it('opens the product through the shared internal-browser service', async () => {
    openOzonProductPage.mockResolvedValue({ ok: true });
    render(
      <DataAnalysisProductLink source={{ productId: '123456789', name: '测试商品' }}>
        <span>测试商品</span>
      </DataAnalysisProductLink>,
    );

    fireEvent.click(screen.getByRole('button', { name: '打开 Ozon 商品页面' }));

    await waitFor(() => expect(openOzonProductPage).toHaveBeenCalledWith({ productId: '123456789', name: '测试商品' }));
  });
});
