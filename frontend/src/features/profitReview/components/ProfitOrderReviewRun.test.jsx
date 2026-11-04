import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runProfitOrderReview: vi.fn(),
}));

vi.mock('../services/profitOrderReviewService.js', () => ({
  runProfitOrderReview: mocks.runProfitOrderReview,
}));

vi.mock('./ProfitOrderReviewReport.jsx', () => ({
  ProfitOrderReviewReport: () => <div>复核报告已生成</div>,
}));

import { ProfitOrderReviewRun } from './ProfitOrderReviewRun.jsx';

describe('ProfitOrderReviewRun', () => {
  beforeEach(() => {
    mocks.runProfitOrderReview.mockReset();
    mocks.runProfitOrderReview.mockResolvedValue({ status: 'ready' });
  });

  it('shows the Seerfar choice as two buttons and passes the disabled choice to the service', async () => {
    render(
      <ProfitOrderReviewRun
        selectedPrompt={{ id: 'profit-risk-review', promptConfig: {} }}
        shops={[{ id: 'shop-a' }]}
      />
    );

    const useButton = screen.getByRole('button', { name: '使用' });
    const skipButton = screen.getByRole('button', { name: '不使用' });
    expect(useButton).toHaveAttribute('aria-pressed', 'true');
    expect(skipButton).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(skipButton);
    expect(useButton).toHaveAttribute('aria-pressed', 'false');
    expect(skipButton).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('仅分析订单数据')).toBeVisible();

    fireEvent.change(screen.getByLabelText('Ozon 订单号'), { target: { value: 'ORDER-1' } });
    fireEvent.click(screen.getByRole('button', { name: '开始核算并分析' }));

    await waitFor(() => expect(mocks.runProfitOrderReview).toHaveBeenCalledOnce());
    expect(mocks.runProfitOrderReview).toHaveBeenCalledWith(
      expect.objectContaining({ orderNumber: 'ORDER-1', useSeerfar: false }),
      expect.any(Object),
    );
  });
});
