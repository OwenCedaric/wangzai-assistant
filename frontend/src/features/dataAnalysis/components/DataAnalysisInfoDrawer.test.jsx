import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DataAnalysisInfoDrawer } from './DataAnalysisInfoDrawer.jsx';

describe('DataAnalysisInfoDrawer', () => {
  it('keeps source and endpoint details in a secondary dialog', () => {
    const onClose = vi.fn();
    render(
      <DataAnalysisInfoDrawer
        open
        onClose={onClose}
        dataPolicy={{ localFirst: true, fakeDataAllowed: false }}
        sources={[
          {
            id: 'orders',
            label: 'Ozon订单',
            type: 'official-cache',
            status: 'ready',
            rowCount: 295,
            syncedAt: '2026-07-10T10:37:00.000Z',
            endpoints: ['/v3/posting/fbs/list'],
          },
        ]}
      />
    );

    const dialog = screen.getByRole('dialog', { name: '数据说明' });
    expect(within(dialog).getByText('指标口径与规则')).toBeInTheDocument();
    expect(within(dialog).getByText('数据来源')).toBeInTheDocument();
    expect(within(dialog).getByText('平台订单')).toBeInTheDocument();
    expect(within(dialog).queryByText('Ozon订单')).not.toBeInTheDocument();
    expect(within(dialog).getByText('295 条')).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: '关闭数据说明' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
