import {
  cancelSyncJob,
  confirmDomainWrite,
  getDomainCache,
  getSyncJob,
  previewDomainWrite,
  startDomainSync,
} from '../api/localApiClient.js';
import { getOzonDomainSyncMapping } from './ozonDomainSyncMap.js';

export function readDomainCache(domain, query = {}, options = {}) {
  return getDomainCache(domain, query, options);
}

export function startDomainRefresh(domain, payload = {}, options = {}) {
  return startDomainSync(domain, payload, options);
}

export function getJobStatus(jobId, options = {}) {
  return getSyncJob(jobId, options);
}

export function cancelJob(jobId, reason, options = {}) {
  return cancelSyncJob(jobId, reason, options);
}

export function mapLegacyOzonEndpoint(endpoint, method = 'POST') {
  const mapping = getOzonDomainSyncMapping(endpoint);
  if (!mapping) {
    return {
      ok: false,
      error: {
        code: 'OZON_ENDPOINT_NOT_CONNECTED_TO_SCHEDULER',
        message: '该 Ozon 接口尚未接入统一调度',
      },
      endpoint,
      method,
    };
  }
  return { ok: true, ...mapping, endpoint, method };
}

export function startLegacyEndpointRefresh(endpoint, shop, body = {}, options = {}) {
  const mapping = mapLegacyOzonEndpoint(endpoint, options.method || 'POST');
  if (!mapping.ok) return Promise.resolve(mapping);
  if (mapping.access !== 'read') {
    return Promise.resolve({
      ok: false,
      error: { code: 'OZON_WRITE_REQUIRES_WRITE_GUARD', message: '写入接口不能通过刷新入口执行。' },
      endpoint,
    });
  }
  return startDomainSync(mapping.domain, {
    shopId: shop?.id || shop?.shopId || body.shopId,
    endpointKey: mapping.endpointKey,
    action: mapping.action,
    params: body,
    forceRefresh: options.forceRefresh === true,
    requestedBy: options.requestedBy || 'frontend-legacy-adapter',
  }, options);
}

export function requestOzonReadOnly(endpoint, shop, body = {}, options = {}) {
  return startLegacyEndpointRefresh(endpoint, shop, body, options);
}

export function requestOzonWrite(endpoint, shop, payload = {}, options = {}) {
  const mapping = mapLegacyOzonEndpoint(endpoint, options.method || 'POST');
  if (!mapping.ok) return Promise.resolve(mapping);
  if (mapping.access !== 'write') {
    return Promise.resolve({
      ok: false,
      error: {
        code: 'OZON_READ_ENDPOINT_CANNOT_WRITE',
        message: '只读 Ozon 接口不能通过写入入口执行。',
      },
      endpoint,
      endpointKey: mapping.endpointKey,
      domain: mapping.domain,
    });
  }

  const shopId = shop?.id || shop?.shopId || payload.shopId || payload.shop_id || '';
  const body = {
    shopId,
    endpointKey: mapping.endpointKey,
    action: mapping.action,
    payload: payload.payload || payload.params || payload,
    before: payload.before || null,
    after: payload.after || payload.payload || payload,
    idempotencyKey: payload.idempotencyKey || options.idempotencyKey,
    requestedBy: options.requestedBy || payload.requestedBy || 'frontend-legacy-write-adapter',
  };

  if ((options.confirm === true || options.confirmed === true) && options.previewId) {
    return confirmDomainWrite(mapping.domain, {
      ...body,
      previewId: options.previewId,
      confirm: true,
      realWrite: options.realWrite !== false,
      dryRun: options.dryRun === true,
      fastAck: options.fastAck === true,
      asyncWrite: options.asyncWrite === true,
      waitForResult: options.waitForResult !== false,
    }, options);
  }

  return previewDomainWrite(mapping.domain, body, options);
}
