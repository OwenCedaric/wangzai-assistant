import assert from 'node:assert/strict';
import test from 'node:test';
import { createRecoveryRemoteClient } from './recoveryRemoteClient.js';

const ownerRef = 'o'.repeat(32);
const json = (payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
const create = (fetchImpl) => createRecoveryRemoteClient({ baseUrl: 'https://synthetic-recovery.invalid', accessToken: 'synthetic-token', fetchImpl });

test('only an explicit pre-mutation remote 401 advertises safe authorization retry', async () => {
  const client = create(async () => json({ detail: 'rejected' }, 401));
  await assert.rejects(client.listGenerations(), { code: 'RECOVERY_REMOTE_AUTH_REQUIRED', remoteStatus: 401, safeAuthRetry: true });
});

test('an owner purge request is never replayable merely because its response is 401', async () => {
  let requests = 0;
  const client = create(async () => { requests += 1; return json({}, 401); });
  await assert.rejects(client.purgeOwner({ ownerRef, expectedGenerationIds: [] }),
    { code: 'RECOVERY_REMOTE_AUTH_REQUIRED', remoteStatus: 401, safeAuthRetry: false });
  assert.equal(requests, 1);
});

test('a 401 during post-purge readback does not authorize re-executing the mutation', async () => {
  const client = create(async (_url, options = {}) => options.method === 'POST'
    ? json({ owner_ref: ownerRef, tombstoned: true, deleted_generation_ids: [], remaining_generation_count: 0 }) : json({}, 401));
  await client.purgeOwner({ ownerRef, expectedGenerationIds: [] });
  await assert.rejects(client.getOwnerPurgeStatus({ ownerRef }), { code: 'RECOVERY_REMOTE_AUTH_REQUIRED', safeAuthRetry: false });
});

for (const [status, code] of [[403, 'RECOVERY_REMOTE_ACCESS_DENIED'], [404, 'RECOVERY_REMOTE_ENDPOINT_UNAVAILABLE']]) {
  test(`remote ${status} remains an actionable failure, never an empty-remote proof`, async () => {
    const client = create(async () => json({}, status));
    await assert.rejects(client.listGenerations(), { code, remoteStatus: status, safeAuthRetry: false });
  });
}

test('unavailable transport and missing login are distinct failures without automatic retry permission', async () => {
  const client = create(async () => { throw new Error('synthetic disconnected transport'); });
  await assert.rejects(client.listGenerations(), { code: 'RECOVERY_REMOTE_UNAVAILABLE', remoteStatus: 0, safeAuthRetry: false });
  assert.throws(() => createRecoveryRemoteClient({ baseUrl: 'https://synthetic-recovery.invalid', accessToken: '' }),
    { code: 'RECOVERY_REMOTE_LOGIN_REQUIRED', remoteStatus: 401, safeAuthRetry: false });
});
