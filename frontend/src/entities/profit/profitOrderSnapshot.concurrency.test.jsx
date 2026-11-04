import { describe, expect, it } from 'vitest';
import {
  isLocalApiOrderTransportFailure,
  runOzonOrderEndpointReadersSequentially,
} from './profitOrderSnapshot.jsx';

describe('Ozon order endpoint scheduling', () => {
  it('runs FBS, unfulfilled FBS and FBO readers strictly in sequence', async () => {
    const events = [];
    let active = 0;
    let maxActive = 0;
    const reader = (name) => async () => {
      events.push(`${name}:start`);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      events.push(`${name}:end`);
      return { ok: true, label: name, value: { items: [] } };
    };

    const results = await runOzonOrderEndpointReadersSequentially([
      reader('fbs'),
      reader('unfulfilled'),
      reader('fbo'),
    ]);

    expect(maxActive).toBe(1);
    expect(events).toEqual([
      'fbs:start',
      'fbs:end',
      'unfulfilled:start',
      'unfulfilled:end',
      'fbo:start',
      'fbo:end',
    ]);
    expect(results).toHaveLength(3);
  });

  it('stops the remaining endpoint readers when local-api transport is down', async () => {
    const events = [];
    const transportError = Object.assign(new Error('ECONNREFUSED'), { status: 0 });
    const results = await runOzonOrderEndpointReadersSequentially([
      async () => {
        events.push('fbs');
        return { ok: false, error: transportError };
      },
      async () => {
        events.push('unfulfilled');
        return { ok: true, value: { items: [] } };
      },
    ]);

    expect(isLocalApiOrderTransportFailure(transportError)).toBe(true);
    expect(events).toEqual(['fbs']);
    expect(results).toHaveLength(1);
  });
});
