import { describe, expect, it, vi } from 'vitest';
import { createWorkspacePerformanceRuntime } from './workspacePerformanceRuntime.js';

describe('workspacePerformanceRuntime', () => {
  it('measures only explicitly started navigation and separates cold opens from warm switches', () => {
    let time = 100;
    const runtime = createWorkspacePerformanceRuntime({ now: () => time, navigationLimit: 3 });
    expect(runtime.markPageReady('products')).toBeNull();

    runtime.beginNavigation('products');
    time += 120;
    expect(runtime.markPageReady('products')).toMatchObject({
      pageId: 'products',
      durationMs: 120,
      isColdStart: true,
    });
    runtime.beginNavigation('products');
    time += 80;
    expect(runtime.markPageReady('products')).toMatchObject({
      pageId: 'products',
      durationMs: 80,
      isColdStart: false,
    });
    runtime.beginNavigation('orders');
    time += 260;
    runtime.markPageReady('orders');
    runtime.beginNavigation('profit');
    time += 80;
    runtime.markPageReady('profit');

    const snapshot = runtime.snapshot();
    expect(snapshot.navigation.count).toBe(3);
    expect(snapshot.navigation.p95Ms).toBe(260);
    expect(snapshot.navigation).toMatchObject({
      coldCount: 2,
      coldP95Ms: 260,
      warmCount: 1,
      warmP95Ms: 80,
    });
    expect(snapshot.navigation.last).toMatchObject({ pageId: 'profit', durationMs: 80 });
  });

  it('collects long tasks through the browser observer without requiring it in unsupported runtimes', () => {
    let callback;
    const disconnect = vi.fn();
    class FakePerformanceObserver {
      constructor(next) { callback = next; }
      observe = vi.fn();
      disconnect = disconnect;
    }
    const runtime = createWorkspacePerformanceRuntime({ performanceObserverFactory: () => FakePerformanceObserver });
    const stop = runtime.startLongTaskObserver();
    callback({ getEntries: () => [{ name: 'longtask', duration: 120, startTime: 4 }, { duration: 40, startTime: 9 }] });

    expect(runtime.snapshot().longTasks).toMatchObject({ count: 2, over50ms: 1, over100ms: 1, maxMs: 120 });
    stop();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
