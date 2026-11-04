import assert from 'node:assert/strict';
import test from 'node:test';
import { createShopRepository } from '../src/db/repositories/shopRepository.js';
import { createReturnsService } from '../src/domain/returns/returnsService.js';
import { listReturnsWriteActions } from '../src/domain/returns/returnsWriteService.js';
import { createWriteGuardService } from '../src/security/writeGuardService.js';
import { createMigratedTestDb, saveUnitShop } from './testDb.js';

function createReturnsWriteFixture({ writeResult } = {}) {
  const db = createMigratedTestDb();
  const shopRepository = createShopRepository(db);
  const shopId = saveUnitShop(shopRepository, 'shop_returns_write');
  const schedulerCalls = [];
  const returnsService = createReturnsService({
    db,
    ozonScheduler: {
      async executeWrite(input) {
        schedulerCalls.push(input);
        return typeof writeResult === 'function'
          ? writeResult(input)
          : writeResult || {
              ok: true,
              status: 'success',
              jobId: 'returns-write-job-1',
              realWrite: input.realWrite === true,
              dryRun: input.dryRun === true,
              readBackRows: [{ return_id: 'ret-1', posting_number: 'posting-1', status: 'approved' }],
              data: { result: true },
            };
      },
    },
    backgroundRunner() {},
  });
  const guard = createWriteGuardService(db, {
    executors: {
      returns: (context) => returnsService.executeConfirmedWrite(context),
    },
  });
  return { db, shopId, schedulerCalls, returnsService, guard };
}

test('returns write executor maps action to endpoint and only marks complete after readback merge', async () => {
  const { db, shopId, schedulerCalls, returnsService, guard } = createReturnsWriteFixture();
  try {
    const preview = guard.previewWrite('returns', {
      shopId,
      action: 'verifyRfbsReturn',
      endpointKey: 'returns.verifyRfbsReturn',
      payload: { return_id: 'ret-1', comment: 'ok' },
      after: { return_id: 'ret-1', status: 'approved' },
      idempotencyKey: 'returns-write-1',
    });
    const confirm = await guard.confirmWrite('returns', {
      previewId: preview.previewId,
      confirm: true,
      shopId,
      action: 'verifyRfbsReturn',
      endpointKey: 'returns.verifyRfbsReturn',
      realWrite: true,
      dryRun: false,
      idempotencyKey: 'returns-write-1',
    });

    assert.equal(confirm.ok, true);
    assert.equal(confirm.writeStatus, 'readback_merged');
    assert.match(confirm.message, /SQLite 已合并/u);
    assert.equal(confirm.readBack.rows, 1);
    assert.equal(schedulerCalls.length, 1);
    assert.equal(schedulerCalls[0].domain, 'returns');
    assert.equal(schedulerCalls[0].endpointKey, 'returns.verifyRfbsReturn');
    assert.equal(schedulerCalls[0].action, 'verifyRfbsReturn');
    assert.equal(schedulerCalls[0].realWrite, true);
    assert.equal(schedulerCalls[0].dryRun, false);

    const cache = returnsService.readCache({ shopId, returnIds: 'ret-1' });
    assert.equal(cache.total, 1);
    assert.equal(cache.rows[0].return_id, 'ret-1');
    assert.equal(cache.rows[0].posting_number, 'posting-1');
    assert.equal(cache.rows[0].status, 'approved');
  } finally {
    db.close();
  }
});

test('returns write executor registers every after-sales write action with canonical endpoint keys', () => {
  const { db } = createReturnsWriteFixture();
  try {
    const actions = Object.fromEntries(
      listReturnsWriteActions().map((item) => [item.action, item.endpointKey])
    );

    assert.deepEqual(actions, {
      setRfbsReturnAction: 'returns.setRfbsReturnAction',
      rejectRfbsReturn: 'returns.rejectRfbsReturn',
      compensateRfbsReturn: 'returns.compensateRfbsReturn',
      verifyRfbsReturn: 'returns.verifyRfbsReturn',
      receiveRfbsReturn: 'returns.receiveRfbsReturn',
      refundRfbsReturn: 'returns.refundRfbsReturn',
      approveConditionalCancellation: 'returns.approveConditionalCancellation',
      rejectConditionalCancellation: 'returns.rejectConditionalCancellation',
    });
  } finally {
    db.close();
  }
});

test('returns write executor keeps submitted status when Ozon result has no readback rows', async () => {
  const fixture = createReturnsWriteFixture({
    writeResult(input) {
      return {
        ok: true,
        status: 'success',
        jobId: 'returns-write-job-no-readback',
        realWrite: input.realWrite === true,
        dryRun: false,
        data: { result: true },
      };
    },
  });
  const { db, shopId, guard } = fixture;
  try {
    const preview = guard.previewWrite('returns', {
      shopId,
      action: 'rejectRfbsReturn',
      endpointKey: 'returns.rejectRfbsReturn',
      payload: { return_id: 'ret-no-readback', comment: 'reject reason' },
    });
    const confirm = await guard.confirmWrite('returns', {
      previewId: preview.previewId,
      confirm: true,
      shopId,
      action: 'rejectRfbsReturn',
      endpointKey: 'returns.rejectRfbsReturn',
      realWrite: true,
      dryRun: false,
    });

    assert.equal(confirm.ok, true);
    assert.equal(confirm.writeStatus, 'submitted_waiting_readback');
    assert.equal(confirm.readBack.status, 'pending');
    assert.match(confirm.message, /仅显示处理中/u);
    assert.doesNotMatch(confirm.message, /写入完成/u);
  } finally {
    db.close();
  }
});

test('returns write executor rejects endpoint override for registered action', async () => {
  const { db, shopId, schedulerCalls, guard } = createReturnsWriteFixture();
  try {
    const preview = guard.previewWrite('returns', {
      shopId,
      action: 'refundRfbsReturn',
      endpointKey: 'returns.refundRfbsReturn',
      payload: { return_id: 'ret-override' },
    });
    const confirm = await guard.confirmWrite('returns', {
      previewId: preview.previewId,
      confirm: true,
      shopId,
      action: 'refundRfbsReturn',
      endpointKey: 'returns.rejectRfbsReturn',
      realWrite: true,
      dryRun: false,
    });

    assert.equal(confirm.ok, false);
    assert.equal(confirm.error.code, 'RETURNS_WRITE_ENDPOINT_MISMATCH');
    assert.equal(schedulerCalls.length, 0);
  } finally {
    db.close();
  }
});
