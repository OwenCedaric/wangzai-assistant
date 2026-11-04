import { afterEach, describe, expect, it, vi } from 'vitest';
import { readRecoveryStartupMode } from './recoveryStartupMode.js';

afterEach(() => {
  delete globalThis.window?.wangzaiDesktop;
});

describe('readRecoveryStartupMode', () => {
  it('reads the main-process recovery-only mode without treating bridge failures as recovery', async () => {
    globalThis.window.wangzaiDesktop = {
      getAppInfo: vi.fn().mockResolvedValue({ recoveryMode: true }),
    };
    await expect(readRecoveryStartupMode()).resolves.toBe(true);

    globalThis.window.wangzaiDesktop.getAppInfo.mockRejectedValue(new Error('bridge unavailable'));
    await expect(readRecoveryStartupMode()).resolves.toBe(false);
  });
});
