function buildOzonSkillSourceRef(skillName) {
  return 'local-ozon-skill:' + skillName;
}

function createOzonSkill({
  id,
  scene,
  sceneLabel,
  title,
  goal,
  status = '待接入',
  owner = '运营组',
  body,
  variables = [],
  dependencies = [],
  entryPoints = [],
  originalSkillName,
  runType,
  riskLabel = '待调试',
  riskTone = 'warning',
  actionMode = '先接入，再调试',
  availability,
  capabilities = [],
  usageInputs = [],
  inputs = [],
  outputs = [],
  workflowSteps = [],
  safetyNotes = [],
  modelPurpose = '',
  outputFormat = '',
  implementationVersion = 1,
}) {
  const sourceRef = buildOzonSkillSourceRef(originalSkillName);
  const skillProfile = {
    sourceName: `Ozon Skill / ${originalSkillName}`,
    sourceRef,
    originalSkillName,
    installType: 'ozon-skill-local-skill',
    runType,
    availability,
    capabilities,
    usageInputs,
    inputs,
    outputs,
    workflowSteps,
    safetyNotes,
    implementationVersion,
  };

  return {
    id,
    scene,
    sceneLabel,
    title,
    goal,
    status,
    tone: 'default',
    updatedAt: '07-09 20:30',
    used: 0,
    owner,
    body,
    variables,
    dependencies,
    entryPoints,
    modelPurpose,
    outputFormat,
    skillProfile,
    runtimeProfile: {
      dependencies,
      entryPoints,
      actionMode,
      riskLabel,
      riskTone,
      displayTitle: title,
      displayGoal: goal,
      displayBody: body,
      displayVariables: usageInputs.length ? usageInputs : variables,
    },
  };
}

export const ozonSkillItems = [
  createOzonSkill({
    id: 'ozon-skill-1688-channel-shopdata-get',
    scene: 'report',
    sceneLabel: '数据报表',
    title: 'Ozon 报表读取与分析',
    goal: '按店铺读取 Ozon 完整经营报表并直接生成经营分析',
    owner: '运营组',
    originalSkillName: '1688-channel-shopdata-get',
    status: '可用',
    runType: 'ozon-synced-report-read-and-analyze-v4',
    riskLabel: '只读数据',
    riskTone: 'success',
    actionMode: '读取并分析报表',
    availability: '可按店铺和日期范围读取软件已经同步的 Ozon 经营数据，并直接调用所选文本模型生成经营分析',
    body:
      '按当前店铺和日期范围读取软件已经同步的 Ozon 销售、商品、库存、费用、售后和营销数据，金额统一折算成人民币；读取完成后直接生成总体判断、关键发现、经营机会、主要风险和处理顺序。',
    variables: ['报告内容', '统计范围'],
    usageInputs: ['报告内容', '统计范围'],
    dependencies: ['已同步的 Ozon 店铺数据', '卢布兑人民币汇率', '已配置的文本模型'],
    entryPoints: ['商品列表', '仓储物流', '数据报表'],
    capabilities: ['经营概览读取', '销售与商品排行读取', '商品库存与补货读取', '费用与扣费明细读取', '售后原因与售后单读取', '营销活动与活动商品读取', '跨模块经营诊断', '问题优先级和行动建议'],
    inputs: ['报告内容', '统计范围', '当前店铺', '文本模型'],
    outputs: ['经营分析结论', '关键发现', '经营机会', '主要风险', '处理顺序', '经营概览', '销售明细', '商品库存明细', '费用项目和扣费流水', '售后明细', '营销活动明细'],
    workflowSteps: [
      '选择当前 Ozon 店铺、报告内容和统计范围',
      '从店铺本地同步数据中读取销售、商品、库存、财务、售后和营销经营快照',
      '按所选日期范围读取所有已返回的每日销售、商品排行、状态、类目、价格区间、库存风险和补货数据',
      '读取对应日期汇率，将报表中的卢布金额统一折算成人民币',
      '把费用代码翻译为中文项目名称，并展示发生笔数、合计金额、扣费日期、关联订单和流水号',
      '售后数据展示状态、原因、商品、订单号、金额和售后编号；营销数据展示活动、商品、价格、库存和活动编号',
      '优先使用官方返回的商品名、商家货号、商品编码、订单号和业务编号，不生成“第几项”匿名记录',
      '字段确实未返回时明确指出缺少的字段和已有业务编号，不补造名称、金额或状态',
      '把读取结果直接交给当前选择的文本模型，交叉分析销售、库存、费用、售后和营销之间的关系',
      '分析报告必须给出具体数据依据、业务影响和处理顺序，不能只是重新整理或复述报表',
      '分析完成后先展示经营分析，再保留完整报表明细供人工核对',
      '只读展示，不覆盖商品、订单、库存或利润数据',
    ],
    safetyNotes: ['只读 Ozon 已同步数据', '缺失数据不能按 0 展示', '不得使用匿名序号替代真实项目名称', '不使用浏览器插件快照替代店铺报表', '不覆盖任何业务数据'],
    modelPurpose: 'Ozon 店铺经营报表读取与诊断',
    outputFormat: '先输出分析报告：总体结论 / 整体判断 / 关键发现 / 经营机会 / 主要风险 / 处理顺序 / 数据缺口；再保留报表明细：读取范围 / 经营概览 / 每日销售 / 商品排行 / 商品状态 / 类目和价格区间 / 库存风险和补货 / 费用构成 / 扣费流水 / 售后状态和原因 / 最近售后 / 活动和活动商品。分析必须引用真实数字和业务编号，不能只复述数据。',
    implementationVersion: 4,
  }),
  createOzonSkill({
    id: 'ozon-skill-1688-channel-shopdata-analyzer',
    scene: 'report',
    sceneLabel: '数据报表',
    title: 'Ozon 报表分析',
    goal: '分析 Ozon 店铺经营数据，找低效商品',
    status: '可用',
    owner: '运营组',
    originalSkillName: '1688-channel-shopdata-analyzer',
    runType: 'ozon-skill-offline-report-analyzer',
    riskLabel: '只分析',
    riskTone: 'success',
    actionMode: '分析报表',
    availability: '可直接读取已同步的店铺数据，并按可编辑 Skill 规则调用文本模型生成诊断',
    body:
      '现在不需要上传 Excel/CSV：选择店铺和日期范围后，直接读取软件已同步的 Ozon 商品、订单、库存、财务、售后和营销数据，识别低效商品、滞销商品和库存问题，并由文本模型输出结构化经营诊断。',
    variables: ['店铺', '日期范围', '文本模型'],
    usageInputs: ['店铺', '日期范围', '文本模型'],
    dependencies: ['已同步的 Ozon 店铺数据', '文本模型接口'],
    entryPoints: ['商品列表', '仓储物流', '数据报表'],
    capabilities: ['读取当前店铺真实数据', '分析销售、商品、库存、财务、售后和营销', '识别低效商品和滞销商品', '生成经营风险与运营建议', '输出结构化 Markdown 诊断'],
    inputs: ['店铺', '日期范围', '文本模型', '可选的补充分析要求'],
    outputs: ['数据概览', '低效商品清单', '库存风险', '费用与利润提示', '售后与营销提示', '优先行动清单', '数据缺口说明'],
    workflowSteps: [
      '选择要分析的 Ozon 店铺和日期范围',
      '读取软件已同步的店铺商品、订单、库存、财务、售后和营销数据',
      '将多源数据按店铺和日期范围整理为分析快照',
      '调用已配置的文本模型生成经营诊断',
      '识别低效、滞销、缺货和库存积压风险',
      '输出结构化分析报告；缺失数据单独标记，不补造结论',
    ],
    safetyNotes: ['只分析软件已经同步的真实店铺数据', '不要求上传 Excel/CSV', '数据缺失时明确标记数据缺口', '不自动下架、改价或改库存'],
    modelPurpose: 'Ozon 销售库存报表分析',
    outputFormat: '分段输出：数据概览 / 低效商品 / 库存风险 / 建议动作 / 数据不足。',
    implementationVersion: 2,
  }),
  createOzonSkill({
    id: 'ozon-skill-1688-product-detail-query',
    scene: '1688',
    sceneLabel: '1688 工具',
    title: '1688 商品读取',
    goal: '读取 1688 商品详情，为采购资料核对提供前置数据',
    owner: '商品组',
    originalSkillName: '1688-product-detail-query',
    status: '可用',
    runType: 'isolated-product-browser-read-v2',
    riskLabel: '只读 1688',
    riskTone: 'success',
    actionMode: '读取商品详情',
    availability: '可通过独立商品读取浏览器取得 1688 页面真实资料，不抢占 Ozon 后台轮询浏览器',
    body:
      '打开独立的后台商品读取窗口，读取 1688 商品标题、采购价、图片、规格、重量和长宽高，可继续用于采购资料核对和采集核价。',
    variables: ['1688 商品链接或商品 ID'],
    usageInputs: ['1688 商品链接或商品 ID'],
    dependencies: ['1688 采购账号', '独立商品读取浏览器'],
    entryPoints: ['采集核价', '商品列表', '1688 工具'],
    capabilities: ['解析 1688 商品链接或商品 ID', '读取商品标题、价格、图片和规格', '读取重量与长宽高', '给采购资料核对与采集核价提供前置数据'],
    inputs: ['1688 商品链接', '1688 商品 ID'],
    outputs: ['商品标题', '商品 ID/规格', '采购价格', '图片', '重量与长宽高', '缺失项'],
    workflowSteps: [
      '接收 1688 商品链接或商品 ID',
      '商品 ID 自动转换为 1688 商品链接',
      '使用独立 product-link-parser 浏览器打开商品页，不导航或复用 Ozon 市场轮询浏览器',
      '解析标题、商品 ID、价格、图片、规格、重量和长宽高',
      '返回真实字段和缺失项，不补造供应商、规格或物流数据',
      '把结果交给采购资料核对或采集核价；只读 1688，不写 Ozon',
    ],
    safetyNotes: ['只读商品详情', '使用独立后台读取窗口，不抢 Ozon 轮询浏览器', '不写 Ozon 或业务缓存', '页面没有返回的字段保持为空'],
    modelPurpose: '1688 商品详情整理',
    outputFormat: '分段输出：商品信息 / SKU 规格 / 价格图片 / 可用于核价的数据 / 缺失项。',
    implementationVersion: 2,
  }),
];

export const ozonSkillIds = ozonSkillItems.map((item) => item.id);

export const ozonSkillProfiles = Object.fromEntries(
  ozonSkillItems.map((item) => [item.id, item.skillProfile])
);

export const ozonRuntimeProfiles = Object.fromEntries(
  ozonSkillItems.map((item) => [item.id, item.runtimeProfile])
);






