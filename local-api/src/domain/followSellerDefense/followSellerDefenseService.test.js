import assert from 'node:assert/strict';
import test from 'node:test';

import { createFollowSellerDefenseRepository } from '../../db/repositories/followSellerDefenseRepository.js';
import { createIntegrationProfileRepository } from '../../db/repositories/integrationProfileRepository.js';
import { createMigratedTestDb } from '../../../test/testDb.js';
import { createFollowSellerDefenseService } from './followSellerDefenseService.js';

function insertProduct(db, { id, offerId, sku, productId }) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO ozon_products (
      id, shop_id, product_key, product_id, offer_id, sku, name, visibility,
      attributes_json, images_json, raw_json, remote_hash, last_seen_at, created_at, updated_at
    ) VALUES (?, 'shop-1', ?, ?, ?, ?, ?, 'VISIBLE', ?, '[]', '{}', ?, ?, ?, ?)
  `).run(
    id,
    `product:${productId}`,
    productId,
    offerId,
    sku,
    `商品 ${offerId}`,
    '[]',
    `hash-${id}`,
    now,
    now,
    now,
  );
}

function createFixture() {
  const db = createMigratedTestDb();
  db.prepare("INSERT INTO shops (id, name, status) VALUES ('shop-1', '测试店铺', 'active')").run();
  insertProduct(db, { id: 'legacy-1', offerId: 'OFFER-1', sku: '900000001', productId: '101' });
  insertProduct(db, { id: 'legacy-2', offerId: 'OFFER-2', sku: '900000002', productId: '102' });
  return { db, repository: createFollowSellerDefenseRepository(db) };
}

function createQuickComplaintService(onPrepare = () => {}) {
  return {
    async prepare({ caseRecord }) {
      onPrepare();
      return {
        scheme: 'scheme1-seller-backend',
        evidenceId: `evidence-${caseRecord.id}`,
        manifestPath: `C:/follow-seller-evidence/scheme1/${caseRecord.id}/manifest.json`,
        materialDirectory: `C:/follow-seller-evidence/scheme1/${caseRecord.id}`,
        sourceProductUrl: `https://www.ozon.ru/product/${caseRecord.sku}/`,
        files: [{ kind: 'current_image', path: `C:/follow-seller-evidence/scheme1/${caseRecord.id}/current.png`, sha256: 'a'.repeat(64) }],
        speech: {
          ru: 'Первичное доказательство',
          initialEvidenceRu: 'Первичное доказательство',
          supplementRu: 'Дата размещения карточки: {{LISTING_DATE}}.',
          followerBatchRu: '3771432837\nПрошу принять жалобу.',
          zh: '准确话术',
        },
        evidenceFollowers: [{ sku: '3771432837', productLink: 'https://www.ozon.ru/product/3771432837/' }],
        followers: [{ sku: '3771432837', productLink: 'https://www.ozon.ru/product/3771432837/' }],
        failedImageCount: 0,
        status: 'ready',
      };
    },
    async validate(bundle) { return bundle; },
  };
}

test('single identifier resolves from SQLite and persists a restart-safe patrol case', () => {
  const { db, repository } = createFixture();
  try {
    const service = createFollowSellerDefenseService({ repository });
    const result = service.resolve({ shopId: 'shop-1', identifier: 'OFFER-1' });

    assert.equal(result.ok, true);
    assert.equal(result.captureTargets[0].sku, '900000001');
    assert.equal(result.cases[0].offerId, 'OFFER-1');
    assert.equal(repository.listPatrols({ shopId: 'shop-1' }).length, 1);
    assert.equal(repository.listCases({ shopId: 'shop-1' }).length, 1);
  } finally {
    db.close();
  }
});

test('manual verification compares the exact product with its saved baseline and succeeds on any decrease', () => {
  const { db, repository } = createFixture();
  try {
    const service = createFollowSellerDefenseService({ repository });
    const resolved = service.resolve({ shopId: 'shop-1', identifier: 'OFFER-1' });
    const captured = service.recordCapture({
      patrolRunId: resolved.patrol.id,
      results: [{
        sku: '900000001',
        followSellerCount: 3,
        followSellers: [
          { sku: '3771432837', id: 'seller-1' },
          { sku: '3771432838', id: 'seller-2' },
          { sku: '3771432839', id: 'seller-3' },
        ],
      }],
    });
    const caseId = captured.cases[0].id;
    repository.updateCase(caseId, {
      status: 'verification_ready',
      stage: 'awaiting_manual_verification',
      ozonJobId: 'ticket-1',
    });

    const prepared = service.prepareVerification({ caseId, shopId: 'shop-1' });
    assert.deepEqual(prepared.target, { caseId, sku: '900000001' });
    assert.equal(prepared.baseline.followCountBefore, 3);

    const verified = service.verify({
      caseId,
      result: {
        sku: '900000001',
        followSellerCount: 2,
        followSellers: [
          { sku: '3771432838', id: 'seller-2' },
          { sku: '3771432839', id: 'seller-3' },
        ],
      },
    });
    assert.equal(verified.detached, true);
    assert.equal(verified.decreasedBy, 1);
    assert.equal(verified.followCountBefore, 3);
    assert.equal(verified.followCountAfter, 2);
    assert.equal(verified.case.status, 'detached');
    assert.equal(verified.case.followCountAfter, 2);
  } finally {
    db.close();
  }
});

test('manual verification stays retryable when the current follow count has not decreased', () => {
  const { db, repository } = createFixture();
  try {
    const service = createFollowSellerDefenseService({ repository });
    const resolved = service.resolve({ shopId: 'shop-1', identifier: 'OFFER-2' });
    const captured = service.recordCapture({
      patrolRunId: resolved.patrol.id,
      results: [{
        sku: '900000002',
        followSellerCount: 2,
        followSellers: [
          { sku: '4771432837', id: 'seller-1' },
          { sku: '4771432838', id: 'seller-2' },
        ],
      }],
    });
    const caseId = captured.cases[0].id;
    repository.updateCase(caseId, {
      status: 'verification_ready',
      stage: 'awaiting_manual_verification',
      ozonJobId: 'ticket-2',
    });

    const verified = service.verify({
      caseId,
      result: { sku: '900000002', followSellerCount: 2 },
    });
    assert.equal(verified.detached, false);
    assert.equal(verified.decreasedBy, 0);
    assert.equal(verified.case.status, 'still_followed');
    assert.equal(verified.case.followCountAfter, 2);
    assert.equal(verified.case.completedAt, null);
    assert.equal(service.prepareVerification({ caseId, shopId: 'shop-1' }).ok, true);
  } finally {
    db.close();
  }
});

test('standalone recheck keeps the complaint state when followers remain and completes only at zero', () => {
  const { db, repository } = createFixture();
  try {
    const service = createFollowSellerDefenseService({ repository });
    const resolved = service.resolve({ shopId: 'shop-1', identifier: 'OFFER-1' });
    const captured = service.recordCapture({
      patrolRunId: resolved.patrol.id,
      results: [{
        sku: '900000001',
        followSellerCount: 3,
        followSellers: [
          { sku: '3771432837', id: 'seller-1' },
          { sku: '3771432838', id: 'seller-2' },
          { sku: '3771432839', id: 'seller-3' },
        ],
      }],
    });
    const caseId = captured.cases[0].id;
    repository.updateCase(caseId, {
      status: 'submission_failed',
      stage: 'submission_failed',
      lastErrorCode: 'OLD_SUBMISSION_FAILURE',
      lastErrorMessage: '原投诉失败原因',
    });

    const prepared = service.prepareVerification({ caseId, shopId: 'shop-1', mode: 'standalone' });
    assert.equal(prepared.mode, 'standalone');
    assert.deepEqual(prepared.target, { caseId, sku: '900000001' });

    const stillFollowed = service.verify({
      caseId,
      mode: 'standalone',
      result: {
        sku: '900000001',
        followSellerCount: 2,
        followSellers: [
          { sku: '3771432838', id: 'seller-2' },
          { sku: '3771432839', id: 'seller-3' },
        ],
      },
    });
    assert.equal(stillFollowed.detached, false);
    assert.equal(stillFollowed.followCountAfter, 2);
    assert.equal(stillFollowed.case.status, 'submission_failed');
    assert.equal(stillFollowed.case.stage, 'submission_failed');
    assert.equal(stillFollowed.case.followCountAfter, 2);
    assert.equal(stillFollowed.case.lastErrorCode, '');

    const completed = service.verify({
      caseId,
      mode: 'standalone',
      result: { sku: '900000001', followSellerCount: 0, followSellers: [] },
    });
    assert.equal(completed.detached, true);
    assert.equal(completed.followCountAfter, 0);
    assert.equal(completed.case.status, 'detached');
    assert.equal(completed.case.stage, 'completed');
    assert.ok(completed.case.completedAt);
  } finally {
    db.close();
  }
});

test('failed standalone recheck preserves the original processing state', () => {
  const { db, repository } = createFixture();
  try {
    const service = createFollowSellerDefenseService({ repository });
    const resolved = service.resolve({ shopId: 'shop-1', identifier: 'OFFER-2' });
    const captured = service.recordCapture({
      patrolRunId: resolved.patrol.id,
      results: [{ sku: '900000002', followSellerCount: 1 }],
    });
    const caseId = captured.cases[0].id;
    repository.updateCase(caseId, { status: 'submission_ready', stage: 'ready_to_submit' });

    const failed = service.verify({
      caseId,
      mode: 'standalone',
      result: {
        sku: '900000002',
        errorCode: 'FOLLOW_SELLER_CAPTURE_UNCONFIRMED',
        errorMessage: '未读取到跟卖数量',
      },
    });
    assert.equal(failed.ok, false);
    assert.equal(failed.case.status, 'submission_ready');
    assert.equal(failed.case.stage, 'ready_to_submit');
    assert.equal(failed.case.lastErrorCode, 'FOLLOW_SELLER_CAPTURE_UNCONFIRMED');
  } finally {
    db.close();
  }
});

test('detected seller creates an exact support complaint preview and never falls back to product attributes', async () => {
  const { db, repository } = createFixture();
  let legacyWriteCount = 0;
  try {
    const service = createFollowSellerDefenseService({
      repository,
      ozonScheduler: { execute: async () => { legacyWriteCount += 1; } },
      writeGuardService: { confirmWrite: async () => { legacyWriteCount += 1; } },
      productWriteService: { write: async () => { legacyWriteCount += 1; } },
    });
    const resolved = service.resolve({ shopId: 'shop-1', identifier: 'OFFER-1' });
    const captured = service.recordCapture({
      patrolRunId: resolved.patrol.id,
      results: [{
        sku: '900000001',
        followSellerCount: 1,
        followSellers: [{
          sku: '3771432837',
          id: '4127044',
          name: 'fanyuyanshaung',
          link: '/seller/4127044/',
          productLink: 'https://www.ozon.ru/product/follower-3771432837/',
          credentials: ['Wuhan Fanyiyan Trading Co., Ltd.', 'CN, Wuhan'],
          price: 2841,
        }],
      }],
    });
    assert.equal(captured.cases[0].status, 'detected');

    const prepared = await service.prepare({ caseIds: [captured.cases[0].id] });
    assert.equal(prepared.ok, true);
    assert.equal(prepared.previews.length, 1);
    const preview = prepared.previews[0].preview;
    assert.equal(preview.workflow, 'ozon-support-content-complaint');
    assert.deepEqual(preview.route, ['创建申请', '商品和价格', '质量监督', '卖家使用我的内容']);
    assert.equal(preview.originalSku, '900000001');
    assert.deepEqual(preview.followerSkus, ['3771432837']);
    assert.equal(preview.sellers[0].sellerId, '4127044');
    assert.equal(preview.sellers[0].sellerName, 'fanyuyanshaung');
    assert.equal(preview.evidence.status, 'missing');
    assert.equal(preview.submissionReady, false);
    assert.equal(legacyWriteCount, 0);

    await assert.rejects(
      service.confirm({ caseId: prepared.cases[0].id, previewId: preview.previewId }),
      (failure) => failure?.code === 'FOLLOW_SELLER_EVIDENCE_REQUIRED',
    );
    await assert.rejects(
      service.confirm({
        caseId: prepared.cases[0].id,
        previewId: preview.previewId,
        evidenceFiles: [{ name: 'source.psd', path: 'C:/evidence/source.psd', mimeType: 'image/vnd.adobe.photoshop' }],
      }),
      (failure) => failure?.code === 'FOLLOW_SELLER_EVIDENCE_REQUIRED',
    );
    assert.equal(repository.getCase(prepared.cases[0].id).status, 'preview_ready');
    assert.equal(legacyWriteCount, 0);
  } finally {
    db.close();
  }
});

test('scheme1 creates background submissions in parallel-ready form and never changes an already submitted case', async () => {
  const { db, repository } = createFixture();
  try {
    let prepareCalls = 0;
    const quickComplaintService = {
      async prepare({ caseRecord }) {
		prepareCalls += 1;
        return {
          scheme: 'scheme1-seller-backend',
          evidenceId: `evidence-${caseRecord.id}`,
          manifestPath: `C:/follow-seller-evidence/scheme1/${caseRecord.id}/manifest.json`,
          materialDirectory: `C:/follow-seller-evidence/scheme1/${caseRecord.id}`,
          sourceProductUrl: `https://www.ozon.ru/product/${caseRecord.sku}/`,
          files: [{ kind: 'current_image', path: `C:/follow-seller-evidence/scheme1/${caseRecord.id}/current.png`, sha256: 'a'.repeat(64) }],
		  speech: {
			  ru: 'Первичное доказательство',
			  initialEvidenceRu: 'Первичное доказательство',
			  supplementRu: 'Дата размещения карточки: {{LISTING_DATE}}.',
			  followerBatchRu: '3771432837\nПрошу принять жалобу.',
			  zh: '准确话术',
		  },
		  evidenceFollowers: [{
			  sku: '3771432837',
			  productLink: 'https://www.ozon.ru/product/3771432837/',
		  }],
		  followers: [{
			  sku: '3771432837',
			  productLink: 'https://www.ozon.ru/product/3771432837/',
		  }],
          failedImageCount: 0,
          status: 'ready',
        };
      },
      async validate(bundle) { return bundle; },
    };
    const service = createFollowSellerDefenseService({ repository, quickComplaintService });
    const resolved = service.resolve({ shopId: 'shop-1', identifier: 'OFFER-1' });
    const captured = service.recordCapture({
      patrolRunId: resolved.patrol.id,
      results: [{
        sku: '900000001',
        followSellerCount: 1,
        sourceProductUrl: 'https://www.ozon.ru/product/900000001/',
        followSellers: [{ sku: '3771432837', name: 'seller' }],
      }],
    });
    const prepared = await service.prepareQuick({ caseIds: [captured.cases[0].id] });
    assert.equal(prepared.ok, true);
    assert.equal(prepared.submissions.length, 1);
    assert.equal(prepared.submissions[0].submission.scheme, 'scheme1-seller-backend');
	assert.equal(prepared.submissions[0].submission.reusePreparedEvidence, false);
	assert.deepEqual(prepared.submissions[0].submission.route, [
	  'Ozon 卖家后台',
	  '支持',
	  '创建申请',
	  '商品和价格',
	  '质量监督',
	  '卖家使用我的内容',
	]);
	    assert.equal(prepared.submissions[0].case.writePayload.workflow, 'ozon-seller-backend-content-complaint-v2');
	    assert.equal(prepared.submissions[0].submission.speech.supplementRu, 'Дата размещения карточки: {{LISTING_DATE}}.');
	assert.deepEqual(prepared.submissions[0].submission.followers, [{
	  sku: '3771432837',
	  productLink: 'https://www.ozon.ru/product/3771432837/',
	}]);
    assert.equal(prepared.cases[0].status, 'submission_ready');
    const second = await service.prepareQuick({ caseIds: [captured.cases[0].id] });
    assert.equal(second.ok, true);
    assert.equal(second.submissions[0].submission.evidenceId, prepared.submissions[0].submission.evidenceId);
	assert.equal(second.submissions[0].submission.reusePreparedEvidence, false);
	assert.equal(second.submissions[0].submission.continuation, undefined);
	assert.equal(prepareCalls, 2);
    service.recordSubmission({
      caseId: captured.cases[0].id,
      previewId: prepared.submissions[0].submission.previewId,
	  result: {
		ok: false,
		submissionStarted: true,
		ticketId: '90620788',
		pageUrl: 'https://seller.ozon.ru/app/messenger/?id=resume-ticket-1&group=support_v2',
		phase: 'wait-evidence-prompt',
		error: { code: 'FOLLOW_SELLER_COMPLAINT_BUNDLE_SUBMIT_NOT_CONFIRMED', message: 'not confirmed' },
	  },
	});
	const continued = await service.prepareQuick({ caseIds: [captured.cases[0].id], resumeExisting: true });
	assert.equal(continued.ok, true);
	assert.deepEqual(continued.submissions[0].submission.continuation, {
	  requested: true,
	  available: true,
	  ticketId: '90620788',
	  pageUrl: 'https://seller.ozon.ru/app/messenger/?id=resume-ticket-1&group=support_v2',
	  phase: 'wait-evidence-prompt',
	  previousSubmissionStarted: true,
	});
	assert.equal(continued.submissions[0].submission.reusePreparedEvidence, true);
	assert.equal(continued.cases[0].writeResult.ticketId, '90620788');
	service.recordSubmission({
	  caseId: captured.cases[0].id,
	  previewId: prepared.submissions[0].submission.previewId,
	  result: {
		ok: false,
		submissionStarted: true,
		ticketId: '90620788',
		pageUrl: 'https://seller.ozon.ru/app/messenger/?id=resume-ticket-1&group=support_v2',
		error: { code: 'FOLLOW_SELLER_COMPLAINT_BUNDLE_SUBMIT_NOT_CONFIRMED', message: 'not confirmed' },
	  },
	});
	const retried = await service.prepareQuick({ caseIds: [captured.cases[0].id] });
	assert.equal(retried.ok, true);
	assert.equal(retried.submissions[0].submission.evidenceId, prepared.submissions[0].submission.evidenceId);
	assert.equal(retried.submissions[0].submission.reusePreparedEvidence, false);
	assert.equal(retried.submissions[0].submission.continuation, undefined);
	assert.equal(retried.cases[0].status, 'submission_ready');
	assert.equal(retried.cases[0].writeResult, null);
	assert.equal(prepareCalls, 3);
    service.recordSubmission({
      caseId: captured.cases[0].id,
      previewId: retried.submissions[0].submission.previewId,
      result: { ok: true, ticketId: 'ticket-scheme1-1' },
    });
	const completed = await service.prepareQuick({ caseIds: [captured.cases[0].id] });
	assert.equal(completed.ok, false);
    assert.equal(repository.getCase(captured.cases[0].id).status, 'verification_ready');
  } finally {
    db.close();
  }
});

test('scheme1 continue reuses prepared evidence and creates a fresh ticket when the previous attempt never started', async () => {
  const { db, repository } = createFixture();
  let prepareCalls = 0;
  try {
    const service = createFollowSellerDefenseService({
      repository,
      quickComplaintService: createQuickComplaintService(() => { prepareCalls += 1; }),
    });
    const resolved = service.resolve({ shopId: 'shop-1', identifier: 'OFFER-1' });
    const captured = service.recordCapture({
      patrolRunId: resolved.patrol.id,
      results: [{
        sku: '900000001',
        followSellerCount: 1,
        sourceProductUrl: 'https://www.ozon.ru/product/900000001/',
        followSellers: [{ sku: '3771432837', name: 'seller' }],
      }],
    });
    const caseId = captured.cases[0].id;
    const prepared = await service.prepareQuick({ caseIds: [caseId] });
    service.recordSubmission({
      caseId,
      previewId: prepared.submissions[0].submission.previewId,
      result: {
        ok: false,
        submissionStarted: false,
        error: { code: 'PURCHASE_BROWSER_CEF_PROTOCOL_CLOSED', message: 'protocol closed before sending' },
      },
    });

    const retried = await service.prepareQuick({ caseIds: [caseId], resumeExisting: true });

    assert.equal(retried.ok, true);
    assert.equal(retried.submissions[0].submission.evidenceId, prepared.submissions[0].submission.evidenceId);
    assert.equal(retried.submissions[0].submission.reusePreparedEvidence, true);
    assert.deepEqual(retried.submissions[0].submission.continuation, {
      requested: false,
      available: false,
      previousSubmissionStarted: false,
    });
    assert.equal(retried.cases[0].status, 'submission_ready');
    assert.equal(retried.cases[0].stage, 'waiting_seller_backend_submission');
    assert.equal(retried.cases[0].writeResult, null);
    assert.equal(prepareCalls, 1);
  } finally {
    db.close();
  }
});

test('scheme1 continue repairs the old continuation-not-found state without rebuilding evidence', async () => {
  const { db, repository } = createFixture();
  let prepareCalls = 0;
  try {
    const service = createFollowSellerDefenseService({
      repository,
      quickComplaintService: createQuickComplaintService(() => { prepareCalls += 1; }),
    });
    const resolved = service.resolve({ shopId: 'shop-1', identifier: 'OFFER-1' });
    const captured = service.recordCapture({
      patrolRunId: resolved.patrol.id,
      results: [{
        sku: '900000001',
        followSellerCount: 1,
        sourceProductUrl: 'https://www.ozon.ru/product/900000001/',
        followSellers: [{ sku: '3771432837', name: 'seller' }],
      }],
    });
    const caseId = captured.cases[0].id;
    const prepared = await service.prepareQuick({ caseIds: [caseId] });
    service.recordSubmission({
      caseId,
      previewId: prepared.submissions[0].submission.previewId,
      result: {
        ok: false,
        submissionStarted: false,
        error: { code: 'PURCHASE_BROWSER_CEF_PROTOCOL_UNAVAILABLE', message: 'protocol unavailable before sending' },
      },
    });
    repository.updateCase(caseId, {
      status: 'prepare_failed',
      stage: 'scheme1_prepare_failed',
      lastErrorCode: 'FOLLOW_SELLER_SCHEME1_CONTINUATION_NOT_FOUND',
      lastErrorMessage: '没有找到上次失败工单的地址或工单号，请重新提交。',
    });

    const recovered = await service.prepareQuick({ caseIds: [caseId], resumeExisting: true });

    assert.equal(recovered.ok, true);
    assert.equal(recovered.submissions[0].submission.evidenceId, prepared.submissions[0].submission.evidenceId);
    assert.equal(recovered.submissions[0].submission.continuation.requested, false);
    assert.equal(recovered.cases[0].status, 'submission_ready');
    assert.equal(recovered.cases[0].lastErrorCode, '');
    assert.equal(recovered.cases[0].writeResult, null);
    assert.equal(prepareCalls, 1);
  } finally {
    db.close();
  }
});

test('scheme1 continue stays fail-closed when sending started but the exact ticket is missing', async () => {
  const { db, repository } = createFixture();
  let prepareCalls = 0;
  try {
    const service = createFollowSellerDefenseService({
      repository,
      quickComplaintService: createQuickComplaintService(() => { prepareCalls += 1; }),
    });
    const resolved = service.resolve({ shopId: 'shop-1', identifier: 'OFFER-1' });
    const captured = service.recordCapture({
      patrolRunId: resolved.patrol.id,
      results: [{
        sku: '900000001',
        followSellerCount: 1,
        sourceProductUrl: 'https://www.ozon.ru/product/900000001/',
        followSellers: [{ sku: '3771432837', name: 'seller' }],
      }],
    });
    const caseId = captured.cases[0].id;
    const prepared = await service.prepareQuick({ caseIds: [caseId] });
    service.recordSubmission({
      caseId,
      previewId: prepared.submissions[0].submission.previewId,
      result: {
        ok: false,
        submissionStarted: true,
        error: { code: 'FOLLOW_SELLER_COMPLAINT_BUNDLE_SUBMIT_NOT_CONFIRMED', message: 'sending started without ticket readback' },
      },
    });

    const blocked = await service.prepareQuick({ caseIds: [caseId], resumeExisting: true });

    assert.equal(blocked.ok, false);
    assert.equal(blocked.submissions.length, 0);
    assert.equal(blocked.cases[0].status, 'prepare_failed');
    assert.equal(blocked.cases[0].lastErrorCode, 'FOLLOW_SELLER_SCHEME1_CONTINUATION_NOT_FOUND');
    assert.match(blocked.cases[0].lastErrorMessage, /已经开始发送/u);
    assert.equal(prepareCalls, 1);
  } finally {
    db.close();
  }
});

test('support complaint submit and direct front-page verification form one closed loop', async () => {
  const { db, repository } = createFixture();
  const submissions = [];
  try {
    const service = createFollowSellerDefenseService({
      repository,
      evidenceBundleService: {
        async prepare() {
          return {
            evidenceId: 'evidence-1',
            status: 'ready',
            speech: 'Фактическое обращение',
            manifestPath: 'C:/follow-seller-evidence/evidence-1/manifest.json',
            hashes: { manifestSha256: 'a'.repeat(64) },
            browserEvidenceReady: true,
            browserEvidence: {
              listingDate: '2026-08-01',
              ownSellerList: { kind: 'supplement_image', path: 'C:/follow-seller-evidence/evidence-1/own-seller-list.png', sha256: 'd'.repeat(64) },
            },
            workflowSpeech: {
              initialEvidenceRu: 'Первичное доказательство',
              supplementRu: 'Дата размещения: {{LISTING_DATE}}',
              followerBatchRu: '3771432837\nПрошу принять жалобу.',
            },
            files: [
              {
                kind: 'psd',
                name: 'evidence.psd',
                path: 'C:/follow-seller-evidence/evidence-1/evidence.psd',
                mimeType: 'image/vnd.adobe.photoshop',
                sha256: 'b'.repeat(64),
                size: 128,
              },
              {
                kind: 'pdf',
                name: 'evidence.pdf',
                path: 'C:/follow-seller-evidence/evidence-1/evidence.pdf',
                mimeType: 'application/pdf',
                sha256: 'c'.repeat(64),
                size: 256,
              },
            ],
          };
        },
        async validate(bundle) {
          return bundle;
        },
      },
      complaintSubmitter: {
        async submit(input) {
          submissions.push(input);
          return { ok: true, status: 'submitted', chatId: 'chat-1', messageId: 'message-1' };
        },
      },
    });
    const resolved = service.resolve({ shopId: 'shop-1', identifier: 'OFFER-1' });
    const captured = service.recordCapture({
      patrolRunId: resolved.patrol.id,
      results: [{
        sku: '900000001',
        followSellerCount: 1,
        followSellers: [{ sku: '3771432837', id: '4127044', name: 'fanyuyanshaung' }],
      }],
    });
    const prepared = await service.prepare({ caseIds: [captured.cases[0].id] });
    const preview = prepared.previews[0].preview;
    const confirmed = await service.confirm({
      caseId: captured.cases[0].id,
      previewId: preview.previewId,
    });
    assert.equal(confirmed.ok, true);
    assert.equal(confirmed.cases[0].status, 'verification_ready');
    assert.equal(confirmed.cases[0].ozonJobId, 'chat-1');
    assert.equal(submissions[0].draft.originalSku, '900000001');
    assert.deepEqual(submissions[0].draft.followerSkus, ['3771432837']);

    const verification = service.prepareVerification({ caseId: captured.cases[0].id, shopId: 'shop-1' });
    assert.deepEqual(verification.target, { caseId: captured.cases[0].id, sku: '900000001' });
    assert.equal(verification.baseline.followCountBefore, 1);

    const verified = service.verify({
      caseId: captured.cases[0].id,
      result: { sku: '900000001', followSellerConfirmed: true, followSellerCount: 0 },
    });
    assert.equal(verified.ok, true);
    assert.equal(verified.detached, true);
    assert.equal(verified.case.status, 'detached');
  } finally {
    db.close();
  }
});

test('browser submission receipt transitions directly to front-page verification', async () => {
  const { db, repository } = createFixture();
  try {
    const evidenceBundleService = {
      async prepare() {
        return {
          evidenceId: 'evidence-browser-1',
          status: 'ready',
          speech: 'Фактическое обращение',
          manifestPath: 'C:/follow-seller-evidence/evidence-browser-1/manifest.json',
          hashes: { manifestSha256: 'a'.repeat(64) },
          files: [
            {
              kind: 'psd',
              name: 'evidence.psd',
              path: 'C:/follow-seller-evidence/evidence-browser-1/evidence.psd',
              mimeType: 'image/vnd.adobe.photoshop',
              sha256: 'b'.repeat(64),
              size: 128,
            },
            {
              kind: 'pdf',
              name: 'evidence.pdf',
              path: 'C:/follow-seller-evidence/evidence-browser-1/evidence.pdf',
              mimeType: 'application/pdf',
              sha256: 'c'.repeat(64),
              size: 256,
            },
            ],
          browserEvidenceReady: false,
          captureRequest: {
            materialDirectory: 'C:/follow-seller-evidence/evidence-browser-1',
            sourceProductUrl: 'https://www.ozon.ru/product/900000001/',
            originalSku: '900000001',
            offerId: 'OFFER-1',
            followerSkus: ['3771432837'],
            evidenceFollowers: [{ sku: '3771432837', productLink: 'https://www.ozon.ru/product/3771432837/' }],
          },
        };
      },
      async validate(bundle) { return bundle; },
      async finalizeBrowserEvidence(bundle, { capture }) {
        return {
          ...bundle,
          materialDirectory: 'C:/follow-seller-evidence/evidence-browser-1',
          browserEvidenceReady: true,
          browserEvidence: {
            listingDate: capture.listingDate,
            ownSellerList: { kind: 'supplement_image', path: capture.ownSellerList.path, sha256: 'd'.repeat(64) },
          },
          workflowSpeech: {
            initialEvidenceRu: 'Первичное доказательство',
            supplementRu: 'Дата размещения: {{LISTING_DATE}}',
            followerBatchRu: '3771432837\nПрошу принять жалобу.',
          },
        };
      },
    };
    const service = createFollowSellerDefenseService({ repository, evidenceBundleService });
    const resolved = service.resolve({ shopId: 'shop-1', identifier: 'OFFER-1' });
    const captured = service.recordCapture({
      patrolRunId: resolved.patrol.id,
      results: [{
        sku: '900000001',
        followSellerCount: 1,
        followSellers: [{ sku: '3771432837', id: '4127044', name: 'fanyuyanshaung' }],
      }],
    });
    const caseId = captured.cases[0].id;
    const prepared = await service.prepare({ caseIds: [caseId] });
    const previewId = prepared.previews[0].preview.previewId;

    const captureRequired = await service.confirm({ caseId, previewId });
    assert.equal(captureRequired.requiresEvidenceCapture, true);
    assert.equal(captureRequired.captureRequest.originalSku, '900000001');
    await service.finalizeEvidence({
      caseId,
      previewId,
      capture: {
        listingDate: '2026-08-01',
        ownSellerList: { path: 'C:/follow-seller-evidence/evidence-browser-1/own-seller-list.png' },
      },
    });
    const submission = await service.confirm({ caseId, previewId });
    assert.equal(submission.requiresBrowserSubmission, true);
    assert.deepEqual(submission.submission.files.map((item) => item.kind).sort(), ['pdf', 'psd']);
    assert.equal(submission.submission.supplementFiles.length, 1);
    assert.equal(submission.submission.listingDate, '2026-08-01');
    assert.equal(submission.submission.speech.initialEvidenceRu, 'Первичное доказательство');
    assert.equal(submission.cases[0].status, 'submission_ready');

    const submitted = service.recordSubmission({
      caseId,
      previewId,
      result: {
        ok: true,
        ticketId: 'ticket-10001',
        messageId: 'ticket-10001',
        pageUrl: 'https://www.ozon.ru/support/ticket-10001',
        screenshots: [{ path: 'C:/follow-seller-evidence/evidence-browser-1/submission-after.png' }],
      },
    });
    assert.equal(submitted.ok, true);
    assert.equal(submitted.cases[0].status, 'verification_ready');

    const verification = service.prepareVerification({ caseId, shopId: 'shop-1' });
    assert.deepEqual(verification.target, { caseId, sku: '900000001' });
    assert.equal(verification.baseline.followCountBefore, 1);

    const verified = service.verify({
      caseId,
      result: { sku: '900000001', followSellerConfirmed: true, followSellerCount: 0 },
    });
    assert.equal(verified.case.status, 'detached');
    assert.equal(verified.detached, true);
  } finally {
    db.close();
  }
});

test('complaint preview fails closed when patrol data omitted follower SKU', async () => {
  const { db, repository } = createFixture();
  try {
    const service = createFollowSellerDefenseService({ repository });
    const resolved = service.resolve({ shopId: 'shop-1', identifier: 'OFFER-1' });
    const captured = service.recordCapture({
      patrolRunId: resolved.patrol.id,
      results: [{ sku: '900000001', followSellerCount: 1, followSellers: [{ id: '4127044', name: 'fanyuyanshaung' }] }],
    });
    const prepared = await service.prepare({ caseIds: [captured.cases[0].id] });
    assert.equal(prepared.ok, false);
    assert.equal(prepared.cases[0].status, 'prepare_failed');
    assert.equal(prepared.cases[0].lastErrorCode, 'FOLLOW_SELLER_TARGET_SKU_MISSING');
  } finally {
    db.close();
  }
});

test('shop patrol records partial capture without turning missing results into zero-follow success', () => {
  const { db, repository } = createFixture();
  try {
    const service = createFollowSellerDefenseService({ repository });
    const patrol = service.startPatrol({ shopId: 'shop-1' });
    const recorded = service.recordCapture({
      patrolRunId: patrol.patrol.id,
      results: [{ sku: '900000001', confirmed: true, followSellerCount: 0 }],
    });
    assert.equal(recorded.patrol.status, 'partial');
    assert.equal(recorded.patrol.clearCount, 1);
    assert.equal(recorded.patrol.failedCount, 1);
    assert.equal(recorded.cases.find((item) => item.sku === '900000002').status, 'capture_failed');
  } finally {
    db.close();
  }
});

test('one-click retry reopens only failed capture cases and completes the same patrol', () => {
  const { db, repository } = createFixture();
  try {
    const service = createFollowSellerDefenseService({ repository });
    const started = service.startPatrol({ shopId: 'shop-1' });
    const partial = service.recordCapture({
      patrolRunId: started.patrol.id,
      results: [{ sku: '900000001', confirmed: true, followSellerCount: 0 }],
    });
    assert.equal(partial.patrol.failedCount, 1);

    const retried = service.retryCapture({ shopId: 'shop-1' });
    assert.equal(retried.retry, true);
    assert.equal(retried.resumed, true);
    assert.equal(retried.patrol.id, started.patrol.id);
    assert.equal(retried.patrol.status, 'running');
    assert.equal(retried.patrol.failedCount, 0);
    assert.deepEqual(retried.captureTargets.map((item) => item.sku), ['900000002']);
    assert.equal(retried.cases.find((item) => item.sku === '900000001').status, 'clear');
    assert.equal(retried.cases.find((item) => item.sku === '900000002').status, 'pending_capture');

    service.recordCapture({
      patrolRunId: started.patrol.id,
      final: false,
      results: [{ sku: '900000002', confirmed: true, followSellerCount: 0 }],
    });
    const completed = service.recordCapture({ patrolRunId: started.patrol.id, results: [], final: true });
    assert.equal(completed.patrol.status, 'completed');
    assert.equal(completed.patrol.scannedCount, 2);
    assert.equal(completed.patrol.failedCount, 0);
  } finally {
    db.close();
  }
});

test('selected retry reopens only the chosen failed row and leaves other failures untouched', () => {
  const { db, repository } = createFixture();
  try {
    const service = createFollowSellerDefenseService({ repository });
    const started = service.startPatrol({ shopId: 'shop-1' });
    const failed = service.recordCapture({
      patrolRunId: started.patrol.id,
      results: [],
      final: true,
    });
    assert.equal(failed.patrol.failedCount, 2);
    const selected = failed.cases.find((item) => item.sku === '900000001');

    const retried = service.retryCapture({
      shopId: 'shop-1',
      patrolRunId: started.patrol.id,
      caseIds: [selected.id],
    });

    assert.deepEqual(retried.captureTargets.map((item) => item.sku), ['900000001']);
    assert.equal(retried.patrol.failedCount, 1);
    assert.equal(retried.cases.find((item) => item.sku === '900000001').status, 'pending_capture');
    assert.equal(retried.cases.find((item) => item.sku === '900000002').status, 'capture_failed');
  } finally {
    db.close();
  }
});

test('shop patrol persists each browser batch and resumes only unfinished SKUs', () => {
  const { db, repository } = createFixture();
  try {
    const service = createFollowSellerDefenseService({ repository });
    const started = service.startPatrol({ shopId: 'shop-1' });
    assert.equal(started.cases.length, 2);
    assert.equal(started.captureTargets.length, 2);

    const firstBatch = service.recordCapture({
      patrolRunId: started.patrol.id,
      final: false,
      results: [{ sku: '900000001', followSellerCount: 1 }],
    });
    assert.equal(firstBatch.patrol.status, 'running');
    assert.equal(firstBatch.patrol.stage, 'capture_running');
    assert.equal(firstBatch.patrol.scannedCount, 1);
    assert.equal(firstBatch.patrol.followedCount, 1);
    assert.equal(firstBatch.pendingCount, 1);
    assert.equal(repository.listCases({ patrolRunId: started.patrol.id, status: 'pending_capture' }).length, 1);

    const resumed = service.startPatrol({ shopId: 'shop-1' });
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.patrol.id, started.patrol.id);
    assert.deepEqual(resumed.captureTargets.map((item) => item.sku), ['900000002']);

    service.recordCapture({
      patrolRunId: started.patrol.id,
      final: false,
      results: [{ sku: '900000002', followSellerCount: 0 }],
    });
    const finished = service.recordCapture({ patrolRunId: started.patrol.id, results: [], final: true });
    assert.equal(finished.patrol.status, 'completed');
    assert.equal(finished.patrol.scannedCount, 2);
    assert.equal(finished.patrol.followedCount, 1);
    assert.equal(finished.patrol.clearCount, 1);
    assert.equal(finished.patrol.failedCount, 0);
  } finally {
    db.close();
  }
});

test('shop patrol paginates past one thousand products and overview counts the complete result set', () => {
  const { db, repository } = createFixture();
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      for (let index = 3; index <= 1205; index += 1) {
        insertProduct(db, {
          id: `legacy-${index}`,
          offerId: `OFFER-${index}`,
          sku: String(900000000 + index),
          productId: String(100 + index),
        });
      }
      db.exec('COMMIT');
    } catch (failure) {
      db.exec('ROLLBACK');
      throw failure;
    }
    const service = createFollowSellerDefenseService({ repository });

    const started = service.startPatrol({ shopId: 'shop-1' });
    assert.equal(started.patrol.totalCount, 1205);
    assert.equal(started.captureTargets.length, 1205);
    assert.equal(new Set(started.captureTargets.map((item) => item.sku)).size, 1205);

    const overview = service.overview({ shopId: 'shop-1', limit: 1000 });
    assert.equal(overview.cases.length, 1000);
    assert.equal(overview.counts.total, 1205);
    assert.equal(overview.pagination.total, 1205);
  } finally {
    db.close();
  }
});

test('shop patrol task creation never scans the normalized image fact table', () => {
  const { db, repository } = createFixture();
  try {
    // 全店巡查只需要商品 SKU。图片事实表可能包含数万行，不能成为
    // 建立巡查任务的前置依赖；投诉材料阶段会再按单品读取完整图片。
    db.exec('DROP TABLE product_image_facts');

    const service = createFollowSellerDefenseService({ repository });
    const started = service.startPatrol({ shopId: 'shop-1' });

    assert.equal(started.patrol.totalCount, 2);
    assert.deepEqual(started.captureTargets.map((item) => item.sku), ['900000001', '900000002']);
  } finally {
    db.close();
  }
});

test('repeated shop patrols keep one current case per shop and SKU without losing patrol audit rows', () => {
  const { db, repository } = createFixture();
  try {
    const service = createFollowSellerDefenseService({ repository });
    const first = service.startPatrol({ shopId: 'shop-1' });
    service.recordCapture({
      patrolRunId: first.patrol.id,
      results: [
        { sku: '900000001', confirmed: true, followSellerCount: 2 },
        { sku: '900000002', confirmed: true, followSellerCount: 0 },
      ],
      final: true,
    });

    const second = service.startPatrol({ shopId: 'shop-1' });
    service.recordCapture({
      patrolRunId: second.patrol.id,
      results: [
        { sku: '900000001', confirmed: true, followSellerCount: 0 },
        { sku: '900000002', confirmed: true, followSellerCount: 3 },
      ],
      final: true,
    });

    const currentCases = repository.listCases({ shopId: 'shop-1', limit: 100 });
    const counts = repository.summarizeCases({ shopId: 'shop-1' });
    assert.equal(currentCases.length, 2);
    assert.equal(new Set(currentCases.map((item) => item.sku)).size, 2);
    assert.equal(counts.total, 2);
    assert.equal(counts.detected, 1);
    assert.equal(currentCases.find((item) => item.sku === '900000001').status, 'clear');
    assert.equal(currentCases.find((item) => item.sku === '900000002').status, 'detected');

    assert.equal(repository.listCases({ patrolRunId: first.patrol.id, limit: 100 }).length, 2);
    assert.equal(repository.listCases({ patrolRunId: second.patrol.id, limit: 100 }).length, 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM follow_seller_cases').get().count, 4);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM follow_seller_cases WHERE is_latest = 1').get().count, 2);
  } finally {
    db.close();
  }
});

test('front patrol login profiles are global and remember one selection across shops', () => {
  const { db, repository } = createFixture();
  try {
    const integrationProfiles = createIntegrationProfileRepository(db);
    const first = integrationProfiles.saveProfile({
      integrationType: 'ozon-follow-seller-session',
      platformName: 'Ozon 前台巡查 1',
      configStatus: '连接成功',
      tokenStatus: 'Cookie 已保存',
    }).profile;
    const second = integrationProfiles.saveProfile({
      integrationType: 'ozon-follow-seller-session',
      platformName: 'Ozon 前台巡查 2',
      configStatus: '待登录',
      tokenStatus: 'Cookie 未保存',
    }).profile;
    integrationProfiles.saveProfile({
      integrationType: 'ozon-browser-session',
      platformName: '旧版店铺网页登录',
      shopId: 'shop-1',
      configStatus: '连接成功',
      tokenStatus: 'Cookie 已保存',
    });

    const service = createFollowSellerDefenseService({ repository });
    const before = service.loginProfiles();
    assert.deepEqual(before.profiles.map((profile) => profile.id), [first.id, second.id]);
    assert.equal(before.selectedProfileId, first.id);

    const selected = service.selectLoginProfile({ profileId: second.id });
    assert.equal(selected.selectedProfileId, second.id);
    assert.equal(repository.getLoginPreference().profileId, second.id);
    assert.equal(service.loginProfiles().selectedProfileId, second.id);
  } finally {
    db.close();
  }
});
