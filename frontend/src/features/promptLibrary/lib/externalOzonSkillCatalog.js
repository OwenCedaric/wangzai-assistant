const COMMON_PAID_QUERY_SAFETY_NOTES = [
  '这是只读数据查询，不修改 Ozon、商品、订单或本地业务数据',
  '每次查询必须标明数据来源、统计日期和筛选条件',
  '按接口允许的最大每页条数读取全部分页，限流时串行退避重试',
  '同一组参数运行中只保留一个任务，更换条件会停止旧任务',
  '接口没有返回的字段不得猜测或补写',
];

function createExternalOzonSkill({
  id,
  provider,
  providerType,
  operation,
  title,
  goal,
  body,
  usageInputs,
  inputs,
  outputs,
  capabilities,
  workflowSteps,
  outputFormat,
  entryPoints = ['工具中心', '选品分析'],
}) {
  const originalSkillName = id;
  const dependencies = ['Seerfar Open API 账号或 API Key', '可用查询积分'];

  return {
    id,
    scene: 'ozon',
    sceneLabel: 'Ozon 数据',
    title,
    goal,
    status: '待配置',
    tone: 'warning',
    updatedAt: '07-21 12:00',
    used: 0,
    owner: '选品组',
    body,
    variables: usageInputs,
    dependencies,
    entryPoints,
    provider,
    providerType,
    operation,
    modelPurpose: `${provider} 查询结果整理`,
    outputFormat,
    skillProfile: {
      sourceName: '内置 Ozon 数据工具',
      sourceRef: `local-data-skill:${originalSkillName}`,
      originalSkillName,
      installType: 'linkfox-local-skill',
      runType: 'external-readonly',
      availability: `已内置查询规则；真实查询需要配置${dependencies[0]}`,
      modelCapability: 'data-query-planning',
      capabilities,
      usageInputs,
      inputs,
      outputs,
      workflowSteps: [
        ...workflowSteps,
        '按 Skill 指标口径生成汇总、排名、机会与风险分析',
        '点击商品时按 SKU 补充商品详情并进入统一操作台',
      ],
      safetyNotes: COMMON_PAID_QUERY_SAFETY_NOTES,
    },
    runtimeProfile: {
      dependencies,
      entryPoints,
      actionMode: '生成只读查询草稿',
      riskLabel: '只看不改',
      riskTone: 'success',
      displayTitle: title,
      displayGoal: goal,
      displayBody: body,
      displayVariables: usageInputs,
    },
    promptTemplate: {
      modelPurpose: `${provider} 查询结果整理`,
      outputFormat,
    },
  };
}

export const externalOzonSkillItems = [
  createExternalOzonSkill({
    id: 'linkfox-seerfar-ozon-shop-search',
    provider: 'Seerfar',
    providerType: 'seerfar-open-api',
    operation: 'ozon-shop-search',
    title: 'Seerfar 店铺商品',
    goal: '查看一个 Ozon 店铺旗下的商品和近 30 天表现',
    body: '按 Ozon 店铺或卖家 ID 查询商品列表，查看近 30 天销量、价格、评分、配送方式、退货取消率等指标。',
    usageInputs: ['店铺 ID 或链接'],
    inputs: ['店铺或卖家 ID', '排序方式（可选）', '指标筛选（可选）'],
    outputs: ['店铺商品列表', '近 30 天销量与销售额', '价格与评分', 'FBO/FBS 配送', '退货取消率', '商品重量与卖家类型'],
    capabilities: ['按店铺查看商品矩阵', '查看近 30 天经营指标', '筛选店铺爆款和低效商品', '分析 FBO/FBS 和退货取消情况'],
    workflowSteps: ['校验店铺或卖家 ID', '确认排序和筛选条件', '按接口上限自动读取全部分页', '合并并去重商品数据', '整理商品级指标', '输出来源、统计周期和查询条件'],
    outputFormat: '表格输出：SKU / 商品 / 价格 / 近 30 天销量 / 销售额 / 评分 / 配送 / 退货取消率。',
    entryPoints: ['竞店分析', '选品分析', '工具中心'],
  }),
  createExternalOzonSkill({
    id: 'linkfox-seerfar-ozon-product-detail-search',
    provider: 'Seerfar',
    providerType: 'seerfar-open-api',
    operation: 'seerfar-ozon-product-detail-search',
    title: 'Seerfar 商品详情',
    goal: '查看单个 Ozon SKU 的完整表现和每日趋势',
    body: '按一个 Ozon SKU 查询商品详情、销量、销售额、库存、排名、品牌、卖家和每日趋势。',
    usageInputs: ['分析对象', '商品 SKU 或链接'],
    inputs: ['分析对象：竞对商品或自己商品', '单个 Ozon SKU'],
    outputs: ['商品基本信息', '价格与销售指标', '库存与类目排名', '品牌与卖家', '每日趋势'],
    capabilities: ['按 SKU 查询完整商品卡片', '分别执行竞对商品和自己商品分析', '读取每日销量与价格趋势', '查看库存和类目排名', '识别品牌、卖家和配送信息'],
    workflowSteps: ['选择竞对商品或自己商品分析', '校验单个 Ozon SKU', '生成一次只读商品详情查询', '整理当前商品指标', '按所选方案分析趋势、转化和风险', '标出缺失字段', '输出来源和数据日期'],
    outputFormat: '分段输出：商品概览 / 销量价格库存 / 类目排名 / 每日趋势 / 数据日期。',
    entryPoints: ['商品列表', '商品详情', '选品分析'],
  }),
  createExternalOzonSkill({
    id: 'linkfox-seerfar-ozon-category-search',
    provider: 'Seerfar',
    providerType: 'seerfar-open-api',
    operation: 'seerfar-ozon-category-search',
    title: 'Seerfar 类目商品',
    goal: '按 Seerfar 类目查看 Ozon 商品和类目表现',
    body: '按 Seerfar 类目 ID 查询类目商品，可查看历史月份、销量、价格、评分和配送方式等指标。',
    usageInputs: ['Seerfar 类目 ID'],
    inputs: ['Seerfar 类目 ID', '历史月份（可选）', '配送方式（可选）', '排序方式（可选）'],
    outputs: ['类目商品列表', '销量与销售额', '价格与评分', '配送方式', '历史月份数据'],
    capabilities: ['按类目 ID 查看商品', '切换历史月份', '筛选 FBO/FBS 配送方式', '按关键指标排序'],
    workflowSteps: ['校验 Seerfar 类目 ID', '固定历史月份和配送筛选', '按接口上限自动读取全部分页', '合并并去重商品数据', '整理商品指标', '输出来源、月份和查询条件'],
    outputFormat: '表格输出：SKU / 商品 / 价格 / 销量 / 销售额 / 评分 / 配送；附类目与统计月份。',
  }),
  createExternalOzonSkill({
    id: 'linkfox-seerfar-ozon-product-report-search',
    provider: 'Seerfar',
    providerType: 'seerfar-open-api',
    operation: 'seerfar-ozon-product-report-search',
    title: 'Seerfar 商品筛选',
    goal: '按销量、价格、转化率等多项指标筛选 Ozon 商品',
    body: '在 Seerfar 商品报表中按销量、增长、价格、评分、转化率、品牌、卖家、配送和上架时间等条件筛选商品。',
    usageInputs: ['商品关键词、SKU 或链接（可多个）'],
    inputs: ['筛选目标或关键词', '类目 ID（可选）', '品牌/卖家（可选）', '销量/价格/转化等范围（可选）', '排序方式（可选）'],
    outputs: ['商品筛选结果', '销量与销售额', '增长与转化率', '价格与评分', '品牌卖家与配送', '退货取消率'],
    capabilities: ['按多指标筛选商品', '查找热销、新品或低竞争商品', '按品牌、卖家、类目缩小范围', '比较转化、毛利和退货取消指标'],
    workflowSteps: ['把中文或俄语商品词匹配到真实筛选条件', '确定类目、品牌或卖家范围', '设置一个主要排序指标', '按接口上限自动读取全部分页', '合并并去重完整报表', '输出来源、条件和字段口径'],
    outputFormat: '表格输出：SKU / 商品 / 价格 / 销量 / 销售额 / 增长 / 转化 / 评分 / 品牌 / 卖家；附筛选条件。',
  }),
  createExternalOzonSkill({
    id: 'linkfox-seerfar-ozon-keyword-mining',
    provider: 'Seerfar',
    providerType: 'seerfar-open-api',
    operation: 'seerfar-ozon-keyword-mining',
    title: 'Seerfar 关键词挖掘',
    goal: '从一个中文或俄语种子词扩展 Ozon 相关搜索词',
    body: '从一个种子关键词扩展相关词，查看搜索量、增长、商品数、卖家数、均价、相关性和转化指标。',
    usageInputs: ['种子关键词'],
    inputs: ['中文或俄语种子关键词', '历史月份（可选）', '搜索量/竞争度等筛选（可选）', '排序方式（可选）'],
    outputs: ['俄语关键词与中文释义', '搜索量与增长', '商品数与卖家数', '均价与竞争度', '相关性与转化指标'],
    capabilities: ['从种子词扩展相关关键词', '识别高搜索低竞争词', '查看关键词增长和转化', '保留俄语原词并展示可用中文释义'],
    workflowSteps: ['把中文种子词匹配为可查询的俄语词', '确定筛选和排序指标', '按接口上限自动读取全部分页', '合并并去重关键词', '保留俄语原词并整理指标', '输出来源、月份和查询条件'],
    outputFormat: '表格输出：俄语词 / 中文释义 / 搜索量 / 增长 / 商品数 / 卖家数 / 均价 / 相关性 / 转化。',
    entryPoints: ['标题优化', '广告分析', '选品分析'],
  }),
  createExternalOzonSkill({
    id: 'linkfox-seerfar-ozon-market-keyword-search',
    provider: 'Seerfar',
    providerType: 'seerfar-open-api',
    operation: 'seerfar-ozon-market-keyword-search',
    title: 'Seerfar 市场热词',
    goal: '浏览和筛选 Ozon 市场关键词',
    body: '不用先指定 SKU，可按月份、类目、搜索量、增长、竞争度等条件浏览 Ozon 市场关键词。',
    usageInputs: ['关键词或筛选条件（可多个）'],
    inputs: ['筛选目标或关键词（可选）', '历史月份（可选）', '类目 ID（可选）', '搜索量/增长/竞争等范围（可选）', '排序方式（可选）'],
    outputs: ['市场关键词', '搜索量与增长', '商品数与卖家数', '均价与竞争度', 'Top 商品与类目信息'],
    capabilities: ['浏览全市场热词', '按类目和月份筛选', '寻找增长词和低竞争词', '查看关键词对应 Top 商品'],
    workflowSteps: ['把中文或俄语市场词转换为查询条件', '确定月份和类目范围', '设置主要排序指标', '按接口上限自动读取全部分页', '合并并去重市场词', '输出来源、月份和查询条件'],
    outputFormat: '市场词卡片：俄语词 / 中文释义 / 平台 / 搜索量 / 增长 / 销量销售额 / 商品与卖家 / 转化 / 类目 / Top 商品；附筛选口径。',
    entryPoints: ['选品分析', '标题优化', '广告分析'],
  }),
  createExternalOzonSkill({
    id: 'linkfox-seerfar-ozon-keyword-back-search',
    provider: 'Seerfar',
    providerType: 'seerfar-open-api',
    operation: 'seerfar-ozon-keyword-back-search',
    title: 'Seerfar 关键词反查',
    goal: '按 Ozon SKU 反查自然词和广告词',
    body: '输入最多 20 个 Ozon SKU，反查商品出现在哪些自然搜索词或广告词下，并查看排名、曝光、转化和市场指标。',
    usageInputs: ['商品 SKU 或链接（最多20个）'],
    inputs: ['Ozon SKU 列表（最多 20 个）', '是否排除变体（必填）', '自然词/广告词类型（可选）', '关键词和指标筛选（可选）', '排序方式（可选）'],
    outputs: ['自然搜索词与广告词', '自然排名与广告排名', '曝光与转化', '搜索量与增长', '商品数与卖家数', 'Top 商品'],
    capabilities: ['按 SKU 反查流量词', '区分自然词和广告词', '查看自然/广告排名、曝光和转化', '支持最多 20 个 SKU 对比'],
    workflowSteps: ['校验 SKU 数量不超过 20 个', '明确是否排除变体', '确定自然词/广告词和筛选条件', '按接口上限自动读取全部分页', '合并并去重关键词', '输出来源、SKU 和查询条件'],
    outputFormat: '表格输出：关键词 / 中文释义 / 渠道 / 自然或广告排名 / 曝光 / 转化 / 搜索量 / 增长。',
    entryPoints: ['商品详情', '标题优化', '广告分析'],
  }),
];

export const externalOzonSkillIds = externalOzonSkillItems.map((item) => item.id);

export const externalOzonSkillProfiles = Object.fromEntries(
  externalOzonSkillItems.map((item) => [item.id, item.skillProfile])
);

export const externalOzonRuntimeProfiles = Object.fromEntries(
  externalOzonSkillItems.map((item) => [item.id, item.runtimeProfile])
);

export const externalOzonPromptTemplates = Object.fromEntries(
  externalOzonSkillItems.map((item) => [item.id, item.promptTemplate])
);

export const externalOzonSkillSetupRules = Object.fromEntries(
  externalOzonSkillItems.map((item) => [
    item.id,
    {
      needed: 'thirdParty',
      missingText: 'Seerfar Open API 账号或 API Key',
      settingsModule: 'platformApi',
      integrationTypes: ['seerfar-open-api'],
      readyLabel: '能查',
      readyTone: 'success',
    },
  ])
);
