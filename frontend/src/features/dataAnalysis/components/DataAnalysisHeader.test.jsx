import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DataAnalysisHeader } from './DataAnalysisHeader.jsx';

describe('DataAnalysisHeader', () => {
  it('keeps the top-right actions in the requested order and opens analysis from the header', () => {
    const onOpenInfo = vi.fn();
    const onOpenAnalysis = vi.fn();
    const onRebuild = vi.fn();
    render(
      <DataAnalysisHeader
        updatedAt="2026-07-21T00:00:00.000Z"
        loading={false}
        currencyStatus="success"
        currencyMeta={{}}
        onOpenInfo={onOpenInfo}
        onOpenAnalysis={onOpenAnalysis}
        onRebuild={onRebuild}
      />
    );

    expect(screen.getAllByRole('button').map((button) => button.textContent.trim())).toEqual([
      '数据说明',
      '数据分析',
      '重新计算',
    ]);

    fireEvent.click(screen.getByRole('button', { name: '数据分析' }));
    expect(onOpenAnalysis).toHaveBeenCalledTimes(1);
  });
});
