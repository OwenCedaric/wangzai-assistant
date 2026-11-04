import assert from 'node:assert/strict';
import test from 'node:test';
import { createShopRepository } from '../../db/repositories/shopRepository.js';
import { createMigratedTestDb, saveUnitShop } from '../../../test/testDb.js';
import {
  createReportsService,
  getOzonBusinessDate,
  resolveReportsDateRange,
} from './reportsService.js';

const CHINA_NEXT_DAY_MOSCOW_PREVIOUS_DAY = new Date('2026-07-31T20:30:00.000Z');

test('reports uses the Moscow business date when China has already crossed midnight', () => {
  assert.equal(getOzonBusinessDate(CHINA_NEXT_DAY_MOSCOW_PREVIOUS_DAY), '2026-07-31');
  assert.deepEqual(resolveReportsDateRange({}, CHINA_NEXT_DAY_MOSCOW_PREVIOUS_DAY), {
    startDate: '2026-07-02',
    endDate: '2026-07-31',
  });
});

test('reports truncates an explicit future end date to the current Moscow date', () => {
  assert.deepEqual(
    resolveReportsDateRange(
      { startDate: '2026-07-03', endDate: '2026-08-01' },
      CHINA_NEXT_DAY_MOSCOW_PREVIOUS_DAY,
    ),
    { startDate: '2026-07-03', endDate: '2026-07-31' },
  );
});

test('reports never swaps a future start date back into the outgoing range', () => {
  assert.deepEqual(
    resolveReportsDateRange(
      { startDate: '2026-08-05', endDate: '2026-08-01' },
      CHINA_NEXT_DAY_MOSCOW_PREVIOUS_DAY,
    ),
    { startDate: '2026-07-31', endDate: '2026-07-31' },
  );
});

test('reports preserves a valid historical range', () => {
  assert.deepEqual(
    resolveReportsDateRange(
      { startDate: '2026-06-01', endDate: '2026-06-30' },
      CHINA_NEXT_DAY_MOSCOW_PREVIOUS_DAY,
    ),
    { startDate: '2026-06-01', endDate: '2026-06-30' },
  );
});

test('reports sends the capped Moscow range to Ozon instead of the renderer future date', async (t) => {
  const db = createMigratedTestDb();
  t.after(() => db.close());
  saveUnitShop(createShopRepository(db), 'shop-a');
  const schedulerCalls = [];
  let backgroundTask = null;
  const service = createReportsService({
    db,
    clock: () => CHINA_NEXT_DAY_MOSCOW_PREVIOUS_DAY,
    backgroundRunner(task) {
      backgroundTask = task;
    },
    ozonScheduler: {
      async executeReadOnly(input) {
        schedulerCalls.push(input);
        return {
          ok: true,
          data: {
            result: {
              data: [
                {
                  dimensions: [{ id: '2026-07-31' }],
                  metrics: [1000, 4, 20, 5, 12],
                },
              ],
            },
          },
        };
      },
    },
  });

  const submitted = service.startSync({
    shopId: 'shop-a',
    startDate: '2026-07-03',
    endDate: '2026-08-01',
  });
  assert.deepEqual(submitted.dateRange, { startDate: '2026-07-03', endDate: '2026-07-31' });
  assert.equal(typeof backgroundTask, 'function');

  const completed = await backgroundTask();

  assert.equal(completed.job.status, 'success');
  assert.equal(schedulerCalls.length, 1);
  assert.equal(schedulerCalls[0].shopId, 'shop-a');
  assert.equal(schedulerCalls[0].params.date_from, '2026-07-03');
  assert.equal(schedulerCalls[0].params.date_to, '2026-07-31');
});
