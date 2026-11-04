import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const PATROL_PRODUCT_PAGE_SIZE = 1000;
const COMPLAINT_ROUTE = Object.freeze(['创建申请', '商品和价格', '质量监督', '卖家使用我的内容']);
const SCHEME1_BACKEND_ROUTE = Object.freeze(['Ozon 卖家后台', '支持', '创建申请', '商品和价格', '质量监督', '卖家使用我的内容']);
const PREPARABLE_STATUSES = new Set([
  'detected',
  'still_followed',
  'prepare_failed',
  'submission_failed',
  'submission_rejected',
]);
const VERIFIABLE_STATUSES = new Set([
  'verification_ready',
  'still_followed',
  'verification_failed',
]);
const STANDALONE_RECHECK_BLOCKED_STATUSES = new Set(['clear', 'detached']);

function isStandaloneRecheck(mode) {
  return text(mode) === 'standalone';
}

function text(value) {
  return String(value ?? '').trim();
}

function rows(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  return [value];
}

function firstPresent(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '') ?? null;
}

function error(code, message, statusCode = 400, details = null) {
  const failure = new Error(message);
  failure.code = code;
  failure.statusCode = statusCode;
  if (details !== null) failure.details = details;
  return failure;
}

function scheme1Continuation(item = {}, evidence = {}) {
  const previous = item.writeResult && typeof item.writeResult === 'object' ? item.writeResult : {};
  let diagnostic = {};
  const materialDirectory = text(evidence.materialDirectory);
  if (materialDirectory) {
    try {
      diagnostic = JSON.parse(readFileSync(path.resolve(materialDirectory, 'scheme1-backend-diagnostic.json'), 'utf8'));
    } catch {
      diagnostic = {};
    }
  }
  const pageUrl = text(firstPresent(previous.pageUrl, previous.page_url, diagnostic.pageUrl));
  const ticketId = text(firstPresent(
    previous.ticketId,
    previous.ticket_id,
    previous.chatId,
    previous.chat_id,
	item.ozonJobId,
    diagnostic?.state?.ticketId,
  ));
  const phase = text(firstPresent(previous.phase, previous.resumePhase, diagnostic?.state?.phase));
  let trustedPageUrl = '';
  try {
    const parsed = new URL(pageUrl);
    if (parsed.protocol === 'https:'
      && parsed.hostname.toLowerCase() === 'seller.ozon.ru'
      && parsed.pathname.startsWith('/app/messenger')) {
      trustedPageUrl = parsed.toString();
    }
  } catch {
    trustedPageUrl = '';
  }
  return {
    requested: true,
    available: Boolean(ticketId && trustedPageUrl),
    ticketId,
    pageUrl: trustedPageUrl,
    phase,
    previousSubmissionStarted: previous.submissionStarted === true
      || previous?.retryFailure?.submissionStarted === true
      || diagnostic?.submissionStarted === true
      || diagnostic?.state?.submissionStarted === true,
  };
}

function normalizeCaptureResult(result = {}) {
  const countValue = firstPresent(
    result.followSellerCount,
    result.follow_seller_count,
    result.followCount,
    result.follow_info?.count,
  );
  const count = Number(countValue);
  // “已确认”标记不能替代真实数量。缺少 count 时必须失败关闭，
  // 否则一个残缺浏览器结果会被静默记成 0 个跟卖。
  const confirmed = countValue !== null && Number.isFinite(count) && count >= 0;
  const sellers = Array.isArray(result.followSellers)
    ? result.followSellers
    : Array.isArray(result.follow_info?.sellers)
      ? result.follow_info.sellers
      : [];
  const observedAt = text(firstPresent(result.capturedAt, result.observedAt)) || new Date().toISOString();
  const sourceProductUrl = normalizeOzonLink(firstPresent(result.sourceProductUrl, result.productUrl));
  const offersRoute = text(result.offersRoute);
  const captureSource = text(result.captureSource || result.source) || 'ozon-public-product-page';
  const sourceDigest = createHash('sha256').update(JSON.stringify({
    sku: text(firstPresent(result.sku, result.skuId, result.id)),
    count: confirmed ? Math.max(0, Math.floor(count)) : null,
    sellers,
    observedAt,
    sourceProductUrl,
    offersRoute,
    captureSource,
  }), 'utf8').digest('hex');
  return {
    sku: text(firstPresent(result.sku, result.skuId, result.id)),
    confirmed,
    count: confirmed ? Math.max(0, Number.isFinite(count) ? Math.floor(count) : 0) : null,
    minPrice: Number.isFinite(Number(result.followMinPrice)) ? Number(result.followMinPrice) : null,
    maxPrice: Number.isFinite(Number(result.followMaxPrice)) ? Number(result.followMaxPrice) : null,
    sellers,
    observedAt,
    sourceProductUrl,
    offersRoute,
    captureSource,
    sourceDigest,
    errorCode: text(result.errorCode || result.error?.code),
    errorMessage: text(result.errorMessage || result.error?.message),
  };
}

function followerSku(seller = {}) {
  const value = text(firstPresent(seller.sku, seller.productSku, seller.product_id, seller.productId));
  return /^\d{5,20}$/u.test(value) ? value : '';
}

function normalizeOzonLink(value) {
  const raw = text(value);
  if (!raw) return '';
  if (raw.startsWith('/')) return `https://www.ozon.ru${raw}`;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && /(^|\.)ozon\.ru$/iu.test(url.hostname) ? url.toString() : '';
  } catch {
    return '';
  }
}

function complaintSellers(sellers = []) {
  const bySku = new Map();
  for (const source of rows(sellers)) {
    const sku = followerSku(source);
    if (!sku) continue;
    bySku.set(sku, {
      sku,
      sellerId: text(firstPresent(source.id, source.sellerId, source.seller_id)),
      sellerName: text(firstPresent(source.name, source.sellerName, source.seller_name)),
      sellerLink: normalizeOzonLink(source.link),
      productLink: normalizeOzonLink(firstPresent(source.productLink, source.product_link)),
      price: Number.isFinite(Number(source.price)) ? Number(source.price) : null,
      credentials: rows(source.credentials).map(text).filter(Boolean).slice(0, 8),
      coverImage: text(firstPresent(source.coverImage, source.cover_image)),
      observedAt: text(source.observedAt),
      sourceProductUrl: normalizeOzonLink(source.sourceProductUrl),
      offersRoute: text(source.offersRoute),
      captureSource: text(source.captureSource),
      sourceDigest: text(source.sourceDigest),
    });
  }
  return [...bySku.values()];
}

function complaintPreview(item) {
  const sellers = complaintSellers(item.sellers);
  if (!sellers.length) {
    throw error(
      'FOLLOW_SELLER_TARGET_SKU_MISSING',
      `商品 ${item.offerId} 的巡查结果没有保存跟卖商品 SKU，请重新巡查后再生成投诉预览。`,
      409,
    );
  }
  const followerSkus = sellers.map((seller) => seller.sku);
  const seed = [item.shopId, item.sku, ...followerSkus].join('|');
  const previewId = `complaint_${createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, 24)}`;
  const draft = {
    version: 1,
    workflow: 'ozon-support-content-complaint',
    route: [...COMPLAINT_ROUTE],
    originalSku: item.sku,
    followerSkus,
    sellers,
    sourceProduct: {
      offerId: item.offerId,
      productId: item.productId,
      productName: item.productName,
      imageUrl: item.imageUrl,
    },
    evidence: {
      layeredSourceRequired: true,
      files: [],
      status: 'missing',
    },
    submissionReady: false,
    blockedReason: '请补充能证明原创关系的分层源文件或原始设计文件。',
  };
  return { previewId, draft };
}

export function createFollowSellerDefenseService({
  repository,
  complaintSubmitter,
  evidenceBundleService,
  quickComplaintService,
} = {}) {
  if (!repository) throw new Error('FOLLOW_SELLER_SERVICE_REPOSITORY_REQUIRED');

  function resolve({ shopId, identifier } = {}) {
    const normalizedShopId = text(shopId);
    const normalizedIdentifier = text(identifier);
    if (!normalizedShopId) throw error('FOLLOW_SELLER_SHOP_ID_REQUIRED', '请选择 Ozon 店铺。');
    if (!normalizedIdentifier) throw error('FOLLOW_SELLER_IDENTIFIER_REQUIRED', '请输入货号、Ozon SKU 或商品 ID。');
    const product = repository.listProductCandidates({
      shopId: normalizedShopId,
      identifier: normalizedIdentifier,
      limit: 10,
      sellableOnly: false,
    })[0];
    if (!product) {
      throw error('FOLLOW_SELLER_PRODUCT_NOT_FOUND', '本地商品缓存没有找到这个货号，请先同步商品列表。', 404);
    }
    const patrol = repository.createPatrol({ shopId: normalizedShopId, mode: 'manual', totalCount: 1 });
    const createdCase = repository.createCase({
      shopId: normalizedShopId,
      patrolRunId: patrol.id,
      inputIdentifier: normalizedIdentifier,
      product,
    });
    return {
      ok: true,
      patrol,
      cases: [createdCase],
      captureTargets: [{ caseId: createdCase.id, sku: createdCase.sku }],
    };
  }

  function patrolTaskPayload(patrol, { resumed = false, retry = false } = {}) {
    const cases = repository.listCaptureCases({ patrolRunId: patrol.id });
    return {
      ok: true,
      resumed,
      retry,
      patrol,
      cases,
      captureTargets: cases
        .filter((item) => item.status === 'pending_capture')
        .map((item) => ({ caseId: item.id, sku: item.sku })),
    };
  }

  function listAllPatrolProducts(shopId) {
    const bySku = new Map();
    let offset = 0;
    while (true) {
      const page = repository.listProductCandidates({
        shopId,
        limit: PATROL_PRODUCT_PAGE_SIZE,
        offset,
        sellableOnly: true,
      });
      for (const product of page) {
        const sku = text(product?.sku);
        if (sku && !bySku.has(sku)) bySku.set(sku, product);
      }
      offset += page.length;
      if (page.length < PATROL_PRODUCT_PAGE_SIZE) break;
    }
    return [...bySku.values()];
  }

  function startPatrol({ shopId } = {}) {
    const normalizedShopId = text(shopId);
    if (!normalizedShopId) throw error('FOLLOW_SELLER_SHOP_ID_REQUIRED', '请选择 Ozon 店铺。');
    const resumablePatrol = repository.listPatrols({ shopId: normalizedShopId, limit: 10 })
      .find((item) => (
        item.mode === 'shop'
        && item.status === 'running'
        && ['awaiting_capture', 'capture_running'].includes(item.stage)
      ));
    if (resumablePatrol) {
      const pending = repository.getPatrolCaptureCounts(resumablePatrol.id).pendingCount;
      if (pending > 0) return patrolTaskPayload(resumablePatrol, { resumed: true });
    }
    const products = listAllPatrolProducts(normalizedShopId);
    if (!products.length) {
      throw error('FOLLOW_SELLER_PATROL_PRODUCTS_EMPTY', '当前店铺没有可巡查商品，请先同步商品列表。', 404);
    }
    const patrol = repository.createPatrol({ shopId: normalizedShopId, mode: 'shop', totalCount: products.length });
    repository.createCases({
      shopId: normalizedShopId,
      patrolRunId: patrol.id,
      products,
    });
    return patrolTaskPayload(patrol);
  }

  function recordCapture({ patrolRunId, results = [], final = true } = {}) {
    const patrol = repository.getPatrol(patrolRunId);
    if (!patrol) throw error('FOLLOW_SELLER_PATROL_NOT_FOUND', '巡查任务不存在。', 404);
    const cases = repository.listCases({ patrolRunId: patrol.id, status: 'pending_capture', limit: 20_000 });
    const bySku = new Map(rows(results).map(normalizeCaptureResult).filter((item) => item.sku).map((item) => [item.sku, item]));
    const updates = [];
    const attempts = [];
    for (const item of cases) {
      const capture = bySku.get(item.sku);
      if (!capture) {
        if (!final) continue;
        updates.push({
          id: item.id,
          current: item,
          patch: {
            status: 'capture_failed',
            stage: 'capture_failed',
            lastErrorCode: 'FOLLOW_SELLER_CAPTURE_MISSING',
            lastErrorMessage: '未取得这个 SKU 的跟卖结果。',
            retryCount: item.retryCount + 1,
          },
        });
        attempts.push({ caseId: item.id, shopId: item.shopId, action: 'capture', status: 'failed', detail: {} });
        continue;
      }
      if (!capture.confirmed) {
        updates.push({
          id: item.id,
          current: item,
          patch: {
            status: 'capture_failed',
            stage: 'capture_failed',
            lastErrorCode: capture.errorCode || 'FOLLOW_SELLER_CAPTURE_UNCONFIRMED',
            lastErrorMessage: capture.errorMessage || '跟卖结果缺少真实数量。',
            retryCount: item.retryCount + 1,
          },
        });
        attempts.push({ caseId: item.id, shopId: item.shopId, action: 'capture', status: 'failed', detail: capture });
        continue;
      }
      const detected = capture.count > 0;
      updates.push({
        id: item.id,
        current: item,
        patch: {
          status: detected ? 'detected' : 'clear',
          stage: detected ? 'ready_for_preview' : 'completed',
          followCountBefore: capture.count,
          followMinPrice: capture.minPrice,
          followMaxPrice: capture.maxPrice,
          sellers: capture.sellers.map((seller) => ({
            ...seller,
            observedAt: capture.observedAt,
            sourceProductUrl: capture.sourceProductUrl,
            offersRoute: capture.offersRoute,
            captureSource: capture.captureSource,
            sourceDigest: capture.sourceDigest,
          })),
          lastErrorCode: '',
          lastErrorMessage: '',
          completedAt: detected ? null : new Date().toISOString(),
        },
      });
      attempts.push({ caseId: item.id, shopId: item.shopId, action: 'capture', status: detected ? 'detected' : 'clear', detail: capture });
    }
    const updatedCases = repository.updateCases(updates);
    repository.recordAttempts(attempts);
    const counts = repository.getPatrolCaptureCounts(patrol.id);
    const finishedAt = final ? new Date().toISOString() : null;
    const updatedPatrol = repository.updatePatrol(patrol.id, {
      status: final ? (counts.failedCount > 0 ? 'partial' : 'completed') : 'running',
      stage: final ? 'capture_completed' : 'capture_running',
      scannedCount: counts.scannedCount,
      followedCount: counts.followedCount,
      clearCount: counts.clearCount,
      failedCount: counts.failedCount,
      finishedAt,
    });
    return {
      ok: true,
      final: final === true,
      patrol: updatedPatrol,
      cases: updatedCases,
      updatedCases,
      pendingCount: counts.pendingCount,
    };
  }

  function retryCapture({ shopId, patrolRunId = '', caseIds = [] } = {}) {
    const normalizedShopId = text(shopId);
    if (!normalizedShopId) throw error('FOLLOW_SELLER_SHOP_ID_REQUIRED', '请选择 Ozon 店铺。');
    const normalizedCaseIds = [...new Set((Array.isArray(caseIds) ? caseIds : [caseIds])
      .map(text)
      .filter(Boolean))];
    const selectedCases = normalizedCaseIds.length ? repository.getCasesByIds(normalizedCaseIds) : [];
    if (normalizedCaseIds.length && (
      selectedCases.length !== normalizedCaseIds.length
      || selectedCases.some((item) => item.shopId !== normalizedShopId || item.status !== 'capture_failed')
    )) {
      throw error('FOLLOW_SELLER_CAPTURE_RETRY_SELECTION_INVALID', '所选项中包含其他店铺或已经不是巡查失败的商品。');
    }
    const selectedPatrolIds = [...new Set(selectedCases.map((item) => item.patrolRunId).filter(Boolean))];
    if (selectedPatrolIds.length > 1) {
      throw error('FOLLOW_SELLER_CAPTURE_RETRY_PATROL_MIXED', '请选择同一次巡查任务中的失败项。');
    }
    const selectedPatrolId = selectedPatrolIds[0] || '';
    if (text(patrolRunId) && selectedPatrolId && text(patrolRunId) !== selectedPatrolId) {
      throw error('FOLLOW_SELLER_CAPTURE_RETRY_PATROL_MISMATCH', '所选失败项不属于当前巡查任务。');
    }
    const requestedPatrol = text(patrolRunId || selectedPatrolId)
      ? repository.getPatrol(text(patrolRunId || selectedPatrolId))
      : repository.listPatrols({ shopId: normalizedShopId, limit: 100 })
        .find((item) => item.failedCount > 0);
    if (!requestedPatrol || requestedPatrol.shopId !== normalizedShopId) {
      throw error('FOLLOW_SELLER_CAPTURE_RETRY_EMPTY', '当前店铺没有可重试的巡查失败项。', 404);
    }
    const failedCases = selectedCases.length
      ? selectedCases
      : repository.listCases({
        patrolRunId: requestedPatrol.id,
        status: 'capture_failed',
        limit: 20_000,
      });
    if (!failedCases.length) {
      throw error('FOLLOW_SELLER_CAPTURE_RETRY_EMPTY', '当前任务没有可重试的巡查失败项。', 404);
    }
    repository.updateCases(failedCases.map((item) => ({
      id: item.id,
      current: item,
      patch: {
        status: 'pending_capture',
        stage: 'awaiting_capture',
        followCountBefore: null,
        followCountAfter: null,
        followMinPrice: null,
        followMaxPrice: null,
        sellers: [],
        lastErrorCode: '',
        lastErrorMessage: '',
        completedAt: null,
      },
    })));
    const counts = repository.getPatrolCaptureCounts(requestedPatrol.id);
    const patrol = repository.updatePatrol(requestedPatrol.id, {
      status: 'running',
      stage: 'awaiting_capture',
      scannedCount: counts.scannedCount,
      followedCount: counts.followedCount,
      clearCount: counts.clearCount,
      failedCount: counts.failedCount,
      lastErrorCode: '',
      lastErrorMessage: '',
      finishedAt: '',
    });
    return patrolTaskPayload(patrol, { resumed: true, retry: true });
  }

  async function prepare({ caseIds = [] } = {}, context = {}) {
    const cases = repository.getCasesByIds(caseIds);
    if (!cases.length) throw error('FOLLOW_SELLER_CASE_REQUIRED', '请选择需要处理的跟卖商品。');
    const previews = [];
    for (const item of cases) {
      try {
        if (!PREPARABLE_STATUSES.has(item.status)) {
          throw error('FOLLOW_SELLER_CASE_NOT_PREPARABLE', `商品 ${item.offerId} 当前状态不能生成处理预览。`, 409);
        }
        const prepared = complaintPreview(item);
        if (evidenceBundleService?.prepare) {
          const bundle = await evidenceBundleService.prepare({
            caseRecord: item,
            complaintDraft: prepared.draft,
          }, context);
          prepared.draft.evidence = {
            layeredSourceRequired: true,
            ...bundle,
            status: 'ready',
          };
          prepared.draft.submissionReady = bundle.browserEvidenceReady === true;
          prepared.draft.blockedReason = bundle.browserEvidenceReady === true
            ? ''
            : '提交前需自动采集我方商品页、跟卖商品页、后台商品列表和真实上架日期。';
        }
        const updated = repository.updateCase(item.id, {
          status: 'preview_ready',
          stage: 'awaiting_confirmation',
          modelBefore: '',
          modelAfter: '',
          groupOfferIds: prepared.draft.followerSkus,
          writePayload: prepared.draft,
          writeResult: null,
          previewId: prepared.previewId,
          lastErrorCode: '',
          lastErrorMessage: '',
        });
        const preview = {
          ok: true,
          previewId: prepared.previewId,
          workflow: prepared.draft.workflow,
          route: prepared.draft.route,
          originalSku: prepared.draft.originalSku,
          followerSkus: prepared.draft.followerSkus,
          sellers: prepared.draft.sellers,
          evidence: prepared.draft.evidence,
          submissionReady: prepared.draft.submissionReady,
          blockedReason: prepared.draft.blockedReason,
        };
        const evidenceMode = text(prepared.draft.evidence?.reuse?.mode);
        repository.recordAttempt({
          caseId: item.id,
          shopId: item.shopId,
          action: 'complaint_preview',
          status: evidenceMode === 'reused' ? 'reused' : evidenceMode === 'updated' ? 'updated' : 'ready',
          detail: preview,
        });
        previews.push({ case: updated, preview });
      } catch (failure) {
        repository.updateCase(item.id, {
          status: 'prepare_failed',
          stage: 'prepare_failed',
          lastErrorCode: text(failure?.code) || 'FOLLOW_SELLER_PREPARE_FAILED',
          lastErrorMessage: failure?.message || String(failure),
          retryCount: item.retryCount + 1,
        });
        repository.recordAttempt({ caseId: item.id, shopId: item.shopId, action: 'complaint_preview', status: 'failed', detail: { code: failure?.code, message: failure?.message } });
      }
    }
    return { ok: previews.length > 0, previews, cases: repository.getCasesByIds(caseIds) };
  }

  async function prepareQuick({ caseIds = [], resumeExisting = false } = {}, context = {}) {
    const cases = repository.getCasesByIds(caseIds);
    if (!cases.length) throw error('FOLLOW_SELLER_CASE_REQUIRED', '请选择需要后台提交的跟卖商品。');
    if (!quickComplaintService?.prepare || !quickComplaintService?.validate) {
      throw error('FOLLOW_SELLER_SCHEME1_SERVICE_UNAVAILABLE', '方案1后台材料服务未启动。', 503);
    }
    const submissions = [];
    const failed = [];
    const queue = [...cases];
    const worker = async () => {
      while (queue.length) {
        const item = queue.shift();
        try {
          const recoversMissingContinuation = item.status === 'prepare_failed'
            && text(item.lastErrorCode) === 'FOLLOW_SELLER_SCHEME1_CONTINUATION_NOT_FOUND';
          const hasPreparedScheme1Flow = (
            ['submission_ready', 'submission_failed'].includes(item.status)
              || recoversMissingContinuation
          ) && text(item.writePayload?.workflow) === 'ozon-seller-backend-content-complaint-v2';
          if (resumeExisting === true && hasPreparedScheme1Flow) {
            const draft = item.writePayload;
            const evidence = draft.evidence || {};
            await quickComplaintService.validate(evidence, { caseRecord: item }, context);
            const savedContinuation = scheme1Continuation(item, evidence);
            if (!savedContinuation.available
              && savedContinuation.previousSubmissionStarted) {
              throw error('FOLLOW_SELLER_SCHEME1_CONTINUATION_NOT_FOUND', '上次已经开始发送，但没有找到准确的原工单，系统已停止以避免重复投诉。', 409);
            }
            const continuation = savedContinuation.available
              ? savedContinuation
              : { requested: false, available: false, previousSubmissionStarted: false };
            const resetUnsentFailure = !continuation.requested && Boolean(item.writeResult);
            const reusableCase = item.status === 'submission_ready' && !resetUnsentFailure
              ? item
              : repository.updateCase(item.id, {
                  status: 'submission_ready',
                  stage: continuation.requested ? 'waiting_seller_backend_continuation' : 'waiting_seller_backend_submission',
                  writeResult: continuation.requested ? item.writeResult : null,
                  lastErrorCode: '',
                  lastErrorMessage: '',
                });
            submissions.push({
              case: reusableCase,
              submission: {
                scheme: 'scheme1-seller-backend',
                caseId: item.id,
                shopId: item.shopId,
                previewId: item.previewId,
                evidenceId: evidence.evidenceId,
                manifestPath: evidence.manifestPath,
                materialDirectory: evidence.materialDirectory,
                sourceProductUrl: evidence.sourceProductUrl,
                files: evidence.files,
                speech: evidence.speech,
                followers: evidence.followers,
                evidenceFollowers: evidence.evidenceFollowers,
                route: draft.route,
                originalSku: draft.originalSku,
                offerId: draft.sourceProduct?.offerId,
                followerSkus: draft.followerSkus,
                sellers: draft.sellers,
                reusePreparedEvidence: true,
                continuation,
              },
            });
            repository.recordAttempt({
              caseId: item.id,
              shopId: item.shopId,
              action: 'scheme1_backend_ready',
              status: continuation.requested
                ? 'continuing_existing_ticket'
                : item.status === 'submission_ready' ? 'resumed_existing_material' : 'reused_unsent_material',
              detail: {
                evidenceId: evidence.evidenceId,
                continuation: continuation.requested ? continuation : undefined,
              },
            });
            continue;
          }
          const legacyScheme1Ready = item.status === 'submission_ready'
            && text(item.writePayload?.workflow) === 'ozon-seller-backend-content-complaint-v1';
          const freshScheme1Restart = resumeExisting !== true && hasPreparedScheme1Flow;
          if (!PREPARABLE_STATUSES.has(item.status) && !legacyScheme1Ready && !freshScheme1Restart) {
            throw error('FOLLOW_SELLER_CASE_NOT_PREPARABLE', `商品 ${item.offerId} 已提交或当前状态不能重复提交。`, 409);
          }
          const prepared = complaintPreview(item);
          const evidence = await quickComplaintService.prepare({ caseRecord: item }, context);
          await quickComplaintService.validate(evidence, { caseRecord: item }, context);
          const previewId = `scheme1_${createHash('sha256').update([
            item.shopId,
            item.sku,
            evidence.evidenceId,
            ...prepared.draft.followerSkus,
          ].join('|'), 'utf8').digest('hex').slice(0, 24)}`;
          const draft = {
            ...prepared.draft,
            version: 3,
            workflow: 'ozon-seller-backend-content-complaint-v2',
            route: [...SCHEME1_BACKEND_ROUTE],
            evidence,
            speech: evidence.speech,
            submissionReady: true,
            blockedReason: '',
          };
          const ready = repository.updateCase(item.id, {
            status: 'submission_ready',
            stage: 'waiting_seller_backend_submission',
            groupOfferIds: draft.followerSkus,
            writePayload: draft,
            writeResult: null,
            previewId,
            lastErrorCode: '',
            lastErrorMessage: '',
          });
          const submission = {
            scheme: 'scheme1-seller-backend',
            caseId: item.id,
            shopId: item.shopId,
            previewId,
            evidenceId: evidence.evidenceId,
            manifestPath: evidence.manifestPath,
            materialDirectory: evidence.materialDirectory,
            sourceProductUrl: evidence.sourceProductUrl,
            files: evidence.files,
            speech: evidence.speech,
            followers: evidence.followers,
            evidenceFollowers: evidence.evidenceFollowers,
            route: draft.route,
            originalSku: draft.originalSku,
            offerId: draft.sourceProduct?.offerId,
            followerSkus: draft.followerSkus,
            sellers: draft.sellers,
			reusePreparedEvidence: false,
          };
          repository.recordAttempt({
            caseId: item.id,
            shopId: item.shopId,
            action: 'scheme1_backend_ready',
            status: 'ready',
            detail: {
              evidenceId: evidence.evidenceId,
              followerCount: draft.followerSkus.length,
              imageCount: evidence.files.length,
              evidenceFollowerCount: evidence.evidenceFollowers.length,
              failedImageCount: evidence.failedImageCount,
            },
          });
          submissions.push({ case: ready, submission });
        } catch (failure) {
          if (text(failure?.code) === 'FOLLOW_SELLER_CASE_NOT_PREPARABLE') {
            failed.push(item);
            repository.recordAttempt({
              caseId: item.id,
              shopId: item.shopId,
              action: 'scheme1_backend_prepare',
              status: 'skipped_existing_state',
              detail: { status: item.status, code: failure.code },
            });
            continue;
          }
          const updated = repository.updateCase(item.id, {
            status: 'prepare_failed',
            stage: 'scheme1_prepare_failed',
            lastErrorCode: text(failure?.code) || 'FOLLOW_SELLER_SCHEME1_PREPARE_FAILED',
            lastErrorMessage: failure?.message || String(failure),
            retryCount: item.retryCount + 1,
          });
          repository.recordAttempt({
            caseId: item.id,
            shopId: item.shopId,
            action: 'scheme1_backend_prepare',
            status: 'failed',
            detail: { code: failure?.code, message: failure?.message },
          });
          failed.push(updated);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, () => worker()));
    return {
      ok: submissions.length > 0,
      submissions,
      failed,
      cases: repository.getCasesByIds(caseIds),
    };
  }

  async function confirm({ caseId, previewId } = {}, context = {}) {
    const item = repository.getCase(caseId);
    if (!item) throw error('FOLLOW_SELLER_CASE_NOT_FOUND', '跟卖处理记录不存在。', 404);
    const normalizedPreviewId = text(previewId || item.previewId);
    if (!normalizedPreviewId || normalizedPreviewId !== item.previewId || item.status !== 'preview_ready') {
      throw error('FOLLOW_SELLER_PREVIEW_REQUIRED', '请先生成并核对最新投诉预览。', 409);
    }
    const storedEvidence = item.writePayload?.evidence || {};
    const files = rows(storedEvidence.files).map((file) => ({
      name: text(firstPresent(file?.name, file?.fileName)),
      path: text(firstPresent(file?.path, file?.filePath)),
      mimeType: text(firstPresent(file?.mimeType, file?.type)),
      sha256: text(file?.sha256),
      size: Number(file?.size) || 0,
      kind: text(file?.kind),
    })).filter((file) => file.name && file.path && file.sha256);
    const kinds = new Set(files.map((file) => file.kind));
    if (storedEvidence.status !== 'ready' || files.length !== 2 || !kinds.has('psd') || !kinds.has('pdf')) {
      throw error(
        'FOLLOW_SELLER_EVIDENCE_REQUIRED',
        '提交前必须由系统自动生成并校验 PSD 与 PDF 两个证据文件。',
        409,
      );
    }
    let validatedEvidence = storedEvidence;
    if (evidenceBundleService?.validate) {
      validatedEvidence = await evidenceBundleService.validate(storedEvidence, { caseRecord: item }, context);
    }
    if (validatedEvidence.browserEvidenceReady !== true) {
      const captureRequest = validatedEvidence.captureRequest || {};
      if (!text(captureRequest.sourceProductUrl)
        || !rows(captureRequest.evidenceFollowers).length
        || !text(captureRequest.materialDirectory)) {
        throw error(
          'FOLLOW_SELLER_SCHEME2_CAPTURE_INPUT_REQUIRED',
          '方案2缺少我方商品页或跟卖商品页真实链接，请重新巡查后再提交。',
          409,
        );
      }
      repository.recordAttempt({
        caseId: item.id,
        shopId: item.shopId,
        action: 'scheme2_browser_evidence',
        status: 'required',
        detail: { evidenceId: validatedEvidence.evidenceId },
      });
      return {
        ok: true,
        requiresEvidenceCapture: true,
        captureRequest: {
          ...captureRequest,
          caseId: item.id,
          shopId: item.shopId,
          previewId: normalizedPreviewId,
        },
        cases: [item],
      };
    }
    const draft = {
      ...(item.writePayload || {}),
      evidence: { ...validatedEvidence, layeredSourceRequired: true, files: validatedEvidence.files, status: 'ready' },
      submissionReady: true,
      blockedReason: '',
    };
    if (!complaintSubmitter?.submit) {
      const ready = repository.updateCase(item.id, {
        status: 'submission_ready',
        stage: 'waiting_browser_submission',
        writePayload: draft,
        lastErrorCode: '',
        lastErrorMessage: '',
      });
      const submission = {
        caseId: item.id,
        shopId: item.shopId,
        previewId: normalizedPreviewId,
        evidenceId: text(validatedEvidence.evidenceId),
        manifestPath: text(validatedEvidence.manifestPath),
        materialDirectory: text(validatedEvidence.materialDirectory),
        files: validatedEvidence.files,
        supplementFiles: [validatedEvidence.browserEvidence?.ownSellerList].filter(Boolean),
        speech: validatedEvidence.workflowSpeech || { ru: validatedEvidence.speech || draft.speech || '' },
        route: draft.route,
        originalSku: draft.originalSku,
        offerId: draft.sourceProduct?.offerId,
        followerSkus: draft.followerSkus,
        listingDate: validatedEvidence.browserEvidence?.listingDate,
      };
      repository.recordAttempt({
        caseId: item.id,
        shopId: item.shopId,
        action: 'complaint_browser_ready',
        status: 'ready',
        detail: { evidenceId: submission.evidenceId, files: files.map(({ path: _, ...file }) => file) },
      });
      return { ok: true, requiresBrowserSubmission: true, submission, cases: [ready] };
    }
    repository.updateCase(item.id, { status: 'submitting', stage: 'submitting_support_complaint', writePayload: draft });
    try {
      const result = await complaintSubmitter.submit({
        caseId: item.id,
        shopId: item.shopId,
        previewId: normalizedPreviewId,
        draft,
      });
      const submitted = result?.ok === true && text(firstPresent(result.status, result.state)) !== 'failed';
      const updated = repository.updateCase(item.id, {
        status: submitted ? 'verification_ready' : 'submission_failed',
        stage: submitted ? 'awaiting_manual_verification' : 'submission_failed',
        writeResult: result,
        ozonJobId: text(firstPresent(result?.chatId, result?.chat_id)),
        ozonTaskId: text(firstPresent(result?.messageId, result?.message_id, result?.ticketId, result?.ticket_id)),
        lastErrorCode: submitted ? '' : text(result?.error?.code) || 'FOLLOW_SELLER_COMPLAINT_SUBMIT_FAILED',
        lastErrorMessage: submitted ? '' : text(result?.error?.message || result?.message) || 'Ozon 客服投诉未提交。',
        retryCount: submitted ? item.retryCount : item.retryCount + 1,
      });
      repository.recordAttempt({ caseId: item.id, shopId: item.shopId, action: 'complaint_submit', status: updated.status, detail: result });
      return { ok: submitted, result, cases: [updated] };
    } catch (failure) {
      const updated = repository.updateCase(item.id, {
        status: 'submission_failed',
        stage: 'submission_failed',
        lastErrorCode: text(failure?.code) || 'FOLLOW_SELLER_COMPLAINT_SUBMIT_FAILED',
        lastErrorMessage: failure?.message || String(failure),
        retryCount: item.retryCount + 1,
      });
      repository.recordAttempt({ caseId: item.id, shopId: item.shopId, action: 'complaint_submit', status: 'failed', detail: { code: failure?.code, message: failure?.message } });
      throw Object.assign(failure, { case: updated });
    }
  }

  async function finalizeEvidence({ caseId, previewId, capture } = {}, context = {}) {
    const item = repository.getCase(caseId);
    if (!item) throw error('FOLLOW_SELLER_CASE_NOT_FOUND', '跟卖处理记录不存在。', 404);
    if (item.status !== 'preview_ready' || text(previewId) !== text(item.previewId)) {
      throw error('FOLLOW_SELLER_PREVIEW_REQUIRED', '方案2浏览器证据只能写入当前待提交预览。', 409);
    }
    if (!evidenceBundleService?.finalizeBrowserEvidence) {
      throw error('FOLLOW_SELLER_SCHEME2_FINALIZER_UNAVAILABLE', '方案2证据整合服务未启动。', 503);
    }
    const evidence = await evidenceBundleService.finalizeBrowserEvidence(
      item.writePayload?.evidence || {},
      { caseRecord: item, capture },
      context,
    );
    const draft = {
      ...(item.writePayload || {}),
      evidence: { ...evidence, layeredSourceRequired: true, status: 'ready' },
      speech: evidence.workflowSpeech,
      submissionReady: true,
      blockedReason: '',
    };
    const updated = repository.updateCase(item.id, {
      status: 'preview_ready',
      stage: 'scheme2_evidence_ready',
      writePayload: draft,
      lastErrorCode: '',
      lastErrorMessage: '',
    });
    repository.recordAttempt({
      caseId: item.id,
      shopId: item.shopId,
      action: 'scheme2_browser_evidence',
      status: 'ready',
      detail: {
        evidenceId: evidence.evidenceId,
        listingDate: evidence.browserEvidence?.listingDate,
        followerScreenshotCount: rows(evidence.browserEvidence?.followerProductPages).length,
        pdfSha256: evidence.hashes?.pdfSha256,
      },
    });
    return {
      ok: true,
      preview: {
        previewId: item.previewId,
        evidence,
        submissionReady: true,
      },
      cases: [updated],
    };
  }

  function recordSubmission({ caseId, previewId, result = {} } = {}) {
    const item = repository.getCase(caseId);
    if (!item) throw error('FOLLOW_SELLER_CASE_NOT_FOUND', '跟卖处理记录不存在。', 404);
    if (item.status !== 'submission_ready' || text(previewId) !== text(item.previewId)) {
      throw error('FOLLOW_SELLER_SUBMISSION_NOT_READY', '当前投诉没有待提交的浏览器任务。', 409);
    }
    const submitted = result?.ok === true && text(firstPresent(
      result.ticketId,
      result.ticket_id,
      result.messageId,
      result.message_id,
      result.chatId,
      result.chat_id,
    ));
    const updated = repository.updateCase(item.id, {
      status: submitted ? 'verification_ready' : 'submission_failed',
      stage: submitted ? 'awaiting_manual_verification' : 'submission_failed',
      writeResult: result,
      ozonJobId: text(firstPresent(result.chatId, result.chat_id, result.ticketId, result.ticket_id)),
      ozonTaskId: text(firstPresent(result.messageId, result.message_id, result.ticketId, result.ticket_id)),
      lastErrorCode: submitted ? '' : text(result?.error?.code) || 'FOLLOW_SELLER_COMPLAINT_SUBMIT_FAILED',
      lastErrorMessage: submitted ? '' : text(result?.error?.message || result?.message) || 'Ozon 客服投诉未取得提交回执。',
      retryCount: submitted ? item.retryCount : item.retryCount + 1,
    });
    repository.recordAttempt({
      caseId: item.id,
      shopId: item.shopId,
      action: 'complaint_browser_submit',
      status: updated.status,
      detail: result,
    });
    return { ok: Boolean(submitted), result, cases: [updated] };
  }

  function prepareVerification({ caseId, shopId = '', mode = '' } = {}) {
    const item = repository.getCase(caseId);
    if (!item) throw error('FOLLOW_SELLER_CASE_NOT_FOUND', '跟卖处理记录不存在。', 404);
    const expectedShopId = text(shopId);
    if (expectedShopId && text(item.shopId) !== expectedShopId) {
      throw error('FOLLOW_SELLER_VERIFICATION_SHOP_MISMATCH', '当前商品不属于所选店铺，已停止复查。', 409);
    }
    const standalone = isStandaloneRecheck(mode);
    if (standalone && STANDALONE_RECHECK_BLOCKED_STATUSES.has(item.status)) {
      throw error('FOLLOW_SELLER_STANDALONE_RECHECK_NOT_NEEDED', '当前商品已没有跟卖，无需重复复查。', 409);
    }
    if (!standalone && !VERIFIABLE_STATUSES.has(item.status)) {
      throw error('FOLLOW_SELLER_VERIFICATION_NOT_READY', '当前记录还不能复查剔除结果。', 409);
    }
    const followCountBefore = Number(item.followCountBefore);
    if (!text(item.sku) || (!standalone && (!Number.isInteger(followCountBefore) || followCountBefore < 1))) {
      throw error('FOLLOW_SELLER_VERIFICATION_BASELINE_REQUIRED', '缺少投诉前的跟卖数量或商品 SKU，请重新巡查后再复查。', 409);
    }
    return {
      ok: true,
      mode: standalone ? 'standalone' : 'verification',
      target: { caseId: item.id, sku: item.sku },
      baseline: {
        followCountBefore: Number.isInteger(followCountBefore) && followCountBefore >= 0 ? followCountBefore : null,
        sellerSkus: complaintSellers(item.sellers).map((seller) => seller.sku),
      },
      case: item,
    };
  }

  function verify({ caseId, result, mode = '' } = {}) {
    const item = repository.getCase(caseId);
    if (!item) throw error('FOLLOW_SELLER_CASE_NOT_FOUND', '跟卖处理记录不存在。', 404);
    const standalone = isStandaloneRecheck(mode);
    if (standalone && STANDALONE_RECHECK_BLOCKED_STATUSES.has(item.status)) {
      throw error('FOLLOW_SELLER_STANDALONE_RECHECK_NOT_NEEDED', '当前商品已没有跟卖，无需重复复查。', 409);
    }
    if (!standalone && !VERIFIABLE_STATUSES.has(item.status)) {
      throw error('FOLLOW_SELLER_VERIFICATION_NOT_READY', '当前记录还不能复查剔除结果。', 409);
    }
    const followCountBefore = Number(item.followCountBefore);
    if (!standalone && (!Number.isInteger(followCountBefore) || followCountBefore < 1)) {
      throw error('FOLLOW_SELLER_VERIFICATION_BASELINE_REQUIRED', '缺少投诉前的跟卖数量，无法判断是否减少。', 409);
    }
    const capture = normalizeCaptureResult(result);
    if (!capture.confirmed || capture.sku !== item.sku) {
      const updated = repository.updateCase(item.id, {
        status: standalone ? item.status : 'verification_failed',
        stage: standalone ? item.stage : 'verification_failed',
        lastErrorCode: capture.errorCode || 'FOLLOW_SELLER_VERIFICATION_CAPTURE_FAILED',
        lastErrorMessage: capture.errorMessage || '未取得复查结果。',
        retryCount: item.retryCount + 1,
      });
      repository.recordAttempt({
        caseId: item.id,
        shopId: item.shopId,
        action: standalone ? 'standalone_recheck' : 'verify',
        status: 'failed',
        detail: capture,
      });
      return { ok: false, case: updated };
    }
    const detached = standalone ? capture.count === 0 : capture.count < followCountBefore;
    const decreasedBy = Number.isInteger(followCountBefore) && followCountBefore >= capture.count
      ? followCountBefore - capture.count
      : 0;
    const updated = repository.updateCase(item.id, {
      status: detached ? 'detached' : standalone ? item.status : 'still_followed',
      stage: detached ? 'completed' : standalone ? item.stage : 'follow_seller_still_present',
      followCountAfter: capture.count,
      followMinPrice: capture.minPrice,
      followMaxPrice: capture.maxPrice,
      sellers: capture.sellers,
      lastErrorCode: '',
      lastErrorMessage: '',
      completedAt: detached ? new Date().toISOString() : null,
    });
    repository.recordAttempt({
      caseId: item.id,
      shopId: item.shopId,
      action: standalone ? 'standalone_recheck' : 'verify',
      status: detached ? 'detached' : 'still_followed',
      detail: { ...capture, followCountBefore: Number.isInteger(followCountBefore) ? followCountBefore : null, decreasedBy },
    });
    return {
      ok: true,
      detached,
      decreasedBy,
      followCountBefore,
      followCountAfter: capture.count,
      case: updated,
    };
  }

  function overview({ shopId = '', status = '', limit = 500, offset = 0 } = {}) {
    const cases = repository.listCases({ shopId, status, limit, offset });
    const patrols = repository.listPatrols({ shopId, limit: 30 });
    const counts = repository.summarizeCases({ shopId, status });
    return {
      ok: true,
      cases,
      patrols,
      counts,
      pagination: {
        offset: Math.max(0, Number(offset) || 0),
        limit: Math.max(1, Number(limit) || 500),
        total: counts.total,
      },
    };
  }

  function loginProfiles() {
    const profiles = repository.listLoginProfiles();
    const preferred = repository.getLoginPreference();
    const selectedProfileId = profiles.some((profile) => profile.id === preferred?.profileId)
      ? preferred.profileId
      : profiles.find((profile) => profile.connected)?.id || profiles[0]?.id || '';
    return { ok: true, scope: 'global', profiles, selectedProfileId };
  }

  function selectLoginProfile({ profileId } = {}) {
    const normalizedProfileId = text(profileId);
    if (!normalizedProfileId) throw error('FOLLOW_SELLER_LOGIN_PROFILE_REQUIRED', '请选择 Ozon 前台巡查账号。');
    const preference = repository.saveLoginPreference({
      profileId: normalizedProfileId,
    });
    if (!preference) {
      throw error(
        'FOLLOW_SELLER_LOGIN_PROFILE_INVALID',
        '这个账号不是可用的 Ozon 前台巡查账号，请重新选择。',
        409,
      );
    }
    return { ...loginProfiles(), preference };
  }

  return {
    resolve,
    startPatrol,
    recordCapture,
    retryCapture,
    prepare,
    prepareQuick,
    finalizeEvidence,
    confirm,
    recordSubmission,
    prepareVerification,
    verify,
    overview,
    loginProfiles,
    selectLoginProfile,
  };
}
