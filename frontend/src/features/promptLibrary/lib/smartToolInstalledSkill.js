import { getSmartToolSkillExecutionState } from './smartToolAdapterRegistry.js';
import {
  parseInstalledSkillDocuments,
  SMART_TOOL_SKILL_DOCUMENT_PARSER_VERSION,
} from './smartToolSkillDocumentParser.js';

const INSTALLED_INPUT_LABELS = Object.freeze({
  'objective and mode': '处理模式',
  'store/market/language': '店铺、市场与语言',
  'product, spu/skc, and sku identities': '商品、SPU/SKC 与 SKU 信息',
  'product type and intended category': '商品类型与目标类目',
  'authoritative product sources': '商品事实来源',
  'reference-image rights and generation authority': '参考图授权与生图范围',
  'search-data window and source': '搜索数据周期与来源',
  'requested deliverables': '需要生成的内容',
  'deadline and acceptance': '完成时间与验收要求',
  'external-effect boundary': '允许执行的操作边界',
  'product identity': '商品信息',
  'sku matrix': 'SKU 规格信息',
});

function cleanText(value) {
  return String(value ?? '').trim();
}

function uniqueList(...values) {
  return [
    ...new Set(
      values
        .flatMap((value) => (Array.isArray(value) ? value : []))
        .map(cleanText)
        .filter(Boolean)
    ),
  ];
}

function skillProfileOf(tool = {}) {
  return tool?.skillProfile && typeof tool.skillProfile === 'object' && !Array.isArray(tool.skillProfile)
    ? tool.skillProfile
    : {};
}

function unquoteYamlValue(value = '') {
  return cleanText(value)
    .replace(/^['"]|['"]$/gu, '')
    .trim();
}

function getReferenceContent(profile = {}, expectedPath = '') {
  const normalizedPath = expectedPath.replace(/\\/gu, '/').toLowerCase();
  return cleanText(
    (Array.isArray(profile.referenceFiles) ? profile.referenceFiles : []).find(
      (item) => cleanText(item?.path).replace(/\\/gu, '/').toLowerCase() === normalizedPath
    )?.content
  );
}

function parseAgentPresentation(profile = {}) {
  const content = getReferenceContent(profile, 'agents/openai.yaml');
  if (!content) return {};
  const displayName = content.match(/^\s*display_name:\s*(.+)$/imu)?.[1];
  const shortDescription = content.match(/^\s*short_description:\s*(.+)$/imu)?.[1];
  return {
    displayName: unquoteYamlValue(displayName),
    shortDescription: unquoteYamlValue(shortDescription),
  };
}

function parseFrontmatterDescription(body = '') {
  const source = String(body || '');
  if (!source.startsWith('---')) return '';
  const endIndex = source.indexOf('\n---', 3);
  if (endIndex < 0) return '';
  return unquoteYamlValue(source.slice(3, endIndex).match(/^description:\s*(.+)$/imu)?.[1]);
}

export function isUserInstalledSmartTool(tool = {}) {
  const profile = skillProfileOf(tool);
  if (getSmartToolSkillExecutionState(tool).isBuiltIn) return false;
  return Boolean(
    cleanText(profile.installType) ||
    cleanText(profile.sourceUrl) ||
    cleanText(profile.repository) ||
    cleanText(profile.sourceHash) ||
    (Array.isArray(profile.referenceFiles) && profile.referenceFiles.length)
  );
}

export function localizeInstalledSkillInputLabel(value = '') {
  const original = cleanText(value);
  return INSTALLED_INPUT_LABELS[original.toLowerCase()] || original;
}

function localizeInstalledSkillInputList(value) {
  return (Array.isArray(value) ? value : []).map(localizeInstalledSkillInputLabel).filter(Boolean);
}

export function normalizeInstalledSkillProfile(tool = {}, profileOverride = null) {
  const profile = profileOverride && typeof profileOverride === 'object' ? profileOverride : skillProfileOf(tool);
  if (!isUserInstalledSmartTool({ ...tool, skillProfile: profile })) return profile;
  if (Number(profile.parserVersion || 0) >= SMART_TOOL_SKILL_DOCUMENT_PARSER_VERSION) {
    return {
      ...profile,
      inputs: localizeInstalledSkillInputList(profile.inputs),
      usageInputs: localizeInstalledSkillInputList(profile.usageInputs),
      presentationVersion: 1,
    };
  }
  const parsed = parseInstalledSkillDocuments({
    body: tool?.body,
    referenceFiles: profile.referenceFiles,
    sourceName: profile.sourceName || profile.repository || tool?.title,
  });
  const parsedOrExisting = (field) =>
    Array.isArray(parsed[field]) && parsed[field].length ? parsed[field] : profile[field];
  return {
    ...profile,
    ...parsed,
    referenceFiles: Array.isArray(profile.referenceFiles) ? profile.referenceFiles : [],
    capabilities: parsedOrExisting('capabilities'),
    inputs: localizeInstalledSkillInputList(parsedOrExisting('inputs')),
    usageInputs: localizeInstalledSkillInputList(parsedOrExisting('usageInputs')),
    outputs: parsedOrExisting('outputs'),
    workflowSteps: parsedOrExisting('workflowSteps'),
    safetyNotes: uniqueList(parsedOrExisting('safetyNotes'), parsed.stopConditions),
    presentationVersion: 1,
  };
}

export function resolveInstalledSkillPresentation(tool = {}) {
  const profile = skillProfileOf(tool);
  if (!isUserInstalledSmartTool(tool)) {
    return { title: cleanText(tool.title), goal: cleanText(tool.goal) };
  }
  const metadata = parseAgentPresentation(profile);
  const currentTitle = cleanText(tool.title);
  const currentGoal = cleanText(tool.goal);
  const sourceName = cleanText(profile.sourceName);
  const sourceDescription = parseFrontmatterDescription(tool.body);
  const canUseDisplayName = metadata.displayName && (!currentTitle || currentTitle === sourceName);
  const canUseShortDescription =
    metadata.shortDescription && (!currentGoal || currentGoal === sourceDescription || currentGoal === '待补充用途');
  return {
    title: canUseDisplayName ? metadata.displayName : currentTitle,
    goal: canUseShortDescription ? metadata.shortDescription : currentGoal,
  };
}

export function getInstalledSkillUsageInputSpecs(tool = {}) {
  if (!isUserInstalledSmartTool(tool)) return [];
  const profile = normalizeInstalledSkillProfile(tool);
  const labels = localizeInstalledSkillInputList(profile.usageInputs);
  const modes = (Array.isArray(profile.operatingModes) ? profile.operatingModes : [])
    .map((item) => ({ value: cleanText(item?.value), label: cleanText(item?.label) }))
    .filter((item) => item.value && item.label);
  return labels.map((label) => {
    if (/(?:模式|范围|mode|scope)/iu.test(label) && modes.length) {
      return {
        label,
        control: 'select',
        defaultValue: modes[0].value,
        helperText: '按 Skill 自带的工作模式选择本次执行范围。',
        options: modes,
      };
    }
    if (/(?:店铺|市场|语言|store|market|language)/iu.test(label)) {
      return {
        label,
        placeholder: '由软件内已绑定的店铺自动带出',
        helperText: '优先使用软件内已绑定的店铺、市场和语言。',
      };
    }
    if (/(?:商品|sku|spu|skc|product|资料|facts?)/iu.test(label)) {
      return {
        label,
        placeholder: '填写或选择本次商品与 SKU 信息',
        helperText: '一行一项；不确定的内容请标记“待确认”。',
        multiple: true,
        minRows: 4,
        maxRows: 7,
      };
    }
    return { label, placeholder: `填写${label}` };
  });
}
