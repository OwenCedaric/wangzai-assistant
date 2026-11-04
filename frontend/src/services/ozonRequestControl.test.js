import { describe, expect, it, vi } from 'vitest';
import {
  classifyOzonRequestError,
  createOzonHttpError,
  createOzonRequestControl,
  parseRetryAfter,
} from './ozonRequestControl.js';

describe('ozonRequestControl', () => {
  it('parses Retry-After seconds and dates', () => {
    expect(parseRetryAfter('2')).toBe(2000);
    expect(parseRetryAfter('Tue, 23 Jun 2026 00:00:05 GMT', Date.parse('2026-06-23T00:00:00Z'))).toBe(5000);
    expect(parseRetryAfter('bad-value')).toBe(0);
  });

  it('classifies 429, server, timeout, and auth failures', () => {
    expect(classifyOzonRequestError(createOzonHttpError({ endpoint: '/x', status: 429 }))).toMatchObject({
      retryable: true,
      type: 'rate-limit',
    });
    expect(classifyOzonRequestError(new Error('HTTP 503'))).toMatchObject({ retryable: true, type: 'server' });
    expect(classifyOzonRequestError(new Error('request timeout'))).toMatchObject({
      retryable: true,
      type: 'timeout',
    });
    expect(classifyOzonRequestError(new Error('HTTP 403'))).toMatchObject({ retryable: false, type: 'http' });
  });

  it('retries 429 with backoff and keeps request stats', async () => {
    vi.useFakeTimers();
    const control = createOzonRequestControl({ maxConcurrent: 1 });
    const execute = vi
      .fn()
      .mockRejectedValueOnce(createOzonHttpError({ endpoint: '/v1/test', status: 429, retryAfterMs: 1000 }))
      .mockResolvedValueOnce({ ok: true });

    const promise = control.runControlledRequest({
      endpoint: '/v1/test',
      shopKey: 'shop-a',
      execute,
      maxRetries: 2,
      jitterMs: 0,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(control.getStats().currentIssues[0]).toMatchObject({
      willRetry: true,
      retryDelayMs: 1000,
    });
    expect(Date.parse(control.getStats().currentIssues[0].nextRetryAt)).toBe(Date.now() + 1000);

    await vi.advanceTimersByTimeAsync(1000);
    await expect(promise).resolves.toEqual({ ok: true });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(control.getStats()).toMatchObject({
      total: 1,
      retries: 1,
      rateLimited: 1,
      failed: 0,
    });
    vi.useRealTimers();
  });

  it('does not exceed the configured concurrency', async () => {
    const control = createOzonRequestControl({ maxConcurrent: 1 });
    const order = [];
    let releaseFirst;
    const first = control.runControlledRequest({
      endpoint: '/v1/a',
      shopKey: 'shop-a',
      execute: () =>
        new Promise((resolve) => {
          order.push('first-start');
          releaseFirst = () => resolve('first');
        }),
    });
    const second = control.runControlledRequest({
      endpoint: '/v1/b',
      shopKey: 'shop-a',
      execute: async () => {
        order.push('second-start');
        return 'second';
      },
    });

    expect(order).toEqual(['first-start']);
    releaseFirst();
    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
    expect(order).toEqual(['first-start', 'second-start']);
  });

  it('runs different shops concurrently even when each shop is limited to one request', async () => {
    const control = createOzonRequestControl({ maxConcurrentPerShop: 1 });
    const started = [];
    const releases = new Map();
    const run = (shopKey) => control.runControlledRequest({
      endpoint: '/v3/product/list',
      shopKey,
      execute: () => new Promise((resolve) => {
        started.push(shopKey);
        releases.set(shopKey, () => resolve(shopKey));
      }),
    });

    const shopA = run('shop-a');
    const shopB = run('shop-b');
    await Promise.resolve();
    expect([...started].sort()).toEqual(['shop-a', 'shop-b']);
    expect(control.getStats().activeByShop).toEqual({ 'shop-a': 1, 'shop-b': 1 });
    releases.get('shop-a')();
    releases.get('shop-b')();
    await expect(Promise.all([shopA, shopB])).resolves.toEqual(['shop-a', 'shop-b']);
  });

  it('coalesces concurrent requests with the same dedupe key', async () => {
    const control = createOzonRequestControl({ maxConcurrent: 2 });
    const execute = vi.fn(async () => ({ rows: [1, 2, 3] }));

    const first = control.runControlledRequest({
      endpoint: '/v3/product/list',
      shopKey: 'shop-a',
      dedupeKey: 'shop-a:/v3/product/list:{}',
      execute,
    });
    const second = control.runControlledRequest({
      endpoint: '/v3/product/list',
      shopKey: 'shop-a',
      dedupeKey: 'shop-a:/v3/product/list:{}',
      execute,
    });

    await expect(Promise.all([first, second])).resolves.toEqual([{ rows: [1, 2, 3] }, { rows: [1, 2, 3] }]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(control.getStats()).toMatchObject({
      total: 1,
      deduped: 1,
      failed: 0,
    });
  });

  it('never coalesces the same dedupe key across different shops', async () => {
    const control = createOzonRequestControl({ maxConcurrentPerShop: 1 });
    const executeA = vi.fn(async () => 'shop-a');
    const executeB = vi.fn(async () => 'shop-b');

    await expect(Promise.all([
      control.runControlledRequest({ endpoint: '/v3/product/list', shopKey: 'shop-a', dedupeKey: 'same-query', execute: executeA }),
      control.runControlledRequest({ endpoint: '/v3/product/list', shopKey: 'shop-b', dedupeKey: 'same-query', execute: executeB }),
    ])).resolves.toEqual(['shop-a', 'shop-b']);
    expect(executeA).toHaveBeenCalledTimes(1);
    expect(executeB).toHaveBeenCalledTimes(1);
    expect(control.getStats().deduped).toBe(0);
  });

  it('keeps shop-b running while shop-a waits through its own 429 backoff', async () => {
    vi.useFakeTimers();
    const control = createOzonRequestControl({ maxConcurrentPerShop: 1 });
    const executeA = vi
      .fn()
      .mockRejectedValueOnce(createOzonHttpError({ endpoint: '/v3/product/list', status: 429, retryAfterMs: 1000 }))
      .mockResolvedValueOnce('shop-a-recovered');
    const shopA = control.runControlledRequest({
      endpoint: '/v3/product/list',
      shopKey: 'shop-a',
      execute: executeA,
      jitterMs: 0,
    });
    await vi.advanceTimersByTimeAsync(0);

    const executeB = vi.fn(async () => 'shop-b-ok');
    const shopB = control.runControlledRequest({
      endpoint: '/v3/product/list',
      shopKey: 'shop-b',
      execute: executeB,
    });
    await expect(shopB).resolves.toBe('shop-b-ok');
    expect(executeB).toHaveBeenCalledTimes(1);
    expect(executeA).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    await expect(shopA).resolves.toBe('shop-a-recovered');
    vi.useRealTimers();
  });

  it('fails closed when no exact shop key is provided', async () => {
    const control = createOzonRequestControl();
    await expect(control.runControlledRequest({ endpoint: '/v3/product/list', execute: async () => 'no' }))
      .rejects.toThrow(/exact shopKey/u);
  });

  it('lets a deduped subscriber abort without aborting the shared request', async () => {
    const control = createOzonRequestControl({ maxConcurrent: 1 });
    let releaseShared;
    const execute = vi.fn(
      () =>
        new Promise((resolve) => {
          releaseShared = () => resolve('shared-result');
        })
    );

    const shared = control.runControlledRequest({
      endpoint: '/v3/product/list',
      shopKey: 'shop-a',
      dedupeKey: 'shared-read',
      execute,
    });
    const controller = new AbortController();
    const joined = control.runControlledRequest({
      endpoint: '/v3/product/list',
      shopKey: 'shop-a',
      dedupeKey: 'shared-read',
      signal: controller.signal,
      execute,
    });

    controller.abort();
    await expect(joined).rejects.toMatchObject({ name: 'AbortError' });
    releaseShared();
    await expect(shared).resolves.toBe('shared-result');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('removes aborted queued requests before they occupy a slot', async () => {
    const control = createOzonRequestControl({ maxConcurrent: 1 });
    let releaseFirst;
    const first = control.runControlledRequest({
      endpoint: '/v1/a',
      shopKey: 'shop-a',
      execute: () =>
        new Promise((resolve) => {
          releaseFirst = () => resolve('first');
        }),
    });
    const controller = new AbortController();
    const queuedExecute = vi.fn(async () => 'queued');
    const queued = control.runControlledRequest({
      endpoint: '/v1/b',
      shopKey: 'shop-a',
      signal: controller.signal,
      execute: queuedExecute,
    });

    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    expect(queuedExecute).not.toHaveBeenCalled();
    expect(control.getStats().queued).toBe(0);
    releaseFirst();
    await expect(first).resolves.toBe('first');
  });
});
