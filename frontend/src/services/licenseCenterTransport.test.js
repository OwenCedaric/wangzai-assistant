import { describe, expect, it, vi } from 'vitest';
import { requestLicenseCenterJson } from './licenseCenterTransport.js';

describe('license center transport', () => {
  it('keeps browser fallback transport separate from licensing state', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue({ valid: true }) });

    await expect(
      requestLicenseCenterJson('https://license.example.test/api/license/check', {
        method: 'POST',
        headers: { Authorization: 'Bearer scoped-token' },
        body: '{"project_code":"wangzai_desktop"}',
        fetchImpl,
      })
    ).resolves.toEqual(expect.objectContaining({ payload: { valid: true } }));
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://license.example.test/api/license/check',
      expect.objectContaining({ method: 'POST', headers: { Authorization: 'Bearer scoped-token' } })
    );
  });

  it('returns an explicit empty transport result when the browser request cannot start', async () => {
    await expect(requestLicenseCenterJson('https://license.example.test', { fetchImpl: null })).resolves.toEqual({
      response: null,
      payload: {},
    });
  });
});
