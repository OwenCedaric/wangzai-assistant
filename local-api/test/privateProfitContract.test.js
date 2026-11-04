import test from 'node:test';
import assert from 'node:assert/strict';
import { createProfitCoreBatch, encodeProfitWire, PRIVATE_PROFIT_VERSION } from '../../shared/profitCoreWire.js';
import { normalizePrivateProfitInput, validatePrivateProfitResult } from '../src/domain/protectedCompute/privateProfitContract.js';

test('private profit transport preserves the exact signed input string', () => {
  const input = createProfitCoreBatch([{ id: 'one', operation: 'normalize', input: {
    order: { shopId: 'fixture-shop', shopClientId: 'fixture-identity', amountValue: 1.23456789 },
    context: { financeIndex: new Map([['one', [{ amount: 0 }]]]) },
  } }]);
  assert.deepEqual(normalizePrivateProfitInput(input), input);
});

test('private profit rejects malformed, secret-bearing and oversized calls before dispatch', () => {
  const input = createProfitCoreBatch([{ id: 'one', operation: 'ledger', input: { order: {} } }]);
  const encode = calls => ({ ...input, callsJson: JSON.stringify(encodeProfitWire(calls)) });
  for (const bad of [null, { ...input, extra: true }, { ...input, callsJson: ' '.repeat(1024 * 1024 + 1) },
    encode([{ id: 1, operation: 'ledger', input: { order: {} } }]),
    encode([{ id: 'one', operation: 'ledger', input: { order: [] } }]),
    { ...input, callsJson: input.callsJson.replace('"order"', '"apiKey"') },
  ]) assert.throws(() => normalizePrivateProfitInput(bad), error => error.code === 'PROTECTED_COMPUTE_INPUT_INVALID');
});

test('private profit results require the exact version and bounded typed fields', () => {
  const result = { calculationVersion: PRIVATE_PROFIT_VERSION, resultsJson: JSON.stringify(encodeProfitWire([{ id: 'one', value: {} }])) };
  assert.deepEqual(validatePrivateProfitResult(result), result);
  for (const bad of [{ ...result, extra: true }, { ...result, calculationVersion: 'old' }, { ...result, resultsJson: '{}' },
    { ...result, resultsJson: 'x'.repeat(16 * 1024 * 1024 + 1) }]) assert.throws(() => validatePrivateProfitResult(bad));
});
