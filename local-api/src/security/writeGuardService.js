import { randomUUID } from 'node:crypto';
import { createStableHash } from '../utils/stableHash.js';
import { createAuditLogService } from './auditLogService.js';

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}


function isRealWriteRequested(input = {}) {
  return input.realWrite === true && input.dryRun === false;
}

function evaluateRealWritePolicy(policy, { domain, input = {}, preview = {} } = {}) {
  if (!policy || !isRealWriteRequested(input)) {
    return { ok: true, writeStatus: 'dry_run_or_preview_only' };
  }

  const endpointKey = normalizeText(input.endpointKey || preview.endpointKey || preview.diff?.endpointKey);
  const shopId = normalizeText(input.shopId || input.shop_id || preview.shopId || preview.diff?.shopId);

  if (policy.enabled !== true) {
    return {
      ok: false,
      code: 'REAL_OZON_WRITE_DISABLED',
      writeStatus: 'blocked_real_write_disabled',
      message: '真实写入未开启，本次不会提交 Ozon。',
    };
  }

  if (!shopId) {
    return {
      ok: false,
      code: 'REAL_OZON_WRITE_SHOP_ID_REQUIRED',
      writeStatus: 'blocked_shop_missing',
      message: '店铺缺少真实写入配置，本次不会提交 Ozon。',
    };
  }

  return {
    ok: true,
    writeStatus: 'real_write_allowed',
    shopId,
    endpointKey: endpointKey || null,
  };
}

export function createWriteGuardService(db, options = {}) {
  const auditLogService = createAuditLogService(db);
  const executors = options.executors || {};
  const realWritePolicy = options.realWritePolicy || null;
  const previews = new Map();
  const previewTtlMs = Number.isSafeInteger(Number(options.previewTtlMs)) && Number(options.previewTtlMs) > 0
    ? Number(options.previewTtlMs)
    : 30 * 60 * 1000;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();

  function isExpired(preview, timestamp = now()) {
    return Number(preview?.expiresAtMs || 0) <= timestamp;
  }

  function cleanupExpiredPreviews(timestamp = now()) {
    let removed = 0;
    for (const [previewId, preview] of previews.entries()) {
      if (!isExpired(preview, timestamp)) continue;
      previews.delete(previewId);
      removed += 1;
    }
    return removed;
  }

  function ownerPreviewEntries(shopId) {
    cleanupExpiredPreviews();
    const ownerId = normalizeText(shopId);
    return [...previews.entries()].filter(([, preview]) => normalizeText(preview?.shopId) === ownerId);
  }

  return {
    countOwnerPreviews(shopId) {
      return ownerPreviewEntries(shopId).length;
    },

    cleanupExpiredPreviews() {
      return { ok: true, removed: cleanupExpiredPreviews() };
    },

    invalidateOwnerPreviews(shopId) {
      let removed = 0;
      for (const [previewId] of ownerPreviewEntries(shopId)) {
        previews.delete(previewId);
        removed += 1;
      }
      return { ok: true, removed };
    },

    previewWrite(domain, input = {}) {
      cleanupExpiredPreviews();
      const idempotencyKey = normalizeText(input.idempotencyKey);
      const shopId = normalizeText(input.shopId || input.shop_id);
      if (idempotencyKey) {
        const existing = [...previews.values()].find((preview) => (
          normalizeText(preview.domain) === normalizeText(domain)
          && normalizeText(preview.shopId) === shopId
          && normalizeText(preview.idempotencyKey) === idempotencyKey
        ));
        if (existing) {
          return {
            ok: true,
            previewId: existing.previewId,
            diffHash: existing.diffHash,
            auditId: existing.auditId,
            action: existing.action,
            endpointKey: existing.endpointKey,
            requiresConfirmation: true,
            writeConnected: false,
            expiresAt: existing.expiresAt,
            reused: true,
          };
        }
      }
      const previewId = `write_preview_${randomUUID()}`;
      const createdAtMs = now();
      const diff = {
        domain,
        accountId: input.accountId || input.account_id || null,
        endpointKey: input.endpointKey || null,
        action: input.action || 'unknown',
        shopId: input.shopId || input.shop_id || null,
        before: input.before || null,
        after: input.after || null,
      };
      const diffHash = createStableHash(diff, { length: 32 });
      const audit = auditLogService.record({
        domain,
        shopId: input.shopId || null,
        endpointKey: input.endpointKey || null,
        action: input.action || 'preview',
        status: 'preview',
        requestedBy: input.requestedBy || null,
        idempotencyKey: input.idempotencyKey || null,
        diffHash,
        payload: diff,
      });
      previews.set(previewId, {
        previewId,
        domain,
        accountId: input.accountId || input.account_id || null,
        shopId: input.shopId || input.shop_id || null,
        endpointKey: input.endpointKey || null,
        action: input.action || 'unknown',
        payload: input.payload || input.after || null,
        requestedBy: input.requestedBy || null,
        idempotencyKey: idempotencyKey || null,
        diff,
        diffHash,
        auditId: audit.id,
        createdAt: new Date(createdAtMs).toISOString(),
        expiresAt: new Date(createdAtMs + previewTtlMs).toISOString(),
        expiresAtMs: createdAtMs + previewTtlMs,
      });
      return {
        ok: true,
        previewId,
        diffHash,
        auditId: audit.id,
        action: input.action || 'unknown',
        endpointKey: input.endpointKey || null,
        requiresConfirmation: true,
        writeConnected: false,
        expiresAt: new Date(createdAtMs + previewTtlMs).toISOString(),
      };
    },

    releasePreview(domain, input = {}) {
      cleanupExpiredPreviews();
      const previewIds = [...new Set([
        ...(Array.isArray(input.previewIds) ? input.previewIds : []),
        input.previewId,
      ].map(normalizeText).filter(Boolean))];
      const existing = previewIds
        .map((previewId) => [previewId, previews.get(previewId)])
        .filter(([, preview]) => Boolean(preview));
      if (!existing.length) {
        return { ok: true, released: false, releasedCount: 0, previewId: normalizeText(input.previewId), previewIds };
      }
      const requestedShopId = normalizeText(input.shopId || input.shop_id);
      if (existing.some(([, preview]) => normalizeText(domain) !== normalizeText(preview.domain))) {
        return {
          ok: false,
          released: false,
          releasedCount: 0,
          previewIds,
          error: { code: 'WRITE_PREVIEW_DOMAIN_MISMATCH', message: '写入预览所属业务不匹配。' },
        };
      }
      if (requestedShopId && existing.some(([, preview]) => {
        const previewShopId = normalizeText(preview.shopId);
        return previewShopId && requestedShopId !== previewShopId;
      })) {
        return {
          ok: false,
          released: false,
          releasedCount: 0,
          previewIds,
          error: { code: 'WRITE_PREVIEW_OWNER_MISMATCH', message: '写入预览所属店铺不匹配。' },
        };
      }
      existing.forEach(([previewId]) => previews.delete(previewId));
      return {
        ok: true,
        released: existing.length > 0,
        releasedCount: existing.length,
        previewId: normalizeText(input.previewId),
        previewIds,
      };
    },

    confirmWrite(domain, input = {}) {
      const candidate = previews.get(input.previewId);
      if (candidate && isExpired(candidate)) {
        previews.delete(input.previewId);
        return {
          ok: false,
          error: {
            code: 'WRITE_PREVIEW_EXPIRED',
            message: '写入预览已过期，请重新生成后再确认。',
          },
        };
      }
      cleanupExpiredPreviews();
      const preview = previews.get(input.previewId);
      if (!preview || input.confirm !== true) {
        return {
          ok: false,
          error: {
            code: 'WRITE_CONFIRMATION_REQUIRED',
            message: 'Write confirmation requires a valid previewId and confirm=true.',
          },
        };
      }
      const policyResult = evaluateRealWritePolicy(realWritePolicy, { domain, input, preview });
      if (!policyResult.ok) {
        const audit = auditLogService.record({
          domain,
          shopId: input.shopId || preview.shopId || null,
          endpointKey: input.endpointKey || preview.diff.endpointKey,
          action: input.action || preview.diff.action,
          status: 'rejected',
          requestedBy: input.requestedBy || null,
          idempotencyKey: input.idempotencyKey || null,
          diffHash: preview.diffHash,
          payload: { preview: preview.diff, policy: policyResult },
          confirmedAt: new Date().toISOString(),
        });
        return {
          ok: false,
          confirmed: true,
          blocked: true,
          auditId: audit.id,
          previewId: input.previewId,
          writeConnected: false,
          writeStatus: policyResult.writeStatus,
          error: {
            code: policyResult.code,
            message: policyResult.message,
          },
        };
      }
      const audit = auditLogService.record({
        domain,
        shopId: input.shopId || null,
        endpointKey: input.endpointKey || preview.diff.endpointKey,
        action: input.action || preview.diff.action,
        status: 'confirmed',
        requestedBy: input.requestedBy || null,
        idempotencyKey: input.idempotencyKey || null,
        diffHash: preview.diffHash,
        payload: preview.diff,
        confirmedAt: new Date().toISOString(),
      });
      const executor = executors[domain];
      const blocked = {
        ok: false,
        confirmed: true,
        auditId: audit.id,
        previewId: input.previewId,
        writeConnected: false,
        error: {
          code: 'WRITE_EXECUTION_NOT_CONNECTED',
          message: 'Write confirmation was recorded, but real Ozon write execution is not connected in this foundation stage.',
        },
        writeQueue: {
          priority: 'WRITE',
          requiredFlow: ['preview', 'confirm', 'write_queue', 'ozonClient.requestWrite', 'read_back', 'audit'],
          connected: false,
        },
      };
      if (!executor) return blocked;

      const recordExecutionAudit = (result) => {
        const executionAuditStatus = result?.accepted || result?.pending ? 'confirmed' : result?.ok ? 'executed' : 'failed';
        return auditLogService.record({
          domain,
          shopId: input.shopId || preview.shopId || null,
          endpointKey: input.endpointKey || preview.endpointKey || preview.diff.endpointKey,
          action: input.action || preview.action || preview.diff.action,
          status: executionAuditStatus,
          requestedBy: input.requestedBy || preview.requestedBy || null,
          idempotencyKey: input.idempotencyKey || preview.idempotencyKey || null,
          diffHash: preview.diffHash,
          payload: { preview: preview.diff, result },
          confirmedAt: new Date().toISOString(),
        });
      };

      return Promise.resolve(executor({ preview, input, audit, recordAsyncResult: recordExecutionAudit }))
        .then((result) => {
          recordExecutionAudit(result);
          return {
            ...result,
            confirmed: true,
            auditId: audit.id,
            previewId: input.previewId,
          };
        })
        .catch((error) => {
          const payload = { preview: preview.diff, error: error instanceof Error ? error.message : String(error) };
          auditLogService.record({
            domain,
            shopId: input.shopId || preview.shopId || null,
            endpointKey: input.endpointKey || preview.endpointKey || preview.diff.endpointKey,
            action: input.action || preview.action || preview.diff.action,
            status: 'failed',
            requestedBy: input.requestedBy || preview.requestedBy || null,
            idempotencyKey: input.idempotencyKey || preview.idempotencyKey || null,
            diffHash: preview.diffHash,
            payload,
            confirmedAt: new Date().toISOString(),
          });
          return {
            ...blocked,
            auditId: audit.id,
            error: {
              code: 'WRITE_EXECUTOR_FAILED',
              message: error instanceof Error ? error.message : String(error),
            },
          };
        });
    },
  };
}
