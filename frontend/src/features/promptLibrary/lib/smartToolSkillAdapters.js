import { ozonSkillIds } from './ozonSkillCatalog.js';

import { externalOzonSkillIds } from './externalOzonSkillCatalog.js';
import { PROFIT_ORDER_REVIEW_SKILL_ID } from '../../profitReview/constants/profitOrderReviewContract.js';
import {
  getSmartToolSkillExecutionState,
  SMART_TOOL_ADAPTER_STATUS,
  SMART_TOOL_GENERIC_RUNTIME_ADAPTER_KEY,
} from './smartToolAdapterRegistry.js';

function normalizeSkillText(value, fallback = '') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function parseSkillInput(inputText = '') {
  const rows = {};
  const rawText = String(inputText || '').trim();

  rawText.split(/\r?\n/).forEach((line) => {
    const cleanLine = line.trim();
    if (!cleanLine) return;
    const match = cleanLine.match(/^([^:：]+)[:：]\s*(.*)$/);
    if (!match) return;
    rows[match[1].trim()] = match[2].trim();
  });

  return { rawText, rows };
}

function getInputValue(parsedInput, labels = []) {
  const keys = Array.isArray(labels) ? labels : [labels];
  for (const key of keys) {
    const value = parsedInput.rows[key];
    if (normalizeSkillText(value)) return value;
  }
  return '';
}

function createAdapterResult({
  status = 'ready',
  statusLabel = 'Skill 已运行',
  summary,
  sections = [],
  missingInputs = [],
  integrationNeeds = [],
  nextActions = [],
} = {}) {
  return {
    status,
    statusLabel,
    summary: normalizeSkillText(summary, '已按当前 skill 生成本地运行结果。'),
    sections,
    missingInputs,
    integrationNeeds,
    nextActions,
  };
}

function createUnsupportedSkillResult(tool, parsedInput, state) {
  const profile = tool.skillProfile || {};
  return createAdapterResult({
    status: state.status,
    statusLabel: state.statusLabel,
    summary: `${normalizeSkillText(tool.title, '自定义 Skill')} 已安装，但当前不能直接运行：${state.reason}`,
    sections: [
      {
        title: '运行状态',
        rows: [
          `适配器：${state.adapterKey || '未登记'}`,
          `版本：${state.adapterVersion}`,
          `运行类型：${normalizeSkillText(profile.runType, '未声明')}`,
        ],
      },
      {
        title: '本次输入',
        rows: parsedInput.rawText ? parsedInput.rawText.split(/\r?\n/) : ['还没有填写输入。'],
      },
    ],
    integrationNeeds:
      state.status === SMART_TOOL_ADAPTER_STATUS.GUARD_REQUIRED
        ? ['对应业务模块的 preview → confirm → submit → readback → audit 链路']
        : ['登记 adapterKey、输入 schema、输出 schema、权限和取消/重试规则'],
    nextActions:
      state.status === SMART_TOOL_ADAPTER_STATUS.GUARD_REQUIRED
        ? ['转入对应业务模块完成安全接入']
        : ['补充并登记专用 adapter 后再运行'],
  });
}

function createExternalReadonlyResult(tool, parsedInput, options = {}) {
  const profile = tool.skillProfile || {};
  const capabilities = Array.isArray(profile.capabilities) ? profile.capabilities : [];
  const inputs =
    Array.isArray(profile.usageInputs) && profile.usageInputs.length
      ? profile.usageInputs
      : Array.isArray(profile.inputs)
        ? profile.inputs
        : [];
  const missingInputs = inputs.filter((item) => !getInputValue(parsedInput, item));

  return createAdapterResult({
    status: 'needs_interface',
    statusLabel: 'Skill 已运行，待接外部接口',
    summary: `${normalizeSkillText(tool.title, '外部只读工具')} 已生成查询计划；补上 ${normalizeSkillText(
      profile.sourceName,
      '外部数据源'
    )} 接口后可直接替换为真实结果。`,
    sections: [
      {
        title: '当前可执行结果',
        rows: [
          '已根据输入整理查询目标和结果结构。',
          `运行类型：${normalizeSkillText(profile.runType, 'external-readonly')}`,
          `数据来源：${normalizeSkillText(profile.sourceName, '待接外部来源')}`,
        ],
      },
      {
        title: 'skill 能力',
        rows: capabilities.length ? capabilities : ['按 skillProfile 能力补充。'],
      },
      {
        title: '本次输入摘要',
        rows: parsedInput.rawText ? parsedInput.rawText.split(/\r?\n/) : ['未填写输入。'],
      },
    ],
    missingInputs,
    integrationNeeds: [
      `${normalizeSkillText(profile.sourceName, '外部数据源')} 账号或接口配置`,
      '请求适配器',
      '限流/重试/错误处理',
      '返回字段映射',
    ],
    nextActions: ['补齐缺失输入', '接入外部只读接口 adapter', '将真实返回映射到当前输出结构'],
  });
}

function runOzonProductSearchSkill(tool, parsedInput) {
  const query = getInputValue(parsedInput, ['关键词或 SKU', '关键词', 'SKU', '品牌名', '卖家名', '类目']);
  const missingInputs = query ? [] : ['关键词或 SKU'];

  return createAdapterResult({
    status: missingInputs.length ? 'partial_ready' : 'browser_data_pending',
    statusLabel: missingInputs.length ? 'Skill 已运行，需补搜索条件' : '正在后台搜索 Ozon 商品',
    summary: query
      ? `已按「${query}」建立 Ozon 商品查询任务，后台专用浏览器将执行只读查询并返回真实商品数据。`
      : '请填写关键词或 SKU，Skill 将通过后台专用浏览器执行只读商品查询。',
    sections: [
      {
        title: '运行规则',
        rows: [
          '支持中文、俄文和 SKU；常见中文商品词会先在本地展开成俄文同义词。',
          '使用后台专用浏览器执行一次只读商品查询，只读取本次新捕获的 product-performance 数据集。',
          '按商品 ID 或标题去重，最多返回 1000 条实际记录。',
          '按市场动量、竞争、转化、自然动销、库存、履约和跟卖七个维度生成机会评分与可信度。',
          '同步输出价格销量关系、主要风险和下一步动作；没有完整成本时不推断净利润。',
          '没有捕获数据或字段缺失时明确提示，不生成替代数据。',
        ],
      },
      {
        title: '本次搜索条件',
        rows: [query || '未填写'],
      },
    ],
    missingInputs,
    integrationNeeds: [],
    nextActions: query ? ['读取浏览器插件数据并展示筛选结果'] : ['填写关键词或 SKU 后重新运行'],
  });
}

function runPerformanceAdApiOnlySkill() {
  return createAdapterResult({
    status: 'performance_api_required',
    statusLabel: '请通过 Performance API 运行',
    summary: '广告分析已切换为 Ozon Performance API 真实读取，本地手工阈值草稿已停用。',
    sections: [
      {
        title: '真实数据入口',
        rows: [
          '从智能工具运行窗口选择推广账号、广告计划和统计范围。',
          '系统将实时读取计划、完整统计和每日趋势，并统一计算 CTR、CPC、CVR、CPO、ACOS、ROAS。',
        ],
      },
    ],
    missingInputs: ['Ozon Performance API 账号'],
    integrationNeeds: ['Ozon Performance API 账号'],
    nextActions: ['返回智能工具运行窗口，点击“读取并分析广告”'],
  });
}

function runOzonProductImageGenerationSkill(tool, parsedInput) {
  const productReference = getInputValue(parsedInput, [
    '商品图片或商品 SKU',
    '商品参考图',
    '商品图片',
    '商品 SKU',
    'SKU',
  ]);
  const skuFacts = getInputValue(parsedInput, ['SKU 信息', '当前 SKU', 'SKU 事实']);
  const targetScene = getInputValue(parsedInput, ['目标场景（可选）', '目标场景', '场景']);
  const missingInputs = [!productReference ? '商品图片或商品 SKU' : ''].filter(Boolean);

  return createAdapterResult({
    status: missingInputs.length ? 'partial_ready' : 'ready',
    statusLabel: missingInputs.length ? 'PromptPlan 待补商品信息' : 'PromptPlan 已生成',
    summary: '已生成商品图规则重构版的本地 PromptPlan；当前没有调用图片模型，也没有修改商品图片。',
    sections: [
      {
        title: '商品身份锁定',
        rows: [
          productReference ? `商品证据：${productReference}` : '等待补充商品图片或商品 SKU。',
          skuFacts ? `当前 SKU 事实：${skuFacts}` : 'SKU 信息未填写，真实生图前必须补齐。',
          '必须保持商品颜色、结构、材质、比例、部件、配件和包装数量不变。',
        ],
      },
      {
        title: '当前选中图片的逐图 Prompt',
        rows: [
          `生成 3:4 竖版 Ozon 俄罗斯电商主图，商品为前景主体，${
            targetScene ? `使用场景为${targetScene}` : '背景使用真实且匹配商品用途的场景'
          }。`,
          '实际数量以用户选择的商品图片为准，每张原图只生成一个对应方案。',
          '只展示当前 SKU；主标题使用简短自然俄语，最多再放 3 个基于证据的短卖点。',
          '先满足商品真实度和 SKU 一致性，再考虑构图、灯光和视觉风格。',
        ],
      },
      {
        title: '可选图片职责',
        rows: [
          '可按位置设置：标准白底图、使用场景图、材质细节图或功能卖点图。',
          '也可设置：适配/安装说明、规格信息板、包装展示或综合海报。',
          '以上只是职责选项，不固定数量；没有单独规则的位置使用全局 Skill。',
        ],
      },
      {
        title: '负面提示词',
        rows: [
          '禁止虚构功能、配件、赠品、认证、保修、性能或安全提升。',
          '禁止改变 SKU 颜色、结构、材质、部件、数量和商品表面真实图案。',
          '禁止中文广告字、价格、折扣、评分、销量、水印、二维码、电话和平台 UI。',
          '禁止工厂、车间、生产线、仓库、工人及工厂直供宣传。',
        ],
      },
      {
        title: '生图前验收',
        rows: [
          '商品身份和当前 SKU 是否一致',
          '是否为 3:4 竖版且缩略图可读',
          '俄语文案是否简短、自然且有证据',
          '是否没有新增配件、尺寸标线、价格、平台标识或违规承诺',
        ],
      },
    ],
    missingInputs,
    integrationNeeds: ['商品参考图输入', '逐图位置绑定', '生图结果预览', '人工验收与失败重试'],
    nextActions: ['补齐商品图片和 SKU 事实', '选择图片模型', '生成图片预览后人工验收'],
  });
}

function createProfitReviewEntryResult(tool, parsedInput) {
  const orderNumber = getInputValue(parsedInput, ['订单号', 'Ozon订单号', 'Ozon 订单号', '货号']);

  return createAdapterResult({
    status: orderNumber ? 'dedicated_runner_ready' : 'partial_ready',
    statusLabel: orderNumber ? '订单号已准备' : '请输入订单号',
    summary: orderNumber ? `订单号 ${orderNumber} 已交给订单利润专用运行器。` : '订单利润评估只需要订单号。',
    sections: [
      {
        title: '正式运行路径',
        rows: [
          orderNumber ? `订单号：${orderNumber}` : '订单号：未填写',
          '由专用运行器读取真实利润账本和同 SKU 店内历史。',
          'Seerfar 仅在用户选择“使用”时调用；文本模型只负责解释，不改金额。',
        ],
      },
    ],
    missingInputs: [!orderNumber ? '订单号' : ''].filter(Boolean),
    integrationNeeds: [],
    nextActions: orderNumber ? ['运行订单利润专用分析'] : ['输入订单号'],
  });
}

function runOzonReferenceSkill(tool, parsedInput) {
  const profile = tool.skillProfile || {};
  const inputs =
    Array.isArray(profile.usageInputs) && profile.usageInputs.length
      ? profile.usageInputs
      : Array.isArray(profile.inputs)
        ? profile.inputs
        : [];
  const missingInputs = inputs.filter((item) => !getInputValue(parsedInput, item));

  return createAdapterResult({
    status: 'needs_adapter',
    statusLabel: 'Ozon Skill 已接入，待调试',
    summary: `${normalizeSkillText(tool.title, ' Ozon Skill')} 已接入智能工具；当前只生成调试入口，不会真实调用本地脚本、第三方接口或 Ozon。`,
    sections: [
      {
        title: '原 Skill',
        rows: [
          `原名称：${normalizeSkillText(profile.originalSkillName, '未记录')}`,
          `来源编号：${normalizeSkillText(profile.sourceRef, '未记录')}`,
          `运行类型：${normalizeSkillText(profile.runType, 'local-ozon-skill')}`,
          `可用状态：${normalizeSkillText(profile.availability, '等待调试')}`,
        ],
      },
      {
        title: '本次输入',
        rows: parsedInput.rawText ? parsedInput.rawText.split(/\r?\n/) : ['还没有填写输入。'],
      },
      {
        title: '当前边界',
        rows: [
          '已经作为旺崽智能工具项接入。',
          '当前不读取 Ozon、不请求 AlphaShop、不运行本地 Python 脚本。',
          '涉及上传、改价、补货、写入 Ozon 的能力暂时只保留预览和调试入口。',
        ],
      },
      {
        title: '后续调试',
        rows: [
          '按这个 Skill 的原始脚本或 workflow 建 adapter。',
          '先调只读能力，再调需要人工确认的能力。',
          '会写 Ozon 的链路必须接预览、确认、提交、Ozon 回读。',
        ],
      },
    ],
    missingInputs,
    integrationNeeds: [
      '读取Ozon Skill 原始 SKILL.md / workflow / scripts',
      '建立旺崽 services adapter',
      '接入账号配置和限流重试',
      '字段映射到旺崽页面或采集核价模块',
      '补测试和回读校验',
    ],
    nextActions: ['先调试只读接口', '再调试核价计算', '最后调试会写 Ozon 的预览/确认/回读闭环'],
  });
}

const ozonSkillAdapters = Object.fromEntries(ozonSkillIds.map((skillId) => [skillId, runOzonReferenceSkill]));
const externalOzonSkillAdapters = Object.fromEntries(
  externalOzonSkillIds.map((skillId) => [skillId, createExternalReadonlyResult])
);
const smartToolAdapters = {
  ...ozonSkillAdapters,
  ...externalOzonSkillAdapters,
  'ozon-product-search': runOzonProductSearchSkill,
  'ozon-product-selection': createExternalReadonlyResult,
  'ozon-ad-analyzer': runPerformanceAdApiOnlySkill,
  'ozon-product-image-generation': runOzonProductImageGenerationSkill,
  [PROFIT_ORDER_REVIEW_SKILL_ID]: createProfitReviewEntryResult,
};

export function runSmartToolSkillAdapter(tool = {}, inputText = '', options = {}) {
  const parsedInput = parseSkillInput(inputText);
  const state = getSmartToolSkillExecutionState(tool);
  if (state.adapterKey === SMART_TOOL_GENERIC_RUNTIME_ADAPTER_KEY) {
    return createAdapterResult({
      status: 'generic_runtime_required',
      statusLabel: '请通过通用运行引擎执行',
      summary: `${normalizeSkillText(tool.title, '自定义 Skill')} 已绑定通用运行引擎；真实接口和模型调用由异步服务执行。`,
      sections: [
        {
          title: '本次输入',
          rows: parsedInput.rawText ? parsedInput.rawText.split(/\r?\n/) : ['还没有填写输入。'],
        },
      ],
      nextActions: ['在运行窗口点击“运行 Skill”'],
    });
  }
  const adapter = smartToolAdapters[tool.id];
  if (!adapter) return createUnsupportedSkillResult(tool, parsedInput, state);
  return adapter(tool, parsedInput, options);
}

export function listSmartToolSkillAdapterIds() {
  return Object.keys(smartToolAdapters);
}
