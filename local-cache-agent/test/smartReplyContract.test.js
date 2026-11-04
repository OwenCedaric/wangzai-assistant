import assert from 'node:assert/strict';
import test from 'node:test';
import {
  detectTriggerScene,
  missingTemplateVariables,
  postingVariables,
  renderTemplate,
} from '../src/smartReply/contract.js';

test('matches the four exact smart-reply stages and lets later states win', () => {
  assert.equal(detectTriggerScene({ status: 'awaiting_packaging', substatus: 'posting_awaiting_passport_data' }).scene, 'passportRequired');
  assert.equal(detectTriggerScene({ status: 'delivering', substatus: 'posting_in_carriage' }).scene, 'shipmentNotice');
  assert.equal(detectTriggerScene({ status: 'delivering', substatus: 'posting_in_pickup_point' }).scene, 'pickupReminder');
  assert.equal(detectTriggerScene({ status: 'posting_delivered', substatus: 'posting_in_pickup_point' }).scene, 'reviewRequest');
  assert.equal(detectTriggerScene({ status: 'cancelled', substatus: 'posting_in_pickup_point' }).scene, '');
});

test('renders only order variables and reports variables that Ozon has not returned', () => {
  const posting = {
    posting_number: '100-200',
    in_process_at: '2026-08-24T01:02:03Z',
    analytics_data: { buyer_name: 'Ирина' },
    products: [{ name: 'Чехол' }],
    tracking_number: 'TRACK-1',
  };
  const variables = postingVariables(posting, '100-200');
  const template = 'Здравствуйте, {{买家昵称}}! {{产品名称}} {{货件编号}} {{运单号}}';
  assert.equal(
    renderTemplate(template, variables),
    'Здравствуйте, Ирина! Чехол 100-200 TRACK-1',
  );
  assert.deepEqual(missingTemplateVariables(template, { ...variables, trackingNumber: '' }), ['{{运单号}}']);
});
