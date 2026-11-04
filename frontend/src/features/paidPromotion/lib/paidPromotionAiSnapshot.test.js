import { describe, expect, it } from 'vitest';
import { inspectPaidPromotionAiSnapshot, requirePaidPromotionAiSnapshot } from './paidPromotionAiSnapshot.js';

const NOW = Date.parse('2026-08-13T08:00:00.000Z');

describe('paid promotion AI snapshot guard', () => {
  it('rejects a local instant-open snapshot even when its data looks complete', () => {
    const result = inspectPaidPromotionAiSnapshot({
      ok: true,
      finishedAt: '2026-08-13T07:59:50.000Z',
      cache: { fallback: true },
      freshness: { live: false },
      aiReadiness: { ready: true },
    }, NOW);
    expect(result.ready).toBe(false);
    expect(result.reason).toContain('本地秒开快照');
  });

  it('rejects incomplete and expired realtime snapshots', () => {
    expect(() => requirePaidPromotionAiSnapshot({
      ok: true,
      freshness: { live: true },
      aiReadiness: {
        ready: false,
        capturedAt: '2026-08-13T07:59:50.000Z',
        incompleteDataSets: ['expenseStatistics'],
      },
    }, NOW)).toThrow(/尚未完整/u);

    expect(inspectPaidPromotionAiSnapshot({
      ok: true,
      freshness: { live: true },
      aiReadiness: { ready: true, capturedAt: '2026-08-13T07:55:00.000Z', maxAgeMs: 120_000 },
    }, NOW).ready).toBe(false);
  });

  it('accepts only a complete fresh live snapshot', () => {
    const overview = {
      ok: true,
      freshness: { live: true },
      aiReadiness: { ready: true, capturedAt: '2026-08-13T07:59:30.000Z', maxAgeMs: 120_000 },
    };
    expect(requirePaidPromotionAiSnapshot(overview, NOW)).toBe(overview);
  });
});
