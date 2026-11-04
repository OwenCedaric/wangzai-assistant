import { describe, expect, it } from 'vitest';
import {
  buildPageDataset,
  buildRefreshChangeSummary,
  buildRowsIndex,
  buildStatusCounts,
  createLocalMirrorReadLog,
  createLocalMirrorRetryTask,
  filterRowsByShopScope,
  filterRowsByStatus,
  mergeLocalMirrorRetryQueue,
  paginateRows,
  queryRowsIndex,
  resolveLocalMirrorDataState,
  rowMatchesShopScope,
  validatePageDatasetConsistency,
} from './localMirrorDataset.js';

const statusTabs = [
  { label: '全部订单', value: 'all' },
  { label: '等待发货', value: 'waiting' },
  { label: '已经发货', value: 'shipped' },
];

describe('localMirrorDataset', () => {
  it('filters rows by shop scope without collapsing same offer ids across shops', () => {
    const rows = [
      { id: 'a-1', shopClientId: 'client-a', shop: 'Ozon 1店', offerId: 'same-offer' },
      { id: 'b-1', shopClientId: 'client-b', shop: 'Ozon 2店', offerId: 'same-offer' },
    ];

    expect(filterRowsByShopScope(rows, 'all')).toHaveLength(2);
    expect(filterRowsByShopScope(rows, 'Ozon 1店', { getRowShop: (row) => [row.shop, row.shopClientId] })).toEqual([
      rows[0],
    ]);
    expect(rowMatchesShopScope(rows[1], ['client-b', 'Ozon 2店'])).toBe(true);
  });

  it('builds status counts from the searched shop dataset before applying the selected status', () => {
    const rows = [
      { id: '1', shop: 'A', status: 'waiting', posting: 'A-001' },
      { id: '2', shop: 'A', status: 'shipped', posting: 'A-002' },
      { id: '3', shop: 'B', status: 'waiting', posting: 'B-001' },
    ];

    const dataset = buildPageDataset(rows, {
      shopScope: 'A',
      getRowShop: (row) => row.shop,
      beforeStatusFilter: (row) => row.posting.includes('A-'),
      statusValue: 'waiting',
      statusRules: statusTabs,
      matchesStatus: (row, status) => row.status === status,
      page: 1,
      pageSize: 20,
    });

    expect(dataset.statusCounts).toEqual({ all: 2, waiting: 1, shipped: 1 });
    expect(dataset.filteredRows).toEqual([rows[0]]);
    expect(dataset.pageRows).toEqual([rows[0]]);
    expect(dataset.consistency).toEqual({ ok: true, issues: [] });
  });

  it('searches the full current scope before pagination', () => {
    const rows = Array.from({ length: 30 }, (_, index) => ({
      id: String(index + 1),
      shop: 'A',
      status: index === 24 ? 'waiting' : 'shipped',
      sku: index === 24 ? 'needle-sku' : `sku-${index + 1}`,
    }));

    const dataset = buildPageDataset(rows, {
      shopScope: 'A',
      getRowShop: (row) => row.shop,
      beforeStatusFilter: (row) => row.sku.includes('needle'),
      statusValue: 'all',
      statusRules: statusTabs,
      matchesStatus: (row, status) => row.status === status,
      page: 1,
      pageSize: 20,
    });

    expect(dataset.pageRows).toHaveLength(1);
    expect(dataset.pageRows[0].id).toBe('25');
    expect(dataset.statusCounts).toEqual({ all: 1, waiting: 1, shipped: 0 });
    expect(dataset.consistency).toEqual({ ok: true, issues: [] });
  });

  it('validates page dataset counts, pagination, and same-source detail rows', () => {
    const rows = [
      { id: '1', shop: 'A', status: 'waiting' },
      { id: '2', shop: 'A', status: 'shipped' },
    ];
    const dataset = buildPageDataset(rows, {
      shopScope: 'A',
      getRowShop: (row) => row.shop,
      getRowKey: (row) => row.id,
      selectedDetail: rows[1],
      statusValue: 'all',
      statusRules: statusTabs,
      page: 1,
      pageSize: 20,
    });

    expect(dataset.consistency).toEqual({ ok: true, issues: [] });
    expect(
      validatePageDatasetConsistency(
        {
          ...dataset,
          statusCounts: { ...dataset.statusCounts, all: 1 },
        },
        { getRowKey: (row) => row.id }
      ).issues.map((issue) => issue.code)
    ).toContain('status-count-mismatch');
    expect(
      validatePageDatasetConsistency(
        {
          ...dataset,
          page: { ...dataset.page, totalRows: 99 },
        },
        { getRowKey: (row) => row.id }
      ).issues.map((issue) => issue.code)
    ).toContain('page-total-mismatch');
    expect(
      validatePageDatasetConsistency(
        {
          ...dataset,
          selectedDetail: { id: 'missing', shop: 'A' },
        },
        { getRowKey: (row) => row.id }
      ).issues.map((issue) => issue.code)
    ).toContain('detail-row-outside-source');
  });

  it('separates not-loaded, empty, failed, partial, and filtered-empty dataset states', () => {
    expect(resolveLocalMirrorDataState({ status: 'miss', rows: 0 })).toMatchObject({
      state: 'not_loaded',
      sourceStatus: 'local-cache:not_loaded',
    });
    expect(resolveLocalMirrorDataState({ hasLoaded: true, rows: 0 })).toMatchObject({
      state: 'empty',
      isEmpty: true,
    });
    expect(resolveLocalMirrorDataState({ rows: 0, failures: 1 })).toMatchObject({
      state: 'failed',
      isFailed: true,
    });
    expect(resolveLocalMirrorDataState({ rows: 2, failures: 1 })).toMatchObject({
      state: 'partial',
      isPartial: true,
    });

    const dataset = buildPageDataset([{ id: '1', shop: 'A', status: 'waiting', sku: 'visible' }], {
      shopScope: 'A',
      getRowShop: (row) => row.shop,
      beforeStatusFilter: (row) => row.sku.includes('missing'),
      statusValue: 'all',
      statusRules: statusTabs,
      hasLoaded: true,
    });

    expect(dataset.pageRows).toHaveLength(0);
    expect(dataset.dataState).toMatchObject({
      state: 'ready',
      hasRows: true,
      hasFilteredRows: false,
    });
  });

  it('queries indexed rows by shop, status, and associated order keywords', () => {
    const rows = [
      {
        id: '1',
        shop: 'Ozon 1店',
        shopClientId: 'client-a',
        status: 'waiting',
        posting: '11279330-0313-1',
        sku: 'mz-26050715-590867',
        product: 'Sealant gun',
      },
      {
        id: '2',
        shop: 'Ozon 2店',
        shopClientId: 'client-b',
        status: 'waiting',
        posting: '11279330-0313-1',
        sku: 'same-sku-other-shop',
        product: 'Other shop item',
      },
      {
        id: '3',
        shop: 'Ozon 1店',
        shopClientId: 'client-a',
        status: 'shipped',
        posting: '67012372-0248-1',
        sku: 'bag-1',
        product: 'Shoulder bag',
      },
    ];
    const index = buildRowsIndex(rows, {
      getRowKey: (row) => `${row.shopClientId}:${row.id}`,
      getRowShop: (row) => [row.shop, row.shopClientId],
      getRowStatuses: (row) => [row.status],
      getSearchValues: (row) => [row.posting, row.sku, row.product],
    });

    expect(
      queryRowsIndex(index, {
        shopScope: 'client-a',
        statusValue: 'waiting',
        keyword: '26050715',
      }).map((row) => row.id)
    ).toEqual(['1']);
    expect(
      queryRowsIndex(index, {
        shopScope: 'all',
        allStatusValue: 'all',
        statusValue: 'all',
        keyword: '1127933003131',
      }).map((row) => row.id)
    ).toEqual(['1', '2']);
  });

  it('prefers exact compact identifier matches before broad prefix tokens', () => {
    const rows = [
      { id: '1', shop: 'A', posting: '11279330-0313-1', sku: 'mz-26050715-590867' },
      { id: '2', shop: 'A', posting: '11279330-0314-1', sku: 'mz-26050715-590868' },
      { id: '3', shop: 'A', posting: '99887766-0001-1', sku: 'other' },
    ];
    const index = buildRowsIndex(rows, {
      getRowKey: (row) => row.id,
      getRowShop: (row) => row.shop,
      getSearchValues: (row) => [row.posting, row.sku],
    });

    expect(queryRowsIndex(index, { keyword: '1127933003131' }).map((row) => row.id)).toEqual(['1']);
    expect(queryRowsIndex(index, { keyword: '590867' }).map((row) => row.id)).toEqual(['1']);
  });

  it('indexes full-width Chinese punctuation for local search', () => {
    const rows = [
      {
        id: '1',
        shop: 'A',
        purchaseInfo: '采购单号：PO-778899；SKU：mz-26050715-590867',
        product: '胶枪、黄色',
      },
      {
        id: '2',
        shop: 'A',
        purchaseInfo: '采购单号：PO-000001；SKU：other',
        product: '肩包，黑色',
      },
    ];
    const index = buildRowsIndex(rows, {
      getRowKey: (row) => row.id,
      getRowShop: (row) => row.shop,
      getSearchValues: (row) => [row.purchaseInfo, row.product],
    });

    expect(queryRowsIndex(index, { keyword: 'PO778899' }).map((row) => row.id)).toEqual(['1']);
    expect(queryRowsIndex(index, { keyword: 'mz26050715590867' }).map((row) => row.id)).toEqual(['1']);
    expect(queryRowsIndex(index, { keyword: '胶枪 黄色' }).map((row) => row.id)).toEqual(['1']);
  });

  it('paginates with stable range metadata', () => {
    const rows = Array.from({ length: 42 }, (_, index) => ({ id: index + 1 }));

    expect(paginateRows(rows, 3, 20)).toMatchObject({
      totalRows: 42,
      totalPages: 3,
      currentPage: 3,
      rangeStart: 41,
      rangeEnd: 42,
      rows: [{ id: 41 }, { id: 42 }],
    });
    expect(filterRowsByStatus(rows, 'all')).toHaveLength(42);
  });

  it('summarizes refresh changes and records skipped empty fields and failures', () => {
    const summary = buildRefreshChangeSummary(
      [
        { id: '1', status: 'old' },
        { id: '2', status: 'same' },
      ],
      [
        { id: '1', status: 'new' },
        { id: '2', status: 'same' },
        { id: '3', status: 'added' },
      ],
      { skippedEmpty: 4, failed: 2 }
    );

    expect(summary).toEqual({
      previous: 2,
      next: 3,
      added: 1,
      updated: 1,
      unchanged: 1,
      removed: 0,
      skippedEmpty: 4,
      failed: 2,
    });
  });

  it('creates local mirror logs without leaking secrets', () => {
    const uuidSecret = '11111111-2222-3333-4444-555555555555';
    const log = createLocalMirrorReadLog({
      domain: 'salesOrders',
      shopScope: ['client-a'],
      rows: 10,
      failures: 1,
      details: {
        clientId: 'client-a',
        apiKey: 'redacted-api-key-placeholder',
        message: `token=${uuidSecret}`,
        nested: { clientSecret: 'redacted-client-secret-placeholder', raw: `failed with ${uuidSecret}`, ok: true },
      },
    });

    expect(log.details).toMatchObject({
      clientId: '[REDACTED]',
      apiKey: '[REDACTED]',
      message: '[REDACTED]',
      nested: { clientSecret: '[REDACTED]', raw: 'failed with [REDACTED]', ok: true },
    });
    expect(log).toMatchObject({
      sourceStatus: 'local-cache:partial',
      dataState: {
        state: 'partial',
        rows: 10,
        failures: 1,
      },
    });
  });

  it('redacts raw Ozon client ids from read logs and snapshot keys', () => {
    const log = createLocalMirrorReadLog({
      domain: 'warehouse',
      shopScope: 'ozon-shop:client:4616153|ozon-shop:client:4917820',
      rows: 2,
      details: {
        clientId: '4616153',
        snapshotKey: 'ozon-warehouse-v1:ozon-warehouse-products:ozon-shop:client:4917820:all',
        nested: {
          localSnapshotKey: 'ozon-purchase-orders:ozon-shop:client:4616153|ozon-shop:client:4917820:purchase-orders',
        },
      },
    });

    const serialized = JSON.stringify(log);
    expect(serialized).not.toContain('4616153');
    expect(serialized).not.toContain('4917820');
    expect(serialized).not.toContain('ozon-shop:client:');
    expect(log.shopScope).toBe('[REDACTED]|[REDACTED]');
    expect(log.details.clientId).toBe('[REDACTED]');
    expect(log.details.snapshotKey).toBe('ozon-warehouse-v1:ozon-warehouse-products:[REDACTED]:all');
  });

  it('creates bounded local mirror retry tasks with backoff and redaction', () => {
    const firstQueue = mergeLocalMirrorRetryQueue(
      {},
      {
        domain: '05_sales_orders',
        source: 'local-cache',
        entityType: 'snapshot',
        entityKey: 'ozon-sales-orders:shop-a',
        fileKey: 'ozon-local-data-layer',
        snapshotKey: 'ozon-sales-orders:shop-a',
        reason: 'token=11111111-2222-3333-4444-555555555555 failed',
        maxAttempts: 2,
      },
      { now: '2026-06-23T00:00:00.000Z' }
    );

    expect(firstQueue.rows[0]).toMatchObject({
      domain: '05_sales_orders',
      entityType: 'snapshot',
      attemptCount: 1,
      maxAttempts: 2,
      status: 'pending',
      nextRetryAt: '2026-06-23T00:00:30.000Z',
    });
    expect(JSON.stringify(firstQueue)).not.toContain('11111111-2222-3333-4444-555555555555');

    const secondQueue = mergeLocalMirrorRetryQueue(
      firstQueue,
      {
        domain: '05_sales_orders',
        source: 'local-cache',
        entityType: 'snapshot',
        entityKey: 'ozon-sales-orders:shop-a',
        fileKey: 'ozon-local-data-layer',
        snapshotKey: 'ozon-sales-orders:shop-a',
        reason: 'HTTP 429',
        maxAttempts: 2,
      },
      { now: '2026-06-23T00:01:00.000Z' }
    );

    expect(secondQueue.rows).toHaveLength(1);
    expect(secondQueue.rows[0]).toMatchObject({
      attemptCount: 2,
      status: 'paused',
      nextRetryAt: '',
      retryDelayMs: 0,
      firstFailedAt: '2026-06-23T00:00:00.000Z',
      lastFailedAt: '2026-06-23T00:01:00.000Z',
    });
  });

  it('keeps local mirror retry queues bounded', () => {
    let queue = {};
    for (let index = 0; index < 510; index += 1) {
      queue = mergeLocalMirrorRetryQueue(
        queue,
        { domain: '03_products', entityType: 'productMirror', entityKey: `shop-${index}`, reason: 'failed' },
        { now: new Date(Date.parse('2026-06-23T00:00:00.000Z') + index * 1000).toISOString() }
      );
    }

    expect(queue.rows).toHaveLength(500);
    expect(queue.rows.some((row) => row.entityKey === 'shop-509')).toBe(true);
    expect(queue.rows.some((row) => row.entityKey === 'shop-0')).toBe(false);
  });

  it('creates direct retry tasks when callers need to inspect one item', () => {
    expect(
      createLocalMirrorRetryTask(
        { domain: '09_after_sales', entityType: 'domainSnapshot', entityKey: 'after-sales', retryAfterMs: 120000 },
        null,
        { now: '2026-06-23T00:00:00.000Z' }
      )
    ).toMatchObject({
      attemptCount: 1,
      retryDelayMs: 120000,
      nextRetryAt: '2026-06-23T00:02:00.000Z',
    });
  });

  it('builds direct status counts for product-like status tabs', () => {
    const counts = buildStatusCounts(
      [{ status: '出售中' }, { status: '出售中' }, { status: '待销售' }],
      [{ label: '全部商品' }, { label: '出售中' }, { label: '待销售' }],
      {
        allValue: '全部商品',
        matchesStatus: (row, status) => row.status === status,
      }
    );

    expect(counts).toEqual({ 全部商品: 3, 出售中: 2, 待销售: 1 });
  });
});
