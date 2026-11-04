import { describe, expect, it, vi } from 'vitest';
import { createProductWorkspaceActivityRuntime } from './productWorkspaceActivityRuntime.js';

describe('product workspace activity runtime', () => {
  it('notifies one component-owned activity signal without retaining an unsubscribed listener', () => {
    const runtime = createProductWorkspaceActivityRuntime(false);
    const listener = vi.fn();
    const unsubscribe = runtime.subscribe(listener);

    runtime.setActive(true);
    runtime.setActive(true);
    unsubscribe();
    runtime.setActive(false);

    expect(listener.mock.calls).toEqual([[false], [true]]);
    expect(runtime.getSnapshot()).toBe(false);
  });

  it('rejects non-function subscribers', () => {
    const runtime = createProductWorkspaceActivityRuntime();
    expect(() => runtime.subscribe(null)).toThrow('PRODUCT_WORKSPACE_ACTIVITY_LISTENER_REQUIRED');
  });
});
