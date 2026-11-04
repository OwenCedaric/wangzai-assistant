import { createHash } from 'node:crypto';

// Internal observer identity only. Never use an anonymous fallback: otherwise
// unrelated authorized users would share assistant request/idempotency state.
export function licenseAuthorizationScope(user, projectCode = '') {
  for (const field of ['id', 'email', 'username']) {
    const value = user?.[field];
    if (!['string', 'number'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) continue;
    if (value === null || value === undefined || !String(value).trim()) continue;
    return createHash('sha256').update(`wangzai-authorization-owner:v1\0${projectCode}\0${field}\0${String(value).trim()}`).digest('hex');
  }
  return null;
}
