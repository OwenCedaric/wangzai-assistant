import { expect, it } from 'vitest';
import { createProfitCoreBatch, encodeProfitWire, decodeProfitWire, readProfitCoreResults, PRIVATE_PROFIT_VERSION } from './profitCoreWire.js';

it('preserves supported financial data without converting missing values, maps or dates', () => {
  const value = { missing: undefined, zero: 0, no: false, n: null, amount: 1.23456789,
    map: new Map([['a', [1, null]], ['b', new Set(['x', 'y'])]]),
    date: new Date('2026-09-07T00:00:00Z'), bigint: 123n, string: '人民币 ₽中文' };
  expect(decodeProfitWire(JSON.parse(JSON.stringify(encodeProfitWire(value))))).toEqual(value);
});
it('rejects secrets, cycles, nonfinite values, traversal-style object keys and unknown operations', () => {
  const cyclic = {}; cyclic.self = cyclic;
  for (const input of [{ apiKey: 'test' }, { nested: { cookie: 'test' } }, cyclic, { amount: Infinity }, { f() {} }]) expect(() => encodeProfitWire(input)).toThrow();
  expect(() => decodeProfitWire({ t: 'object', v: [['__proto__', {}]] })).toThrow();
  expect(() => createProfitCoreBatch([{ id: 'x', operation: 'eval', input: { order: {} } }])).toThrow();
  expect(() => createProfitCoreBatch(Array.from({ length: 65 }, (_, i) => ({ id: `${i}`, operation: 'ledger', input: { order: {} } })))).toThrow();
});
it('validates exact result coverage and ordering rather than accepting a partial or wrong batch', () => {
  const calls = [{ id: 'a', operation: 'ledger', input: { order: {} } }, { id: 'b', operation: 'ledger', input: { order: {} } }];
  expect(createProfitCoreBatch(calls).calculationVersion).toBe(PRIVATE_PROFIT_VERSION);
  const result = rows => ({ calculationVersion: PRIVATE_PROFIT_VERSION, resultsJson: JSON.stringify(encodeProfitWire(rows)) });
  expect(readProfitCoreResults(result([{ id: 'a', value: 1 }, { id: 'b', value: 2 }]), calls)).toEqual([1, 2]);
  for (const rows of [[{ id: 'a', value: 1 }], [{ id: 'b', value: 2 }, { id: 'a', value: 1 }]]) expect(() => readProfitCoreResults(result(rows), calls)).toThrow();
});
