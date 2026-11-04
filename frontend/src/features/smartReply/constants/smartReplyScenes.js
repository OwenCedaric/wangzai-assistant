export const smartReplyScenes = Object.freeze([
  Object.freeze({
    id: 'passport-required',
    value: 'passportRequired',
    title: '催护照',
    description: '订单明确缺少护照或清关资料时提醒买家补充。',
    trigger: '下单后未填写护照时触发',
  }),
  Object.freeze({
    id: 'pickup-reminder',
    value: 'pickupReminder',
    title: '催取货',
    description: '货件首次到达自提点后提醒买家及时取件。',
    trigger: '货物到达取货点时触发',
  }),
  Object.freeze({
    id: 'shipment-notice',
    value: 'shipmentNotice',
    title: '发货通知',
    description: '订单真正进入运输状态后向买家发送发货信息。',
    trigger: '货物发出后触发',
  }),
  Object.freeze({
    id: 'review-request',
    value: 'reviewRequest',
    title: '索要好评',
    description: '订单签收且没有取消、退款后按设定时间发送。',
    trigger: '货物签收后触发',
  }),
]);
