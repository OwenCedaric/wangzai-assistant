import { describe, expect, it, vi } from 'vitest';
import { createOzonMarketCollectorCoordinator } from './marketCollectorCoordinator.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

describe('Ozon market collector coordinator', () => {
  it('preempts background work and starts an interactive search immediately', async () => {
    const coordinator = createOzonMarketCollectorCoordinator();
    const backgroundCommand = deferred();
    const command = vi.fn((input) => {
      if (input.command === 'background-page') return backgroundCommand.promise;
      return Promise.resolve({ ok: true, input });
    });
    let backgroundSignal;
    const background = coordinator.run({
      name: 'hot-cache',
      priority: 'background',
      command,
      task: async ({ command: runCommand, signal }) => {
        backgroundSignal = signal;
        await runCommand({ command: 'background-page' });
        return 'background-complete';
      },
    });
    await vi.waitFor(() => expect(command).toHaveBeenCalledTimes(1));

    const interactive = coordinator.run({
      name: 'product-search',
      priority: 'interactive',
      command,
      task: ({ command: runCommand }) => runCommand({ command: 'search-page' }),
    });

    await expect(interactive).resolves.toMatchObject({
      ok: true,
      input: { command: 'search-page', collectorPriority: 'interactive' },
    });
    expect(backgroundSignal.aborted).toBe(true);
    backgroundCommand.resolve({ ok: true });
    await expect(background).rejects.toMatchObject({
      code: 'OZON_MARKET_COLLECTOR_TASK_CANCELLED',
    });
  });

  it('serializes tasks of the same priority', async () => {
    const coordinator = createOzonMarketCollectorCoordinator();
    const firstGate = deferred();
    const order = [];
    const command = vi.fn(async (input) => ({ ok: true, input }));
    const first = coordinator.run({
      name: 'first',
      priority: 'interactive',
      command,
      task: async () => {
        order.push('first-start');
        await firstGate.promise;
        order.push('first-end');
      },
    });
    const second = coordinator.run({
      name: 'second',
      priority: 'interactive',
      command,
      task: async () => { order.push('second'); },
    });
    await vi.waitFor(() => expect(order).toEqual(['first-start']));
    firstGate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'first-end', 'second']);
  });
});
