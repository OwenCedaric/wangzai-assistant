import { createSmartToolApiBindingManifest } from './smartToolApiCapabilityRegistry.js';

export const SMART_TOOL_EXECUTION_CONTRACT_VERSION = 1;

const GENERIC_READ_EXECUTORS = Object.freeze({
  'ozon.products.read': 'ozon-product-read',
  'ozon.productImages.read': 'ozon-product-image-read',
  'ozon.shops.read': 'ozon-shop-read',
  'ozon.warehouse.read': 'ozon-warehouse-read',
  'ozon.salesOrders.read': 'ozon-order-read',
  'ozon.afterSales.read': 'ozon-after-sales-read',
  'ozon.finance.read': 'ozon-finance-read',
  'ozon.marketing.read': 'ozon-marketing-read',
  'ozon.analytics.read': 'ozon-analytics-read',
  'cross-border.read': 'cross-border-read',
  'ozon.performance.read': 'ozon-performance-read',
  'seerfar.market.read': 'seerfar-market-read',
});

const GENERIC_GENERATION_EXECUTORS = Object.freeze({
  'model.text.generate': 'managed-text-model',
  'model.image.generate': 'protected-image-generation',
  'product-image-storage': 'protected-image-persistence',
});

function text(value) {
  return String(value ?? '').trim();
}

function bindingsOf(tool = {}, bindingsOverride = null) {
  if (Array.isArray(bindingsOverride) && bindingsOverride.length) return bindingsOverride;
  const runtimeBindings = tool?.toolMeta?.apiCapabilityMatch?.bindings;
  if (Array.isArray(runtimeBindings) && runtimeBindings.length) return runtimeBindings;
  const inferred = createSmartToolApiBindingManifest(tool);
  if (inferred.length) return inferred;
  const profile = tool?.skillProfile && typeof tool.skillProfile === 'object' ? tool.skillProfile : {};
  if (/text|analysis|文案|分析/iu.test(text(profile.modelCapability || tool.modelCapability))) {
    return [{ id: 'model.text.generate', label: '文本模型', access: 'read' }];
  }
  return inferred;
}

function compileBinding(binding = {}) {
  const id = text(binding.id);
  const access = text(binding.access).toLowerCase();
  const readExecutor = GENERIC_READ_EXECUTORS[id];
  const generationExecutor = GENERIC_GENERATION_EXECUTORS[id];

  if (access === 'write' || binding.status === 'business_guard') {
    return {
      id,
      label: text(binding.label || id),
      kind: 'write',
      executor: 'business-safe-write-gate',
      compileStatus: 'guarded',
      compileStatusLabel: '需预览确认',
      detail: '只能通过对应业务模块的预览、确认、提交、回读和审计链路执行。',
    };
  }
  if (readExecutor) {
    return {
      id,
      label: text(binding.label || id),
      kind: 'read',
      executor: readExecutor,
      compileStatus: binding.status === 'missing_configuration' ? 'missing_configuration' : 'executable',
      compileStatusLabel: binding.status === 'missing_configuration' ? '待配置' : '可真实执行',
      detail: '运行时必须产生真实接口记录。',
    };
  }
  if (generationExecutor) {
    return {
      id,
      label: text(binding.label || id),
      kind: id === 'model.text.generate' ? 'model' : 'image',
      executor: generationExecutor,
      compileStatus: binding.status === 'missing_configuration' ? 'missing_configuration' : 'executable',
      compileStatusLabel: binding.status === 'missing_configuration' ? '待配置' : '可真实执行',
      detail:
        id === 'product-image-storage'
          ? '随真实生图结果进入当前店铺的受保护图片资产链路。'
          : '运行时必须调用已选模型并返回实际结果。',
    };
  }
  return {
    id,
    label: text(binding.label || id),
    kind: access === 'write' ? 'write' : 'unknown',
    executor: '',
    compileStatus: 'unsupported',
    compileStatusLabel: '缺少执行器',
    detail: '接口定义存在，但通用运行引擎还没有这个能力的安全执行器。',
  };
}

export function compileSmartToolExecutionPlan(tool = {}, bindingsOverride = null) {
  const steps = bindingsOf(tool, bindingsOverride).map(compileBinding);
  const executableCount = steps.filter((item) => item.compileStatus === 'executable').length;
  const missingConfigurationCount = steps.filter((item) => item.compileStatus === 'missing_configuration').length;
  const guardedCount = steps.filter((item) => item.compileStatus === 'guarded').length;
  const unsupportedCount = steps.filter((item) => item.compileStatus === 'unsupported').length;
  const requiresImageExecution = steps.some((item) => item.id === 'model.image.generate');
  return {
    version: SMART_TOOL_EXECUTION_CONTRACT_VERSION,
    steps,
    totalCount: steps.length,
    executableCount,
    missingConfigurationCount,
    guardedCount,
    unsupportedCount,
    requiresImageExecution,
    canStart: steps.length > 0 && missingConfigurationCount === 0 && unsupportedCount === 0,
    canCompleteWithoutGuard: guardedCount === 0 && missingConfigurationCount === 0 && unsupportedCount === 0,
    summaryLabel: steps.length
      ? unsupportedCount
        ? `${executableCount} 项可执行，${unsupportedCount} 项缺少执行器`
        : missingConfigurationCount
          ? `${executableCount} 项可执行，${missingConfigurationCount} 项待配置`
          : guardedCount
            ? `${executableCount} 项可执行，${guardedCount} 项需确认`
            : `${executableCount} 项均可真实执行`
      : '没有编译出可执行步骤',
  };
}

export function getSmartToolExecutionPlan(tool = {}) {
  const runtime = tool?.toolMeta?.apiCapabilityMatch?.executionPlan;
  if (runtime && Number(runtime.version) === SMART_TOOL_EXECUTION_CONTRACT_VERSION && Array.isArray(runtime.steps)) {
    return runtime;
  }
  const stored = tool?.skillProfile?.executionPlan;
  if (stored && Number(stored.version) === SMART_TOOL_EXECUTION_CONTRACT_VERSION && Array.isArray(stored.steps)) {
    return stored;
  }
  return compileSmartToolExecutionPlan(tool);
}

export function isSmartToolExecutionPlanRunnable(tool = {}) {
  return getSmartToolExecutionPlan(tool).canStart === true;
}
