import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DashboardBusinessShareCard } from './DashboardBusinessShareCard.jsx';

vi.mock('../../../shared/ui/CommunityChart.jsx', async () => {
  const ReactModule = await import('react');
  return {
    default: function MockCommunityChart() {
      return ReactModule.default.createElement('div', { 'data-testid': 'dashboard-business-share-apex' });
    },
  };
});

describe('DashboardBusinessShareCard', () => {
  it('renders true zero without a synthetic chart slice, then renders the four real data values', async () => {
    const { rerender } = render(
      <DashboardBusinessShareCard
        businessShareState={{ status: 'empty', counts: {}, scopeKey: 'shop-a', error: null }}
      />
    );

    const card = screen.getByTestId('dashboard-business-share');
    expect(card).toHaveAttribute('data-dashboard-business-status', 'empty');
    expect(card).toHaveAttribute('data-dashboard-business-series', '0,0,0,0');
    expect(card).toHaveAttribute('data-dashboard-business-chart-series', '');
    expect(card).toHaveAttribute('data-dashboard-business-visual-state', 'empty');
    expect(card).toHaveAttribute('data-dashboard-business-total', '0');
    expect(screen.getByTestId('dashboard-business-share-center-total')).toHaveTextContent('0');
    expect(screen.queryByTestId('dashboard-business-share-apex')).not.toBeInTheDocument();
    expect(screen.getByTestId('dashboard-business-share-pendingPurchaseCount')).toHaveTextContent('0');

    rerender(
      <DashboardBusinessShareCard
        businessShareState={{
          status: 'data',
          scopeKey: 'shop-a',
          error: null,
          counts: {
            pendingPurchaseCount: 2,
            waitingDeliveryCount: 5,
            afterSalesTodoCount: 1,
            stockWarningCount: 1,
          },
        }}
      />
    );
    expect(card).toHaveAttribute('data-dashboard-business-status', 'data');
    expect(card).toHaveAttribute('data-dashboard-business-series', '2,5,1,1');
    expect(card).toHaveAttribute('data-dashboard-business-chart-series', '2,5,1,1');
    expect(card).toHaveAttribute('data-dashboard-business-visual-state', 'chart');
    expect(card).toHaveAttribute('data-dashboard-business-total', '9');
    expect(screen.getByTestId('dashboard-business-share-pendingPurchaseCount')).toHaveTextContent('2');
    await waitFor(() => expect(screen.getByTestId('dashboard-business-share-apex')).toBeInTheDocument());
  });

  it('shows loading and read failures as unavailable rather than successful zeroes', () => {
    const { rerender } = render(
      <DashboardBusinessShareCard businessShareState={{ status: 'loading', counts: null, scopeKey: 'shop-a' }} />
    );
    expect(screen.getByTestId('dashboard-business-share-status')).toHaveTextContent('正在读取');
    expect(screen.getByTestId('dashboard-business-share-pendingPurchaseCount')).toHaveTextContent('—');

    rerender(
      <DashboardBusinessShareCard businessShareState={{ status: 'error', counts: null, scopeKey: 'shop-a' }} />
    );
    expect(screen.getByTestId('dashboard-business-share-status')).toHaveTextContent('读取失败');
    expect(screen.getByTestId('dashboard-business-share-stockWarningCount')).toHaveTextContent('—');
  });
});
