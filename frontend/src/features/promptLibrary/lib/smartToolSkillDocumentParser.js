import { analyzeInstalledSkillModules } from './smartToolSkillModuleAnalyzer.js';
import {
  createSmartToolDependencyManifest,
  normalizeSmartToolDependencyBindings,
} from './smartToolDependencyRegistry.js';

export const SMART_TOOL_SKILL_DOCUMENT_PARSER_VERSION = 4;

const SECTION_CATEGORY = Object.freeze({
  OVERVIEW: 'overview',
  INPUT: 'input',
  CAPABILITY: 'capability',
  MODE: 'mode',
  WORKFLOW: 'workflow',
  EVIDENCE: 'evidence',
  SEO: 'seo',
  IMAGE: 'image',
  SKU_IMAGE: 'sku-image',
  ATTRIBUTE: 'attribute',
  OUTPUT: 'output',
  QA: 'qa',
  SAFETY: 'safety',
  STOP: 'stop',
  UNCLASSIFIED: 'unclassified',
});

const IMAGE_JOB_LABELS = Object.freeze({
  'primary/ctr image': '首图 / 点击图',
  'hero image': '首图 / 点击图',
  'structure image': '结构展示图',
  'dimension/specification image': '尺寸规格图',
  'specification image': '尺寸规格图',
  'material/detail image': '材质细节图',
  'detail image': '材质细节图',
  'function/use image': '功能使用图',
  'usage image': '功能使用图',
  'best remaining decision aid': '补充决策图',
  主图: '首图 / 点击图',
  首图: '首图 / 点击图',
  结构图: '结构展示图',
  尺寸图: '尺寸规格图',
  规格图: '尺寸规格图',
  材质图: '材质细节图',
  细节图: '材质细节图',
  功能图: '功能使用图',
  使用图: '功能使用图',
  场景图: '补充决策图',
});

const OPERATING_MODE_LABELS = Object.freeze({
  'full card': '完整商品卡',
  'step3 seo': '只做俄语 SEO',
  'step4 images': '只做商品图',
  'post-launch review': '上架后复盘',
});

function text(value) {
  return String(value ?? '')
    .replace(/\r\n?/gu, '\n')
    .trim();
}

function cleanMarkdown(value) {
  return text(value)
    .replace(/^```[^\n]*\n?|```$/gmu, '')
    .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/u, '')
    .replace(/^\s*>\s?/u, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, '$1')
    .replace(/[*_`]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function uniqueRows(value, limit = 120) {
  const seen = new Set();
  return (Array.isArray(value) ? value : [])
    .map(cleanMarkdown)
    .filter((item) => {
      const key = item.toLowerCase();
      if (!item || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}

function normalizeReferenceFiles(value) {
  return (Array.isArray(value) ? value : [])
    .map((item) => ({ path: text(item?.path).replace(/\\/gu, '/'), content: text(item?.content) }))
    .filter((item) => item.path && item.content)
    .slice(0, 48);
}

function createSourceDocuments(body = '', referenceFiles = []) {
  return [
    ...(text(body) ? [{ path: 'SKILL.md', content: text(body), primary: true }] : []),
    ...normalizeReferenceFiles(referenceFiles).map((item) => ({ ...item, primary: false })),
  ].map((item, index) => ({ ...item, sourceOrder: index }));
}

function stripFrontmatter(value = '') {
  const source = text(value);
  if (!source.startsWith('---\n')) return source;
  const endIndex = source.indexOf('\n---', 4);
  return endIndex < 0 ? source : source.slice(endIndex + 4).trim();
}

function splitMarkdownSections(document = {}) {
  const lines = stripFrontmatter(document.content).split('\n');
  const sections = [];
  let current = { heading: '', level: 0, lines: [], lineStart: 1 };
  const pushCurrent = () => {
    const content = current.lines.join('\n').trim();
    if (!current.heading && !content) return;
    sections.push({
      sourcePath: document.path,
      sourceOrder: document.sourceOrder,
      sectionOrder: sections.length,
      lineStart: current.lineStart,
      heading: cleanMarkdown(current.heading) || (document.primary ? 'Skill 说明' : document.path),
      level: current.level,
      content,
    });
  };
  lines.forEach((line, index) => {
    const match = line.match(/^\s*(#{1,6})\s+(.+?)\s*$/u);
    if (!match) {
      current.lines.push(line);
      return;
    }
    pushCurrent();
    current = { heading: match[2], level: match[1].length, lines: [], lineStart: index + 1 };
  });
  pushCurrent();
  return sections;
}

function classifySection(section = {}) {
  const heading = text(section.heading);
  const path = text(section.sourcePath);
  const sample = `${path}\n${heading}\n${text(section.content).slice(0, 600)}`;
  if (/(?:stop conditions?|停止条件|中止条件|何时停止)/iu.test(heading)) return SECTION_CATEGORY.STOP;
  if (/(?:sku\s*(?:images?|photos?)|sku\s*图片|sku\s*图|变体图)/iu.test(heading)) return SECTION_CATEGORY.SKU_IMAGE;
  if (/(?:acceptance|quality assurance|\bqa\b|validation|验收|质检|质量检查|生成和检查)/iu.test(heading)) {
    return SECTION_CATEGORY.QA;
  }
  if (/(?:security|safety|guardrails?|operating precautions|安全|风险|合规|防护)/iu.test(`${path}\n${heading}`)) {
    return SECTION_CATEGORY.SAFETY;
  }
  if (/(?:outputs?|result|deliverables?|artifacts?|complete operator bundle|输出|交付|结果结构)/iu.test(heading)) {
    return SECTION_CATEGORY.OUTPUT;
  }
  if (/(?:inputs?|arguments?|intake record|prerequisites?|输入|入参|使用信息|准备资料)/iu.test(heading)) {
    return SECTION_CATEGORY.INPUT;
  }
  if (/(?:operating modes?|work modes?|objective and mode|工作模式|运行模式|处理模式)/iu.test(heading)) {
    return SECTION_CATEGORY.MODE;
  }
  if (/(?:capabilities|features|abilities|主要能力|功能范围|能力)/iu.test(heading)) {
    return SECTION_CATEGORY.CAPABILITY;
  }
  if (/(?:workflow|process|run the gates|steps?|handoff gate|核心流程|执行流程|使用流程|工作流|阶段)/iu.test(heading)) {
    return SECTION_CATEGORY.WORKFLOW;
  }
  if (/(?:evidence|readiness|product truth|fact ledger|post-launch|证据|事实|准备度|复盘)/iu.test(heading)) {
    return SECTION_CATEGORY.EVIDENCE;
  }
  if (/(?:attributes?|属性)/iu.test(heading)) return SECTION_CATEGORY.ATTRIBUTE;
  if (
    /(?:seo|keyword|title|introduction|detail content|tags?|copy|搜索词|关键词|标题|简介|详情|标签|文案)/iu.test(
      heading
    )
  ) {
    return SECTION_CATEGORY.SEO;
  }
  if (
    /(?:images?|visual|picture|photo|prompt compilation|reference-role|图片|生图|图像|视觉|构图)/iu.test(
      `${path}\n${heading}`
    )
  ) {
    return SECTION_CATEGORY.IMAGE;
  }
  if (section.level <= 1 || /(?:readme|skill\.md)$/iu.test(path)) return SECTION_CATEGORY.OVERVIEW;
  if (/(?:scope|maturity)/iu.test(heading) && /security/iu.test(path)) return SECTION_CATEGORY.SAFETY;
  if (/(?:check|must|never|do not|不得|禁止|必须)/iu.test(sample)) return SECTION_CATEGORY.SAFETY;
  return SECTION_CATEGORY.UNCLASSIFIED;
}

function extractSectionRows(section = {}) {
  const lines = text(section.content).split('\n');
  const rows = [];
  let paragraph = [];
  let inCode = false;
  const flushParagraph = () => {
    const value = cleanMarkdown(paragraph.join(' '));
    if (value) rows.push(value);
    paragraph = [];
  };
  lines.forEach((line) => {
    if (/^\s*```/u.test(line)) {
      flushParagraph();
      inCode = !inCode;
      return;
    }
    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      return;
    }
    if (inCode) {
      const value = cleanMarkdown(trimmed);
      if (value) rows.push(value);
      return;
    }
    if (/^\s*(?:[-*+]\s+|\d+[.)]\s+)/u.test(line)) {
      flushParagraph();
      rows.push(cleanMarkdown(line));
      return;
    }
    if (/^\s*\|.*\|\s*$/u.test(line)) {
      flushParagraph();
      if (!/^\s*\|?\s*:?-{2,}/u.test(line)) {
        const cells = line.split('|').map(cleanMarkdown).filter(Boolean);
        if (cells.length) rows.push(cells.join(' — '));
      }
      return;
    }
    paragraph.push(trimmed);
  });
  flushParagraph();
  return uniqueRows(rows);
}

function rowsForCategory(sections, category, limit = 120) {
  return uniqueRows(
    sections.filter((item) => item.category === category).flatMap((item) => extractSectionRows(item)),
    limit
  );
}

function splitInstructionClauses(value = '') {
  return text(value)
    .split(/(?<=[.!?。！？；;])\s*|\n+/u)
    .map(cleanMarkdown)
    .filter(Boolean);
}

function createImageJob(section, rawTitle, rawInstruction, index) {
  const clauses = splitInstructionClauses(rawInstruction);
  const visibleText = clauses.filter((item) =>
    /(?:headline|copy|text|typograph|label|icon benefits?|information strip|Russian|标题|文案|文字|标签|俄语|信息条)/iu.test(
      item
    )
  );
  const mustAvoid = clauses.filter((item) =>
    /(?:\bno\b|\bnever\b|\bdo not\b|\bmust not\b|\bwithout\b|unsupported|absent|only when supported|must differ|禁止|不得|不要|不可|严禁|避免|未经|缺失|不能|不应|不可|不夸张)/iu.test(
      item
    )
  );
  const instructions = clauses.filter(
    (item) => !/^(?:No\b|Never\b|Do not\b|Must not\b|If\b|禁止|不得|不要|不可|严禁)/iu.test(item)
  );
  const sourceTitle = cleanMarkdown(rawTitle).replace(/[：:]$/u, '');
  return {
    id: `image-job-${index + 1}`,
    sourceIndex: index,
    position: index + 1,
    purpose: IMAGE_JOB_LABELS[sourceTitle.toLowerCase()] || sourceTitle,
    sourceTitle,
    instructions: uniqueRows(instructions).join(' '),
    visibleText: uniqueRows(visibleText).join(' '),
    mustAvoid: uniqueRows(mustAvoid).join(' '),
    sourcePath: section.sourcePath,
    sourceHeading: section.heading,
  };
}

function extractImageJobs(sections = []) {
  const jobs = [];
  sections
    .filter((section) => section.category === SECTION_CATEGORY.IMAGE)
    .forEach((section) => {
      const source = text(section.content);
      const matches = [...source.matchAll(/^\s*(\d+)[.)]\s+\*\*([^*]+)\*\*\s*[:：]\s*(.+)$/gimu)];
      matches.forEach((match) => {
        const sourceIndex = Math.max(0, Number(match[1]) - 1);
        if (jobs.some((item) => item.sourceIndex === sourceIndex)) return;
        jobs.push(createImageJob(section, match[2], match[3], sourceIndex));
      });
    });
  return jobs.sort((left, right) => left.sourceIndex - right.sourceIndex).slice(0, 30);
}

function createImagePositionRules(imageJobs = []) {
  return {
    main: imageJobs.map((item) => ({
      sourceIndex: item.sourceIndex,
      position: item.position,
      purpose: item.purpose,
      instructions: item.instructions,
      visibleText: item.visibleText,
      mustAvoid: item.mustAvoid,
    })),
    detail: [],
  };
}

function extractOperatingModes(sections = []) {
  const rows = sections
    .filter((item) => item.category === SECTION_CATEGORY.MODE)
    .flatMap((item) => extractSectionRows(item));
  const seen = new Set();
  return uniqueRows(rows)
    .filter((item) => !/^(?:模式|mode)\s*[—-]\s*(?:用途|use)$/iu.test(item))
    .map((item, index) => {
      const [label, ...descriptionParts] = item.split(/\s+[—–-]\s+|\s*[:：]\s*/u);
      const safeLabel = cleanMarkdown(label);
      return {
        value:
          safeLabel
            .toLowerCase()
            .replace(/[^a-z0-9\u4e00-\u9fff]+/gu, '-')
            .replace(/^-|-$/gu, '') || `mode-${index + 1}`,
        label: OPERATING_MODE_LABELS[safeLabel.toLowerCase()] || safeLabel,
        description: cleanMarkdown(descriptionParts.join(' — ')),
      };
    })
    .filter((item) => {
      if (!item.label || item.label.length > 80 || seen.has(item.value)) return false;
      seen.add(item.value);
      return true;
    })
    .slice(0, 12);
}

function inferRequiredCapabilities(sourceDocuments = [], parsed = {}) {
  const source = sourceDocuments.map((item) => item.content).join('\n');
  const hasOzon = /\bozon\b|俄罗斯电商|俄区平台/iu.test(source);
  const result = new Set();
  if (hasOzon && /\b(?:product|listing|sku|offer|category|attribute)\b|商品|商品卡|货号|类目|属性/iu.test(source)) {
    result.add('ozon.products.read');
  }
  if (hasOzon && /\b(?:image|photo|picture|visual)\b|图片|主图|详情图|生图/iu.test(source)) {
    result.add('ozon.productImages.read');
  }
  if (hasOzon && /\b(?:store|shop|seller|market)\b|店铺|卖家|市场/iu.test(source)) result.add('ozon.shops.read');
  if (hasOzon && /\b(?:order|posting|shipment|tracking)\b|订单|发货|运单|追踪号/iu.test(source)) {
    result.add('ozon.salesOrders.read');
  }
  if (hasOzon && /\b(?:return|refund|cancellation|after.?sales)\b|售后|退款|退货|取消/iu.test(source)) {
    result.add('ozon.afterSales.read');
  }
  if (hasOzon && /\b(?:finance|profit|fee|commission|accrual)\b|财务|利润|佣金|费用/iu.test(source)) {
    result.add('ozon.finance.read');
  }
  if (hasOzon && /\b(?:advertising|campaign|promotion)\b|广告|推广|营销活动/iu.test(source)) {
    result.add('ozon.marketing.read');
  }
  if (
    hasOzon &&
    /\b(?:analytics|metrics?|impressions|ctr|conversion|rank)\b|经营分析|指标|曝光|转化|排名/iu.test(source)
  ) {
    result.add('ozon.analytics.read');
  }
  if (/cross.?border.?bus|跨境巴士|物流同步|物流预报/iu.test(source)) result.add('cross-border.read');
  if (/seerfar|linkfox|领狐|竞品数据|市场数据/iu.test(source)) result.add('seerfar.market.read');
  if (parsed.seoRules.length || /\b(?:seo|copywriting|translate|text model)\b|文案|翻译|文本模型/iu.test(source)) {
    result.add('model.text.generate');
  }
  if (parsed.imageJobs.length || /\b(?:image generation|generate images?|image model)\b|生图|图片生成/iu.test(source)) {
    result.add('model.image.generate');
    result.add('product-image-storage');
  }
  return [...result];
}

function sectionTextByHeading(sections = [], pattern, categories = []) {
  return sections
    .filter((item) => (!categories.length || categories.includes(item.category)) && pattern.test(item.heading))
    .flatMap((item) => extractSectionRows(item))
    .join('\n')
    .slice(0, 6000);
}

function createAttributeRules(sections = [], parsed = {}) {
  const evidenceText = rowsForCategory(sections, SECTION_CATEGORY.EVIDENCE, 40).join('\n').slice(0, 6000);
  const safetyText = [...parsed.safetyNotes, ...parsed.stopConditions].join('\n').slice(0, 6000);
  return {
    optimizationGoal: rowsForCategory(sections, SECTION_CATEGORY.OVERVIEW, 8).join('\n').slice(0, 3000),
    factSources: evidenceText,
    editableScope: [...parsed.capabilities, ...parsed.outputs].join('\n').slice(0, 6000),
    protectedScope: safetyText,
    titleRules: sectionTextByHeading(sections, /(?:title|标题)/iu, [SECTION_CATEGORY.SEO]),
    descriptionRules: sectionTextByHeading(sections, /(?:introduction|detail content|description|简介|详情|描述)/iu, [
      SECTION_CATEGORY.SEO,
    ]),
    tagRules: sectionTextByHeading(sections, /(?:tags?|标签|搜索词)/iu, [SECTION_CATEGORY.SEO]),
    missingFieldRules: [...parsed.evidenceRules, ...parsed.stopConditions].join('\n').slice(0, 6000),
    outputRules: [...parsed.outputs, ...parsed.qaRules].join('\n').slice(0, 6000),
  };
}

export function parseInstalledSkillDocuments({ body = '', referenceFiles = [], sourceName = '' } = {}) {
  const sourceDocuments = createSourceDocuments(body, referenceFiles);
  const sections = sourceDocuments
    .flatMap(splitMarkdownSections)
    .map((section) => ({ ...section, category: classifySection(section) }));
  const capabilities = rowsForCategory(sections, SECTION_CATEGORY.CAPABILITY);
  const inputs = rowsForCategory(sections, SECTION_CATEGORY.INPUT).filter(
    (item) =>
      item.length <= 120 &&
      !/[.:;。；：]$/u.test(item) &&
      !/^(?:capture|provide|use|for project|first inspect|请|先|使用|提供)/iu.test(item) &&
      !item.includes('$')
  );
  const outputs = rowsForCategory(sections, SECTION_CATEGORY.OUTPUT);
  const workflowSteps = rowsForCategory(sections, SECTION_CATEGORY.WORKFLOW);
  const evidenceRules = rowsForCategory(sections, SECTION_CATEGORY.EVIDENCE);
  const seoRules = rowsForCategory(sections, SECTION_CATEGORY.SEO);
  const imageRules = rowsForCategory(sections, SECTION_CATEGORY.IMAGE);
  const skuImageRules = rowsForCategory(sections, SECTION_CATEGORY.SKU_IMAGE);
  const qaRules = rowsForCategory(sections, SECTION_CATEGORY.QA);
  const safetyNotes = rowsForCategory(sections, SECTION_CATEGORY.SAFETY);
  const stopConditions = rowsForCategory(sections, SECTION_CATEGORY.STOP);
  const imageJobs = extractImageJobs(sections);
  const ruleCatalog = sections.map((section, index) => ({
    id: `rule-section-${index + 1}`,
    category: section.category,
    sourcePath: section.sourcePath,
    sourceOrder: section.sourceOrder,
    sectionOrder: section.sectionOrder,
    lineStart: section.lineStart,
    heading: section.heading,
    content: text(section.content),
  }));
  const unclassifiedSections = ruleCatalog.filter((item) => item.category === SECTION_CATEGORY.UNCLASSIFIED);
  const operatingModes = extractOperatingModes(sections);
  const partial = {
    capabilities,
    inputs,
    outputs,
    workflowSteps,
    evidenceRules,
    seoRules,
    imageRules,
    skuImageRules,
    qaRules,
    safetyNotes,
    stopConditions,
    imageJobs,
  };
  const requiredCapabilities = inferRequiredCapabilities(sourceDocuments, partial);
  const declaredSourceName =
    text(sourceName) || text(String(body || '').match(/^name:\s*['"]?([^'"\n]+)['"]?\s*$/imu)?.[1]);
  const moduleAnalysis = analyzeInstalledSkillModules({
    sourceName: declaredSourceName,
    ruleCatalog,
    requiredCapabilities,
    ...partial,
  });
  const dependencyManifest = createSmartToolDependencyManifest({
    referencedTools: moduleAnalysis.referencedTools,
    ruleCatalog,
  });
  const dependencyBindings = normalizeSmartToolDependencyBindings(dependencyManifest);
  const resolvedModuleAnalysis = {
    ...moduleAnalysis,
    dependencyManifest,
    warnings: [
      ...(moduleAnalysis.warnings || []).filter((item) => !/^发现 \d+ 个外部 Skill\/工具依赖/u.test(item)),
      ...(dependencyManifest.dependencies.length
        ? [
            `已自动分类 ${dependencyManifest.dependencies.length} 个外部依赖：${dependencyManifest.requiredCount} 个始终需要、${dependencyManifest.conditionalCount} 个按场景启用、${dependencyManifest.embeddedCount} 个逻辑已内置。`,
          ]
        : []),
    ],
  };
  const parseWarnings = [];
  if (!sourceDocuments.length) parseWarnings.push('没有读取到 Skill 文档。');
  if (!workflowSteps.length) parseWarnings.push('没有识别到明确的执行流程。');
  if (/image|图片|生图/iu.test(sourceDocuments.map((item) => item.content).join('\n')) && !imageJobs.length) {
    parseWarnings.push('识别到图片能力，但没有解析出按位置排列的图片任务。');
  }
  return {
    parserVersion: SMART_TOOL_SKILL_DOCUMENT_PARSER_VERSION,
    sourceDocuments: sourceDocuments.map((item) => ({
      path: item.path,
      primary: item.primary,
      sourceOrder: item.sourceOrder,
      characterCount: item.content.length,
    })),
    ruleCatalog,
    unclassifiedSections,
    parseWarnings,
    parseSummary: {
      documentCount: sourceDocuments.length,
      sectionCount: sections.length,
      classifiedSectionCount: sections.length - unclassifiedSections.length,
      unclassifiedSectionCount: unclassifiedSections.length,
      imageJobCount: imageJobs.length,
      moduleCount: moduleAnalysis.moduleCount,
    },
    ...partial,
    usageInputs: inputs.slice(0, 3),
    operatingModes,
    requiredCapabilities,
    moduleAnalysis: resolvedModuleAnalysis,
    dependencyManifest,
    dependencyBindings,
    modules: resolvedModuleAnalysis.modules,
    referencedTools: resolvedModuleAnalysis.referencedTools,
    imageJobs,
    imagePositionRules: createImagePositionRules(imageJobs),
    attributeRules: createAttributeRules(sections, partial),
  };
}
