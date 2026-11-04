import assert from 'node:assert/strict';
import test from 'node:test';
import { createHealthPayload } from './health.js';

test('health payload exposes the local runtime identity without credentials', () => {
  const payload = createHealthPayload({
    config: {
      server: { host: '127.0.0.1', port: 3790 },
      runtime: {
        appId: 'com.wangzai.assistant.desktop',
        profileId: 'profile-1',
        dataRootFingerprint: 'fingerprint-1',
        protocolVersion: '1',
      },
    },
    databaseStatus: { ok: true, journalMode: 'wal', userVersion: 32, tables: [] },
  });

  assert.deepEqual(payload.runtime, {
    appId: 'com.wangzai.assistant.desktop',
    profileId: 'profile-1',
    dataRootFingerprint: 'fingerprint-1',
    protocolVersion: '1',
  });
  assert.deepEqual(Object.keys(payload.runtime).sort(), [
    'appId',
    'dataRootFingerprint',
    'profileId',
    'protocolVersion',
  ]);
});
