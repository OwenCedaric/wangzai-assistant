export const SMART_TOOL_IMAGE_POSITION_RULES_VERSION = 3;
export const SMART_TOOL_ATTRIBUTE_RULES_VERSION = 1;

export const SMART_TOOL_ATTRIBUTE_RULE_FIELDS = [
  {
    key: 'optimizationGoal',
    label: '优化目标',
    description: '说明属性功能要解决什么问题，以及是否只处理现有商品。',
  },
  {
    key: 'factSources',
    label: '商品事实来源',
    description: '规定模型可以使用哪些当前商品信息，避免混入其他 SKU。',
  },
  {
    key: 'editableScope',
    label: '允许优化的字段',
    description: '指定哪些文案或非固定属性可以生成优化建议。',
  },
  {
    key: 'protectedScope',
    label: '禁止修改的字段',
    description: '锁定类目、货号、品牌和商品客观参数等现有事实。',
  },
  {
    key: 'titleRules',
    label: '商品标题规则',
    description: '填写标题的语言、结构、关键词和禁止内容。',
  },
  {
    key: 'descriptionRules',
    label: '商品简介规则',
    description: '填写简介的信息层级、可读性和事实要求。',
  },
  {
    key: 'tagRules',
    label: '商品标签规则',
    description: '填写标签数量、格式、去重和相关性要求。',
  },
  {
    key: 'missingFieldRules',
    label: '缺失属性处理',
    description: '规定空字段在什么情况下可以补充，证据不足时如何处理。',
  },
  {
    key: 'outputRules',
    label: '生成结果格式',
    description: '规定模型返回的字段、格式以及替换前的检查要求。',
  },
];

const IMAGE_SKILL_DEFAULT_ATTRIBUTE_RULES = {
  optimizationGoal: '只优化当前已存在的 Ozon 商品资料。保留商品身份和真实参数，优先改善标题、商品简介、商品话题标签以及有明确事实依据的可填写文本属性。',
  factSources: '事实优先级：当前商品编辑页的已填写属性、当前商品标题与简介、当前 SKU 信息、当前商品图片。不得使用其他商品或其他 SKU 的事实；不同来源冲突时保留当前 Ozon 值并提示人工核对。',
  editableScope: '允许优化商品标题、商品简介、商品话题标签，以及当前类目中非字典、非结构性、可以自由填写的文本属性。只对用户勾选的字段生成建议。',
  protectedScope: '不得修改 Ozon 类目、商品类型、品牌、Offer ID、型号合并分组、条码、包装数量、重量尺寸、颜色、材质、配件、数量、认证、保修和其他客观事实；除非当前商品数据中已有明确且一致的证据。',
  titleRules: '使用自然、准确、便于俄罗斯买家理解的俄语标题。保留商品核心类型、关键规格和当前 SKU 差异，不堆砌关键词，不加入价格、折扣、销量、评分、最好、100% 等夸张或无法验证的表述。',
  descriptionRules: '使用适合手机阅读的自然俄语，先说明商品是什么，再说明有证据的材质、结构、用途、包含物和使用方式。不得虚构功能、效果、参数、认证、赠品或适用人群。',
  tagRules: '只生成与当前商品直接相关的俄语话题标签；去重、简短、可搜索，不加入品牌蹭词、竞品名称、价格促销词和与商品无关的热门词。',
  missingFieldRules: '空字段只有在当前商品事实能够直接证明时才允许补充。证据不足返回空字符串，不猜测材质、尺寸、重量、数量、功能、兼容性、保修、认证或医疗效果。',
  outputRules: '只返回本次允许生成且用户已选择的 Ozon 字段。每项必须保留真实字段 ID，生成值使用俄语；没有可靠建议时返回空字符串。替换前必须显示当前值与建议值的差异，并由用户人工确认。',
};

const ORIGINAL_GALLERY_POSITION_RULES = [
  {
    purpose: '核心卖点总览图',
    instructions: '使用 3:4 竖版构图，完整展示商品整体，并用清晰的信息层级表达 3-5 个有证据的核心卖点。',
    visibleText: '使用自然俄语；一个简短标题，最多 3 个短卖点标签，其余卖点通过画面表达。',
    mustAvoid: '不要堆满小字，不要加入价格、折扣、评分、销量或没有证据的功能。',
  },
  {
    purpose: '材质与细节特写图',
    instructions: '突出真实材质、做工、边缘、接口、纹理或结构细节，商品特征必须与参考图一致。',
    visibleText: '仅在有证据时使用 1-2 个简短俄语材质或做工标签。',
    mustAvoid: '不要改变材质、纹理、颜色、接口、结构或表面图案。',
  },
  {
    purpose: '真实使用场景图',
    instructions: '放入符合俄罗斯用户生活语境的真实使用场景，商品必须清晰完整且仍是视觉主体。',
    visibleText: '可使用 1 个自然俄语场景标题和最多 2 个短卖点。',
    mustAvoid: '不要让人物、手部或道具遮挡商品，不要虚构商品用途或使用效果。',
  },
  {
    purpose: '尺寸、容量或结构说明图',
    instructions: '使用参照物、分区或结构示意表达比例、容量或结构；只有源数据明确时才允许显示具体数字。',
    visibleText: '使用简短俄语结构标签；没有可靠数据时不显示尺寸、容量或重量数字。',
    mustAvoid: '不要编造测量线、尺寸箭头、cm/mm 标注、容量、重量、承重或其他数字。',
  },
  {
    purpose: '功能与使用方式演示图',
    instructions: '展示真实存在的安装、开合、佩戴、收纳或操作方式，只解释一个有证据的核心功能。',
    visibleText: '使用 1-3 个简短俄语步骤或功能标签。',
    mustAvoid: '不要新增不存在的功能、步骤、部件、适配关系或使用效果。',
  },
  {
    purpose: '适用人群与多场景图',
    instructions: '展示与商品真实用途相关的适用人群或多个典型场景；出现人物时应符合俄罗斯电商语境。',
    visibleText: '使用简短自然的俄语人群或场景标签。',
    mustAvoid: '不要加入无关人物或场景，不要声称未经证实的年龄、医疗、安全或兼容性。',
  },
  {
    purpose: '包装、配件与组合展示图',
    instructions: '按源图或商品数据展示真实包装、配件、包含物和套装数量，构图清楚、数量可核对。',
    visibleText: '使用简短俄语包装清单；数量必须与商品证据完全一致。',
    mustAvoid: '不要新增、删除或替换包装、赠品、配件、套装内容和数量。',
  },
];

const SKU_HERO_POSITION_RULE = {
  purpose: 'SKU 专属主卖点图',
  instructions: '使用 3:4 竖版构图，商品保持清晰完整并位于视觉中心，背景符合商品真实使用场景，突出当前 SKU 的一个核心卖点。',
  visibleText: '一个简短自然的俄语主标题，最多搭配 3 个有证据的短信息标签。',
  mustAvoid: '不要套用其他 SKU，不要使用普通纯白空背景，不要显示测量线、尺寸箭头或未经确认的数字。',
};

const IMAGE_SKILL_DEFAULT_POSITION_RULES = {
  main: [SKU_HERO_POSITION_RULE, ...ORIGINAL_GALLERY_POSITION_RULES],
  detail: ORIGINAL_GALLERY_POSITION_RULES,
};

const LEGACY_IMAGE_SKILL_DEFAULT_POSITION_RULES = {
  main: [
    {
      purpose: 'SKU 专属主卖点图',
      instructions: '商品保持清晰完整并位于视觉中心，使用符合商品用途的真实场景。',
      visibleText: '一个简短自然的俄语主标题，最多搭配 3 个有证据的短信息。',
      mustAvoid: '不要使用普通纯白空背景，不要显示测量线、尺寸箭头或未经确认的数字。',
    },
  ],
  detail: [
    { purpose: '真实使用、安装或场景展示' },
    { purpose: '材质、边缘、纹理、接口或做工特写' },
    { purpose: '解释一个有证据的核心功能利益点' },
    { purpose: '适配、安装或使用关系' },
    { purpose: '规格、结构、材质、功能或包含物信息板' },
  ],
};

function text(value) {
  return String(value ?? '').trim();
}

export function createEmptyAttributeRules() {
  return Object.fromEntries(SMART_TOOL_ATTRIBUTE_RULE_FIELDS.map((item) => [item.key, '']));
}

export function createDefaultAttributeRules(toolId = '') {
  return toolId === 'ozon-product-image-generation'
    ? { ...IMAGE_SKILL_DEFAULT_ATTRIBUTE_RULES }
    : createEmptyAttributeRules();
}

export function normalizeAttributeRules(value, options = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const fallback = options.useDefaults ? createDefaultAttributeRules(options.toolId) : createEmptyAttributeRules();
  return Object.fromEntries(
    SMART_TOOL_ATTRIBUTE_RULE_FIELDS.map((item) => [
      item.key,
      text(Object.prototype.hasOwnProperty.call(source, item.key) ? source[item.key] : fallback[item.key]),
    ])
  );
}

export function formatAttributeRulesForPrompt(value) {
  const rules = normalizeAttributeRules(value);
  return SMART_TOOL_ATTRIBUTE_RULE_FIELDS
    .map((item) => {
      const content = text(rules[item.key]);
      return content ? `${item.label}：\n${content}` : '';
    })
    .filter(Boolean)
    .join('\n\n');
}

function emptyPositionRule(sourceIndex = 0) {
  return {
    sourceIndex,
    position: sourceIndex + 1,
    purpose: '',
    instructions: '',
    visibleText: '',
    mustAvoid: '',
  };
}

function supplementalPositionRule(sourceIndex = 0, group = 'main') {
  return {
    ...emptyPositionRule(sourceIndex),
    purpose: group === 'detail' ? '补充商品证据与购买理由图' : '补充主图卖点图',
    instructions: '根据当前位置参考图中可确认且未被前面位置表达的真实信息，补充一个清晰的商品卖点或购买理由；保持统一视觉系统。',
    visibleText: '只使用有证据的简短俄语标题或标签；没有可靠文字时不添加可见文字。',
    mustAvoid: '不要重复前面位置的主要任务，不要虚构功能、参数、配件、适配关系或数字。',
  };
}

function normalizePositionGroup(value = []) {
  const rows = Array.isArray(value) ? value : [];
  const seen = new Set();
  return rows
    .flatMap((source, index) => {
      if (!source || typeof source !== 'object') return [];
      const explicitSourceIndex = Number(source.sourceIndex);
      const legacyPosition = Number(source.position);
      const sourceIndex = Number.isInteger(explicitSourceIndex) && explicitSourceIndex >= 0
        ? explicitSourceIndex
        : Number.isInteger(legacyPosition) && legacyPosition > 0
          ? legacyPosition - 1
          : index;
      if (seen.has(sourceIndex)) return [];
      seen.add(sourceIndex);
      return [{
        ...emptyPositionRule(sourceIndex),
        purpose: text(source.purpose),
        instructions: text(source.instructions),
        visibleText: text(source.visibleText),
        mustAvoid: text(source.mustAvoid),
      }];
    })
    .sort((left, right) => left.sourceIndex - right.sourceIndex);
}

export function createEmptyImagePositionRules() {
  return {
    main: [],
    detail: [],
  };
}

export function createDefaultImagePositionRules(toolId = '') {
  const defaults = toolId === 'ozon-product-image-generation'
    ? IMAGE_SKILL_DEFAULT_POSITION_RULES
    : {};
  return {
    main: normalizePositionGroup(defaults.main),
    detail: normalizePositionGroup(defaults.detail),
  };
}

export function normalizeImagePositionRules(value, options = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  const fallback = options.useDefaults ? createDefaultImagePositionRules(options.toolId) : createEmptyImagePositionRules();
  return {
    main: normalizePositionGroup(source && Object.prototype.hasOwnProperty.call(source, 'main') ? source.main : fallback.main),
    detail: normalizePositionGroup(source && Object.prototype.hasOwnProperty.call(source, 'detail') ? source.detail : fallback.detail),
  };
}

export function mergeImagePositionRuleDefaults(value, toolId = '') {
  const current = normalizeImagePositionRules(value);
  const defaults = createDefaultImagePositionRules(toolId);
  const legacy = {
    main: normalizePositionGroup(LEGACY_IMAGE_SKILL_DEFAULT_POSITION_RULES.main),
    detail: normalizePositionGroup(LEGACY_IMAGE_SKILL_DEFAULT_POSITION_RULES.detail),
  };
  const isLegacyDefault = (group, item) => {
    const oldRule = legacy[group].find((candidate) => candidate.sourceIndex === item.sourceIndex);
    if (!oldRule) return false;
    return ['purpose', 'instructions', 'visibleText', 'mustAvoid']
      .every((field) => text(item[field]) === text(oldRule[field]));
  };
  const isBlankRule = (item) => ['purpose', 'instructions', 'visibleText', 'mustAvoid']
    .every((field) => !text(item[field]));
  const mergeGroup = (group) => {
    const byIndex = new Map(defaults[group].map((item) => [item.sourceIndex, item]));
    current[group].forEach((item) => {
      if (!isLegacyDefault(group, item) && !isBlankRule(item)) byIndex.set(item.sourceIndex, item);
    });
    return normalizePositionGroup([...byIndex.values()]);
  };
  return {
    main: mergeGroup('main'),
    detail: mergeGroup('detail'),
  };
}

const NUMBERED_SECTION_PATTERN = /^[一二三四五六七八九十百]+、\s*\S/u;

const FRIENDLY_SECTION_LABELS = [
  [/事实来源与处理优先级/u, '商品事实来源'],
  [/商品身份锁定/u, '商品不能改变的内容'],
  [/(?:固定|动态)规划参数/u, '图片数量和画幅'],
  [/输出格式/u, '分析结果格式'],
  [/SKU 专属主图规则/u, '主图规则'],
  [/共享详情图的固定分工/u, '详情图位置分工'],
  [/prompt 构建顺序/u, '每张图的构图顺序'],
  [/negativePrompt 必须覆盖/u, '禁止内容'],
  [/acceptanceChecks/u, '生成后的检查项'],
  [/输出前总检查/u, '生成前总检查'],
  [/交给图片模型前/u, '交给生图模型的规则'],
  [/俄语文字与图片本地化/u, '俄语文字规则'],
  [/全局禁止清单/u, '全局禁止清单'],
  [/缺失信息和人工确认/u, '缺少信息怎么办'],
];

function getFriendlySectionLabel(title) {
  return FRIENDLY_SECTION_LABELS.find(([pattern]) => pattern.test(title))?.[1] || title;
}

export function splitSkillSystemPromptSections(value) {
  const lines = String(value ?? '').replace(/\r\n?/gu, '\n').split('\n');
  const sections = [];
  let current = { kind: 'intro', title: '角色与任务', lines: [] };

  lines.forEach((line) => {
    const cleanLine = line.trim();
    if (NUMBERED_SECTION_PATTERN.test(cleanLine)) {
      if (current.lines.some((item) => item.trim())) sections.push(current);
      current = { kind: 'heading', title: cleanLine, lines: [] };
      return;
    }
    current.lines.push(line);
  });
  if (current.lines.some((item) => item.trim()) || sections.length === 0) sections.push(current);

  return sections.map((section, index) => ({
    id: `${section.kind}-${index + 1}`,
    kind: section.kind,
    title: section.title || `规则 ${index + 1}`,
    label: section.kind === 'heading' ? getFriendlySectionLabel(section.title) : section.title || '角色与任务',
    content: section.lines.join('\n').trim(),
  }));
}

export function joinSkillSystemPromptSections(sections = []) {
  return (Array.isArray(sections) ? sections : [])
    .map((section) => {
      const content = text(section?.content);
      if (!content) return '';
      return section?.kind === 'heading' && text(section?.sourceTitle || section?.title)
        ? `${text(section.sourceTitle || section.title)}\n${content}`
        : content;
    })
    .filter(Boolean)
    .join('\n\n');
}

const ATTRIBUTE_SHARED_GLOBAL_RULE_LABELS = new Set([
  '商品事实来源',
  '商品不能改变的内容',
  '禁止内容',
  '全局禁止清单',
  '缺少信息怎么办',
  '俄语文字规则',
]);

export function formatGlobalSkillRulesForAttributePrompt(systemPrompt = '') {
  return splitSkillSystemPromptSections(systemPrompt)
    .filter((section) => ATTRIBUTE_SHARED_GLOBAL_RULE_LABELS.has(section.label))
    .map((section) => {
      const content = text(section.content);
      return content ? `${section.label}：\n${content}` : '';
    })
    .filter(Boolean)
    .join('\n\n');
}

export function getImagePositionRule(positionRules = {}, group = 'main', sourceIndex = 0, options = {}) {
  const safeGroup = group === 'detail' ? 'detail' : 'main';
  const rules = normalizeImagePositionRules(positionRules)[safeGroup];
  const safeSourceIndex = Number.isInteger(sourceIndex) && sourceIndex >= 0 ? sourceIndex : 0;
  return rules.find((rule) => rule.sourceIndex === safeSourceIndex)
    || (options.useSkillFallback ? supplementalPositionRule(safeSourceIndex, safeGroup) : emptyPositionRule(safeSourceIndex));
}
