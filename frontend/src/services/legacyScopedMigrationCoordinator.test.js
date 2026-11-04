import { describe, expect, it } from 'vitest';
import { createLegacyScopedMigrationCoordinator } from './legacyScopedMigrationCoordinator.js';

function deferred() {
  let resolve;
  const promise = new Promise((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe('legacy scoped migration coordinator', () => {
  it('queues a richer identity scope after an in-flight incomplete scope', async () => {
    const coordinator = createLegacyScopedMigrationCoordinator();
    const gate = deferred();
    const calls = [];
    const first = coordinator.run([], async () => {
      calls.push('incomplete');
      await gate.promise;
      return 'incomplete';
    });
    const richer = coordinator.run([{ id: 'shop-1', clientId: 'client-1' }], async () => {
      calls.push('canonical');
      return 'canonical';
    });

    gate.resolve();
    await expect(first).resolves.toBe('incomplete');
    await expect(richer).resolves.toBe('canonical');
    expect(calls).toEqual(['incomplete', 'canonical']);
  });

  it('shares the active run for an equal or poorer identity scope', async () => {
    const coordinator = createLegacyScopedMigrationCoordinator();
    const gate = deferred();
    const active = coordinator.run([{ id: 'shop-1', clientId: 'client-1' }], async () => {
      await gate.promise;
      return 'canonical';
    });
    const sameScope = coordinator.run([{ clientId: 'client-1', id: 'shop-1' }], async () => 'unexpected');
    const poorerScope = coordinator.run([], async () => 'unexpected');

    expect(sameScope).toBe(active);
    expect(poorerScope).toBe(active);
    gate.resolve();
    await expect(active).resolves.toBe('canonical');
  });
});
