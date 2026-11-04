import crypto from 'node:crypto';

export const LOCAL_API_TOKEN_HEADER = 'x-wangzai-local-api-token';

function constantTimeEqual(left, right) {
  const leftHash = crypto.createHash('sha256').update(String(left || ''), 'utf8').digest();
  const rightHash = crypto.createHash('sha256').update(String(right || ''), 'utf8').digest();
  return crypto.timingSafeEqual(leftHash, rightHash);
}

export function localApiRequestIsAuthorized(config, request, pathname) {
  if (!String(pathname || '').startsWith('/api/')) return true;
  const expected = String(config?.security?.authToken || '');
  if (!expected) return true;
  const provided = String(request?.headers?.[LOCAL_API_TOKEN_HEADER] || '');
  return provided.length >= 32 && constantTimeEqual(provided, expected);
}

export function localApiUnauthorizedPayload() {
  return {
    ok: false,
    error: {
      code: 'LOCAL_API_UNAUTHORIZED',
      message: '当前请求未经桌面端授权通道转发。',
    },
  };
}
