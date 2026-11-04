import { describe, expect, it, vi } from 'vitest';
import { isTransientLocalApiWriteError, retryTransientLocalApiWrite } from './localApiTransientWriteRetry.js';

describe('transient local-api write retry', () => {
  it('retries SQLite busy and timeout failures until the canonical write succeeds', async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(new Error('database is locked'))
      .mockRejectedValueOnce(new Error('本地 API 请求超时'))
      .mockResolvedValueOnce({ ok: true });
    await expect(retryTransientLocalApiWrite(operation, { retryDelaysMs: [0, 0] })).resolves.toEqual({ ok: true });
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('does not retry validation failures', async () => {
    const operation = vi.fn().mockRejectedValue(new Error('PRODUCT_SOURCE_LINK_IDENTITY_REQUIRED'));
    await expect(retryTransientLocalApiWrite(operation, { retryDelaysMs: [0, 0] })).rejects.toThrow(
      'PRODUCT_SOURCE_LINK_IDENTITY_REQUIRED'
    );
    expect(operation).toHaveBeenCalledTimes(1);
    expect(isTransientLocalApiWriteError(new Error('database is locked'))).toBe(true);
  });
});
