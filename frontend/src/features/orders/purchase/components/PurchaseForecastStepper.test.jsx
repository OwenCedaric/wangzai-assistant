import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PurchaseForecastStepper } from './PurchaseForecastStepper.jsx';

function renderStepper(props = {}) {
  const handlers = {
    onPrepare: vi.fn(),
    onCheckLabel: vi.fn(),
    onSubmit: vi.fn(),
    onAutoRun: vi.fn(),
    onExecutionModeChange: vi.fn(),
  };
  const view = render(
    <PurchaseForecastStepper
      flow={{ stage: 'idle' }}
      executionMode="manual"
      confirmed
      canPrepare
      {...handlers}
      {...props}
    />
  );
  return { ...view, handlers };
}

describe('PurchaseForecastStepper', () => {
  it('binds every manual step button to its matching action', () => {
    const first = renderStepper();
    fireEvent.click(screen.getByRole('button', { name: '执行第一步' }));
    expect(first.handlers.onPrepare).toHaveBeenCalledTimes(1);
    first.unmount();

    const second = renderStepper({
      flow: { stage: 'ozon_prepared' },
      canPrepare: false,
      canCheckLabel: true,
    });
    fireEvent.click(screen.getByRole('button', { name: '获取并核对面单' }));
    expect(second.handlers.onCheckLabel).toHaveBeenCalledTimes(1);
    second.unmount();

    const third = renderStepper({
      flow: {
        stage: 'label_ready',
        sheetOrderSn: 'sheet-1',
        sheetUrl: 'https://example.test/sheet.pdf',
      },
      canPrepare: false,
      canSubmit: true,
    });
    fireEvent.click(screen.getByRole('button', { name: '预报订单' }));
    expect(third.handlers.onSubmit).toHaveBeenCalledTimes(1);
  });

  it('switches to automatic mode and binds the automatic start button', () => {
    const view = renderStepper({ executionMode: 'auto', canRunAuto: true });
    fireEvent.click(screen.getByRole('button', { name: '开始自动处理' }));
    expect(view.handlers.onAutoRun).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('switch', { name: '切换预报执行模式' }));
    expect(view.handlers.onExecutionModeChange).toHaveBeenCalledWith('manual');
  });
});
