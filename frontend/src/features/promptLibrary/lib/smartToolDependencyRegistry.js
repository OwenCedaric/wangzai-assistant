import { getSmartToolExecutionPlan } from './smartToolExecutionPlan.js';

export const SMART_TOOL_DEPENDENCY_CONTRACT_VERSION = 1;

export const SMART_TOOL_DEPENDENCY_REQUIREMENT = Object.freeze({
  REQUIRED: 'required',
  CONDITIONAL: 'conditional',
  EMBEDDED: 'embedded',
});

export const SMART_TOOL_DEPENDENCY_RESOLUTION = Object.freeze({
  BUILTIN: 'builtin',
  INSTALLED_SKILL: 'installed_skill',
  DISABLED: 'disabled',
});

const KNOWN_DEPENDENCY_CONTRACTS = Object.freeze({
  $imagegen: {
    purpose: '实际生成商品图片，并把结果进入受保护图片资产链路。',
    requirement: SMART_TOOL_DEPENDENCY_REQUIREMENT.CONDITIONAL,
    activationHint: '仅在本次范围包含实际生图时启用。',
    activationPattern: /full card|step\s*4|images?|图片|生图|生成图/iu,
    requiredCapabilities: ['model.image.generate', 'product-image-storage'],
    builtinAdapter: 'builtin.protected-image-generation',
    builtinLabel: '内置图片生成与安全存储',
  },
  '$grill-me': {
    purpose: '资料存在关键缺口时进行有限追问。',
    requirement: SMART_TOOL_DEPENDENCY_REQUIREMENT.EMBEDDED,
    activationHint: '追问规则已作为本 Skill 的内置流程执行，不需要单独安装。',
    activationPattern: /缺失|追问|证据|evidence|question|interview/iu,
    requiredCapabilities: [],
    builtinAdapter: 'builtin.evidence-gap-interview',
    builtinLabel: '内置资料缺口追问',
  },
  '$ozon-step4-prompt-library': {
    purpose: '读取、学习或维护可复用的商品图风格和提示词模块。',
    requirement: SMART_TOOL_DEPENDENCY_REQUIREMENT.CONDITIONAL,
    activationHint: '只有本次要求读取、学习或保存复用风格时启用。',
    activationPattern: /style|prompt library|提示词库|风格|复用|学习/iu,
    requiredCapabilities: [],
  },
  '$drive-cross-border-ecommerce': {
    purpose: '把当前 Skill 纳入更大的跨境项目、负责人和交接流程。',
    requirement: SMART_TOOL_DEPENDENCY_REQUIREMENT.CONDITIONAL,
    activationHint: '只有本次属于跨境项目协同或需要交接管理时启用。',
    activationPattern: /project|lead|owner|handoff|项目|负责人|交接/iu,
    requiredCapabilities: [],
  },
});

function text(value) {
  return String(value ?? '').trim();
}

function unique(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).map(text).filter(Boolean))];
}

function referenceSourceText(reference = {}, ruleCatalog = []) {
  const sourcePaths = new Set(Array.isArray(reference.sourcePaths) ? reference.sourcePaths.map(text) : []);
  const sourceSections = new Set(Array.isArray(reference.sourceSections) ? reference.sourceSections.map(text) : []);
  return (Array.isArray(ruleCatalog) ? ruleCatalog : [])
    .filter(
      (section) =>
        (!sourcePaths.size || sourcePaths.has(text(section?.sourcePath))) &&
        (!sourceSections.size || sourceSections.has(text(section?.heading)))
    )
    .map((section) => `${text(section?.heading)}\n${text(section?.content)}`)
    .join('\n')
    .slice(0, 8000);
}

function inferRequirement(
  sourceText = '',
  dependencyId = '',
  fallback = SMART_TOOL_DEPENDENCY_REQUIREMENT.CONDITIONAL
) {
  const id = text(dependencyId);
  const occurrenceText = sourceText
    .split(/\r?\n/u)
    .filter((line) => !id || line.includes(id))
    .join('\n');
  const evidence = occurrenceText || sourceText;
  if (/adapt only[^\n]{0,180}from|借鉴.{0,80}(?:行为|逻辑)|内置(?:行为|逻辑)/iu.test(evidence)) {
    return SMART_TOOL_DEPENDENCY_REQUIREMENT.EMBEDDED;
  }
  if (/\b(?:if|when|only when|whenever|for project work)\b|如果|仅当|需要时|项目工作/iu.test(evidence)) {
    return SMART_TOOL_DEPENDENCY_REQUIREMENT.CONDITIONAL;
  }
  if (/\b(?:must|required|requires)\b.{0,120}\$[\w.-]+|必须.{0,80}\$[\w.-]+/iu.test(evidence)) {
    return SMART_TOOL_DEPENDENCY_REQUIREMENT.REQUIRED;
  }
  return fallback;
}

function requirementLabel(requirement) {
  if (requirement === SMART_TOOL_DEPENDENCY_REQUIREMENT.REQUIRED) return '始终需要';
  if (requirement === SMART_TOOL_DEPENDENCY_REQUIREMENT.EMBEDDED) return '逻辑已内置';
  return '按场景启用';
}

function defaultActivationHint(requirement) {
  if (requirement === SMART_TOOL_DEPENDENCY_REQUIREMENT.REQUIRED) return '每次运行前都必须确认可用。';
  if (requirement === SMART_TOOL_DEPENDENCY_REQUIREMENT.EMBEDDED) return '按 Skill 自带规则在本地流程中执行。';
  return '只有本次任务明确需要该能力时才启用。';
}

function recommendedResolution(contract = {}, requirement) {
  if (contract.builtinAdapter) return SMART_TOOL_DEPENDENCY_RESOLUTION.BUILTIN;
  if (requirement === SMART_TOOL_DEPENDENCY_REQUIREMENT.REQUIRED) {
    return SMART_TOOL_DEPENDENCY_RESOLUTION.INSTALLED_SKILL;
  }
  return SMART_TOOL_DEPENDENCY_RESOLUTION.DISABLED;
}

export function createSmartToolDependencyManifest({ referencedTools = [], ruleCatalog = [] } = {}) {
  const dependencies = (Array.isArray(referencedTools) ? referencedTools : []).map((reference) => {
    const id = text(reference?.id);
    const contract = KNOWN_DEPENDENCY_CONTRACTS[id.toLowerCase()] || {};
    const sourceText = referenceSourceText(reference, ruleCatalog);
    const requirement = inferRequirement(
      sourceText,
      id,
      contract.requirement || SMART_TOOL_DEPENDENCY_REQUIREMENT.CONDITIONAL
    );
    const requiredCapabilities = unique(contract.requiredCapabilities);
    return {
      id,
      label: text(reference?.label) || id.replace(/^\$/u, ''),
      purpose: contract.purpose || '由外部 Skill 或工具提供安装包声明的辅助能力。',
      requirement,
      requirementLabel: requirementLabel(requirement),
      activationHint: contract.activationHint || defaultActivationHint(requirement),
      activationPattern: contract.activationPattern?.source || '',
      activationPatternFlags: contract.activationPattern?.flags || '',
      requiredCapabilities,
      builtinAdapter: text(contract.builtinAdapter),
      builtinLabel: text(contract.builtinLabel),
      recommendedResolution: recommendedResolution(contract, requirement),
      sourcePaths: unique(reference?.sourcePaths),
      sourceSections: unique(reference?.sourceSections),
    };
  });
  return {
    version: SMART_TOOL_DEPENDENCY_CONTRACT_VERSION,
    dependencies,
    requiredCount: dependencies.filter((item) => item.requirement === SMART_TOOL_DEPENDENCY_REQUIREMENT.REQUIRED)
      .length,
    conditionalCount: dependencies.filter((item) => item.requirement === SMART_TOOL_DEPENDENCY_REQUIREMENT.CONDITIONAL)
      .length,
    embeddedCount: dependencies.filter((item) => item.requirement === SMART_TOOL_DEPENDENCY_REQUIREMENT.EMBEDDED)
      .length,
  };
}

export function normalizeSmartToolDependencyBindings(manifest = {}, value = {}) {
  const saved = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return Object.fromEntries(
    (Array.isArray(manifest?.dependencies) ? manifest.dependencies : []).map((dependency) => {
      const current = saved[dependency.id] && typeof saved[dependency.id] === 'object' ? saved[dependency.id] : {};
      const resolution = Object.values(SMART_TOOL_DEPENDENCY_RESOLUTION).includes(current.resolution)
        ? current.resolution
        : dependency.recommendedResolution;
      return [
        dependency.id,
        {
          dependencyId: dependency.id,
          resolution,
          targetSkillId: text(current.targetSkillId),
          builtinAdapter:
            resolution === SMART_TOOL_DEPENDENCY_RESOLUTION.BUILTIN
              ? text(current.builtinAdapter || dependency.builtinAdapter)
              : '',
        },
      ];
    })
  );
}

function selectedScopeText(values = {}, options = {}) {
  return [...Object.values(values && typeof values === 'object' ? values : {}), options.operation, options.mode]
    .map((value) => (typeof value === 'string' ? value : ''))
    .filter(Boolean)
    .join('\n');
}

function isDependencyActive(dependency = {}, values = {}, options = {}) {
  if (dependency.requirement === SMART_TOOL_DEPENDENCY_REQUIREMENT.REQUIRED) return true;
  if (dependency.requirement === SMART_TOOL_DEPENDENCY_REQUIREMENT.EMBEDDED) return true;
  const scope = selectedScopeText(values, options);
  if (!scope) return false;
  if (!dependency.activationPattern) return false;
  try {
    return new RegExp(dependency.activationPattern, dependency.activationPatternFlags || 'iu').test(scope);
  } catch {
    return false;
  }
}

function availableInstalledSkill(binding = {}, options = {}) {
  const tools = Array.isArray(options.availableTools) ? options.availableTools : [];
  return tools.find((item) => {
    if (binding.targetSkillId && text(item?.id) === binding.targetSkillId) return true;
    return false;
  });
}

function builtinCapabilityState(dependency = {}, tool = {}) {
  if (!dependency.requiredCapabilities.length) return { ready: Boolean(dependency.builtinAdapter), missing: [] };
  const steps = getSmartToolExecutionPlan(tool).steps || [];
  const missing = dependency.requiredCapabilities.filter((capabilityId) => {
    const step = steps.find((item) => item.id === capabilityId);
    return !step || !['executable', 'guarded'].includes(step.compileStatus);
  });
  return { ready: missing.length === 0, missing };
}

export function resolveSmartToolDependencyState(tool = {}, values = {}, options = {}) {
  const profile = tool?.skillProfile && typeof tool.skillProfile === 'object' ? tool.skillProfile : {};
  const manifest = profile.dependencyManifest || { dependencies: [] };
  const bindings = normalizeSmartToolDependencyBindings(manifest, profile.dependencyBindings);
  const dependencies = (Array.isArray(manifest.dependencies) ? manifest.dependencies : []).map((dependency) => {
    const binding = bindings[dependency.id] || {};
    const active = isDependencyActive(dependency, values, options);
    if (!active) {
      return { ...dependency, ...binding, active: false, ready: true, status: 'inactive', statusLabel: '本次不启用' };
    }
    if (binding.resolution === SMART_TOOL_DEPENDENCY_RESOLUTION.BUILTIN) {
      const capabilityState = builtinCapabilityState(dependency, tool);
      return {
        ...dependency,
        ...binding,
        active: true,
        ready: capabilityState.ready,
        status: capabilityState.ready ? 'ready' : 'missing_configuration',
        statusLabel: capabilityState.ready ? '内置能力可用' : `缺少配置：${capabilityState.missing.join('、')}`,
      };
    }
    if (binding.resolution === SMART_TOOL_DEPENDENCY_RESOLUTION.INSTALLED_SKILL) {
      const target = availableInstalledSkill(binding, options);
      const targetReady = Boolean(
        target && target.id !== tool.id && target.toolMeta?.adapterStatus !== 'needs_adapter'
      );
      return {
        ...dependency,
        ...binding,
        active: true,
        ready: targetReady,
        status: targetReady ? 'ready' : 'missing_skill',
        statusLabel: targetReady ? `已绑定：${target.title}` : '尚未绑定可用 Skill',
      };
    }
    return {
      ...dependency,
      ...binding,
      active: true,
      ready: false,
      status: 'disabled',
      statusLabel: '本次需要，但当前已停用',
    };
  });
  const blocked = dependencies.filter((item) => item.active && !item.ready);
  return {
    version: SMART_TOOL_DEPENDENCY_CONTRACT_VERSION,
    dependencies,
    blocked,
    canStart: blocked.length === 0,
    summaryLabel: blocked.length ? `${blocked.length} 个本次依赖未就绪` : '本次依赖检查通过',
  };
}
