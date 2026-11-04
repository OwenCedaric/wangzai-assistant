import { describe, expect, it } from 'vitest';
import {
  buildAfterSalesOperationRequest,
  createAfterSalesOperationForm,
  getAfterSalesOperationPlan,
  shouldLoadAfterSalesOperationPlan,
} from './afterSalesOperation';

describe('afterSalesOperation', () => {
  it('uses the latest Ozon rFBS actions instead of guessing from display status', () => {
    const plan = getAfterSalesOperationPlan(
      { source: 'rfbs-return', returnId: '7788', raw: { available_actions: [] } },
      {
        return_id: 7788,
        available_actions: [{ id: 12, name: 'COMPENSATE' }],
        rejection_reason: [],
      }
    );

    expect(plan.actionable).toBe(true);
    expect(plan.actions).toEqual([
      expect.objectContaining({ operationId: 'setRfbsReturnAction', actionId: 12, kind: 'compensate' }),
    ]);

    const form = { ...createAfterSalesOperationForm(plan), compensationAmount: '25.50' };
    expect(buildAfterSalesOperationRequest(plan, form)).toEqual({
      operationId: 'setRfbsReturnAction',
      payload: { return_id: 7788, id: 12, compensation_amount: '25.50' },
    });
  });

  it('requires an Ozon-provided rejection reason and its mandatory comment', () => {
    const plan = getAfterSalesOperationPlan({
      source: 'rfbs-return',
      returnId: '8899',
      raw: {
        available_actions: [{ id: 7, name: 'REJECT' }],
        rejection_reason: [{ id: 3, name: '商品信息不足', is_comment_required: true }],
      },
    });
    const form = createAfterSalesOperationForm(plan);

    expect(() => buildAfterSalesOperationRequest(plan, form)).toThrow('必须填写说明');
    expect(buildAfterSalesOperationRequest(plan, { ...form, comment: '包装完整，证据不足' })).toEqual({
      operationId: 'setRfbsReturnAction',
      payload: { return_id: 8899, id: 7, rejection_reason_id: 3, comment: '包装完整，证据不足' },
    });
  });

  it('shows Ozon action and rejection labels in Chinese', () => {
    const plan = getAfterSalesOperationPlan({
      source: 'rfbs-return',
      returnId: '9912',
      raw: {
        available_actions: [{ id: 19, name: 'REJECT' }, { id: 88, name: 'SOME_NEW_ACTION' }],
        rejection_reason: [{ id: 10, name: 'Товар закончился на складе' }],
      },
    });

    expect(plan.actions.map((action) => action.label)).toEqual(['拒绝退货', 'Ozon 可用操作 88']);
    expect(plan.rejectionReasons[0].name).toBe('仓库商品已售完');
  });

  it('connects pending conditional cancellations to approve and reject endpoints', () => {
    const plan = getAfterSalesOperationPlan({
      source: 'conditional',
      raw: { cancellation_id: 9911, state: { state: 'ON_APPROVAL' } },
    });

    expect(plan.actionable).toBe(true);
    expect(plan.actions.map((action) => action.operationId)).toEqual([
      'approveConditionalCancellation',
      'rejectConditionalCancellation',
    ]);
    expect(buildAfterSalesOperationRequest(plan, createAfterSalesOperationForm(plan))).toEqual({
      operationId: 'approveConditionalCancellation',
      payload: { cancellation_id: 9911 },
    });
  });

  it('does not expose operations for completed conditional cancellations or unsupported records', () => {
    expect(
      getAfterSalesOperationPlan({
        source: 'conditional',
        raw: { cancellation_id: 9911, state: { state: 'APPROVED' } },
      }).actionable
    ).toBe(false);
    expect(getAfterSalesOperationPlan({ source: 'returns', returnId: '12' }).actionable).toBe(false);
  });

  it('does not leave the dialog loading when Ozon did not return an rFBS return id', () => {
    const missingIdPlan = getAfterSalesOperationPlan({
      source: 'rfbs-return',
      id: 'return:posting-1',
      raw: { available_actions: [] },
    });
    expect(missingIdPlan.returnId).toBe('');
    expect(missingIdPlan.message).toContain('没有返回退货申请 ID');
    expect(shouldLoadAfterSalesOperationPlan(missingIdPlan)).toBe(false);

    const nestedIdPlan = getAfterSalesOperationPlan({
      source: 'rfbs-return',
      raw: { detail: { return_id: 7788 }, available_actions: [] },
    });
    expect(nestedIdPlan.returnId).toBe(7788);
    expect(shouldLoadAfterSalesOperationPlan(nestedIdPlan)).toBe(true);
  });
});
