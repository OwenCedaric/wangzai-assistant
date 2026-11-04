import assert from 'node:assert/strict';
import test from 'node:test';
import { licenseAuthorizationScope } from './licenseAuthorizationScope.js';
test('internal authorization scope is stable per owner/project and has no anonymous fallback', () => {
  const first = licenseAuthorizationScope({ id: 41, email: 'first@example.invalid' }, 'fixture');
  assert.match(first, /^[a-f0-9]{64}$/u);
  assert.equal(first, licenseAuthorizationScope({ id: 41, email: 'changed@example.invalid' }, 'fixture'));
  assert.notEqual(first, licenseAuthorizationScope({ id: 42 }, 'fixture'));
  assert.notEqual(first, licenseAuthorizationScope({ id: 41 }, 'different-project'));
  assert.equal(licenseAuthorizationScope(null, 'fixture'), null);
  assert.equal(licenseAuthorizationScope({}, 'fixture'), null);
  assert.equal(licenseAuthorizationScope({ id: {} }, 'fixture'), null);
  assert.equal(licenseAuthorizationScope({ id: NaN, username: [] }, 'fixture'), null);
});
