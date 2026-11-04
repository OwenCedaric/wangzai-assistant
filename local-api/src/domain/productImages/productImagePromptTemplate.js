const TEMPLATE_ID = 'product-image-generation.v1';

function text(value) {
  return String(value ?? '').trim();
}

function stringList(value, limit = 24) {
  return (Array.isArray(value) ? value : []).map(text).filter(Boolean).slice(0, limit);
}

function selectedPositionRule(positionRules, group, sourceIndex) {
  const source = positionRules && typeof positionRules === 'object' && !Array.isArray(positionRules)
    ? positionRules[group]
    : [];
  const rules = Array.isArray(source) ? source : [];
  return rules.find((item, index) => {
    const explicit = Number(item?.sourceIndex);
    const legacy = Number(item?.position);
    const normalized = Number.isInteger(explicit) && explicit >= 0
      ? explicit
      : Number.isInteger(legacy) && legacy > 0
        ? legacy - 1
        : index;
    return normalized === sourceIndex;
  }) || {};
}

function selectedPlan(approvedPlan, sourceIndex) {
  const items = Array.isArray(approvedPlan?.items) ? approvedPlan.items : [];
  return items.find((item) => Number(item?.sourceIndex) === sourceIndex) || {};
}

export function renderProductImagePromptTemplate(input = {}) {
  const templateId = text(input.promptTemplateId || input.templateId);
  if (templateId && templateId !== TEMPLATE_ID) {
    throw Object.assign(new Error('图片提示词模板不存在。'), { code: 'IMAGE_PROMPT_TEMPLATE_NOT_FOUND' });
  }
  if (!templateId) return text(input.prompt);
  const templateInput = input.promptTemplateInput || input.templateInput;
  if (!templateInput || typeof templateInput !== 'object' || Array.isArray(templateInput)) {
    throw Object.assign(new Error('图片提示词模板缺少结构化输入。'), { code: 'IMAGE_PROMPT_TEMPLATE_INPUT_REQUIRED' });
  }
  const product = templateInput.product && typeof templateInput.product === 'object' ? templateInput.product : {};
  const image = templateInput.image && typeof templateInput.image === 'object' ? templateInput.image : {};
  const group = image.group === 'detail' ? 'detail' : 'main';
  const sourceIndex = Math.max(0, Math.floor(Number(image.sourceIndex) || 0));
  const position = selectedPositionRule(templateInput.positionRules, group, sourceIndex);
  const plan = selectedPlan(templateInput.approvedPlan, sourceIndex);
  const targetScene = text(product.targetScene);
  const positionText = [position.purpose, position.instructions].map(text).filter(Boolean).join(' ');
  const whiteBackground = /(?:白底|纯白背景|white\s+background)/iu.test(positionText);
  const lines = [
    group === 'detail'
      ? '生成一张 3:4 竖版俄罗斯电商详情图，当前图片只解释一个有证据的卖点。'
      : '生成一张 3:4 竖版俄罗斯电商主图，商品主体清晰、完整、醒目。',
    `当前固定位置：${group === 'detail' ? '详情图' : '主图'} ${sourceIndex + 1}。`,
    text(product.title) ? `商品名称：${text(product.title)}。` : '',
    text(product.productKey) ? `商品主键：${text(product.productKey)}。` : '',
    text(product.offerId) ? `商品货号：${text(product.offerId)}。` : '',
    text(product.productId) ? `商品 ID：${text(product.productId)}。` : '',
    text(product.sku) ? `当前 SKU：${text(product.sku)}。` : '',
    `当前 SKU 事实：${text(product.skuFacts) || '只使用参考图中直接可确认的事实'}。`,
    targetScene
      ? `目标场景：${targetScene}。`
      : whiteBackground
        ? '当前位置明确要求标准白底图，背景保持干净、均匀，不增加场景道具。'
        : '背景必须符合商品真实用途。',
    text(position.purpose) ? `位置用途：${text(position.purpose)}。` : '',
    text(position.instructions) ? `构图和背景：${text(position.instructions)}。` : '',
    text(position.visibleText) ? `允许出现的文字：${text(position.visibleText)}。` : '',
    text(position.mustAvoid) ? `当前位置额外禁止：${text(position.mustAvoid)}。` : '',
    text(plan.prompt) ? `已审核的本位置方案：${text(plan.prompt)}` : '',
    text(plan.negativePrompt) ? `已审核的负向约束：${text(plan.negativePrompt)}` : '',
    stringList(plan.mustKeep).length ? `必须保留：${stringList(plan.mustKeep).join('；')}。` : '',
    stringList(plan.mustAvoid).length ? `必须避免：${stringList(plan.mustAvoid).join('；')}。` : '',
    stringList(plan.acceptanceChecks).length ? `生成后验收：${stringList(plan.acceptanceChecks).join('；')}。` : '',
    text(templateInput.approvedPlan?.globalNegativePrompt)
      ? `全局负向约束：${text(templateInput.approvedPlan.globalNegativePrompt)}`
      : '',
    '商品外观以参考图为唯一视觉事实来源，颜色、形状、结构、材质、接口、零件、数量、比例、包装和表面图案都不得改变。',
    '不得新增、删除、替换或复制商品、配件、赠品、人物、包装或功能。',
    '可见文字只能来自已确认事实；不得伪造品牌、认证、专利、原装、性能、保修或医疗承诺。',
    '不得出现价格、折扣、销量、评分、评论、二维码、联系方式、平台界面、明水印、工厂或仓库宣传。',
    templateInput.generationMode === 'fast'
      ? '极速模式只压缩软性摄影描述，以上商品事实和禁止项必须完整执行。'
      : '优先保证商品事实一致，再优化摄影构图、灯光和电商可读性。',
  ];
  const localPlan = stringList(templateInput.localPlan, 12);
  if (localPlan.length) lines.push(`本地草稿补充：${localPlan.join('；')}`);
  return lines.filter(Boolean).join('\n');
}

export const PRODUCT_IMAGE_PROMPT_TEMPLATE_ID = TEMPLATE_ID;
