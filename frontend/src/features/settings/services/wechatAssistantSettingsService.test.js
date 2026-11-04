import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestWechatAssistant } from './wechatAssistantSettingsService.js';

describe('requestWechatAssistant', () => {
  afterEach(() => {
    delete window.wangzaiDesktop;
  });

  it('returns the desktop command result', async () => {
    const command = vi.fn(async () => ({ ok: true, runtimeAvailable: true }));
    window.wangzaiDesktop = { wechatAssistant: { command } };

    await expect(requestWechatAssistant({ command: 'status' })).resolves.toEqual({
      ok: true,
      runtimeAvailable: true,
    });
  });

  it('does not expose Electron or internal process errors to the page', async () => {
    window.wangzaiDesktop = {
      wechatAssistant: {
        command: vi.fn(async () => {
          throw new Error("Error invoking remote method: DESKTOP_PROCESS_LOG_NAME_INVALID");
        }),
      },
    };

    const result = await requestWechatAssistant({ command: 'status' });

    expect(result).toEqual({
      ok: false,
      error: '微信助理操作未完成，请重试；如仍失败请查看运行日志。',
    });
    expect(JSON.stringify(result)).not.toContain('DESKTOP_PROCESS_LOG_NAME_INVALID');
    expect(JSON.stringify(result)).not.toContain('remote method');
  });
});
