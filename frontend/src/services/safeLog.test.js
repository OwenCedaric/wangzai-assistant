import { afterEach, describe, expect, it, vi } from 'vitest';

import { redactSecrets, safeError, safeInfo, safeWarn } from './safeLog';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('safeLog', () => {
  it('redacts UUID-shaped API keys from strings, objects, and errors', () => {
    const uuidSecret = '11111111-2222-3333-4444-555555555555';
    const redacted = redactSecrets({
      message: `token=${uuidSecret}`,
      nested: {
        note: `raw key ${uuidSecret}`,
      },
      error: new Error(`request failed with ${uuidSecret}`),
    });
    const serialized = JSON.stringify(redacted, (_key, value) => {
      if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
      return value;
    });

    expect(serialized).not.toContain(uuidSecret);
    expect(serialized).toContain('[REDACTED_UUID]');
    expect(serialized).toContain('token=[REDACTED]');
  });

  it('redacts values before writing to console sinks', () => {
    const uuidSecret = '11111111-2222-3333-4444-555555555555';
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    safeInfo(`apiKey=${uuidSecret}`);
    safeWarn({ token: uuidSecret });
    safeError(new Error(`failed ${uuidSecret}`));

    expect(infoSpy).toHaveBeenCalledWith('apiKey=[REDACTED]');
    expect(warnSpy).toHaveBeenCalledWith({ token: '[REDACTED]' });
    expect(errorSpy.mock.calls[0][0].message).toBe('failed [REDACTED_UUID]');
  });
});
