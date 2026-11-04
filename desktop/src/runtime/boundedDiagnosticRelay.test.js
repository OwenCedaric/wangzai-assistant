import test from 'node:test';
import assert from 'node:assert/strict';
import { createBoundedDiagnosticRelay } from './boundedDiagnosticRelay.js';

test('a slow log sink cannot accumulate unbounded native diagnostics or block the producer', async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const written = [];
  const relay = createBoundedDiagnosticRelay({ maximumQueuedBytes: 256, maximumQueuedEntries: 4,
    maximumEntryBytes: 128, write: async text => { written.push(text); await blocked; } });
  relay.append('initial error\n');
  await Promise.resolve();
  for (let i = 0; i < 5000; i++) relay.append(`error-${i}:${'x'.repeat(60)}\n`);
  assert.ok(relay.getStatus().queuedBytes <= 256);
  assert.ok(relay.getStatus().queuedEntries <= 4);
  assert.ok(relay.getStatus().dropped > 4900);
  release(); await relay.flush();
  assert.match(written[0], /initial error/u);
  assert.match(written.join(''), /dropped=\d+ reason=bounded-log-queue/u);
  assert.match(written.at(-1), /error-4999/u);
  assert.equal(relay.getStatus().queuedBytes, 0);
});

test('sink rejection is reported diagnostically and does not poison future writes', async () => {
  let fail = true;
  const written = [];
  const relay = createBoundedDiagnosticRelay({ write: text => {
    if (fail) throw new Error('isolated log failure');
    written.push(text);
  } });
  relay.append('first'); await relay.flush();
  assert.equal(relay.getStatus().writeFailures, 1);
  fail = false;
  relay.append('recovered'); await relay.flush();
  assert.deepEqual(written, ['recovered']);
  await relay.close();
  relay.append('late'); await relay.flush();
  assert.deepEqual(written, ['recovered']);
});

test('entry truncation stays byte-bounded and never splits an encoded UTF-8 code point', async () => {
  const written = [];
  const relay = createBoundedDiagnosticRelay({ maximumEntryBytes: 17, maximumQueuedBytes: 128,
    write: text => written.push(text) });
  relay.append('日志🙂'.repeat(10000));
  await relay.flush();
  assert.ok(Buffer.byteLength(written[0]) <= 17);
  assert.doesNotMatch(written[0], /\uFFFD/u);
  assert.equal(relay.getStatus().truncated, 1);
});

test('bad queue limits cannot silently disable diagnostic bounds', () => {
  for (const value of [0, -1, 1.5, Infinity, NaN]) {
    assert.throws(() => createBoundedDiagnosticRelay({ write() {}, maximumQueuedBytes: value }),
      /DIAGNOSTIC_RELAY_POLICY_INVALID/u);
  }
});
