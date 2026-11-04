export const COLLECTION_BEIXIONG_AUTOFILL_VERSION = 'smart-listing-single-wave-20260901';

export const COLLECTION_BEIXIONG_PHASES = Object.freeze([
  Object.freeze({ id: 'structured-title', order: 1, label: '结构字段与逐 SKU 俄文标题' }),
  Object.freeze({ id: 'multi-select', order: 2, label: '多选字段' }),
  Object.freeze({ id: 'text-number', order: 3, label: '文本和数值字段' }),
  Object.freeze({ id: 'description', order: 4, label: '俄文简介与 Rich Content' }),
  Object.freeze({ id: 'tags', order: 5, label: '俄文标签' }),
]);

export const COLLECTION_BEIXIONG_RULES = Object.freeze({
  version: COLLECTION_BEIXIONG_AUTOFILL_VERSION,
  skuBatchSize: 22,
  mainAttemptCount: 2,
  repairAttemptCount: 2,
  temperature: 0.1,
  multiSelectMaximum: 3,
  title: Object.freeze({ minimum: 130, target: 145, maximum: 150 }),
  description: Object.freeze({ minimumSentences: 4, maximumSentences: 6 }),
  tags: Object.freeze({ targetCount: 28, minimumAccepted: 11, maximumLength: 28 }),
  phases: COLLECTION_BEIXIONG_PHASES,
});

export const COLLECTION_BEIXIONG_BUILTIN_MODEL = Object.freeze({
  id: 'builtin-points-text',
  accountId: 'builtin-points',
  model: 'builtin-points-text',
  label: '内置积分文本模型',
  displayName: '内置积分文本模型',
  provider: '官方内置能力',
  ready: true,
});

export const COLLECTION_BEIXIONG_PROMPT_RULES = Object.freeze([
  '在当前单轮任务内一次性完成所给文案、公共属性或逐 SKU 属性；当前任务范围由 mode、schema 和 include* 开关指定。',
  '先读取原链接标题、来源属性、全部 SKU 与商品图片，再按当前 Ozon 实时字段逐项填写。',
  '每批最多处理 22 个 SKU；逐 SKU 标题必须使用自然俄语，目标 130-150 字符且不得超过 150 字符。',
  '下拉和多选只能返回当前字段 options 中真实存在的 Ozon 官方 id；多选最多 3 项。',
  '只有明确标记为 shared 的字段才允许采用第一个有效值并传播到全部 SKU；普通多选字段仍按每个 SKU 的真实资料分别填写。',
  '文本、数字和字典值必须有来源标题、来源属性、SKU、图片事实或当前 Ozon 官方选项支持；没有可靠证据时写入 unresolved，不得猜测。',
  '禁止用 Стандарт、1、任意字典首项、通用标题、通用简介或通用标签补齐缺失资料。',
  '商品简介使用俄文 4-6 句；标签返回 28 个俄文短语，至少 11 个有效且每个不超过 28 字符。',
  '任何中文残留都必须翻译成俄语；禁止省略当前 schema 字段。',
  '输出严格 JSON，不输出 Markdown 或额外解释。',
]);
