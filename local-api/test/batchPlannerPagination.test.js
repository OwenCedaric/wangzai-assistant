import assert from 'node:assert/strict';
import test from 'node:test';
import { createBatchPlanner, createPaginationState } from '../src/ozon/batchPlanner.js';

const baseRequest = { domain: 'products', shopId: 'shop-1', endpointKey: 'products.infoList', action: 'sync', priority: 'P1' };

function endpoint(planning) {
  return { key: 'unit.endpoint', planning };
}

test('batchPlanner supports ids chunking', () => {
  const batches = createBatchPlanner().plan({ ...baseRequest, params: { ids: [1, 2, 2, 3, 4] } }, endpoint({ mode: 'ids', arrayParam: 'ids', batchSize: 2 }));
  assert.equal(batches.length, 2);
  assert.deepEqual(batches[0].params.ids, [1, 2]);
  assert.equal(batches[0].mode, 'ids');
});

test('batchPlanner supports offset pagination and max page truncation', () => {
  const batches = createBatchPlanner().plan({ ...baseRequest, params: { limit: 20, offset: 0 } }, endpoint({ mode: 'offset', maxLimit: 50, defaultLimit: 20, maxPages: 3 }));
  assert.equal(batches.length, 3);
  assert.deepEqual(batches.map((item) => item.params.offset), [0, 20, 40]);
});

test('batchPlanner rejects limit above maxLimit', () => {
  assert.throws(
    () => createBatchPlanner().plan({ ...baseRequest, params: { limit: 1000 } }, endpoint({ mode: 'offset', maxLimit: 100 })),
    /maxLimit/u,
  );
});

test('batchPlanner supports cursor next page and duplicate cursor stop', () => {
  const planner = createBatchPlanner();
  const [first] = planner.plan({ ...baseRequest, params: { limit: 10 } }, endpoint({ mode: 'cursor', nextCursorPath: 'result.cursor', maxPages: 3 }));
  const state = createPaginationState();
  const next = planner.nextPage(baseRequest, endpoint({ mode: 'cursor', nextCursorPath: 'result.cursor', maxPages: 3 }), first, { data: { result: { cursor: 'abc', items: [1] } } }, state);
  assert.equal(next.done, false);
  assert.equal(next.batch.cursor, 'abc');
  const duplicate = planner.nextPage(baseRequest, endpoint({ mode: 'cursor', nextCursorPath: 'result.cursor', maxPages: 3 }), next.batch, { data: { result: { cursor: 'abc', items: [2] } } }, state);
  assert.equal(duplicate.done, true);
  assert.equal(duplicate.reason, 'duplicate_cursor');
});

test('batchPlanner supports last_id next page and duplicate last_id stop', () => {
  const planner = createBatchPlanner();
  const [first] = planner.plan({ ...baseRequest, params: { limit: 10 } }, endpoint({ mode: 'last_id', nextLastIdPath: 'result.last_id', maxPages: 3 }));
  const state = createPaginationState();
  const next = planner.nextPage(baseRequest, endpoint({ mode: 'last_id', nextLastIdPath: 'result.last_id', maxPages: 3 }), first, { data: { result: { last_id: '10', items: [1] } } }, state);
  assert.equal(next.done, false);
  assert.equal(next.batch.lastId, '10');
  const duplicate = planner.nextPage(baseRequest, endpoint({ mode: 'last_id', nextLastIdPath: 'result.last_id', maxPages: 3 }), next.batch, { data: { result: { last_id: '10', items: [2] } } }, state);
  assert.equal(duplicate.done, true);
  assert.equal(duplicate.reason, 'duplicate_last_id');
});

test('batchPlanner stops on empty pages and duplicate payload hashes', () => {
  const planner = createBatchPlanner();
  const [first] = planner.plan({ ...baseRequest, params: { limit: 10, offset: 0 } }, endpoint({ mode: 'offset', maxPages: 2 }));
  const empty = planner.nextPage(baseRequest, endpoint({ mode: 'offset', maxPages: 2 }), first, { data: { result: [] } }, createPaginationState());
  assert.equal(empty.done, true);
  assert.equal(empty.reason, 'empty_page');

  const state = createPaginationState();
  state.seenPayloadHashes.add(first.payloadHash);
  const repeated = planner.nextPage(baseRequest, endpoint({ mode: 'offset', maxPages: 2 }), { ...first, params: { limit: 10, offset: -10 } }, { data: { result: [1] } }, state);
  assert.equal(repeated.done, true);
  assert.equal(repeated.reason, 'duplicate_payload_hash');
});

test('batchPlanner supports date windows and current_page_first', () => {
  const dateBatches = createBatchPlanner().plan(
    { ...baseRequest, params: { since: '2026-01-01T00:00:00.000Z', to: '2026-01-15T00:00:00.000Z' } },
    endpoint({ mode: 'date_window', dateFromParam: 'since', dateToParam: 'to', windowDays: 7, maxBatches: 5 }),
  );
  assert.equal(dateBatches.length, 3);
  assert.equal(Boolean(dateBatches[0].dateWindow), true);

  const current = createBatchPlanner().plan({ ...baseRequest, params: { limit: 20, offset: 20, page: 2 } }, endpoint({ mode: 'current_page_first', maxPages: 3, maxLimit: 50 }));
  assert.equal(current[0].isCurrentPage, true);
  assert.equal(current[0].mode, 'current_page_first');
});
