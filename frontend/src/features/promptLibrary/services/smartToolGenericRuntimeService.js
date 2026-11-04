import {
  getCrossBorderOrderRecords,
  getDomainCache,
  listIntegrationProfiles,
  listPerformanceAccounts,
  readExternalIntegration,
  readPerformanceOverview,
  requestLocalApi,
  requestLocalOzon,
} from '../../../api/localApiClient.js';
import { createSmartToolApiBindingManifest } from '../lib/smartToolApiCapabilityRegistry.js';
import {
  getSmartToolSkillExecutionState,
  SMART_TOOL_ADAPTER_STATUS,
  SMART_TOOL_GENERIC_RUNTIME_ADAPTER_KEY,
} from '../lib/smartToolAdapterRegistry.js';
import { compileSmartToolExecutionPlan, getSmartToolExecutionPlan } from '../lib/smartToolExecutionPlan.js';
import { resolveSmartToolWorkbench, SMART_TOOL_WORKBENCH_KIND } from '../lib/smartToolWorkbenchRegistry.js';
import { isUserInstalledSmartTool } from '../lib/smartToolInstalledSkill.js';
import { resolveSmartToolDependencyState } from '../lib/smartToolDependencyRegistry.js';
import { SMART_TOOL_AUTO_MODEL_ID, SMART_TOOL_BUILTIN_MODEL_ACCOUNT_ID } from './smartToolModelService.js';

const GENERIC_RUNTIME_TIMEOUT_MS = 420_000;
const MAX_SKILL_BODY_CHARS = 12_000;
const MAX_REFERENCE_CHARS = 24_000;
const MAX_CONTEXT_CHARS = 32_000;
const MAX_RUNTIME_MODULES = 30;
const MAX_RUNTIME_MODULE_DESCRIPTION_CHARS = 600;

function text(value) {
  return String(value ?? '').trim();
}

function stringList(value, limit = 80) {
  return (Array.isArray(value) ? value : [])
    .map((item) => text(item))
    .filter(Boolean)
    .slice(0, limit);
}

function skillProfileOf(tool = {}) {
  return tool?.skillProfile && typeof tool.skillProfile === 'object' && !Array.isArray(tool.skillProfile)
    ? tool.skillProfile
    : {};
}

function compactRuntimeModules(profile = {}) {
  const moduleAnalysis =
    profile?.moduleAnalysis && typeof profile.moduleAnalysis === 'object' && !Array.isArray(profile.moduleAnalysis)
      ? profile.moduleAnalysis
      : {};
  const sourceModules = Array.isArray(moduleAnalysis.modules)
    ? moduleAnalysis.modules
    : Array.isArray(profile.modules)
      ? profile.modules
      : [];
  return sourceModules
    .map((module, index) => ({
      id: text(module?.id),
      order: Number(module?.order || index + 1),
      title: text(module?.title) || `模块 ${index + 1}`,
      kind: text(module?.kind),
      description: text(module?.description).slice(0, MAX_RUNTIME_MODULE_DESCRIPTION_CHARS),
      requiredCapabilities: stringList(module?.requiredCapabilities, 20),
      requiredTools: stringList(module?.requiredTools, 20),
    }))
    .filter((module) => module.id || module.title)
    .sort((left, right) => left.order - right.order)
    .slice(0, MAX_RUNTIME_MODULES);
}

function publicShop(shop = {}, fallback = {}) {
  const shopId = text(shop.id || shop.shopId || fallback.shopId);
  const shopName = text(shop.shopAlias || shop.alias || shop.name || shop.sellerName || fallback.shopName || shopId);
  return shopId ? { shopId, shopName } : null;
}

function publicSku(sku = {}) {
  if (!sku || typeof sku !== 'object') return null;
  const result = {
    id: text(sku.id),
    sku: text(sku.sku || sku.offerId || sku.offer_id),
    label: text(sku.label || sku.name || sku.title),
    facts: text(sku.facts),
    image: text(sku.image),
    images: stringList(sku.images, 30),
  };
  return Object.values(result).some((value) => (Array.isArray(value) ? value.length : Boolean(value))) ? result : null;
}

function publicProduct(product = {}, selectedSku = null) {
  if (!product || typeof product !== 'object') return null;
  const result = {
    id: text(product.id),
    productId: text(product.productId || product.product_id),
    offerId: text(product.offerId || product.offer_id),
    title: text(product.title || product.name),
    categoryId: text(product.descriptionCategoryId || product.description_category_id || product.categoryId),
    typeId: text(product.typeId || product.type_id),
    currency: text(product.currencyCode || product.currency_code),
    price: text(product.priceValue || product.price),
    image: text(product.image),
    images: stringList(product.images, 30),
    mainImages: stringList(product.mainImages, 30),
    detailImages: stringList(product.detailImages, 30),
    selectedSku: publicSku(selectedSku || product.skuOptions?.[0]),
    skuOptions: (Array.isArray(product.skuOptions) ? product.skuOptions : [])
      .map(publicSku)
      .filter(Boolean)
      .slice(0, 30),
  };
  return Object.values(result).some((value) => (Array.isArray(value) ? value.length : Boolean(value))) ? result : null;
}

function getBindings(tool = {}) {
  const runtimeBindings = tool?.toolMeta?.apiCapabilityMatch?.bindings;
  if (Array.isArray(runtimeBindings) && runtimeBindings.length) return runtimeBindings;
  const inferred = createSmartToolApiBindingManifest(tool);
  if (inferred.length) return inferred;
  return getSmartToolExecutionPlan(tool).steps.map((step) => ({
    id: step.id,
    label: step.label,
    access: step.kind === 'write' ? 'write' : 'read',
  }));
}

function createExecution(binding, status, statusLabel, detail = '') {
  return {
    id: text(binding?.id),
    label: text(binding?.label || binding?.id),
    status,
    statusLabel,
    detail: text(detail),
  };
}

function productFilter(product = {}) {
  const productId = text(product?.productId);
  const offerId = text(product?.offerId);
  return {
    ...(productId ? { product_id: [productId] } : {}),
    ...(offerId ? { offer_id: [offerId] } : {}),
    limit: 20,
  };
}

function errorMessage(error) {
  return text(error?.payload?.error?.message || error?.payload?.message || error?.message || error) || '读取失败';
}

async function runRead(name, binding, runner) {
  try {
    const data = await runner();
    return {
      name,
      data,
      execution: createExecution(binding, 'executed', '已真实读取', `${name} 已返回。`),
    };
  } catch (error) {
    return {
      name,
      data: null,
      execution: createExecution(binding, 'failed', '读取失败', `${name}：${errorMessage(error)}`),
    };
  }
}

async function settledReadGroup(tasks = []) {
  const settled = await Promise.allSettled(tasks.map((task) => task.run()));
  const succeeded = settled
    .map((entry, index) => ({ entry, label: tasks[index]?.label || `数据 ${index + 1}` }))
    .filter((item) => item.entry.status === 'fulfilled')
    .map((item) => ({ label: item.label, data: item.entry.value }));
  if (succeeded.length) return succeeded;
  const reasons = settled
    .map((entry, index) =>
      entry.status === 'rejected' ? `${tasks[index]?.label || `数据 ${index + 1}`}：${errorMessage(entry.reason)}` : ''
    )
    .filter(Boolean);
  throw new Error(reasons.join('；') || '接口没有返回数据。');
}

function findInputIdentity(values = {}, patterns = []) {
  for (const [label, value] of Object.entries(values || {})) {
    if (!patterns.some((pattern) => pattern.test(label))) continue;
    const normalized = text(value);
    if (normalized) return normalized.split(/\r?\n/u)[0].trim();
  }
  return '';
}

function addScopedOzonRead(reads, executions, bindings, id, name, shop, runner) {
  const binding = bindings.find((item) => item.id === id);
  if (!binding) return;
  if (!shop) {
    executions.push(createExecution(binding, 'not_selected', '本次未选择店铺', '不会跨店读取。'));
    return;
  }
  reads.push(runRead(name, binding, runner));
}

function dateOnly(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function firstInputText(values = {}) {
  return (
    Object.values(values || {})
      .map(text)
      .find(Boolean) || ''
  );
}

function compactJson(value, maxChars = MAX_CONTEXT_CHARS) {
  const seen = new WeakSet();
  const json = JSON.stringify(
    value,
    (key, entry) => {
      if (/api.?key|secret|token|password|authorization|client.?secret/iu.test(key)) return '[已隐藏]';
      if (entry && typeof entry === 'object') {
        if (seen.has(entry)) return undefined;
        seen.add(entry);
      }
      if (typeof entry === 'string' && entry.length > 4_000) return `${entry.slice(0, 4_000)}…`;
      if (Array.isArray(entry) && entry.length > 80) return entry.slice(0, 80);
      return entry;
    },
    2
  );
  return json.length > maxChars ? `${json.slice(0, maxChars)}\n…（上下文已按安全上限截断）` : json;
}

function modelSafeValue(value, maxChars = MAX_CONTEXT_CHARS) {
  const serialized = compactJson(value, maxChars);
  try {
    return JSON.parse(serialized);
  } catch {
    return { truncatedJson: serialized };
  }
}

function runtimeCustomRules(tool = {}) {
  const rules = text(tool?.promptConfig?.systemPrompt);
  const body = text(tool?.body);
  return rules && rules !== body ? rules.slice(0, 12_000) : '';
}

export async function collectSmartToolGenericRuntimeContext(tool = {}, values = {}, options = {}) {
  const bindings = getBindings(tool);
  const shop = publicShop(options.runtimeContext?.selectedShop, options.shopScope);
  const product = publicProduct(options.runtimeContext?.selectedProduct, options.runtimeContext?.selectedSku);
  const executions = [];
  const reads = [];
  const ozonShop = shop ? { id: shop.shopId, name: shop.shopName } : null;
  const filter = productFilter(product);
  const hasProductIdentity = Boolean(product?.productId || product?.offerId);

  const productsBinding = bindings.find((item) => item.id === 'ozon.products.read');
  if (productsBinding) {
    if (ozonShop && hasProductIdentity) {
      reads.push(
        runRead('Ozon 商品资料', productsBinding, async () => {
          const [info, attributes] = await Promise.all([
            requestLocalOzon(
              { endpoint: '/v3/product/info/list', access: 'read', shop: ozonShop, body: filter },
              options
            ),
            requestLocalOzon(
              { endpoint: '/v4/product/info/attributes', access: 'read', shop: ozonShop, body: filter },
              options
            ),
          ]);
          return { info, attributes };
        })
      );
    } else {
      executions.push(
        createExecution(
          productsBinding,
          product ? 'bound' : 'not_selected',
          product ? '已绑定本地商品' : '本次未选择商品',
          product ? '使用当前商品列表的真实快照。' : '没有商品身份时不会猜测查询条件。'
        )
      );
    }
  }

  const imagesBinding = bindings.find((item) => item.id === 'ozon.productImages.read');
  if (imagesBinding) {
    if (ozonShop && hasProductIdentity) {
      reads.push(
        runRead('Ozon 商品图片', imagesBinding, () =>
          requestLocalOzon(
            { endpoint: '/v2/product/pictures/info', access: 'read', shop: ozonShop, body: filter },
            options
          )
        )
      );
    } else {
      executions.push(
        createExecution(
          imagesBinding,
          product?.images?.length ? 'bound' : 'not_selected',
          product?.images?.length ? '已绑定商品图片' : '本次无商品图片',
          product?.images?.length ? '使用当前商品列表已回读的图片。' : '没有图片时不会生成虚构图片事实。'
        )
      );
    }
  }

  const shopsBinding = bindings.find((item) => item.id === 'ozon.shops.read');
  if (shopsBinding) {
    if (ozonShop) {
      reads.push(
        runRead('Ozon 店铺身份', shopsBinding, () =>
          requestLocalOzon({ endpoint: '/v1/seller/info', access: 'read', shop: ozonShop, body: {} }, options)
        )
      );
    } else {
      executions.push(createExecution(shopsBinding, 'not_selected', '本次未选择店铺', '不会跨店读取。'));
    }
  }

  addScopedOzonRead(reads, executions, bindings, 'ozon.warehouse.read', 'Ozon 仓库与配送', ozonShop, () =>
    settledReadGroup([
      {
        label: '仓库',
        run: () =>
          requestLocalOzon(
            { endpoint: '/v2/warehouse/list', access: 'read', shop: ozonShop, body: { limit: 100 } },
            options
          ),
      },
      {
        label: '配送方式',
        run: () =>
          requestLocalOzon(
            { endpoint: '/v2/delivery-method/list', access: 'read', shop: ozonShop, body: { limit: 100 } },
            options
          ),
      },
    ])
  );

  addScopedOzonRead(reads, executions, bindings, 'ozon.salesOrders.read', 'Ozon 销售订单', ozonShop, () => {
    const postingNumber = findInputIdentity(values, [/order|posting|订单|发货单|运单/iu]);
    return settledReadGroup(
      postingNumber
        ? [
            {
              label: 'FBS 订单',
              run: () =>
                requestLocalOzon(
                  {
                    endpoint: '/v3/posting/fbs/get',
                    access: 'read',
                    shop: ozonShop,
                    body: { posting_number: postingNumber },
                  },
                  options
                ),
            },
            {
              label: 'FBO 订单',
              run: () =>
                requestLocalOzon(
                  {
                    endpoint: '/v2/posting/fbo/get',
                    access: 'read',
                    shop: ozonShop,
                    body: { posting_number: postingNumber },
                  },
                  options
                ),
            },
          ]
        : [
            {
              label: 'FBS 订单列表',
              run: () =>
                requestLocalOzon(
                  { endpoint: '/v3/posting/fbs/list', access: 'read', shop: ozonShop, body: { limit: 50 } },
                  options
                ),
            },
            {
              label: 'FBO 订单列表',
              run: () =>
                requestLocalOzon(
                  { endpoint: '/v2/posting/fbo/list', access: 'read', shop: ozonShop, body: { limit: 50 } },
                  options
                ),
            },
          ]
    );
  });

  addScopedOzonRead(reads, executions, bindings, 'ozon.afterSales.read', 'Ozon 售后', ozonShop, () =>
    requestLocalOzon({ endpoint: '/v1/returns/list', access: 'read', shop: ozonShop, body: { limit: 50 } }, options)
  );

  addScopedOzonRead(reads, executions, bindings, 'ozon.finance.read', 'Ozon 财务', ozonShop, () =>
    requestLocalOzon(
      { endpoint: '/v3/finance/transaction/list', access: 'read', shop: ozonShop, body: { page: 1, page_size: 50 } },
      options
    )
  );

  addScopedOzonRead(reads, executions, bindings, 'ozon.marketing.read', 'Ozon 营销活动', ozonShop, () =>
    settledReadGroup([
      {
        label: '平台活动',
        run: () =>
          requestLocalOzon(
            { endpoint: '/v1/actions', method: 'GET', access: 'read', shop: ozonShop, body: {} },
            options
          ),
      },
      {
        label: '卖家活动',
        run: () =>
          requestLocalOzon(
            { endpoint: '/v1/seller-actions/list', access: 'read', shop: ozonShop, body: { limit: 50 } },
            options
          ),
      },
    ])
  );

  const analyticsBinding = bindings.find((item) => item.id === 'ozon.analytics.read');
  if (analyticsBinding) {
    if (shop) {
      reads.push(
        runRead('Ozon 经营分析', analyticsBinding, () =>
          getDomainCache('data-analysis', { shopId: shop.shopId, pageSize: 50 }, options)
        )
      );
    } else {
      executions.push(createExecution(analyticsBinding, 'not_selected', '本次未选择店铺', '不会跨店读取。'));
    }
  }

  const crossBorderBinding = bindings.find((item) => item.id === 'cross-border.read');
  if (crossBorderBinding) {
    if (shop) {
      reads.push(
        runRead('跨境巴士物流', crossBorderBinding, () =>
          getCrossBorderOrderRecords({ shopId: shop.shopId, page: 1, pageSize: 50 }, options)
        )
      );
    } else {
      executions.push(createExecution(crossBorderBinding, 'not_selected', '本次未选择店铺', '不会跨店读取。'));
    }
  }

  const performanceBinding = bindings.find((item) => item.id === 'ozon.performance.read');
  if (performanceBinding) {
    reads.push(
      runRead('Ozon 广告数据', performanceBinding, async () => {
        const payload = await listPerformanceAccounts({ timeoutMs: 10_000, signal: options.signal });
        const accounts = Array.isArray(payload?.accounts)
          ? payload.accounts
          : Array.isArray(payload?.rows)
            ? payload.rows
            : [];
        const account =
          accounts.find(
            (item) => shop?.shopId && [item?.shopId, item?.ozonShopId, item?.sellerId].map(text).includes(shop.shopId)
          ) ||
          accounts.find((item) => item?.verified === true || item?.lastTestStatus === 'connected') ||
          accounts[0];
        if (!account?.id) throw new Error('没有可用的 Ozon Performance API 账号。');
        const dateTo = new Date();
        const dateFrom = new Date(dateTo.getTime() - 29 * 24 * 60 * 60 * 1000);
        return readPerformanceOverview(
          {
            type: 'ozon-performance',
            values: {
              accountId: text(account.id),
              shopName: text(account.title || account.name),
              dateFrom: dateOnly(dateFrom),
              dateTo: dateOnly(dateTo),
              readDepth: 'ai',
              includeCampaignObjects: false,
            },
          },
          { timeoutMs: 120_000, signal: options.signal }
        );
      })
    );
  }

  const seerfarBinding = bindings.find((item) => item.id === 'seerfar.market.read');
  if (seerfarBinding) {
    reads.push(
      runRead('Seerfar 市场数据', seerfarBinding, async () => {
        const payload = await listIntegrationProfiles({ timeoutMs: 10_000, signal: options.signal });
        const profiles = Array.isArray(payload?.profiles) ? payload.profiles : [];
        const profile = profiles.find(
          (item) => item?.integrationType === 'seerfar-open-api' && item?.hasApiKey === true
        );
        const query = text(product?.selectedSku?.sku || product?.offerId || firstInputText(values));
        if (!query) throw new Error('缺少可用于市场查询的商品 SKU 或关键词。');
        const numeric = query.match(/\d{5,}/u)?.[0] || '';
        return readExternalIntegration(
          {
            profileId: text(profile?.id) || 'builtin-points',
            operation: 'seerfar-ozon-product-report-search',
            input: {
              ...(numeric ? { skus: [numeric] } : { keywords: [query] }),
              variationsMerge: 0,
              page: { page: 1, pageSize: 20, orders: [{ field: 'revenue', direction: 'DESC' }] },
            },
          },
          { timeoutMs: 120_000, signal: options.signal }
        );
      })
    );
  }

  const completedReads = await Promise.all(reads);
  completedReads.forEach((item) => executions.push(item.execution));
  const readData = Object.fromEntries(
    completedReads.filter((item) => item.data != null).map((item) => [item.name, item.data])
  );

  bindings.forEach((binding) => {
    if (executions.some((item) => item.id === binding.id)) return;
    if (binding.id === 'model.text.generate') {
      executions.push(createExecution(binding, 'pending', '等待模型执行', '数据准备完成后调用所选文本模型。'));
      return;
    }
    if (binding.access === 'write' || binding.status === 'business_guard') {
      executions.push(createExecution(binding, 'guarded', '已转安全门', '写入不会从通用运行器直接执行。'));
      return;
    }
    if (binding.id === 'model.image.generate') {
      executions.push(
        createExecution(
          binding,
          'available',
          '图片引擎已绑定',
          '仅在明确选择生图任务并具备图片资产时进入专用生图链路。'
        )
      );
      return;
    }
    if (binding.id === 'product-image-storage') {
      executions.push(
        createExecution(binding, 'available', '安全存储已绑定', '真实图片任务会按当前店铺进入私有图片资产链路。')
      );
      return;
    }
    if (binding.id === 'local-business-data.read') {
      executions.push(createExecution(binding, 'bound', '已绑定本次输入', '只向模型提供本次明确选择的数据。'));
      return;
    }
    executions.push(
      createExecution(binding, 'available', '接口已绑定', '本次输入没有要求调用该能力，因此未发起无条件全量读取。')
    );
  });

  return {
    shop,
    product,
    values,
    readData,
    executions,
    bindings,
  };
}

function createGenericRuntimeTemplateInput(tool = {}, context = {}) {
  const profile = skillProfileOf(tool);
  const moduleAnalysis =
    profile?.moduleAnalysis && typeof profile.moduleAnalysis === 'object' && !Array.isArray(profile.moduleAnalysis)
      ? profile.moduleAnalysis
      : {};
  let remainingReferenceChars = MAX_REFERENCE_CHARS;
  const referenceFiles = (Array.isArray(profile.referenceFiles) ? profile.referenceFiles : [])
    .map((item) => {
      if (remainingReferenceChars <= 0) return null;
      const path = text(item?.path);
      const content = text(item?.content).slice(0, remainingReferenceChars);
      if (!path || !content) return null;
      remainingReferenceChars -= content.length;
      return { path, content };
    })
    .filter(Boolean);
  return {
    skill: {
      title: text(tool.title) || '未命名 Skill',
      goal: text(tool.goal) || '未填写',
      body: text(tool.body).slice(0, MAX_SKILL_BODY_CHARS),
      referenceFiles,
      workflowSteps: stringList(profile.workflowSteps || tool?.promptConfig?.workflowSteps),
      outputs: stringList(profile.outputs || tool?.promptConfig?.outputs),
      safetyRules: stringList(profile.safetyNotes || tool?.promptConfig?.safetyRules),
      modules: compactRuntimeModules(profile),
      referencedTools: stringList(
        (Array.isArray(moduleAnalysis.referencedTools)
          ? moduleAnalysis.referencedTools
          : Array.isArray(profile.referencedTools)
            ? profile.referencedTools
            : []
        ).map((item) => (typeof item === 'string' ? item : item?.id)),
        30
      ),
      evidenceRules: stringList(profile.evidenceRules, 60),
      skuImageRules: stringList(profile.skuImageRules, 60),
      qaRules: stringList(profile.qaRules || tool?.promptConfig?.outputRules, 60),
      stopConditions: stringList(profile.stopConditions, 60),
    },
    context: {
      inputs: modelSafeValue(context.values),
      shop: modelSafeValue(context.shop),
      product: modelSafeValue(context.product),
      apiReadback: modelSafeValue(context.readData),
    },
  };
}

function parseJsonObject(value = '') {
  const source = text(value)
    .replace(/^```(?:json)?\s*/iu, '')
    .replace(/\s*```$/u, '')
    .trim();
  const candidates = [source];
  const firstBrace = source.indexOf('{');
  const lastBrace = source.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(source.slice(firstBrace, lastBrace + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // Fall back to a readable text section below.
    }
  }
  return null;
}

function normalizeModelResult(reportText = '') {
  const parsed = parseJsonObject(reportText);
  if (!parsed) {
    const rows = text(reportText).split(/\n+/u).map(text).filter(Boolean);
    return {
      statusLabel: 'Skill 已运行',
      summary: rows[0] || '模型已返回结果。',
      sections: [{ title: 'Skill 运行结果', rows: rows.length ? rows : ['模型没有返回可展示内容。'] }],
      nextActions: [],
    };
  }
  const sections = (Array.isArray(parsed.sections) ? parsed.sections : [])
    .map((section, index) => ({
      title: text(section?.title) || `结果 ${index + 1}`,
      rows: (Array.isArray(section?.rows) ? section.rows : [section?.rows])
        .map((item) => (typeof item === 'string' ? text(item) : compactJson(item, 8_000)))
        .filter(Boolean),
    }))
    .filter((section) => section.rows.length);
  return {
    statusLabel: text(parsed.statusLabel) || 'Skill 已运行',
    summary: text(parsed.summary) || '已按 Skill 流程生成结果。',
    sections: sections.length ? sections : [{ title: 'Skill 运行结果', rows: [compactJson(parsed, 24_000)] }],
    nextActions: stringList(parsed.nextActions, 20),
  };
}

function executionRows(executions = []) {
  return executions.map((item) => [item.label || item.id, item.statusLabel, item.detail].filter(Boolean).join('：'));
}

export function canUseSmartToolGenericRuntime(tool = {}) {
  if (!isUserInstalledSmartTool(tool)) return false;
  const state = getSmartToolSkillExecutionState(tool);
  const executionPlan = getSmartToolExecutionPlan(tool);
  return (
    state.status === SMART_TOOL_ADAPTER_STATUS.READY &&
    state.adapterKey === SMART_TOOL_GENERIC_RUNTIME_ADAPTER_KEY &&
    executionPlan.canStart === true
  );
}

export async function runSmartToolGenericRuntime(tool = {}, values = {}, options = {}) {
  if (!canUseSmartToolGenericRuntime(tool)) throw new Error('当前 Skill 不能进入通用运行引擎。');
  const dependencyState = resolveSmartToolDependencyState(tool, values, options);
  if (!dependencyState.canStart) {
    throw new Error(
      `本次运行需要的依赖尚未就绪：${dependencyState.blocked
        .map((item) => `${item.label}（${item.statusLabel}）`)
        .join('、')}`
    );
  }
  if (
    resolveSmartToolWorkbench(tool).kind === SMART_TOOL_WORKBENCH_KIND.PRODUCT_CONTENT &&
    text(options.operation) !== 'analysis'
  ) {
    throw new Error('图片类 Skill 必须在商品内容工作台选择真实图片位置后运行，不能从报告引擎自动生图。');
  }
  const modelSelection = options.modelSelection || {};
  if (!modelSelection.ready || !text(modelSelection.accountId) || !text(modelSelection.model)) {
    throw new Error('没有可用的文本模型，请选择自有模型接口或内置积分模型。');
  }
  const context = await collectSmartToolGenericRuntimeContext(tool, values, options);
  options.onStage?.({ statusLabel: '真实数据已准备，正在运行 Skill', summary: '正在调用所选文本模型生成最终结果…' });
  const templateInput = createGenericRuntimeTemplateInput(tool, context);
  const usesManagedAutomaticModel = text(modelSelection.id) === SMART_TOOL_AUTO_MODEL_ID;
  const runtimeModelSelection = usesManagedAutomaticModel
    ? {
        accountId: SMART_TOOL_BUILTIN_MODEL_ACCOUNT_ID,
        model: 'builtin-points-text',
      }
    : {
        accountId: text(modelSelection.accountId),
        model: text(modelSelection.model),
      };
  const response = await (options.requester || requestLocalApi)('/api/integrations/analyze', {
    method: 'POST',
    body: {
      accountId: runtimeModelSelection.accountId,
      model: runtimeModelSelection.model,
      allowPaidFallback: usesManagedAutomaticModel,
      templateId: 'generic-skill-runtime.v1',
      templateInput,
      customRules: runtimeCustomRules(tool),
      userInstruction: text(tool?.promptConfig?.userPrompt),
    },
    timeoutMs: options.timeoutMs || GENERIC_RUNTIME_TIMEOUT_MS,
    signal: options.signal,
  });
  const normalized = normalizeModelResult(response?.reportText);
  const chargedPoints = Number(response?.billing?.chargedPoints);
  const modelExecutionDetail =
    text(response?.model) === 'builtin-points'
      ? `内置积分模型${Number.isFinite(chargedPoints) && chargedPoints > 0 ? `（本次 ${chargedPoints} 积分）` : ''}`
      : text(response?.model || modelSelection.model);
  const failedReads = context.executions.filter((item) => item.status === 'failed');
  const executions = context.executions.map((item) =>
    item.id === 'model.text.generate' ? createExecution(item, 'executed', '模型已真实调用', modelExecutionDetail) : item
  );
  const unexecutedRequired = executions.filter((item) => {
    if (item.status === 'guarded') return true;
    if (item.status !== 'available') return false;
    return true;
  });
  const partialReasons = [
    ...(failedReads.length ? [`${failedReads.length} 项真实读取失败`] : []),
    ...(unexecutedRequired.length ? [`${unexecutedRequired.length} 项能力尚未实际执行`] : []),
  ];
  const partial = partialReasons.length > 0;
  return {
    toolId: text(tool.id),
    toolTitle: text(tool.title) || '智能工具',
    createdAt: new Date().toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }),
    shopScope: context.shop,
    adapter: {
      key: SMART_TOOL_GENERIC_RUNTIME_ADAPTER_KEY,
      version: getSmartToolSkillExecutionState(tool).adapterVersion,
      status: SMART_TOOL_ADAPTER_STATUS.READY,
      statusLabel: '通用运行引擎可用',
    },
    result: {
      status: partial ? 'partial_ready' : 'ready',
      statusLabel: partial ? 'Skill 已运行，仍有未完成项' : normalized.statusLabel,
      summary: partial
        ? `${normalized.summary}；${partialReasons.join('，')}，系统没有把未执行内容标成成功。`
        : normalized.summary,
      sections: [...normalized.sections, { title: '本次步骤执行记录', rows: executionRows(executions) }],
      nextActions: normalized.nextActions,
      runtime: {
        adapterKey: SMART_TOOL_GENERIC_RUNTIME_ADAPTER_KEY,
        model: text(response?.model || runtimeModelSelection.model),
        accountId: text(response?.accountId || runtimeModelSelection.accountId),
        usage: response?.usage || null,
        billing: response?.billing || null,
        executionPlan: compileSmartToolExecutionPlan(tool, context.bindings),
        dependencyState,
        executions,
      },
    },
  };
}
