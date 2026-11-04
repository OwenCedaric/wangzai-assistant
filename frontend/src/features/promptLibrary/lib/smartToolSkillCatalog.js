import { ozonSkillProfiles } from './ozonSkillCatalog.js';

import { externalOzonSkillProfiles } from './externalOzonSkillCatalog.js';
import { OZON_PRODUCT_DECISION_RULES_VERSION } from './smartToolOzonProductDecisionRules.js';

export const smartToolSkillCatalog = {
  'ozon-product-search': {
    // 该工具只保留运行规则；真实数据由 Ozon 内置浏览器观察器提供。
    // 不在运行配置中保存任何来源、供应商或外部账号信息。
    runType: 'browser-capture-readonly',
    analysisRulesVersion: OZON_PRODUCT_DECISION_RULES_VERSION,
    availability: '可通过后台内置浏览器查询并分析 Ozon 商品数据',
    capabilities: [
      '支持中文、俄文关键词、Ozon 商品链接或 SKU',
      '中文品类会从本机共享 Ozon 类目目录解析真实 type ID，复合词也能命中叶子类目',
      '读取商品 ID、标题、品牌、卖家等基础信息',
      '查看价格、Ozon Card 价格、折扣、库存、销量等商品详情指标',
      '展示广告、促销、商品卡/搜索流量、转化、履约、包裹、上架和跟卖字段',
      '计算价格销量关系、GMV/品牌/卖家集中度和各价格带动销表现',
      '诊断广告促销依赖、流量转化短板、库存覆盖、履约质量和跟卖压力',
      '按七个有效证据维度生成市场机会评分、可信度、主要风险和下一步动作',
      '支持商品明细分页和价格、销量、GMV、库存排序',
    ],
    usageInputs: ['关键词或 SKU', '产品链接（可选）'],
    inputs: ['关键词', 'SKU', 'Ozon/1688/淘宝/天猫/拼多多商品链接', '品牌名', '卖家名', '类目', '价格区间'],
    outputs: ['目标商品资料与费用预估', '市场概览', '选品决策', '机会评分与可信度', '风险和执行动作', '价格带/品牌分布', '可排序商品明细'],
    workflowSteps: [
      '接收中文/俄文关键词、Ozon 商品链接或 SKU，并生成共享 QueryPlan',
      '商品链接通过独立 product-link-parser 浏览器读取，禁止导航或复用 market-collector 轮询浏览器',
      '解析链接商品的标题、平台价格、长宽高、重量和类目；采购平台价格作为采购参考，Ozon 价格作为销售价',
      '中文先匹配本机共享 Ozon 类目目录；已知同义词同时展开成俄文查询词，不调用翻译接口',
      '商品、SKU、类目型 Skill 复用同一查询入口；卖家、品牌、关键词和第三方类目 ID 不误走商品接口',
      '驱动后台专用浏览器打开 Ozon 市场商品页，并按当前关键词执行一次只读查询',
      '只读取本次查询新捕获并确认的 product-performance 数据集，不混入旧快照',
      '先按商品 ID 锁定身份，再按 SKU 合并已返回的价格、销量、GMV、广告、流量、履约、包裹和跟卖字段',
      '按商品 ID 或标题去重，保留最新捕获记录，最多返回 1000 条',
      '只用有效真实字段按七个维度分析市场动量、竞争结构、流量转化、自然动销、库存健康、履约质量和跟卖压力',
      '每个维度按固定阈值独立评分，仅在至少三个维度有效时生成综合机会分',
      '同时输出证据覆盖率、正向信号、全部低分风险、价格销量关系和可执行动作',
      '统一金额与数字格式，生成统计卡、决策面板、结论卡、分布卡和每页 20 条的商品表格',
      '缺失维度标记为数据不足；没有采购、佣金和物流成本时不得推断净利润',
    ],
    safetyNotes: [
      '只读分析，不写 Ozon、不改商品、订单或库存',
      '只使用内置浏览器已经捕获并确认的数据，不编造缺失字段',
      '综合评分只使用已返回维度并同步展示证据覆盖率，低可信结果不能包装成确定结论',
      '没有捕获数据时明确提示用户先完成一次对应页面查询',
    ],
  },
  'ozon-product-selection': {
    sourceName: '旺崽 Ozon 选品决策链',
    sourceUrl: 'https://clawhub.ai/1688aiinfra/skills/ozon-product-selection',
    installType: 'reference-reimplementation',
    runType: 'ozon-product-selection-readonly',
    analysisRulesVersion: OZON_PRODUCT_DECISION_RULES_VERSION,
    availability: '已接入 Ozon 内置浏览器、中文采购词转换、1688 搜款校验与文本模型；Seerfar 为可选复核',
    capabilities: [
      '支持中文、俄文关键词、Ozon 商品链接或 SKU',
      '读取 Ozon 真实商品、价格、销量、销售额、库存、转化、履约和跟卖数据',
      '按固定七维规则计算机会分、证据覆盖率、正向信号和主要风险',
      '可由用户明确选择是否调用 Seerfar 做近 30 天市场复核',
      '自动选择 Ozon 同类热销商品，转换成中文采购词，并过滤与商品不一致的 1688 识图结果',
      '可读取指定 1688 货源链接的采购价、规格、重量和尺寸',
      '使用用户选择的文本模型严格执行可编辑 Skill，生成最终中文选品报告',
    ],
    usageInputs: ['商品关键词、SKU 或 Ozon 链接', 'Seerfar 市场复核', '1688 货源链接（可选）'],
    inputs: ['商品关键词、SKU 或 Ozon 链接', '是否使用 Seerfar', '1688 货源链接（可选）', '分析模型'],
    outputs: ['综合选品结论', '七维机会评分', '市场证据', '竞争与运营风险', '货源核对', '小批量测试方案', '数据缺口'],
    workflowSteps: [
      '接收商品关键词、SKU 或 Ozon 链接，并生成统一查询计划',
      '通过后台专用浏览器执行一次 Ozon 只读查询，只接收本次新捕获的真实商品数据',
      '按商品 ID 去重并整理价格、销量、销售额、增长、广告促销、转化、库存、履约和跟卖字段',
      '使用固定阈值分别计算市场动量、竞争结构、流量转化、自然动销、库存健康、履约质量和跟卖压力',
      '至少三个维度有真实数据时才生成综合机会分，同时展示证据覆盖率和缺失维度',
      '用户选择使用 Seerfar 时只执行一次受控市场复核；不选择时不消耗 Seerfar 积分',
      '从 Ozon 同类热销商品中选择代表款，转换成中文采购词，再执行 1688 识图补充；只有商品名称一致的结果才作为候选货源返回',
      '用户填写 1688 货源链接时，额外读取该指定货源的采购价、规格、重量和尺寸；没有物流和完整费用时不计算净利润',
      '把程序计算结果、可选外部复核和货源事实交给用户选择的文本模型执行当前可编辑 Skill',
      '输出综合结论、证据、风险、验证动作和数据缺口；只建议小批量验证，不自动上架或采购',
    ],
    safetyNotes: [
      '只读选品，不自动上架、不自动采购、不修改 Ozon 数据',
      '固定评分由程序计算，文本模型只能解释，不能改分或补造指标',
      'Seerfar 仅在用户明确选择使用时调用',
      '1688 货源信息不能覆盖 Ozon 真实市场数据',
      '没有采购、汇率、平台费用和物流费用时不得宣称净利润或最终利润率',
    ],
  },
  'ozon-ad-analyzer': {
    sourceName: '旺崽 Ozon Performance API 广告诊断',
    sourceUrl: '',
    installType: 'built-in-api',
    runType: 'ozon-performance-readonly',
    availability: '需要已配置的 Ozon Performance API 账号',
    capabilities: [
      '实时读取 Ozon Performance API 广告计划、完整统计和每日趋势',
      '统一计算 CTR、CPC、CVR、CPO、ACOS 和 ROAS',
      '识别有花费无订单、低点击、低转化、高 ACOS、预算耗尽和审核失败',
      '按账号、计划名称或计划 ID、统计周期输出只读诊断报告',
      '使用用户选择的文本模型严格执行可编辑 Skill 提示词，生成最终中文经营报告',
    ],
    usageInputs: ['推广账号（可选）', '广告计划名称或 ID（可选）', '统计范围'],
    inputs: ['Performance API 账号', '广告计划筛选', '日期范围', '分析模型'],
    outputs: ['整体表现', '主要问题', '计划诊断', '趋势变化', '调整建议', '数据完整性'],
    workflowSteps: [
      '读取已配置的 Ozon Performance API 账号，按名称或 ID 选择账号',
      '先按用户选择的计划缩小读取范围；选择全部计划时才读取账号下全部计划',
      '以 full 深度实时读取所选计划的统计、商品和每日趋势，跳过不适用于当前分析的旧投放对象接口',
      '区分“暂无数据”和真实数值 0，再计算 CTR、CPC、CVR、CPO、ACOS、ROAS',
      '把已整理的真实数据、可编辑 Skill 提示词和内置流程交给用户选择的文本模型',
      '由模型输出分析范围、整体表现、主要问题、计划诊断、趋势变化、调整建议和数据完整性',
      '只做诊断建议，不自动改预算、不自动停投，不使用浏览器快照或业务缓存',
    ],
    safetyNotes: [
      '只读调用 Ozon Performance API，不自动调预算、不自动停投',
      '没有商品毛利率时不宣称广告一定亏损',
      '接口读取异常必须显示，不用旧快照冒充实时结果',
    ],
  },
  'ozon-product-image-generation': {
    sourceName: 'Ozon 商品图生成规则 2.0.7',
    sourceUrl: '',
    installType: 'reference-reimplementation',
    runType: 'preset-auto-image-generation',
    modelCapability: 'image-generation',
    availability: '已支持按位置规则自动规划并直接调用图片模型，上传前人工选择',
    capabilities: [
      '锁定商品和当前 SKU 的颜色、结构、材质、配件与包装数量',
      '根据实际选择数量生成逐图方案，并把每条位置规则绑定到对应商品图片',
      '生成正向提示词、负面提示词和图片验收项',
      '默认使用 3:4 竖版 Ozon 电商图片方案',
    ],
    usageInputs: ['商品图片或商品 SKU', 'SKU 信息', '目标场景（可选）'],
    inputs: ['商品参考图', '商品名称', '当前 SKU', 'SKU 事实', '目标场景', '核心卖点'],
    outputs: ['逐图位置方案', '主图/详情图生成结果', '位置绑定规则', '负面提示词', '验收检查项'],
    workflowSteps: [
      '接收商品图片或商品 SKU、SKU 信息和目标场景',
      '先锁定商品身份和当前 SKU 事实，不允许改变颜色、结构、材质、配件和包装数量',
      '按用户实际选中的商品图片数量运行，不补齐固定张数',
      '自动把每条主图/详情图预设位置规则绑定到对应商品原图',
      '文本模型自动整理每张图的正向提示词、负面提示词、必须保留项、禁止项和验收项',
      '无需中间确认，自动调用图片模型，并保持原图与生成结果位置一一对应',
    ],
    safetyNotes: [
      '不得虚构商品功能、配件、赠品、认证、保修或性能提升',
      '不得改变 SKU 颜色、结构、材质、比例、部件和包装数量',
      '不得添加价格、折扣、评分、销量、二维码、电话、水印或平台 UI',
      '不得生成工厂、车间、生产线、仓库或工厂直供宣传',
      '不得复制源平台中文广告文案，俄语文字必须简短且可读',
      '位置规划和生图可以自动串联；不自动替换商品图片，不自动写 Ozon，上传前必须人工选择',
    ],
  },
  'profit-risk-review': {
    sourceName: '旺崽内置低利润复核 skill',
    sourceUrl: '',
    installType: 'built-in-prompt',
    runType: 'profit-ledger-market-ai-review',
    availability: '输入订单号即可运行；利润账本为必需，Seerfar 和文本模型可降级',
    capabilities: [
      '按订单号读取现有完整利润账本，不重复发明利润公式',
      '统计同 SKU 历史订单、累计利润、利润率和亏损订单数',
      '通过 Seerfar 查询该 SKU 近 30 天销量、销售额、库存、评分和趋势',
      '综合判断继续投入、优化后继续、减少投入或暂停投入',
      '生成可执行的售价、采购、物流、平台费用和售后优化建议',
    ],
    usageInputs: ['订单号'],
    inputs: ['订单号（唯一人工输入）', '完整利润账本', '同 SKU 历史利润', 'Seerfar 市场数据（可选）'],
    outputs: ['订单利润结论', '最大影响项', '完整费用拆解', '同商品历史表现', '市场表现', '投入判断', '优化方案', '缺失数据'],
    workflowSteps: [
      '接收订单号并限定在当前账号和店铺范围内查找',
      '读取现有完整利润账本，优先使用实际利润，未形成实际利润时使用预估利润',
      '检查采购成本、佣金、收单费、配送服务费、物流费、巴士费、罚款和退款损失状态',
      '按同 SKU 汇总历史订单、利润率和持续亏损情况',
      '从订单自动提取 Ozon SKU，通过 Seerfar 查询近 30 天市场表现',
      '由代码保留确定性金额，由文本模型解释原因并给出投入建议',
      '市场或模型不可用时只降级对应部分，利润核算结果继续展示',
      '不改利润公式、不改金额、不覆盖订单数据，只做复核建议',
    ],
    safetyNotes: ['不改利润公式', '不改金额', '不覆盖订单数据', '缺失数据不按 0 处理', '市场数据没有返回时不得编造'],
  },
  ...externalOzonSkillProfiles,
  ...ozonSkillProfiles,
};

function normalizeSkillList(value) {
  return (Array.isArray(value) ? value : [])
    .map((item) => String(item ?? '').trim())
    .filter(Boolean);
}

export function getSmartToolSkillProfile(tool = {}) {
  const profile = smartToolSkillCatalog[tool.id] || {};
  const hasCatalogProfile = Object.keys(profile).length > 0;
  const sourceName = String(
    hasCatalogProfile ? (profile.sourceName || '') : (tool.sourceName || tool.title || '自定义智能工具')
  ).trim();
  const sourceUrl = String(hasCatalogProfile ? (profile.sourceUrl || '') : (tool.sourceUrl || '')).trim();
  const secondarySourceUrl = String(
    hasCatalogProfile ? (profile.secondarySourceUrl || '') : (tool.secondarySourceUrl || '')
  ).trim();
  const installType = String(
    hasCatalogProfile ? (profile.installType || '') : (tool.installType || 'custom')
  ).trim();
  return {
    ...(sourceName ? { sourceName } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(secondarySourceUrl ? { secondarySourceUrl } : {}),
    ...(installType ? { installType } : {}),
    runType: String(profile.runType || 'local-ai-preview').trim(),
    ...(profile.analysisRulesVersion ? {
      analysisRulesVersion: String(profile.analysisRulesVersion).trim(),
    } : {}),
    availability: String(profile.availability || '需要人工确认配置').trim(),
    modelCapability: String(profile.modelCapability || 'text-generation').trim(),
    capabilities: normalizeSkillList(profile.capabilities),
    usageInputs: normalizeSkillList(profile.usageInputs),
    inputs: normalizeSkillList(profile.inputs),
    outputs: normalizeSkillList(profile.outputs),
    workflowSteps: normalizeSkillList(profile.workflowSteps),
    safetyNotes: normalizeSkillList(profile.safetyNotes),
  };
}




