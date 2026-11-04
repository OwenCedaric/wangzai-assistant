export const SMART_TOOL_SKILL_MODULE_ANALYZER_VERSION = 1;

function text(value) {
  return String(value ?? '').trim();
}

function unique(values = []) {
  return [...new Set(values.map(text).filter(Boolean))];
}

function sourceRefs(ruleCatalog = [], predicate = () => false) {
  return (Array.isArray(ruleCatalog) ? ruleCatalog : [])
    .filter(predicate)
    .map((item) => ({
      sourcePath: text(item?.sourcePath),
      heading: text(item?.heading),
      sourceOrder: Number(item?.sourceOrder || 0),
      sectionOrder: Number(item?.sectionOrder || 0),
    }))
    .filter((item) => item.sourcePath && item.heading)
    .sort((left, right) => left.sourceOrder - right.sourceOrder || left.sectionOrder - right.sectionOrder);
}

function catalogText(ruleCatalog = []) {
  return (Array.isArray(ruleCatalog) ? ruleCatalog : [])
    .map((item) => `${text(item?.heading)}\n${text(item?.content)}`)
    .join('\n');
}

function toolReferences(ruleCatalog = [], sourceName = '') {
  const selfNames = new Set(
    [sourceName, text(sourceName).replace(/^\$/u, '')].map((item) => text(item).toLowerCase()).filter(Boolean)
  );
  const byId = new Map();
  (Array.isArray(ruleCatalog) ? ruleCatalog : []).forEach((section) => {
    const matches = `${text(section?.heading)}\n${text(section?.content)}`.match(/\$[A-Za-z0-9._-]+/gu) || [];
    matches.forEach((rawId) => {
      const name = rawId.slice(1).toLowerCase();
      if (name === 'env' || selfNames.has(name)) return;
      const current = byId.get(rawId) || { id: rawId, sourcePaths: new Set(), sourceSections: [] };
      current.sourcePaths.add(text(section?.sourcePath));
      current.sourceSections.push(text(section?.heading));
      byId.set(rawId, current);
    });
  });
  return [...byId.values()].map((item) => ({
    id: item.id,
    label: item.id.slice(1),
    sourcePaths: unique([...item.sourcePaths]),
    sourceSections: unique(item.sourceSections),
  }));
}

function capabilitiesFor(requiredCapabilities = [], patterns = []) {
  return unique(
    (Array.isArray(requiredCapabilities) ? requiredCapabilities : []).filter((id) =>
      patterns.some((pattern) => pattern.test(id))
    )
  );
}

function toolsFor(referencedTools = [], sourceReferences = []) {
  const sourceSections = new Set(sourceReferences.map((item) => item.heading));
  return referencedTools
    .filter((tool) => tool.sourceSections.some((heading) => sourceSections.has(heading)))
    .map((tool) => tool.id);
}

function createModule({
  id,
  title,
  kind,
  description,
  sourceReferences,
  requiredCapabilities = [],
  requiredTools = [],
}) {
  return {
    id,
    title,
    kind,
    description,
    order: 0,
    sourceReferences,
    requiredCapabilities: unique(requiredCapabilities),
    requiredTools: unique(requiredTools),
  };
}

export function analyzeInstalledSkillModules({
  sourceName = '',
  ruleCatalog = [],
  requiredCapabilities = [],
  imageJobs = [],
  skuImageRules = [],
  qaRules = [],
  outputs = [],
  safetyNotes = [],
  stopConditions = [],
} = {}) {
  const source = catalogText(ruleCatalog);
  const referencedTools = toolReferences(ruleCatalog, sourceName);
  const modules = [];
  const refsByCategory = (categories) => sourceRefs(ruleCatalog, (item) => categories.includes(text(item?.category)));
  const refsBySignal = (pattern) =>
    sourceRefs(ruleCatalog, (item) => pattern.test(`${text(item?.heading)}\n${text(item?.content)}`));
  const addModule = (condition, definition) => {
    if (!condition || !definition.sourceReferences.length) return;
    modules.push(
      createModule({
        ...definition,
        requiredTools: toolsFor(referencedTools, definition.sourceReferences),
      })
    );
  };

  const modeRefs = refsByCategory(['mode']);
  addModule(modeRefs.length, {
    id: 'execution-mode-router',
    title: '运行模式与范围',
    kind: 'routing',
    description: '识别完整执行、分阶段执行或复盘模式，并确定本次允许处理的范围。',
    sourceReferences: modeRefs,
  });

  const intakeRefs = refsByCategory(['input']);
  addModule(intakeRefs.length, {
    id: 'intake-and-context',
    title: '输入资料与任务上下文',
    kind: 'routing',
    description: '收集本次任务需要的店铺、商品、SKU、资料来源、授权和交付要求。',
    sourceReferences: intakeRefs,
    requiredCapabilities: capabilitiesFor(requiredCapabilities, [/\.shops\.read$/u]),
  });

  const capabilityRefs = refsByCategory(['capability']);
  addModule(capabilityRefs.length, {
    id: 'declared-capability-contract',
    title: 'Skill 能力范围',
    kind: 'contract',
    description: '整理 Skill 明确声明能做、不能做和需要调用的能力，作为后续模块匹配边界。',
    sourceReferences: capabilityRefs,
    requiredCapabilities,
  });

  const workflowRefs = refsByCategory(['workflow']);
  addModule(workflowRefs.length, {
    id: 'workflow-orchestration',
    title: '执行流程编排',
    kind: 'orchestration',
    description: '保留 Skill 自带的步骤顺序、阶段门槛和交接关系，运行时必须按该顺序执行。',
    sourceReferences: workflowRefs,
    requiredCapabilities,
  });

  const productTruthRefs = refsBySignal(/product truth|fact ledger|商品事实|事实账本/iu);
  addModule(productTruthRefs.length, {
    id: 'product-truth-ledger',
    title: '商品事实核对',
    kind: 'data-analysis',
    description: '读取并冻结商品身份、类目、材质、尺寸、数量、配件和其他可验证事实。',
    sourceReferences: productTruthRefs,
    requiredCapabilities: capabilitiesFor(requiredCapabilities, [/\.products\.read$/u, /\.productImages\.read$/u]),
  });

  const skuRefs = refsBySignal(
    /sku matrix|sku_matrix|variant matrix|sku\s*(?:and|与)?\s*readiness|SKU 矩阵|变体矩阵/iu
  );
  addModule(skuRefs.length, {
    id: 'sku-matrix',
    title: 'SKU 矩阵与准备度',
    kind: 'data-analysis',
    description: '逐个核对 SKU 的颜色、尺寸、数量、包含物、图片和差异，防止变体错配。',
    sourceReferences: skuRefs,
    requiredCapabilities: capabilitiesFor(requiredCapabilities, [/\.products\.read$/u, /\.productImages\.read$/u]),
  });

  const evidenceRefs = refsByCategory(['evidence']);
  addModule(evidenceRefs.length, {
    id: 'evidence-review',
    title: '证据检查与缺失追问',
    kind: 'data-analysis',
    description: '检查证据等级、冲突和缺失信息，只追问会影响真实性的关键问题。',
    sourceReferences: evidenceRefs,
  });

  const searchRefs = refsBySignal(
    /search evidence|search-data|keyword evidence|keyword_map|搜索证据|搜索数据|关键词证据/iu
  );
  addModule(searchRefs.length, {
    id: 'search-evidence',
    title: 'Ozon 搜索证据',
    kind: 'data-read',
    description: '读取带时间范围的搜索词、匹配度、排名或流量证据，禁止把普通候选词冒充实时数据。',
    sourceReferences: searchRefs,
    requiredCapabilities: capabilitiesFor(requiredCapabilities, [/\.analytics\.read$/u, /\.marketing\.read$/u]),
  });

  const seoRefs = refsByCategory(['seo']);
  addModule(seoRefs.length, {
    id: 'seo-and-russian-copy',
    title: '俄语 SEO 与商品文案',
    kind: 'generation',
    description: '生成或修订俄语标题、简介、详情、标签、搜索词和有证据的文案。',
    sourceReferences: seoRefs,
    requiredCapabilities: capabilitiesFor(requiredCapabilities, [/model\.text\.generate$/u]),
  });

  const attributeRefs = refsByCategory(['attribute']);
  addModule(attributeRefs.length, {
    id: 'attribute-consistency',
    title: '属性与图文一致性',
    kind: 'validation',
    description: '核对类目、属性、标题、详情、图片与 SKU 是否描述同一商品。',
    sourceReferences: attributeRefs,
    requiredCapabilities: capabilitiesFor(requiredCapabilities, [/\.products\.read$/u, /model\.text\.generate$/u]),
  });

  const imageRefs = refsByCategory(['image']);
  addModule(imageJobs.length > 0, {
    id: 'listing-image-plan',
    title: '商品图位置规划',
    kind: 'generation-plan',
    description: `按买家问题和信息层级规划 ${imageJobs.length} 个不同职责的商品图片位置。`,
    sourceReferences: imageRefs,
    requiredCapabilities: capabilitiesFor(requiredCapabilities, [/\.productImages\.read$/u]),
  });

  const skuImageRefs = refsByCategory(['sku-image']);
  addModule(skuImageRules.length > 0, {
    id: 'sku-image-map',
    title: 'SKU 图片映射',
    kind: 'generation-plan',
    description: '为每个真实 SKU 匹配权威参考图、变体信息和独立输出位置。',
    sourceReferences: skuImageRefs,
    requiredCapabilities: capabilitiesFor(requiredCapabilities, [/\.productImages\.read$/u]),
  });

  const imageGenerationRefs = refsBySignal(/\$imagegen|actually generate|image generation|生成图片|实际生图/iu);
  addModule(imageGenerationRefs.length, {
    id: 'image-generation',
    title: '图片模型生成',
    kind: 'generation',
    description: '在授权、资料和费用边界满足后，调用图片模型生成选定位置的实际图片。',
    sourceReferences: imageGenerationRefs,
    requiredCapabilities: capabilitiesFor(requiredCapabilities, [
      /model\.image\.generate$/u,
      /product-image-storage$/u,
    ]),
  });

  const qaRefs = refsByCategory(['qa']);
  addModule(qaRules.length > 0, {
    id: 'content-and-image-qa',
    title: '图文质检与验收',
    kind: 'validation',
    description: '检查商品结构、SKU、俄语文字、虚构内容、图片差异和最终交付完整性。',
    sourceReferences: qaRefs,
  });

  const outputRefs = refsByCategory(['output']);
  addModule(outputs.length > 0, {
    id: 'operator-output-bundle',
    title: '结果整理与阶段数据',
    kind: 'delivery',
    description: '按运营阅读顺序输出结果，并保留可继续处理的结构化阶段数据。',
    sourceReferences: outputRefs,
  });

  const postLaunchRefs = refsBySignal(/post-launch|post_launch|上架后|复盘|impressions|ctr|conversion/iu);
  addModule(postLaunchRefs.length, {
    id: 'post-launch-analysis',
    title: '上架后数据复盘',
    kind: 'analysis',
    description: '读取曝光、点击、转化、订单、排名和流量来源，提出一个主要优化动作。',
    sourceReferences: postLaunchRefs,
    requiredCapabilities: capabilitiesFor(requiredCapabilities, [/\.analytics\.read$/u, /\.marketing\.read$/u]),
  });

  const safetyRefs = refsByCategory(['safety', 'stop']);
  addModule(safetyNotes.length > 0 || stopConditions.length > 0, {
    id: 'safety-and-authorization-gate',
    title: '安全、授权与停止条件',
    kind: 'governance',
    description: '控制事实真实性、图片授权、外部付费、敏感数据和线上写入边界。',
    sourceReferences: safetyRefs,
  });

  const orderedModules = modules.map((module, index) => ({ ...module, order: index + 1 }));
  const allRequiredCapabilities = unique([
    ...requiredCapabilities,
    ...orderedModules.flatMap((module) => module.requiredCapabilities),
  ]);
  const unmappedCapabilities = allRequiredCapabilities.filter(
    (capability) => !orderedModules.some((module) => module.requiredCapabilities.includes(capability))
  );
  const warnings = [];
  if (!orderedModules.length) warnings.push('没有从 Skill 文档中识别出可执行模块。');
  if (referencedTools.length)
    warnings.push(`发现 ${referencedTools.length} 个外部 Skill/工具依赖，安装后需核对可用性。`);
  const unclassifiedSectionCount = (Array.isArray(ruleCatalog) ? ruleCatalog : []).filter(
    (item) => text(item?.category) === 'unclassified'
  ).length;
  if (unclassifiedSectionCount) warnings.push(`有 ${unclassifiedSectionCount} 个章节未能自动归类，安装前需要核对。`);

  return {
    version: SMART_TOOL_SKILL_MODULE_ANALYZER_VERSION,
    completed: orderedModules.length > 0,
    moduleCount: orderedModules.length,
    modules: orderedModules,
    referencedTools,
    requiredCapabilities: allRequiredCapabilities,
    unmappedCapabilities,
    warnings,
    sourceSectionCount: Array.isArray(ruleCatalog) ? ruleCatalog.length : 0,
    unclassifiedSectionCount,
    analyzedCharacterCount: source.length,
  };
}
