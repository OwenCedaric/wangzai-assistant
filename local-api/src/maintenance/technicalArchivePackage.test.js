import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildTechnicalArchivePackage,
  decryptTechnicalArchivePackage,
  parseTechnicalArchivePackage,
  serializeTechnicalArchivePackage,
} from './technicalArchivePackage.js';

const encryptionKey = Buffer.alloc(32, 11);
const dedupeKey = Buffer.alloc(32, 17);

test('technical archive package encrypts private identifiers and round-trips canonical records', () => {
  const archivePackage = buildTechnicalArchivePackage({
    archiveType: 'scheduler-trace',
    sourceFrom: '2026-07-01T00:00:00.000Z',
    sourceTo: '2026-07-01T01:00:00.000Z',
    expiresAt: '2026-08-15T01:00:00.000Z',
    encryptionKey,
    dedupeKey,
    records: [{
      key: 'trace:private-event-id',
      value: { id: 'private-event-id', job_id: 'private-job-id', shop_id: 'private-shop-id' },
    }],
  });
  const bytes = serializeTechnicalArchivePackage(archivePackage);
  const diskText = bytes.toString('utf8');
  assert.equal(diskText.includes('private-event-id'), false);
  assert.equal(diskText.includes('private-job-id'), false);
  assert.equal(diskText.includes('private-shop-id'), false);

  const parsed = parseTechnicalArchivePackage(bytes);
  const restored = decryptTechnicalArchivePackage({ archivePackage: parsed, encryptionKey });
  assert.equal(restored.metadata.archiveType, 'scheduler-trace');
  assert.equal(restored.records[0].value.job_id, 'private-job-id');
  assert.match(restored.metadata.archiveId, /^[A-Za-z0-9_-]{43}$/u);
});

test('technical archive rejects public metadata and ciphertext tampering', () => {
  const archivePackage = buildTechnicalArchivePackage({
    archiveType: 'scheduler-trace',
    sourceFrom: '2026-07-01T00:00:00.000Z',
    sourceTo: '2026-07-01T00:00:00.000Z',
    expiresAt: '2026-08-15T00:00:00.000Z',
    encryptionKey,
    dedupeKey,
    records: [{ key: 'trace:1', value: { id: '1' } }],
  });
  assert.throws(
    () => decryptTechnicalArchivePackage({
      archivePackage: { ...archivePackage, expiresAt: '2026-08-16T00:00:00.000Z' },
      encryptionKey,
    }),
  );
  assert.throws(
    () => decryptTechnicalArchivePackage({
      archivePackage: {
        ...archivePackage,
        encrypted: {
          ...archivePackage.encrypted,
          ciphertextB64u: `${archivePackage.encrypted.ciphertextB64u.slice(0, -1)}A`,
        },
      },
      encryptionKey,
    }),
    /RECOVERY_CIPHER_HASH_MISMATCH/,
  );
});
