import { assertCrossBorderWriteEndpoint } from '../../cross-border/crossBorderEndpointRegistry.js';
import { createCrossBorderAccountRepository } from '../../db/repositories/crossBorderAccountRepository.js';
import { resolveCrossBorderAccountShop } from './crossBorderAccountScope.js';

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function hasCrossBorderAccountsTable(db) {
  try {
    return Boolean(db?.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cross_border_accounts'").get());
  } catch {
    return false;
  }
}

function normalizeWriteInput(input = {}) {
  const endpointKey = normalizeText(input.endpointKey ?? input.endpoint_key);
  if (!endpointKey) {
    const error = new Error('endpointKey is required for cross-border write guard.');
    error.code = 'CROSS_BORDER_WRITE_ENDPOINT_REQUIRED';
    throw error;
  }
  const endpoint = assertCrossBorderWriteEndpoint(endpointKey);
  return {
    endpoint,
    endpointKey: endpoint.key,
    action: normalizeText(input.action) || endpoint.key,
    accountId: normalizeText(input.accountId ?? input.account_id),
    shopId: normalizeText(input.shopId ?? input.shop_id),
    requestedBy: normalizeText(input.requestedBy ?? input.requested_by) || 'cross-border-write-guard',
    idempotencyKey: normalizeText(input.idempotencyKey ?? input.idempotency_key),
    before: input.before ?? null,
    after: input.after ?? input.body ?? input.payload ?? null,
    payload: input.payload ?? input.body ?? input.after ?? null,
  };
}

export function executeCrossBorderConfirmedWrite({ preview, input = {} } = {}) {
  const endpointKey = normalizeText(input.endpointKey || preview?.endpointKey || preview?.diff?.endpointKey);
  const endpoint = assertCrossBorderWriteEndpoint(endpointKey);
  return {
    ok: false,
    confirmed: true,
    endpointKey: endpoint.key,
    action: normalizeText(input.action || preview?.action || preview?.diff?.action) || endpoint.key,
    writeConnected: false,
    error: {
      code: 'CROSS_BORDER_WRITE_NOT_CONNECTED',
      message: '跨境巴士写入安全门 P0 只记录预览和确认，不执行真实创建/更新/废弃请求。',
    },
    writeQueue: {
      priority: 'WRITE',
      requiredFlow: ['preview', 'confirm', 'crossBorderClient.requestWrite', 'read_back', 'audit'],
      connected: false,
    },
  };
}

export function createCrossBorderConfirmedWriteExecutor({ db, crossBorderClient, profileId, tenantId, userId } = {}) {
  const accountRepository = db && hasCrossBorderAccountsTable(db)
    ? createCrossBorderAccountRepository(db, { profileId, tenantId, userId })
    : null;

  return async function executeConnectedCrossBorderWrite({ preview, input = {} } = {}) {
    const endpointKey = normalizeText(input.endpointKey || preview?.endpointKey || preview?.diff?.endpointKey);
    const endpoint = assertCrossBorderWriteEndpoint(endpointKey);
    const accountId = normalizeText(input.accountId ?? input.account_id ?? preview?.accountId ?? preview?.account_id);
    const requestedShopId = normalizeText(input.shopId ?? input.shop_id ?? preview?.shopId ?? preview?.shop_id);
    const payload = input.payload ?? input.body ?? input.after ?? preview?.payload ?? preview?.diff?.after ?? null;

    if (!accountRepository) {
      const error = new Error('跨境巴士账号表未连接，不能执行真实写入。');
      error.code = 'CROSS_BORDER_ACCOUNTS_NOT_CONNECTED';
      throw error;
    }
    if (!crossBorderClient?.requestWrite) {
      return executeCrossBorderConfirmedWrite({ preview, input });
    }
    if (!accountId) {
      const error = new Error('缺少跨境巴士账号 ID，不能执行真实写入。');
      error.code = 'CROSS_BORDER_ACCOUNT_ID_REQUIRED';
      throw error;
    }

    const credentials = accountRepository.getCredentialsForInternalUse(accountId);
    if (!credentials) {
      const error = new Error('跨境巴士授权账号不存在。');
      error.code = 'CROSS_BORDER_ACCOUNT_NOT_FOUND';
      throw error;
    }
    const accountScope = resolveCrossBorderAccountShop(credentials, requestedShopId, { requireShop: true });
    const effectiveShopId = accountScope.shopId;
    const previewAccountId = normalizeText(preview?.accountId ?? preview?.account_id);
    const previewShopId = normalizeText(preview?.shopId ?? preview?.shop_id);
    if ((previewAccountId && previewAccountId !== accountId) || (previewShopId && previewShopId !== effectiveShopId)) {
      const error = new Error('跨境巴士写入确认与预览的账号/店铺范围不一致。');
      error.code = 'CROSS_BORDER_WRITE_SCOPE_MISMATCH';
      throw error;
    }

    const result = await crossBorderClient.requestWrite({
      endpointKey: endpoint.key,
      credentials,
      body: payload || {},
      timeoutMs: input.timeoutMs,
    });

    return {
      ok: true,
      confirmed: true,
      endpointKey: endpoint.key,
      action: normalizeText(input.action || preview?.action || preview?.diff?.action) || endpoint.key,
      accountId,
      shopId: effectiveShopId,
      writeConnected: true,
      data: result.data,
      writeQueue: {
        priority: 'WRITE',
        requiredFlow: ['preview', 'confirm', 'crossBorderClient.requestWrite', 'read_back', 'audit'],
        connected: true,
      },
    };
  };
}

export function createCrossBorderWriteGuardService({ writeGuardService, writeConnected = false } = {}) {
  function ensureGuard() {
    if (!writeGuardService?.previewWrite || !writeGuardService?.confirmWrite) {
      const error = new Error('cross-border write guard is not connected.');
      error.code = 'CROSS_BORDER_WRITE_GUARD_NOT_CONNECTED';
      throw error;
    }
    return writeGuardService;
  }

  function previewWrite(input = {}) {
    const normalized = normalizeWriteInput(input);
    const preview = ensureGuard().previewWrite('cross-border', {
      accountId: normalized.accountId,
      endpointKey: normalized.endpointKey,
      action: normalized.action,
      shopId: normalized.shopId || null,
      before: normalized.before,
      after: normalized.after,
      payload: normalized.payload,
      requestedBy: normalized.requestedBy,
      idempotencyKey: normalized.idempotencyKey,
    });
    return {
      ...preview,
      endpoint: {
        key: normalized.endpoint.key,
        method: normalized.endpoint.method,
        path: normalized.endpoint.path,
        risk: normalized.endpoint.risk,
        description: normalized.endpoint.description,
      },
      domain: 'cross-border',
      writeConnected,
    };
  }

  function confirmWrite(input = {}) {
    const endpointKey = normalizeText(input.endpointKey ?? input.endpoint_key);
    if (endpointKey) assertCrossBorderWriteEndpoint(endpointKey);
    return ensureGuard().confirmWrite('cross-border', input);
  }

  return { domain: 'cross-border-write', previewWrite, confirmWrite };
}
