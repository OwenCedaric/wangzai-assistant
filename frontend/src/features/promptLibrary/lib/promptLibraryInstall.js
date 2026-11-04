import {
  createPromptLibraryId,
  formatPromptLibraryUpdatedAt,
  normalizePromptLibraryItem,
  promptLibraryStatusOptions,
} from './promptLibraryStore.jsx';
import { getSmartToolSkillExecutionState } from './smartToolAdapterRegistry.js';
import { normalizeInstalledSkillProfile, resolveInstalledSkillPresentation } from './smartToolInstalledSkill.js';
import { createSmartToolApiBindingManifest, SMART_TOOL_API_BINDING_VERSION } from './smartToolApiCapabilityRegistry.js';
import { compileSmartToolExecutionPlan, SMART_TOOL_EXECUTION_CONTRACT_VERSION } from './smartToolExecutionPlan.js';
import { parseInstalledSkillDocuments } from './smartToolSkillDocumentParser.js';
import {
  SMART_TOOL_ATTRIBUTE_RULES_VERSION,
  SMART_TOOL_IMAGE_POSITION_RULES_VERSION,
} from './smartToolSkillConfiguration.js';

function splitInstallToolFields(value) {
  const rows = Array.isArray(value) ? value : String(value ?? '').split(/[，,\n]/);
  return rows
    .map((item) =>
      String(item)
        .replace(/^[-*]\s*/, '')
        .replace(/^\d+[.)]\s*/, '')
        .replace(/^```\w*$/u, '')
        .replace(/`/g, '')
        .trim()
    )
    .filter(Boolean);
}

function getInstallMarkdownSectionRows(text = '', headingPattern) {
  return getInstallMarkdownSection(text, headingPattern).split(/\r?\n/u);
}

function findInstallToolScene(categories, source = {}) {
  const rawScene = String(source.scene || source.category || source.sceneLabel || '').trim();
  if (rawScene) {
    const matched = categories.find((item) => item.value === rawScene || item.label === rawScene);
    if (matched) return matched.value;
  }

  const searchText =
    `${source.title || ''} ${source.name || ''} ${source.skillName || ''} ${source.description || ''} ${source.body || ''}`.toLowerCase();
  if (searchText.includes('ozon'))
    return categories.find((item) => item.value === 'ozon')?.value ?? categories[0]?.value;
  if (searchText.includes('1688'))
    return categories.find((item) => item.value === '1688')?.value ?? categories[0]?.value;
  if (searchText.includes('image') || searchText.includes('图片')) {
    return categories.find((item) => item.value === 'image')?.value ?? categories[0]?.value;
  }
  if (searchText.includes('profit') || searchText.includes('利润')) {
    return categories.find((item) => item.value === 'profit')?.value ?? categories[0]?.value;
  }

  return categories[0]?.value ?? 'ozon';
}

function parseInstallFrontmatter(text = '') {
  const sourceText = String(text || '');
  if (!sourceText.startsWith('---')) return {};
  const endIndex = sourceText.indexOf('\n---', 3);
  if (endIndex < 0) return {};
  return sourceText
    .slice(3, endIndex)
    .split(/\r?\n/)
    .reduce((result, line) => {
      const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (!match) return result;
      result[match[1]] = match[2].replace(/^['"]|['"]$/g, '').trim();
      return result;
    }, {});
}

function getInstallMarkdownSection(text = '', headingPattern) {
  const sourceText = String(text || '');
  const match = sourceText.match(headingPattern);
  if (!match) return '';
  const start = match.index + match[0].length;
  const rest = sourceText.slice(start);
  const nextHeading = rest.search(/\n#{1,3}\s+/);
  return (nextHeading >= 0 ? rest.slice(0, nextHeading) : rest).trim();
}

function extractInstallSkillVariables(text = '') {
  const placeholders = Array.from(String(text || '').matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)).map((match) => match[1]);
  const inputSection = getInstallMarkdownSection(
    text,
    /\n#{1,3}\s*(Inputs?|输入|输入资料|参数|Arguments?|Intake record)\s*\n/i
  );
  const inputLines = inputSection
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^[-*]\s*/, '')
        .replace(/^\d+[.)]\s*/, '')
        .replace(/^```\w*$/u, '')
        .replace(/`/g, '')
        .trim()
    )
    .filter((line) => line && !/:$/u.test(line))
    .slice(0, 8);
  return Array.from(new Set([...placeholders, ...inputLines])).filter(Boolean);
}

function actionableInstallText(text = '') {
  return String(text || '')
    .split(/\r?\n/u)
    .filter(
      (line) =>
        !/(?:\bnever\b|\bdo not\b|\bdoes not\b|\bwithout permission\b|\bremain unperformed\b|\bstop before\b|禁止|不得|不会|不代表|未授权|无权)/iu.test(
          line.replace(/[*_`]/gu, '')
        )
    )
    .join('\n')
    .toLowerCase();
}

function detectInstallRunType(text = '', extra = {}) {
  if ((Array.isArray(extra.executableFiles) ? extra.executableFiles : []).length) return 'external-or-script';
  const lowerText = actionableInstallText(text);
  if (
    /\b(?:publish|submit)\b[^\n]{0,80}\b(?:ozon|marketplace|listing|order|ticket)\b|\bwrite\s*back\b|\bupdate\b[^\n]{0,40}\blive\b|\bdelete\b[^\n]{0,40}\b(?:listing|order|record|data)\b|写入[^\n]{0,40}(?:ozon|业务|数据库|订单|商品|库存|价格)|提交[^\n]{0,40}(?:ozon|订单|工单|商品)|修改[^\n]{0,40}(?:线上|商品|订单|库存|价格|广告)|删除[^\n]{0,40}(?:商品|订单|数据)|ozon 回读|readback/iu.test(
      lowerText
    )
  )
    return 'guard-required';
  if (
    /\bscript\b|scripts\/|\bpython\b|\bnode\b|\bapi\b|接口|\bfetch\b|\bbrowser\b|浏览器|\bchrome\b|\bplaywright\b/.test(
      lowerText
    )
  ) {
    return 'api-assisted-readonly';
  }
  return 'local-ai-preview';
}

function normalizeInstallReferenceFiles(value) {
  return (Array.isArray(value) ? value : [])
    .map((item) => ({ path: String(item?.path || '').trim(), content: String(item?.content || '') }))
    .filter((item) => item.path && item.content)
    .slice(0, 24);
}

function createInstallAnalysisText(body, referenceFiles) {
  return [body, ...referenceFiles.map((item) => `\n# Imported reference: ${item.path}\n\n${item.content}`)]
    .filter(Boolean)
    .join('\n');
}

function createInstallSkillProfile(source = {}, extra = {}) {
  const body = String(source.body || source.instructions || source.content || source.readme || source.markdown || '');
  const referenceFiles = normalizeInstallReferenceFiles(source.referenceFiles || extra.referenceFiles);
  const analysisText = createInstallAnalysisText(body, referenceFiles);
  const parsed = parseInstalledSkillDocuments({
    body,
    referenceFiles,
    sourceName: source.sourceName || source.skillName || source.name || source.title || extra.fileName,
  });
  const sourceListOrParsed = (value, fallback) => {
    const sourceRows = splitInstallToolFields(value);
    return sourceRows.length ? sourceRows : fallback;
  };
  const runType = String(source.runType || source.actionMode || detectInstallRunType(analysisText, source)).trim();
  const capabilities = sourceListOrParsed(
    source.capabilities || source.features || source.abilities,
    parsed.capabilities.length
      ? parsed.capabilities
      : splitInstallToolFields(
          getInstallMarkdownSectionRows(analysisText, /\n#{1,3}\s*(Capabilities|主要能力|能力|Features|功能)\s*\n/i)
        )
  );
  const inputs = sourceListOrParsed(
    source.inputs || source.variables,
    parsed.inputs.length ? parsed.inputs : extractInstallSkillVariables(analysisText)
  );
  const usageInputs = sourceListOrParsed(
    source.usageInputs,
    parsed.usageInputs.length ? parsed.usageInputs : inputs.slice(0, 3)
  );
  const outputs = sourceListOrParsed(
    source.outputs || source.outputFields,
    parsed.outputs.length
      ? parsed.outputs
      : splitInstallToolFields(
          getInstallMarkdownSectionRows(
            analysisText,
            /\n#{1,3}\s*(Outputs?|输出|输出结构|Result|Complete operator bundle|Output and acceptance contract)\s*\n/i
          )
        )
  );
  const workflowSteps = sourceListOrParsed(
    source.workflowSteps || source.workflow || source.steps || source.flow,
    parsed.workflowSteps.length
      ? parsed.workflowSteps
      : splitInstallToolFields(
          getInstallMarkdownSectionRows(
            analysisText,
            /\n#{1,3}\s*(Workflow|Workflow and evidence|Run the gates|Gates|Steps?|流程|执行流程|使用流程|Process)\s*\n/i
          )
        )
  );
  const safetyNotes = sourceListOrParsed(
    source.safetyNotes || source.risks,
    [...parsed.safetyNotes, ...parsed.stopConditions].length
      ? [...parsed.safetyNotes, ...parsed.stopConditions]
      : splitInstallToolFields(
          getInstallMarkdownSectionRows(
            analysisText,
            /\n#{1,3}\s*(Safety|Security notes|Stop conditions|安全|安全与能力边界|Risks?|风险|Guardrails?)\s*\n/i
          )
        )
  );

  return {
    ...parsed,
    sourceName: String(
      source.sourceName || source.skillName || source.name || source.title || extra.fileName || ''
    ).trim(),
    sourceUrl: String(source.sourceUrl || source.homepage || source.url || extra.url || '').trim(),
    installType: String(source.installType || extra.installType || 'skill-md').trim(),
    adapterKey: String(source.adapterKey || source.adapter || '').trim(),
    adapterVersion: Number(source.adapterVersion || 1),
    runType,
    availability: String(
      source.availability || source.requires || source.requiredSettings || '安装后需人工确认配置'
    ).trim(),
    capabilities,
    inputs,
    usageInputs,
    outputs,
    workflowSteps,
    safetyNotes,
    referenceFiles,
    repository: String(source.repository || extra.repository || '').trim(),
    ref: String(source.ref || extra.ref || '').trim(),
    packagePath: String(source.packagePath || extra.packagePath || '').trim(),
    sourceHash: String(source.sourceHash || extra.sourceHash || '').trim(),
    manifest: Array.isArray(source.manifest || extra.manifest) ? (source.manifest || extra.manifest).slice(0, 100) : [],
    executableFiles: splitInstallToolFields(source.executableFiles || extra.executableFiles),
  };
}

export function createInstallPreviewFromSource(source, categories, extra = {}) {
  const cleanSource = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
  const fallbackTitle = extra.fileName?.replace(/\.[^.]+$/, '') || extra.url || '未命名工具';
  const title = String(cleanSource.title || cleanSource.name || cleanSource.skillName || fallbackTitle).trim();
  const goal = String(
    cleanSource.goal || cleanSource.description || cleanSource.summary || '安装后先放到工具中心，不会自动执行。'
  ).trim();
  const body = String(
    cleanSource.body ||
      cleanSource.instructions ||
      cleanSource.content ||
      cleanSource.readme ||
      cleanSource.markdown ||
      goal
  ).trim();
  const variables = splitInstallToolFields(
    cleanSource.variables || cleanSource.inputs || cleanSource.inputFields || cleanSource.requiredFields
  );
  const entryPoints = splitInstallToolFields(
    cleanSource.entryPoints || cleanSource.pages || cleanSource.applicablePages || cleanSource.availablePages
  );
  const dependencies = splitInstallToolFields(
    cleanSource.dependencies || cleanSource.requires || cleanSource.requiredSettings || cleanSource.requiredAccounts
  );
  const id = createPromptLibraryId();
  const rawSkillProfile = createInstallSkillProfile(cleanSource, extra);
  const skillProfile = normalizeInstalledSkillProfile(
    { id, title, goal, body, skillProfile: rawSkillProfile },
    rawSkillProfile
  );
  const presentation = resolveInstalledSkillPresentation({ id, title, goal, body, skillProfile });
  const apiBindings = createSmartToolApiBindingManifest({
    id,
    title: presentation.title || title,
    goal: presentation.goal || goal,
    body,
    scene: findInstallToolScene(categories, cleanSource),
    variables: skillProfile.usageInputs.length ? skillProfile.usageInputs : variables,
    dependencies,
    skillProfile,
  });
  const profileWithBindings = {
    ...skillProfile,
    apiBindingVersion: SMART_TOOL_API_BINDING_VERSION,
    apiBindings,
  };
  const executionPlan = compileSmartToolExecutionPlan({ id, skillProfile: profileWithBindings }, apiBindings);
  const executionState = getSmartToolSkillExecutionState({ id, skillProfile: profileWithBindings });
  const nextSkillProfile = {
    ...profileWithBindings,
    adapterKey: executionState.adapterKey || '',
    adapterVersion: executionState.adapterVersion,
    runtimeStatus: executionState.status,
    runtimeStatusLabel: executionState.statusLabel,
    executionContractVersion: SMART_TOOL_EXECUTION_CONTRACT_VERSION,
    executionPlan,
  };
  const inferredStatus =
    executionState.status === 'needs_adapter'
      ? '待接入'
      : executionState.status === 'guard_required'
        ? '待配置'
        : executionState.status === 'ready' && executionPlan.canStart
          ? '可用'
          : ['local-ai-preview', 'api-assisted-readonly'].includes(skillProfile.runType)
            ? '部分可用'
            : '待配置';
  const status = promptLibraryStatusOptions.includes(cleanSource.status) ? cleanSource.status : inferredStatus;

  return normalizePromptLibraryItem(
    {
      id,
      title: presentation.title || title,
      scene: findInstallToolScene(categories, cleanSource),
      status,
      owner: String(cleanSource.owner || cleanSource.author || '工具组').trim(),
      goal: presentation.goal || goal,
      variables: skillProfile.usageInputs.length
        ? skillProfile.usageInputs
        : variables.length
          ? variables
          : ['按工具说明准备'],
      body,
      updatedAt: formatPromptLibraryUpdatedAt(),
      used: 0,
      entryPoints,
      dependencies,
      skillProfile: nextSkillProfile,
      promptConfig: {
        modelPurpose: presentation.goal || goal,
        systemPrompt: body,
        userPrompt: '',
        outputFormat: (skillProfile.outputs || []).join('\n'),
        outputRules: skillProfile.qaRules || [],
        workflowSteps: skillProfile.workflowSteps || [],
        safetyRules: skillProfile.safetyNotes || [],
        capabilities: skillProfile.capabilities || [],
        inputs: skillProfile.inputs || [],
        outputs: skillProfile.outputs || [],
        imagePositionRules: skillProfile.imagePositionRules,
        imagePositionRulesVersion: SMART_TOOL_IMAGE_POSITION_RULES_VERSION,
        attributeRules: skillProfile.attributeRules,
        attributeRulesVersion: SMART_TOOL_ATTRIBUTE_RULES_VERSION,
      },
      runMode: String(cleanSource.runMode || cleanSource.actionMode || '').trim(),
      manifestVersion: Number(cleanSource.manifestVersion || 1),
    },
    0,
    categories
  );
}

export function createInstallPreviewFromMarkdown(text, fileName, categories, extra = {}) {
  const frontmatter = parseInstallFrontmatter(text);
  const referenceFiles = normalizeInstallReferenceFiles(extra.referenceFiles);
  const analysisText = createInstallAnalysisText(text, referenceFiles);
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim());
  const title =
    frontmatter.title ||
    frontmatter.name ||
    lines.find((line) => line.startsWith('# '))?.replace(/^#\s+/, '') ||
    fileName.replace(/\.[^.]+$/, '');
  const description =
    frontmatter.description ||
    lines.find((line) => line && !line.startsWith('#') && !line.startsWith('---')) ||
    '安装后先放到工具中心，不会自动执行。';
  const variables = extractInstallSkillVariables(analysisText);
  const runType = detectInstallRunType(analysisText, extra);

  return createInstallPreviewFromSource(
    {
      ...frontmatter,
      title,
      skillName: frontmatter.name || title,
      description,
      body: text,
      variables,
      runType,
      sourceUrl: extra.sourceUrl,
      installType: extra.installType,
      repository: extra.repository,
      ref: extra.ref,
      packagePath: extra.packagePath,
      sourceHash: extra.sourceHash,
      manifest: extra.manifest,
      executableFiles: extra.executableFiles,
      referenceFiles,
    },
    categories,
    {
      ...extra,
      fileName,
      installType: extra.installType || (fileName.toLowerCase() === 'skill.md' ? 'skill-md' : 'markdown-skill'),
    }
  );
}
