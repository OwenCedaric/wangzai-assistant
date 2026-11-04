export const PURCHASE_PDD_1688_ROUTE_FREEZE_VERSION = 'purchase-pdd-1688-route-v2-shared-alipay-session-20260828';

export const PURCHASE_PDD_1688_ROUTE = Object.freeze([
  '读取当前 Ozon 商品公网图片',
  '通过 1688 以图搜款读取真实同款列表',
  '从真实 1688 同款结果回读商品标题',
  '用该标题打开拼多多搜索页',
  '拼多多选择支付宝后把官方 H5 收银台转入独立小窗',
  '支付宝会话按软件用户和采购账号隔离并长期保存',
  '支付宝返回成功后回读拼多多订单，确认已付款才关闭小窗',
]);
