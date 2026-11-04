import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getOzonFinanceOperationLabel,
  getOzonReturnReasonLabel,
  getOzonReturnStatusLabel,
} from './ozonChineseLabels.js';

test('uses stable Ozon codes instead of garbled localized text', () => {
  assert.equal(
    getOzonReturnReasonLabel({ return_reason: { id: 587, name: '妤把快志抑扮快扶我快' } }),
    '买家拒收：对商品质量不满意'
  );
  assert.equal(getOzonReturnStatusLabel({ state: { state: 'MoneyReturned' } }), '已退款给买家');
  assert.equal(
    getOzonFinanceOperationLabel('DefectFineCancellation', '妤把快志抑扮快扶我快'),
    '错误指数超标：取消罚款'
  );
});

test('preserves unknown official labels instead of inventing a translation', () => {
  assert.equal(getOzonFinanceOperationLabel('UnknownOperation', 'Official source label'), 'Official source label');
  assert.equal(getOzonReturnReasonLabel({ return_reason: { id: 999999 } }), '');
});
