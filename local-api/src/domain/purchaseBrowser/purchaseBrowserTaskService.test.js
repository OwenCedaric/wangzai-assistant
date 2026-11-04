import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createMigratedTestDb } from '../../../test/testDb.js';
import { createPurchaseAccountRepository } from '../../db/repositories/purchaseAccountRepository.js';
import { decryptSecret } from '../../security/secretCrypto.js';
import { createPurchaseBrowserTaskService } from './purchaseBrowserTaskService.js';

function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function seedShop(db, id = 'shop-a') {
  db.prepare(`
    INSERT INTO shops (id, name, status) VALUES (?, ?, 'active')
  `).run(id, `Fixture ${id}`);
}

function fixtureDraft(overrides = {}) {
  return {
    ownerId: 'purchase-a',
    shopId: 'shop-a',
    orderKey: 'order:1001',
    productKey: 'sku:2002',
    productTitle: 'Fixture product',
    variant: 'Blue / XL',
    quantity: 2,
    address: 'Fixture address A',
    expectedAmount: '88.60',
    targetUrl: 'http://127.0.0.1:49152/purchase-fixture',
    idempotencyKey: 'fixture-idempotency-key-0001',
    ...overrides,
  };
}

function exactConfirmation(task) {
  const preview = task.preview;
  return {
    confirm: true,
    previewFingerprint: task.previewFingerprint,
    confirmation: {
      productTitle: preview.productTitle,
      variant: preview.variant,
      quantity: preview.quantity,
      address: preview.address,
      expectedAmount: preview.expectedAmount,
    },
  };
}

test('purchase browser task completes only after exact human confirmation and trusted website readback', () => {
  const db = createMigratedTestDb();
  try {
    seedShop(db);
    createPurchaseAccountRepository(db).saveAccount({ id: 'purchase-a', name: 'A' });
    const service = createPurchaseBrowserTaskService(db, {
      createCapability: () => 'capability-a',
      createAttemptId: () => 'purchase_attempt_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      createReceiptId: () => 'purchase_receipt_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    });
    const preview = service.previewTask(fixtureDraft());
    assert.equal(preview.task.status, 'previewed');
    assert.equal(JSON.stringify(db.prepare('SELECT * FROM purchase_browser_tasks').get()).includes('Fixture address A'), false);
    assert.throws(
      () => service.confirmTask(preview.task.id, { ...exactConfirmation(preview.task), confirm: false }),
      /PURCHASE_BROWSER_HUMAN_CONFIRMATION_REQUIRED/u,
    );
    assert.throws(
      () => service.confirmTask(preview.task.id, {
        ...exactConfirmation(preview.task),
        confirmation: { ...exactConfirmation(preview.task).confirmation, quantity: 3 },
      }),
      /PURCHASE_BROWSER_CONFIRMATION_MISMATCH/u,
    );
    const confirmed = service.confirmTask(preview.task.id, exactConfirmation(preview.task));
    assert.equal(confirmed.task.status, 'confirmed');
    assert.equal(confirmed.executionCapability, 'capability-a');
    assert.throws(
      () => service.confirmTask(preview.task.id, exactConfirmation(preview.task)),
      /PURCHASE_BROWSER_FRESH_PREVIEW_REQUIRED/u,
    );
    assert.throws(
      () => service.claimTask(preview.task.id, { executionCapability: 'wrong' }),
      /PURCHASE_BROWSER_EXECUTION_CAPABILITY_INVALID/u,
    );
    const claimed = service.claimTask(preview.task.id, { executionCapability: 'capability-a' });
    assert.equal(claimed.task.status, 'executing');
    const receipt = {
      orderNumber: 'FIXTURE-ORDER-1001',
      amount: '88.60',
      status: 'submitted',
      pageUrl: fixtureDraft().targetUrl,
      receivedAt: 'ignored-by-service',
    };
    const expectedReceiptEvidence = {
      orderNumber: receipt.orderNumber,
      amount: receipt.amount,
      status: receipt.status,
      pageUrl: receipt.pageUrl,
    };
    assert.throws(
      () => service.completeTask(preview.task.id, {
        attemptId: claimed.attemptId,
        receipt,
        receiptHash: sha256(JSON.stringify(expectedReceiptEvidence)),
        websiteReadbackVerified: false,
        websiteReadbackHash: sha256('website'),
      }),
      /PURCHASE_BROWSER_WEBSITE_READBACK_REQUIRED/u,
    );
  } finally {
    db.close();
  }
});

test('purchase browser receipt is idempotent, amount-bound, and read back before completion', () => {
  const db = createMigratedTestDb();
  let tick = 0;
  const timestamps = [
    '2026-07-15T00:00:00.000Z',
    '2026-07-15T00:00:01.000Z',
    '2026-07-15T00:00:02.000Z',
    '2026-07-15T00:00:03.000Z',
    '2026-07-15T00:00:04.000Z',
  ];
  try {
    seedShop(db);
    createPurchaseAccountRepository(db).saveAccount({ id: 'purchase-a', name: 'A' });
    const service = createPurchaseBrowserTaskService(db, {
      now: () => timestamps[Math.min(tick++, timestamps.length - 1)],
      createCapability: () => 'capability-a',
      createAttemptId: () => 'purchase_attempt_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      createReceiptId: () => 'purchase_receipt_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    });
    const task = service.previewTask(fixtureDraft()).task;
    const confirmed = service.confirmTask(task.id, exactConfirmation(task));
    const claimed = service.claimTask(task.id, { executionCapability: confirmed.executionCapability });
    const receipt = {
      orderNumber: 'FIXTURE-ORDER-1001',
      amount: '88.60',
      status: 'submitted',
      pageUrl: fixtureDraft().targetUrl,
      receivedAt: '2026-07-15T00:00:04.000Z',
    };
    const receiptHash = sha256(JSON.stringify({
      orderNumber: receipt.orderNumber,
      amount: receipt.amount,
      status: receipt.status,
      pageUrl: receipt.pageUrl,
    }));
    assert.throws(
      () => service.completeTask(task.id, {
        attemptId: claimed.attemptId,
        receipt: { ...receipt, amount: '99.00' },
        receiptHash,
        websiteReadbackVerified: true,
        websiteReadbackHash: sha256('website'),
      }),
      /PURCHASE_BROWSER_RECEIPT_AMOUNT_MISMATCH/u,
    );
    const completed = service.completeTask(task.id, {
      attemptId: claimed.attemptId,
      receipt,
      receiptHash,
      websiteReadbackVerified: true,
      websiteReadbackHash: sha256('website'),
    });
    assert.equal(completed.task.status, 'completed');
    assert.equal(completed.task.receipt.orderNumber, receipt.orderNumber);
    assert.equal(JSON.stringify(db.prepare('SELECT * FROM purchase_browser_receipts').get()).includes(receipt.orderNumber), false);
    const history = db.prepare('SELECT * FROM purchase_completion_history').get();
    assert.equal(history.shop_id, 'shop-a');
    assert.equal(history.source_receipt_id, completed.task.receipt.id);
    assert.equal(JSON.stringify(history).includes('purchase-a'), false);
    assert.equal(JSON.stringify(history).includes(receipt.orderNumber), false);
    assert.deepEqual(JSON.parse(decryptSecret(history.order_product_encrypted)), {
      expectedAmount: '88.60',
      orderKey: 'order:1001',
      productKey: 'sku:2002',
      productTitle: 'Fixture product',
      quantity: 2,
      schemaVersion: 1,
      variant: 'Blue / XL',
    });
    assert.deepEqual(JSON.parse(decryptSecret(history.source_summary_encrypted)), {
      accountRefHash: history.source_account_ref_hash,
      attemptId: 'purchase_attempt_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      platformName: '',
      schemaVersion: 1,
      sourceHost: '127.0.0.1',
      sourceKind: 'purchase-browser',
      sourceUrlHash: sha256(`purchase-source-url-v1\0${fixtureDraft().targetUrl}`),
      taskCreatedAt: timestamps[1],
    });
    assert.equal(service.completeTask(task.id, { receiptHash }).alreadyCompleted, true);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM purchase_completion_history').get().count, 1);
  } finally {
    db.close();
  }
});

test('purchase browser idempotency, restart interruption, and account-removal fence fail closed', async () => {
  const db = createMigratedTestDb();
  try {
    seedShop(db);
    createPurchaseAccountRepository(db).saveAccount({ id: 'purchase-a', name: 'A' });
    const service = createPurchaseBrowserTaskService(db, {
      createCapability: () => 'capability-a',
      createAttemptId: () => 'purchase_attempt_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    });
    const first = service.previewTask(fixtureDraft());
    assert.equal(service.previewTask(fixtureDraft()).task.id, first.task.id);
    assert.throws(
      () => service.previewTask(fixtureDraft({ quantity: 4 })),
      /PURCHASE_BROWSER_IDEMPOTENCY_KEY_CONFLICT/u,
    );
    const confirmed = service.confirmTask(first.task.id, exactConfirmation(first.task));
    service.claimTask(first.task.id, { executionCapability: confirmed.executionCapability });
    const restarted = createPurchaseBrowserTaskService(db);
    assert.equal(restarted.getTask(first.task.id).status, 'interrupted');
    assert.throws(
      () => restarted.confirmTask(first.task.id, exactConfirmation(first.task)),
      /PURCHASE_BROWSER_FRESH_PREVIEW_REQUIRED/u,
    );
    await restarted.quiesceAccountRemoval(
      { ownerType: 'purchase_account', ownerId: 'purchase-a' },
      { timeoutMs: 50 },
    );
    assert.deepEqual(
      restarted.getAccountRemovalStatus({ ownerType: 'purchase_account', ownerId: 'purchase-a' }),
      { fenced: true, active: 0 },
    );
    assert.throws(
      () => restarted.previewTask(fixtureDraft({ idempotencyKey: 'fixture-idempotency-key-0002' })),
      /PURCHASE_BROWSER_OWNER_FENCED/u,
    );
    restarted.releaseAccountRemovalFence({ ownerType: 'purchase_account', ownerId: 'purchase-a' });
    assert.equal(
      restarted.previewTask(fixtureDraft({ idempotencyKey: 'fixture-idempotency-key-0002' })).task.status,
      'previewed',
    );
  } finally {
    db.close();
  }
});

test('plugin state is purchase-account scoped and never accepts an unverified package shape', () => {
  const db = createMigratedTestDb();
  try {
    seedShop(db);
    createPurchaseAccountRepository(db).saveAccount({ id: 'purchase-a', name: 'A' });
    const service = createPurchaseBrowserTaskService(db);
    const state = service.recordPluginState({
      ownerId: 'purchase-a',
      extensionId: 'abcdefghijklmnopabcdefghijklmnop',
      extensionVersion: '3.0.0',
      packageSha256: 'a'.repeat(64),
      installState: 'active',
    });
    assert.equal(state.installState, 'active');
    assert.throws(
      () => service.recordPluginState({ ...state, packageSha256: '../unsafe' }),
      /PURCHASE_BROWSER_EXTENSION_HASH_INVALID/u,
    );
  } finally {
    db.close();
  }
});
