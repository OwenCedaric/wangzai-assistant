import { describe, expect, it, vi } from 'vitest';
import {
  cleanupAndVerifyAccountRemovalClientResources,
  countOzonShopLocalDataFileReferences,
  getAccountRemovalClientResourceAdapterIds,
  countOwnerRecordMapValues,
  prepareAccountRemovalBarrier,
  releaseAccountRemovalBarrier,
  removeOzonShopLocalDataFileSlice,
  removeOwnerRecordMapValues,
  validateOzonShopFileStore,
} from './accountRemovalRuntime.js';

describe('accountRemovalRuntime', () => {
  it.each(['RECOVERY_REMOTE_AUTH_REQUIRED', 'RECOVERY_REMOTE_LOGIN_REQUIRED', 'RECOVERY_REMOTE_ACCESS_DENIED',
    'RECOVERY_REMOTE_ENDPOINT_UNAVAILABLE', 'RECOVERY_REMOTE_UNAVAILABLE'])('preserves typed remote cleanup code %s', async code => {
    const previous = Object.getOwnPropertyDescriptor(window, 'wangzaiDesktop');
    Object.defineProperty(window, 'wangzaiDesktop', { configurable: true, value: {
      recoveryRequest: vi.fn().mockResolvedValue({ ok: false, data: { ok: false, error: { code, message: 'private backend detail' } } }),
    } });
    try {
      await expect(cleanupAndVerifyAccountRemovalClientResources(
        { ownerType: 'model_api_account', ownerId: 'typed-remote-owner' },
        ['backup:remote-recovery-owner-model-api-account'], { operationId: 'typed-remote-op' },
      )).rejects.toMatchObject({ code, resourceId: 'backup:remote-recovery-owner-model-api-account' });
    } finally { if (previous) Object.defineProperty(window, 'wangzaiDesktop', previous); else delete window.wangzaiDesktop; }
  });
  it('treats one pending browser observation as unfinished, not a failed or verified cleanup', async () => {
    const previous = Object.getOwnPropertyDescriptor(window, 'wangzaiDesktop');
    const command = vi.fn().mockResolvedValue({ ok: true, accepted: true, verified: false, inProgress: true,
      status: 202, operationId: 'pending-cleanup', phase: 'deleting' });
    Object.defineProperty(window, 'wangzaiDesktop', { configurable: true, value: { purchaseBrowser: { command } } });
    try {
      await expect(cleanupAndVerifyAccountRemovalClientResources(
        { ownerType: 'purchase_account', ownerId: 'synthetic-pending-owner' },
        ['browser:purchase-cookies'], { operationId: 'pending-cleanup' },
      )).rejects.toMatchObject({ code: 'PURCHASE_BROWSER_ACCOUNT_REMOVAL_IN_PROGRESS', operationId: 'pending-cleanup', phase: 'deleting' });
      expect(command).toHaveBeenCalledTimes(1);
    } finally {
      if (previous) Object.defineProperty(window, 'wangzaiDesktop', previous); else delete window.wangzaiDesktop;
    }
  });
  it('purges only explicit record-map shopId values and never guesses an owner from a legacy key', () => {
    const source = {
      'shop-a:product-1': { shopId: 'shop-a', value: 'A' },
      'shop-b:product-2': { shop_id: 'shop-b', value: 'B' },
      'shop-a:legacy-without-owner': { value: 'preserve-fail-closed' },
    };
    expect(countOwnerRecordMapValues(source, 'shop-a')).toBe(1);
    expect(removeOwnerRecordMapValues(source, 'shop-a')).toEqual({
      'shop-b:product-2': { shop_id: 'shop-b', value: 'B' },
      'shop-a:legacy-without-owner': { value: 'preserve-fail-closed' },
    });
    expect(() => removeOwnerRecordMapValues([], 'shop-a')).toThrow('ACCOUNT_REMOVAL_CLIENT_RESOURCE_INVALID');
  });
  it('removes only owner A from the local Ozon file and preserves owner B and global fields', async () => {
    let store = {
      version: 3,
      shops: [
        { id: 'shop-a', shopAlias: 'A' },
        { id: 'shop-b', shopAlias: 'B' },
      ],
      activeShopId: 'shop-a',
      defaultWarehouseIds: { 'shop-a': 'warehouse-a', 'shop-b': 'warehouse-b' },
      globalLayout: { density: 'compact' },
    };
    const readStore = vi.fn(async () => structuredClone(store));
    const writeStore = vi.fn(async (next) => { store = structuredClone(next); });

    await removeOzonShopLocalDataFileSlice('shop-a', { readStore, writeStore });

    expect(store).toEqual({
      version: 3,
      shops: [{ id: 'shop-b', shopAlias: 'B' }],
      activeShopId: 'shop-b',
      defaultWarehouseIds: { 'shop-b': 'warehouse-b' },
      globalLayout: { density: 'compact' },
    });
    await expect(countOzonShopLocalDataFileReferences('shop-a', { readStore })).resolves.toBe(0);
    await expect(countOzonShopLocalDataFileReferences('shop-b', { readStore })).resolves.toBe(3);
    expect(writeStore).toHaveBeenCalledTimes(1);
  });

  it('fails closed for malformed local file structures without writing a replacement', async () => {
    const writeStore = vi.fn();
    for (const malformed of [[], 'bad', { shops: {} }, { shops: [null] }, { defaultWarehouseIds: [] }]) {
      await expect(removeOzonShopLocalDataFileSlice('shop-a', {
        readStore: async () => malformed,
        writeStore,
      })).rejects.toThrow('ACCOUNT_REMOVAL_CLIENT_RESOURCE_INVALID');
    }
    expect(writeStore).not.toHaveBeenCalled();
    expect(() => validateOzonShopFileStore({ shops: [{ id: 'shop-a' }] })).not.toThrow();
  });

  it('fences desktop recovery before confirmation and releases only the exact preview fingerprint', async () => {
    const previousDescriptor = Object.getOwnPropertyDescriptor(window, 'wangzaiDesktop');
    const recoveryRequest = vi.fn(async (input) => ({
      ok: true,
      status: 200,
      data: { ok: true, fenced: input.command === 'begin-account-removal-barrier' },
    }));
    Object.defineProperty(window, 'wangzaiDesktop', {
      configurable: true,
      value: { recoveryRequest },
    });
    const previewFingerprint = 'f'.repeat(64);
    try {
      await expect(prepareAccountRemovalBarrier({
        owner: { ownerType: 'purchase_account', ownerId: 'purchase-a' },
        previewFingerprint,
      })).resolves.toMatchObject({ previewFingerprint });
      await expect(releaseAccountRemovalBarrier({ previewFingerprint })).resolves.toMatchObject({ ok: true });
      expect(recoveryRequest.mock.calls).toEqual([
        [{ command: 'begin-account-removal-barrier', previewFingerprint }],
        [{ command: 'end-account-removal-barrier', previewFingerprint }],
      ]);
    } finally {
      if (previousDescriptor) Object.defineProperty(window, 'wangzaiDesktop', previousDescriptor);
      else delete window.wangzaiDesktop;
    }
  });

  it('requires an exact adapter allowlist and an absent readback for every challenged resource', async () => {
    const owner = { ownerType: 'ozon_shop', ownerId: 'shop-a' };
    const state = { 'resource-a': new Set(['shop-a', 'shop-b']), 'resource-b': new Set(['shop-a', 'shop-b']) };
    const adapters = Object.fromEntries(Object.keys(state).map((resourceId) => [resourceId, {
      ownerType: 'ozon_shop',
      remove: ({ ownerId }) => state[resourceId].delete(ownerId),
      count: ({ ownerId }) => (state[resourceId].has(ownerId) ? 1 : 0),
    }]));

    await expect(cleanupAndVerifyAccountRemovalClientResources(
      owner,
      ['resource-b', 'resource-a'],
      { adapters },
    )).resolves.toEqual([
      { resourceId: 'resource-a', state: 'absent' },
      { resourceId: 'resource-b', state: 'absent' },
    ]);
    expect(state['resource-a'].has('shop-a')).toBe(false);
    expect(state['resource-a'].has('shop-b')).toBe(true);
    expect(state['resource-b'].has('shop-b')).toBe(true);

    await expect(cleanupAndVerifyAccountRemovalClientResources(
      owner,
      ['resource-a', 'resource-a'],
      { adapters },
    )).rejects.toThrow('ACCOUNT_REMOVAL_CLIENT_RESOURCE_DUPLICATE');
    await expect(cleanupAndVerifyAccountRemovalClientResources(
      owner,
      ['resource-unknown'],
      { adapters },
    )).rejects.toThrow('ACCOUNT_REMOVAL_CLIENT_RESOURCE_UNREGISTERED');
  });

  it('does not produce an absent proof when an adapter still reads the owner back', async () => {
    await expect(cleanupAndVerifyAccountRemovalClientResources(
      { ownerType: 'model_api_account', ownerId: 'model-a' },
      ['memory:model-test'],
      { adapters: {
        'memory:model-test': {
          ownerType: 'model_api_account',
          remove: () => undefined,
          count: () => 1,
        },
      } },
    )).rejects.toMatchObject({
      message: 'ACCOUNT_REMOVAL_CLIENT_VERIFY_FAILED',
      resourceId: 'memory:model-test',
      remaining: 1,
    });
  });

  it('purges remote recovery material through the authenticated desktop bridge using only the operation id', async () => {
    const previousDescriptor = Object.getOwnPropertyDescriptor(window, 'wangzaiDesktop');
    const recoveryRequest = vi.fn(async () => ({
      ok: true,
      status: 200,
      data: { ok: true, verified: true, rewrittenGenerationCount: 1 },
    }));
    Object.defineProperty(window, 'wangzaiDesktop', {
      configurable: true,
      value: { recoveryRequest },
    });
    try {
      await expect(cleanupAndVerifyAccountRemovalClientResources(
        { ownerType: 'purchase_account', ownerId: 'purchase-a' },
        ['backup:remote-recovery-owner-purchase-account'],
        { operationId: 'operation-bridge-1' },
      )).resolves.toEqual([
        { resourceId: 'backup:remote-recovery-owner-purchase-account', state: 'absent' },
      ]);
      expect(recoveryRequest).toHaveBeenCalledWith({
        command: 'purge-account-owner',
        operationId: 'operation-bridge-1',
      });
      expect(JSON.stringify(recoveryRequest.mock.calls)).not.toMatch(/token|remote|purchase-a/i);
    } finally {
      if (previousDescriptor) Object.defineProperty(window, 'wangzaiDesktop', previousDescriptor);
      else delete window.wangzaiDesktop;
    }
  });

  it('withholds the absent proof when remote purge lacks a verified bridge readback', async () => {
    const previousDescriptor = Object.getOwnPropertyDescriptor(window, 'wangzaiDesktop');
    Object.defineProperty(window, 'wangzaiDesktop', {
      configurable: true,
      value: { recoveryRequest: vi.fn(async () => ({ ok: true, data: { ok: true, verified: false } })) },
    });
    try {
      await expect(cleanupAndVerifyAccountRemovalClientResources(
        { ownerType: 'promotion_account', ownerId: 'promotion-a' },
        ['backup:remote-recovery-owner-promotion-account'],
        { operationId: 'operation-remote-failed' },
      )).rejects.toThrow('ACCOUNT_REMOVAL_REMOTE_RECOVERY_PURGE_FAILED');
    } finally {
      if (previousDescriptor) Object.defineProperty(window, 'wangzaiDesktop', previousDescriptor);
      else delete window.wangzaiDesktop;
    }
  });

  it('scrubs local recovery protection copies through the desktop bridge and requires verified readback', async () => {
    const previousDescriptor = Object.getOwnPropertyDescriptor(window, 'wangzaiDesktop');
    const recoveryRequest = vi.fn(async () => ({
      ok: true,
      status: 200,
      data: {
        ok: true,
        verified: true,
        familyCount: 3,
        diagnosticLogs: { verified: true, fileCount: 2, replacementCount: 1 },
      },
    }));
    Object.defineProperty(window, 'wangzaiDesktop', {
      configurable: true,
      value: { recoveryRequest },
    });
    try {
      await expect(cleanupAndVerifyAccountRemovalClientResources(
        { ownerType: 'cross_border_bus', ownerId: 'bus-a' },
        [
          'filesystem:diagnostic-logs-owner-cross-border-bus',
          'filesystem:recovery-protection-owner-cross-border-bus',
        ],
        { operationId: 'operation-protection-1' },
      )).resolves.toEqual([
        { resourceId: 'filesystem:diagnostic-logs-owner-cross-border-bus', state: 'absent' },
        { resourceId: 'filesystem:recovery-protection-owner-cross-border-bus', state: 'absent' },
      ]);
      expect(recoveryRequest).toHaveBeenCalledWith({
        command: 'purge-account-owner-protection',
        operationId: 'operation-protection-1',
      });
      expect(recoveryRequest).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(recoveryRequest.mock.calls)).not.toMatch(/token|accessToken|bus-a/i);
    } finally {
      if (previousDescriptor) Object.defineProperty(window, 'wangzaiDesktop', previousDescriptor);
      else delete window.wangzaiDesktop;
    }
  });

  it('keeps the production adapter registry explicit and complete', () => {
    expect(getAccountRemovalClientResourceAdapterIds()).toEqual([
      'backup:remote-recovery-owner-cross-border-bus',
      'backup:remote-recovery-owner-integration-profile',
      'backup:remote-recovery-owner-model-api-account',
      'backup:remote-recovery-owner-ozon-shop',
      'backup:remote-recovery-owner-promotion-account',
      'backup:remote-recovery-owner-purchase-account',
      'browser:integration-cache-storage',
      'browser:integration-cookies',
      'browser:integration-downloads',
      'browser:integration-extension-storage',
      'browser:integration-http-cache',
      'browser:integration-indexed-db',
      'browser:integration-local-storage',
      'browser:integration-persistent-partition',
      'browser:integration-plugin-installation-state',
      'browser:integration-profile-identity',
      'browser:integration-proxy-auth',
      'browser:integration-service-workers',
      'browser:purchase-cache-storage',
      'browser:purchase-cookies',
      'browser:purchase-downloads',
      'browser:purchase-extension-storage',
      'browser:purchase-http-cache',
      'browser:purchase-indexed-db',
      'browser:purchase-local-storage',
      'browser:purchase-persistent-partition',
      'browser:purchase-plugin-installation-state',
      'browser:purchase-profile-identity',
      'browser:purchase-proxy-auth',
      'browser:purchase-service-workers',
      'filesystem:diagnostic-logs-owner-cross-border-bus',
      'filesystem:diagnostic-logs-owner-integration-profile',
      'filesystem:diagnostic-logs-owner-model-api-account',
      'filesystem:diagnostic-logs-owner-ozon-shop',
      'filesystem:diagnostic-logs-owner-promotion-account',
      'filesystem:diagnostic-logs-owner-purchase-account',
      'filesystem:recovery-protection-owner-cross-border-bus',
      'filesystem:recovery-protection-owner-integration-profile',
      'filesystem:recovery-protection-owner-model-api-account',
      'filesystem:recovery-protection-owner-ozon-shop',
      'filesystem:recovery-protection-owner-promotion-account',
      'filesystem:recovery-protection-owner-purchase-account',
      'logical:local-data-ozon-shop-settings-shop-slices',
      'logical:local-data-product-material-profiles-shop-records',
      'logical:local-data-product-source-links-shop-records',
      'logical:local-data-purchase-order-overrides-shop-records',
      'logical:local-data-purchase-source-links-shop-records',
      'logical:local-data-sales-source-links-shop-records',
      'logical:renderer-cross-border-settings-account-slice',
      'logical:renderer-ozon-shop-settings-shop-slices',
      'logical:renderer-purchase-order-overrides-shop-records',
      'memory:purchase-search-bridge-captures-unattributed',
      'memory:purchase-search-bridge-context-unattributed',
      'memory:purchase-search-bridge-purchase-account-captures',
      'memory:purchase-search-bridge-purchase-account-context',
      'memory:renderer-collection-listing-category-template-cache',
      'memory:renderer-model-api-settings',
      'memory:renderer-ozon-snapshot-inflight-unattributed',
      'memory:renderer-ozon-snapshot-manual-refresh-unattributed',
      'memory:renderer-ozon-snapshot-memory-cache-unattributed',
      'memory:renderer-product-list-cursor-cache-unattributed',
      'memory:renderer-product-list-memory-cache-unattributed',
      'memory:renderer-product-list-page-meta-cache-unattributed',
      'memory:renderer-product-material-profiles',
      'memory:renderer-profit-after-sales-snapshot-cache',
      'memory:renderer-profit-finance-operation-cache',
      'memory:renderer-profit-rating-penalty-operation-cache',
      'memory:renderer-purchase-plugin-account-context',
      'memory:renderer-purchase-plugin-source-context-unattributed',
    ]);
  });
});
