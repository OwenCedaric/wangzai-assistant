import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LOCAL_API_TOKEN_HEADER,
  localApiRequestIsAuthorized,
  localApiUnauthorizedPayload,
} from '../src/security/localApiAccess.js';

const config = { security: { authToken: 's'.repeat(43) } };

test('protects API routes when a desktop capability token is configured', () => {
  assert.equal(localApiRequestIsAuthorized(config, { headers: {} }, '/api/app/status'), false);
  assert.equal(
    localApiRequestIsAuthorized(
      config,
      { headers: { [LOCAL_API_TOKEN_HEADER]: 's'.repeat(43) } },
      '/api/app/status',
    ),
    true,
  );
  assert.equal(localApiRequestIsAuthorized(config, { headers: {} }, '/health'), true);
});

test('keeps standalone development compatible when no token is configured', () => {
  assert.equal(
    localApiRequestIsAuthorized({ security: { authToken: '' } }, { headers: {} }, '/api/app/status'),
    true,
  );
  assert.equal(localApiUnauthorizedPayload().error.code, 'LOCAL_API_UNAUTHORIZED');
});
