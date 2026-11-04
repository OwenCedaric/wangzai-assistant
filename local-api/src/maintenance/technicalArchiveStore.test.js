import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createTechnicalArchiveStore } from './technicalArchiveStore.js';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'wangzai-technical-archive-'));
  const store = createTechnicalArchiveStore({
    archiveDirectory: directory,
    encryptionKey: Buffer.alloc(32, 21),
    dedupeKey: Buffer.alloc(32, 23),
    logger: { warn() {} },
  });
  return { directory, store, close: () => rmSync(directory, { recursive: true, force: true }) };
}

function archiveInput(expiresAt = '2026-08-15T00:00:00.000Z') {
  return {
    archiveType: 'scheduler-trace',
    sourceFrom: '2026-07-01T00:00:00.000Z',
    sourceTo: '2026-07-01T00:00:00.000Z',
    expiresAt,
    records: [{ key: 'trace:event-secret', value: { id: 'event-secret', job_id: 'job-secret' } }],
  };
}

test('technical archive store publishes atomically and retry-dedupes the same logical package', () => {
  const item = fixture();
  try {
    const first = item.store.publish(archiveInput());
    const second = item.store.publish(archiveInput());
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(first.archiveId, second.archiveId);
    const files = readdirSync(item.directory).filter((name) => name.endsWith('.wzta'));
    assert.equal(files.length, 1);
    assert.equal(files[0].includes('job-secret'), false);
    assert.equal(readFileSync(first.filePath, 'utf8').includes('job-secret'), false);
    assert.equal(item.store.read(first.archiveId).records[0].value.job_id, 'job-secret');
  } finally {
    item.close();
  }
});

test('technical archive store deletes only verified expired packages and preserves tampered files', () => {
  const item = fixture();
  try {
    const expired = item.store.publish(archiveInput('2026-07-10T00:00:00.000Z'));
    const result = item.store.pruneExpired(new Date('2026-07-11T00:00:00.000Z'));
    assert.equal(result.deleted.length, 1);
    assert.equal(readdirSync(item.directory).filter((name) => name.endsWith('.wzta')).length, 0);

    const corrupt = item.store.publish(archiveInput('2026-08-15T00:00:00.000Z'));
    const bytes = readFileSync(corrupt.filePath);
    bytes[Math.floor(bytes.length / 2)] ^= 1;
    writeFileSync(corrupt.filePath, bytes);
    const preserved = item.store.pruneExpired(new Date('2026-09-01T00:00:00.000Z'));
    assert.equal(preserved.deleted.length, 0);
    assert.equal(preserved.errors.length, 1);
    assert.equal(readdirSync(item.directory).filter((name) => name.endsWith('.wzta')).length, 1);
  } finally {
    item.close();
  }
});

test('technical archive store enforces source-age and byte caps without deleting unverified packages', () => {
  const item = fixture();
  try {
    const oldInput = archiveInput('2026-12-15T00:00:00.000Z');
    const old = item.store.publish(oldInput);
    const recent = item.store.publish({
      ...archiveInput('2026-12-15T00:00:00.000Z'),
      sourceFrom: '2026-07-10T00:00:00.000Z',
      sourceTo: '2026-07-10T00:00:00.000Z',
      records: [{ key: 'trace:recent', value: { id: 'recent' } }],
    });

    const byAge = item.store.pruneExpired(new Date('2026-07-11T00:00:00.000Z'), {
      maxSourceAgeDays: 7,
      maxTotalBytes: Number.POSITIVE_INFINITY,
    });
    assert.equal(byAge.deleted.some((entry) => entry.archiveId === old.archiveId && entry.reason === 'retention-window'), true);
    assert.equal(item.store.read(recent.archiveId).metadata.archiveId, recent.archiveId);

    const capped = item.store.pruneExpired(new Date('2026-07-11T00:00:00.000Z'), {
      maxSourceAgeDays: 7,
      maxTotalBytes: 0,
    });
    assert.equal(capped.deleted.length, 1);
    assert.equal(capped.deleted[0].reason, 'capacity');
    assert.equal(capped.remainingBytes, 0);
    assert.equal(capped.capacitySatisfied, true);
  } finally {
    item.close();
  }
});
