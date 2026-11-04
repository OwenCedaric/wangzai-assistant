import { describe, expect, it } from 'vitest';
import {
  getAfterSalesHandlingCountdown,
  getAfterSalesHandlingDeadlineMs,
} from './afterSalesHandlingCountdown';

describe('after-sales handling countdown', () => {
  it('shows waiting when Ozon returns neither a deadline nor an available action', () => {
    expect(
      getAfterSalesHandlingCountdown({
        raw: { state: { state: 'OnWayToOzon' }, available_actions: [] },
      }, { nowMs: Date.parse('2026-08-22T14:00:00Z') })
    ).toEqual({ label: '等待 Ozon 处理', tone: 'waiting', deadlineMs: 0 });
  });

  it('shows immediately actionable when actions exist but Ozon supplies no deadline', () => {
    expect(
      getAfterSalesHandlingCountdown({ raw: { available_actions: [{ id: 12, name: 'COMPENSATE' }] } })
    ).toMatchObject({ label: '当前可处理', tone: 'ready', deadlineMs: 0 });
  });

  it('reads an action deadline and formats the remaining time', () => {
    const order = {
      raw: {
        available_actions: [{ id: 7, name: 'REJECT', deadline_at: '2026-08-24T17:30:00Z' }],
      },
    };
    expect(getAfterSalesHandlingDeadlineMs(order)).toBe(Date.parse('2026-08-24T17:30:00Z'));
    expect(
      getAfterSalesHandlingCountdown(order, { nowMs: Date.parse('2026-08-22T14:00:00Z') })
    ).toMatchObject({ label: '处理倒计时：剩余 2天 3小时', tone: 'active' });
  });

  it('marks an expired explicit deadline instead of inventing more time', () => {
    expect(
      getAfterSalesHandlingCountdown(
        { raw: { decisionDeadline: '2026-08-22T13:59:00Z' } },
        { nowMs: Date.parse('2026-08-22T14:00:00Z') }
      )
    ).toMatchObject({ label: '处理期限已截止', tone: 'overdue' });
  });
});
