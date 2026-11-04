import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WangzaiMascot } from './WangzaiMascot.jsx';

describe('WangzaiMascot', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('runs a complete ambient action and returns to the living idle state', () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.99);

    const { container } = render(<WangzaiMascot state="idle" />);
    const mascot = container.querySelector('.wangzai-mascot');
    expect(mascot).toHaveAttribute('data-action', 'idle');

    act(() => vi.advanceTimersByTime(5_200));
    expect(mascot).toHaveClass('action-ball-play');

    act(() => vi.advanceTimersByTime(8_400));
    expect(mascot).toHaveClass('action-idle');
  });

  it('keeps password interaction above ambient animation and exposes the realtime skeletal rig', () => {
    const { container } = render(<WangzaiMascot state="typing" />);
    const mascot = container.querySelector('.wangzai-mascot');

    expect(mascot).toHaveClass('is-typing', 'action-typing');
    expect(mascot).toHaveAttribute('data-rig', 'webgl-skeletal-skinning');
    expect(mascot.querySelector('.wangzai-mascot-body')).toBeInTheDocument();
    expect(mascot.querySelector('.wangzai-skeletal-canvas')).toBeInTheDocument();
    expect(mascot.querySelector('.wangzai-blink-pose')).not.toBeInTheDocument();
    expect(mascot.querySelector('.wangzai-rest-pose')).not.toBeInTheDocument();
    expect(mascot.querySelector('.wangzai-paw-tap-pose')).not.toBeInTheDocument();
    expect(mascot.querySelector('.wangzai-ball-track')).toBeInTheDocument();
    expect(mascot.querySelector('.wangzai-tennis-ball')).toBeInTheDocument();
  });
});
