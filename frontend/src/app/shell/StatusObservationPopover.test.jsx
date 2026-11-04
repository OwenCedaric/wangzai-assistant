import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StatusObservationPopover } from './StatusObservationPopover.jsx';
import { formatRetryCountdown } from './statusObservation/statusObservationPlainLanguage.js';

describe('StatusObservationPopover', () => {
  afterEach(() => vi.useRealTimers());

  it('translates page performance into wording ordinary users can understand', () => {
    render(
      <StatusObservationPopover
        open
        anchorEl={document.body}
        onClose={() => {}}
        workspacePerformanceStats={{
          navigation: { count: 3, p95Ms: 140, last: { pageId: 'products' } },
          longTasks: { count: 2, over100ms: 0, maxMs: 70 },
        }}
        continuousSyncStatus={null}
        schedulerStatus={{}}
        maintenanceStatus={{ loaded: true, ok: true }}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /软件速度/ }));
    expect(screen.getByText('页面打开速度')).toBeInTheDocument();
    expect(screen.getByText('最近页面打开速度正常')).toBeInTheDocument();
    expect(screen.queryByText(/p95|主线程/)).not.toBeInTheDocument();
  });

  it('shows product cache failure, retry countdown, and the current product queue', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-12T00:08:00.000Z'));
    render(
      <StatusObservationPopover
        open
        anchorEl={document.body}
        onClose={() => {}}
        continuousSyncStatus={{
          ok: true,
          enabled: true,
          lastRun: { at: '2026-07-12T00:00:00.000Z', accepted: 1, rejected: 0 },
          targets: [{
            shopId: 'shop-1',
            policyId: 'products:all',
            domain: 'products',
            lastResult: {
              accepted: true,
              jobStatus: 'failed',
              jobLastError: 'Ozon temporarily unavailable',
              jobRetryAt: '2026-07-12T00:05:00.000Z',
            },
          }],
        }}
        schedulerStatus={{
          ok: true,
          queue: {
            queued: 3,
            running: 1,
            queuedItems: [
              { domain: 'products' },
              { domain: 'products' },
              { domain: 'orders' },
            ],
          },
        }}
        maintenanceStatus={{ loaded: true, ok: true }}
      />
    );

    expect(screen.getByText('商品缓存更新失败')).toBeInTheDocument();
    expect(screen.getByText(/Ozon 服务暂时不可用/)).toBeInTheDocument();
    expect(formatRetryCountdown('2026-07-12T00:10:00.000Z', Date.parse('2026-07-12T00:08:00.000Z')))
      .toBe('约 2 分钟后自动重试');
    expect(screen.getAllByText(/自动重试/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/商品缓存排队 2 个/).length).toBeGreaterThan(0);
    expect(screen.getByText(/正在处理 1 个，当前排队 3 个/)).toBeInTheDocument();
    expect(screen.getByText(/无需操作：系统会自动重试/)).toBeInTheDocument();
  });

  it('shows hidden maintenance findings as plain data-safety messages', () => {
    render(
      <StatusObservationPopover
        open
        anchorEl={document.body}
        onClose={() => {}}
        continuousSyncStatus={null}
        schedulerStatus={{}}
        maintenanceStatus={{
          loaded: true,
          ok: true,
          manualAssignmentRows: 4,
          emptyShopRows: 4,
        }}
      />
    );

    expect(screen.getByText('4 条数据需要选择所属店铺')).toBeInTheDocument();
    expect(screen.getByText(/系统无法安全判断/)).toBeInTheDocument();
    expect(screen.getByText(/需要你操作：需要你确认所属店铺/)).toBeInTheDocument();
  });

  it('shows the real per-domain hot-cache hit state', () => {
    render(
      <StatusObservationPopover
        open
        anchorEl={document.body}
        onClose={() => {}}
        continuousSyncStatus={{
          ok: true,
          targets: [],
          hotCache: {
            orders: { readThrough: { entries: 2, metrics: { hits: 6, misses: 2 } } },
            'data-analysis': { entries: 1, metrics: { hits: 3, misses: 1 } },
          },
        }}
        schedulerStatus={{}}
        maintenanceStatus={{ loaded: true, ok: true }}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /软件速度/ }));
    expect(screen.getByText('页面热缓存')).toBeInTheDocument();
    expect(screen.getByText('页面正在复用已读取的数据')).toBeInTheDocument();
    expect(screen.getByText(/当前 3 份 · 命中 9 次 · 命中率 75%/)).toBeInTheDocument();
  });
});
