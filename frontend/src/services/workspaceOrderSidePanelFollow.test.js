import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  calculateOrderSidePanelFollowOffset,
  createOrderSidePanelFrameScheduler,
} from '../app/shell/useOrderSidePanelFollow.js';

const stylesSource = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');

describe('workspace order side panel follow', () => {
  it('keeps viewport ancestors from becoming horizontal scroll containers that break sticky', () => {
    expect(stylesSource).toMatch(/\.app-root\s*\{[^}]*overflow-x:\s*clip;/s);
    expect(stylesSource).toMatch(/\.main-shell\s*\{[^}]*overflow-x:\s*clip;/s);
  });

  it('keeps the order card in its natural position before it reaches the top anchor', () => {
    expect(
      calculateOrderSidePanelFollowOffset({
        panelTop: 180,
        panelBottom: 680,
        layoutBottom: 1600,
        stickyTop: 72,
        scale: 0.72,
      })
    ).toBe(0);
  });

  it('converts the viewport distance back into the zoomed workspace coordinate', () => {
    expect(
      calculateOrderSidePanelFollowOffset({
        panelTop: 40,
        panelBottom: 540,
        layoutBottom: 1200,
        stickyTop: 70,
        scale: 0.72,
      })
    ).toBeCloseTo(41.6667, 3);
  });

  it('remains stable when the panel already has the calculated transform', () => {
    expect(
      calculateOrderSidePanelFollowOffset({
        panelTop: 70,
        panelBottom: 570,
        layoutBottom: 1200,
        stickyTop: 70,
        scale: 0.72,
        currentOffset: 41.6666667,
      })
    ).toBeCloseTo(41.6667, 3);
  });

  it('continues following the viewport instead of stopping when a tall detail panel reaches the layout bottom', () => {
    expect(
      calculateOrderSidePanelFollowOffset({
        panelTop: -400,
        panelBottom: 100,
        layoutBottom: 150,
        stickyTop: 70,
        scale: 0.72,
      })
    ).toBeCloseTo(652.7778, 3);
  });

  it('coalesces many scroll events into one update per animation frame', () => {
    const callbacks = new Map();
    let nextId = 1;
    const update = vi.fn();
    const scheduler = createOrderSidePanelFrameScheduler(update, {
      requestFrame(callback) {
        const id = nextId++;
        callbacks.set(id, callback);
        return id;
      },
      cancelFrame(id) {
        callbacks.delete(id);
      },
    });

    for (let index = 0; index < 100; index += 1) scheduler.schedule();
    expect(callbacks.size).toBe(1);
    callbacks.values().next().value();
    expect(update).toHaveBeenCalledTimes(1);

    scheduler.schedule();
    expect(callbacks.size).toBe(2);
    scheduler.cancel();
  });
});
