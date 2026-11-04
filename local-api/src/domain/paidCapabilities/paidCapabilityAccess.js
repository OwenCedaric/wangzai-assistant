import { createHash, randomUUID } from 'node:crypto';

export const PAID_CAPABILITY_ACCESS_TOKEN_HEADER = 'x-wangzai-paid-capability-access-token';

function text(value) {
  return String(value ?? '').trim();
}

export function paidCapabilityContextFromRequest(req) {
  const requestId = text(req?.headers?.['x-request-id']);
  return Object.freeze({
    accessToken: text(req?.headers?.[PAID_CAPABILITY_ACCESS_TOKEN_HEADER]),
    requestId,
  });
}

export function createPaidCapabilityAccess({ runtime } = {}) {
  return Object.freeze({
    async execute({ capability, input, context = {} }) {
      if (typeof runtime?.client?.executePaid !== 'function') {
        const error = new Error('内置积分能力暂不可用，请检查授权服务配置。');
        error.code = 'PAID_CAPABILITY_RUNTIME_UNAVAILABLE';
        error.statusCode = 503;
        throw error;
      }
      if (!text(context.accessToken)) {
        const error = new Error('请先登录授权账号，或在设置中接入可用的自有 API。');
        error.code = 'PAID_CAPABILITY_AUTH_UNAVAILABLE';
        error.statusCode = 401;
        throw error;
      }
      const digest = createHash('sha256')
        .update(`${capability}\0${text(context.requestId) || randomUUID()}`)
        .digest('hex');
      const verified = await runtime.client.executePaid(
        {
          capability,
          version: 1,
          input,
          idempotencyKey: `paid:${digest}`,
        },
        { accessToken: context.accessToken },
      );
      return verified;
    },
  });
}
