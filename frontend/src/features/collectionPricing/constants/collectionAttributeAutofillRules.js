import {
  COLLECTION_BEIXIONG_AUTOFILL_VERSION,
  COLLECTION_BEIXIONG_PROMPT_RULES,
} from './collectionBeixiongAutofillRules.js';

export const COLLECTION_ATTRIBUTE_AUTOFILL_RUNTIME_RULES = Object.freeze({
  id: COLLECTION_BEIXIONG_AUTOFILL_VERSION,
  title: '智能属性一键填满规则',
  promptConfig: Object.freeze({
    defaultModelId: 'builtin-points-text',
    systemPrompt: COLLECTION_BEIXIONG_PROMPT_RULES.join('\n'),
    workflowSteps: Object.freeze([
      '读取原链接标题、来源属性、全部 SKU 和商品图片',
      '将公共文案和公共属性合并为一个任务，并将全部 SKU 按每组最多 22 个合并为逐 SKU 任务',
      '公共任务与逐 SKU 任务在同一轮并行执行，不再等待五个串行阶段',
      '逐 SKU 生成 130-150 字符俄文标题，并填写当前 schema 中有可靠事实支持的字段',
      '下拉和多选只使用当前 Ozon 官方选项；简介和标签只由公共任务生成',
      '失败任务从检查点续跑；必填缺项才局部修正，选填缺项直接保留人工确认',
      'shared 字段只在明确标记 shared 且存在有效值时传播到空白 SKU',
      '将最终结果一次性写入本地上架草稿，不增加属性人工预审步骤',
    ]),
    outputRules: Object.freeze([
      '当前任务 schema 中有可靠事实支持的字段返回值，无可靠事实时明确写入 unresolved',
      '下拉值只允许使用 Ozon 当前类目真实选项 ID，多选最多 3 项',
      '逐 SKU 标题、简介、标签和属性都使用俄语，不保留中文',
      '只输出运行时要求的严格 JSON',
    ]),
    safetyRules: Object.freeze([
      '选项字段必须使用 Ozon 当前类目真实返回的选项 ID，不伪造 ID',
      '只使用来源资料、图片事实和当前 Ozon 官方选项；缺资料时不得猜测',
      '保留已填写的人工值，只自动补齐空白值',
      '一键填充只修改本地上架草稿，不自动上传 Ozon',
    ]),
  }),
});
