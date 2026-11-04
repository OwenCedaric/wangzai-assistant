import { APPROVED_IMAGE_MODEL_ID } from '../../../shared/lib/imageGenerationProviderPolicy.js';

export const POINTS_PACKAGE_TABS = Object.freeze([
  { id: 'plans', label: '套餐购买' },
  { id: 'billing', label: '计费说明' },
  { id: 'faq', label: '常见问题' },
]);

export const IMAGE_COUNTS = Object.freeze([10, 13, 16]);

// These are customer-facing point rates. Upstream cost, margin and provider
// credentials stay outside the renderer and must never be exposed here.
export const POINTS_IMAGE_MODELS = Object.freeze([
  {
    id: 'standard',
    name: '标准图',
    model: APPROVED_IMAGE_MODEL_ID,
    description: '日常 Ozon 主图与详情图',
    qualityLabel: '标准清晰度',
    usageLabel: '主图 · 详情图 · 批量生成',
    unitPriceCny: 0.05,
    unitPoints: 53,
    tone: 'violet',
    pointRates: Object.freeze({
      success: Object.freeze({ 10: 622, 13: 781, 16: 940 }),
      retry: Object.freeze({ 10: 755, 13: 954, 16: 1152 }),
    }),
  },
]);

export const POINTS_FAQ_ITEMS = Object.freeze([
  {
    question: '套餐购买后会得到什么？',
    answer:
      '套餐到账的是软件积分。生成标题、属性、俄语文案和图片时按实际模型与实际调用量扣除，页面展示的链接数量是当前配置下的预计值。',
  },
  {
    question: '为什么链接数量会变化？',
    answer:
      '每条链接可选择 10、13 或 16 张成品图。图片越多或重试次数越多，单条链接消耗的积分越高。所有生图固定使用 images.example.invalid API 的 gpt-image-2。',
  },
  {
    question: '积分和有效期从什么时候开始？',
    answer: '支付平台确认成功后，管理系统会把套餐积分写入当前登录用户的独立积分账本；有效期从到账时间开始计算。',
  },
  {
    question: '支付后为什么没有立即到账？',
    answer: '正式流程会经历支付回调验签、订单确认和积分入账。只有服务端确认积分账本写入成功后，余额才会更新。',
  },
  {
    question: '图片生成使用哪个模型？',
    answer: '全部固定使用 images.example.invalid API 的 gpt-image-2，不会切换或回退到其他图片接口。',
  },
]);
