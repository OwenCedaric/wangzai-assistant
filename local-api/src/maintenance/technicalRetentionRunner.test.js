import assert from 'node:assert/strict';
import test from 'node:test';
import { createTechnicalRetentionRunner } from './technicalRetentionRunner.js';

test('technical retention runner commits small batches and exposes cumulative progress', () => {
  const callbacks = [];
  let candidates = 3;
  const service = {
    inspect() {
      return { ok: true, maximumCandidateRows: candidates, previewFingerprint: `fingerprint-${candidates}` };
    },
    applyConfirmed({ previewFingerprint, maxDeleteRows }) {
      assert.equal(previewFingerprint, `fingerprint-${candidates}`);
      const rows = Math.min(candidates, maxDeleteRows);
      candidates -= rows;
      return {
        ok: true,
        deleted: rows ? [{ table: 'trace', rows }] : [],
        complete: candidates === 0,
        remainingCandidateRows: candidates,
        preview: { previewFingerprint: `fingerprint-${candidates}` },
      };
    },
  };
  const runner = createTechnicalRetentionRunner({
    service,
    batchRows: 1,
    schedule: (callback) => callbacks.push(callback),
  });

  const started = runner.start({
    confirmation: 'APPLY_TECHNICAL_RETENTION',
    previewFingerprint: 'fingerprint-3',
    backupAcknowledged: true,
  });
  assert.equal(started.active, true);
  while (callbacks.length) callbacks.shift()();

  assert.deepEqual(runner.getStatus(), {
    ok: true,
    mode: 'background-retention',
    id: started.id,
    active: false,
    status: 'completed',
    startedAt: started.startedAt,
    finishedAt: runner.getStatus().finishedAt,
    totalCandidateRows: 3,
    processedRows: 3,
    remainingCandidateRows: 0,
    batchesCompleted: 3,
    deleted: [{ table: 'trace', rows: 3 }],
  });
});

test('a failing maintenance slice reports failure instead of escaping its timer and remaining active', () => {
  const callbacks = [];
  const runner = createTechnicalRetentionRunner({
    service: {
      inspect: () => ({ ok: true, maximumCandidateRows: 1, previewFingerprint: 'one' }),
      applyConfirmed() { throw Object.assign(new Error('synthetic private detail'), { code: 'SQLITE_BUSY' }); },
    },
    schedule: callback => callbacks.push(callback),
  });
  runner.start({ confirmation: 'APPLY_TECHNICAL_RETENTION', backupAcknowledged: true, previewFingerprint: 'one' });
  assert.doesNotThrow(() => callbacks.shift()());
  assert.equal(runner.getStatus().active, false);
  assert.equal(runner.getStatus().status, 'failed');
  assert.equal(runner.getStatus().code, 'SQLITE_BUSY');
  assert.equal(JSON.stringify(runner.getStatus()).includes('synthetic private detail'), false);
  assert.equal(callbacks.length, 0);
});

test('fresh-preview retries stay bounded and do not bypass initial confirmation', () => {
  const callbacks = [];
  let attempts = 0;
  const runner = createTechnicalRetentionRunner({
    service: {
      inspect: () => ({ ok: true, maximumCandidateRows: 1, previewFingerprint: 'initial' }),
      applyConfirmed() {
        attempts += 1;
        return { ok: false, code: 'TECHNICAL_RETENTION_PREVIEW_STALE',
          preview: { ok: true, maximumCandidateRows: 1, previewFingerprint: `changed-${attempts}` } };
      },
    },
    schedule: callback => callbacks.push(callback),
  });
  assert.equal(runner.start({ confirmation: 'APPLY_TECHNICAL_RETENTION', backupAcknowledged: true,
    previewFingerprint: 'not-confirmed' }).code, 'TECHNICAL_RETENTION_PREVIEW_STALE');
  assert.equal(callbacks.length, 0);
  runner.start({ confirmation: 'APPLY_TECHNICAL_RETENTION', backupAcknowledged: true, previewFingerprint: 'initial' });
  callbacks.shift()();
  assert.equal(attempts, 2);
  assert.equal(callbacks.length, 1);
  assert.equal(runner.getStatus().status, 'queued');
  assert.equal(runner.getStatus().processedRows, 0);
});
