import { expect, it } from 'vitest';
import { buildAccountRemovalFailureReport } from './accountRemovalFailureReport.js';
const fingerprint = 'd'.repeat(64);
const operation = { operationId: 'owned-op', phase: 'external-delete-pending', previewFingerprint: fingerprint,
  clientCleanup: { nonce: 'trusted-nonce', resourceIds: ['browser:purchase-cookies'] } };

it('whitelists report fields and error codes without forwarding private exception content', () => {
  const error = Object.assign(new Error('secret message'), { code: 'UNRECOGNIZED', token: 'secret', ownerId: 'private',
    resourceId: 'browser:purchase-cookies' });
  expect(buildAccountRemovalFailureReport(operation, fingerprint, error)).toEqual({
    operationId: 'owned-op', nonce: 'trusted-nonce', previewFingerprint: fingerprint,
    errorCode: 'ACCOUNT_REMOVAL_CLIENT_CLEANUP_FAILED', resourceId: 'browser:purchase-cookies',
  });
});
it('never fabricates a nonce or reports pending/finished tasks as failed', () => {
  expect(buildAccountRemovalFailureReport({}, fingerprint, new Error('unknown'))).toBeNull();
  expect(buildAccountRemovalFailureReport(operation, fingerprint, { code: 'PURCHASE_BROWSER_ACCOUNT_REMOVAL_IN_PROGRESS' })).toBeNull();
  expect(buildAccountRemovalFailureReport({ ...operation, completed: true }, fingerprint, new Error('late'))).toBeNull();
  expect(buildAccountRemovalFailureReport(operation, 'x'.repeat(64), new Error('wrong binding'))).toBeNull();
});
