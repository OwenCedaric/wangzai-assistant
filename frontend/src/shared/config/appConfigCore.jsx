export const defaultOzonShops = [
  {
    id: 'ozon-shop-1',
    shopAlias: 'Ozon 1店',
    sellerName: '旺崽 Ozon 店铺',
    clientId: '',
    apiKey: '',
    connectionStatus: '未测试',
    connectionMessage: '填写 Client ID 和 API Key 后可以测试连接',
    connectionDetail: '',
    lastTestAt: '',
    savedAt: '',
    purchaseManagementStartedAt: '',
    purchaseManagementResetAt: '',
    remark: '',
  },
];

export const OZON_READ_TIMEOUT_MS = 12000;

export const OZON_WRITE_TIMEOUT_MS = 20000;

export const OZON_ORDER_SNAPSHOT_CACHE_TTL_MS = 2 * 60 * 1000;

export const OZON_ORDER_DEFAULT_RANGE_DAYS = 90;

export const OZON_INITIAL_ORDER_QUICK_RANGE_DAYS = OZON_ORDER_DEFAULT_RANGE_DAYS;

export const OZON_AFTER_SALES_DEFAULT_RANGE_DAYS = OZON_ORDER_DEFAULT_RANGE_DAYS;

export const OZON_ORDER_PAGE_LIMIT = 100;

export const OZON_ORDER_FALLBACK_PAGE_LIMIT = 20;

export const OZON_ORDER_PAGINATION_SAFETY_MAX_PAGES = 1000;

export const PROFIT_ORDER_DEFAULT_RANGE_DAYS = 90;

export const OZON_ORDER_DETAIL_CONCURRENCY = 8;

export const OZON_PRODUCT_IMAGE_CHUNK_CONCURRENCY = 4;

export const OZON_AFTER_SALES_DETAIL_CONCURRENCY = 8;

export const OZON_LABEL_MAX_POLLS = 8;

export const OZON_LABEL_POLL_DELAY_MS = 1200;

export const OZON_LABEL_CREATE_MAX_ATTEMPTS = 2;

export const OZON_FINANCE_CHUNK_DAYS = 30;

export const OZON_FINANCE_POSTING_CONCURRENCY = 3;

export const PROFIT_PAGE_INTERNAL_REFRESH_TTL_MS = 30 * 60 * 1000;

export const GUOO_REALFBS_ROUTES = [
  {
    id: 'guoo-express-extra-small',
    label: 'GUOO 特快超级轻小件',
    productType: '超级轻小件',
    transport: '空运',
    aliases: ['GUOO Express Extra Small', '特快超级轻小件', '超级轻小件', '空运'],
    kgFee: 46.8,
    ticketFee: 3.12,
    maxWeightKg: 0.5,
    minValueRub: 1,
    maxValueRub: 1500,
    maxDimensionSumCm: 90,
    maxLongestCm: 60,
    maxMiddleCm: 60,
    maxShortestCm: 60,
  },
  {
    id: 'guoo-standard-extra-small',
    label: 'GUOO 标准超级轻小件',
    productType: '超级轻小件',
    transport: '陆空联运',
    aliases: ['GUOO Standard Extra Small', '标准超级轻小件', '超级轻小件', '陆空联运'],
    kgFee: 36.4,
    ticketFee: 3.12,
    maxWeightKg: 0.5,
    minValueRub: 1,
    maxValueRub: 1500,
    maxDimensionSumCm: 90,
    maxLongestCm: 60,
    maxMiddleCm: 60,
    maxShortestCm: 60,
  },
  {
    id: 'guoo-economy-extra-small',
    label: 'GUOO 经济超级轻小件',
    productType: '超级轻小件',
    transport: '陆运',
    aliases: ['GUOO Economy Extra Small', '经济超级轻小件', '超级轻小件', '陆运'],
    kgFee: 26,
    ticketFee: 3,
    maxWeightKg: 0.5,
    minValueRub: 1,
    maxValueRub: 1500,
    maxDimensionSumCm: 90,
    maxLongestCm: 60,
    maxMiddleCm: 60,
    maxShortestCm: 60,
  },
  {
    id: 'guoo-standard-budget',
    label: 'GUOO 标准低客单轻小件',
    productType: '低客单轻小件',
    transport: '陆空联运',
    aliases: ['GUOO Standard Budget', '标准低客单', '低客单轻小件', '陆空联运', 'Budget'],
    kgFee: 26,
    ticketFee: 23.92,
    minWeightKg: 0.5,
    maxWeightKg: 30,
    minValueRub: 1,
    maxValueRub: 1500,
    maxDimensionSumCm: 150,
    maxLongestCm: 60,
    maxMiddleCm: 60,
    maxShortestCm: 60,
  },
  {
    id: 'guoo-economy-budget',
    label: 'GUOO 经济低客单轻小件',
    productType: '低客单轻小件',
    transport: '陆运',
    aliases: ['GUOO Economy Budget', '经济低客单', '低客单轻小件', '陆运', 'Budget'],
    kgFee: 17.68,
    ticketFee: 23.92,
    minWeightKg: 0.5,
    maxWeightKg: 30,
    minValueRub: 1,
    maxValueRub: 1500,
    maxDimensionSumCm: 150,
    maxLongestCm: 60,
    maxMiddleCm: 60,
    maxShortestCm: 60,
  },
  {
    id: 'guoo-express-small',
    label: 'GUOO 特快轻小件',
    productType: '高客单轻小件',
    transport: '空运',
    aliases: ['GUOO Express Small', '特快轻小件', '高客单轻小件', '空运', 'Small'],
    kgFee: 46.8,
    ticketFee: 16.64,
    minWeightKg: 0.001,
    maxWeightKg: 2,
    minValueRub: 1501,
    maxValueRub: 7000,
    maxDimensionSumCm: 150,
    maxLongestCm: 60,
    maxMiddleCm: 60,
    maxShortestCm: 60,
  },
  {
    id: 'guoo-standard-small',
    label: 'GUOO 标准轻小件',
    productType: '高客单轻小件',
    transport: '陆空联运',
    aliases: ['GUOO Standard Small', '标准轻小件', '高客单轻小件', '陆空联运', 'Small'],
    kgFee: 36.4,
    ticketFee: 16.64,
    minWeightKg: 0.001,
    maxWeightKg: 2,
    minValueRub: 1501,
    maxValueRub: 7000,
    maxDimensionSumCm: 150,
    maxLongestCm: 60,
    maxMiddleCm: 60,
    maxShortestCm: 60,
  },
  {
    id: 'guoo-economy-small',
    label: 'GUOO 经济轻小件',
    productType: '高客单轻小件',
    transport: '陆运',
    aliases: ['GUOO Economy Small', '经济轻小件', '高客单轻小件', '陆运', 'Small'],
    kgFee: 26,
    ticketFee: 16.64,
    minWeightKg: 0.001,
    maxWeightKg: 2,
    minValueRub: 1501,
    maxValueRub: 7000,
    maxDimensionSumCm: 150,
    maxLongestCm: 60,
    maxMiddleCm: 60,
    maxShortestCm: 60,
  },
  {
    id: 'guoo-standard-big',
    label: 'GUOO 标准大件',
    productType: '大件',
    transport: '陆空联运',
    aliases: ['GUOO Standard Big', '标准大件', '大件', '陆空联运', 'Big'],
    kgFee: 26,
    ticketFee: 37.44,
    useVolumeWeight: true,
    minWeightKg: 2.001,
    maxWeightKg: 30,
    minValueRub: 1501,
    maxValueRub: 7000,
    maxDimensionSumCm: 250,
    maxLongestCm: 150,
    maxMiddleCm: 50,
    maxShortestCm: 50,
  },
  {
    id: 'guoo-economy-big',
    label: 'GUOO 经济大件',
    productType: '大件',
    transport: '陆运',
    aliases: ['GUOO Economy Big', '经济大件', '大件', '陆运', 'Big'],
    kgFee: 17.68,
    ticketFee: 37.44,
    useVolumeWeight: true,
    minWeightKg: 2.001,
    maxWeightKg: 30,
    minValueRub: 1501,
    maxValueRub: 7000,
    maxDimensionSumCm: 250,
    maxLongestCm: 150,
    maxMiddleCm: 50,
    maxShortestCm: 50,
  },
  {
    id: 'guoo-express-premium-small',
    label: 'GUOO 特快高客单轻小件',
    productType: '高客单轻小件',
    transport: '空运',
    aliases: ['GUOO Express Premium Small', '特快高客单', '高客单轻小件', '空运', 'Premium Small'],
    kgFee: 46.8,
    ticketFee: 22.88,
    minWeightKg: 0.001,
    maxWeightKg: 5,
    minValueRub: 7001,
    maxValueRub: 250000,
    maxDimensionSumCm: 250,
    maxLongestCm: 150,
    maxMiddleCm: 80,
    maxShortestCm: 80,
  },
  {
    id: 'guoo-standard-premium-small',
    label: 'GUOO 标准高客单轻小件',
    productType: '高客单轻小件',
    transport: '陆空联运',
    aliases: ['GUOO Standard Premium Small', '标准高客单', '高客单轻小件', '陆空联运', 'Premium Small'],
    kgFee: 36.4,
    ticketFee: 22.88,
    minWeightKg: 0.001,
    maxWeightKg: 5,
    minValueRub: 7001,
    maxValueRub: 250000,
    maxDimensionSumCm: 250,
    maxLongestCm: 150,
    maxMiddleCm: 80,
    maxShortestCm: 80,
  },
  {
    id: 'guoo-economy-premium-small',
    label: 'GUOO 经济高客单轻小件',
    productType: '高客单轻小件',
    transport: '陆运',
    aliases: ['GUOO Economy Premium Small', '经济高客单', '高客单轻小件', '陆运', 'Premium Small'],
    kgFee: 26,
    ticketFee: 22.88,
    minWeightKg: 0.001,
    maxWeightKg: 5,
    minValueRub: 7001,
    maxValueRub: 250000,
    maxDimensionSumCm: 250,
    maxLongestCm: 150,
    maxMiddleCm: 80,
    maxShortestCm: 80,
  },
  {
    id: 'guoo-standard-premium-big',
    label: 'GUOO 标准高客单大件',
    productType: '高客单大件',
    transport: '陆空联运',
    aliases: ['GUOO Standard Premium Big', '标准高客单大件', '高客单大件', '陆空联运', 'Premium Big'],
    kgFee: 29.12,
    ticketFee: 64.48,
    useVolumeWeight: true,
    minWeightKg: 5.001,
    maxWeightKg: 30,
    minValueRub: 7001,
    maxValueRub: 250000,
    maxDimensionSumCm: 310,
    maxLongestCm: 150,
    maxMiddleCm: 80,
    maxShortestCm: 80,
  },
  {
    id: 'guoo-economy-premium-big',
    label: 'GUOO 经济高客单大件',
    productType: '高客单大件',
    transport: '陆运',
    aliases: ['GUOO Economy Premium Big', '经济高客单大件', '高客单大件', '陆运', 'Premium Big'],
    kgFee: 23.92,
    ticketFee: 64.48,
    useVolumeWeight: true,
    minWeightKg: 5.001,
    maxWeightKg: 30,
    minValueRub: 7001,
    maxValueRub: 250000,
    maxDimensionSumCm: 310,
    maxLongestCm: 150,
    maxMiddleCm: 80,
    maxShortestCm: 80,
  },
  {
    id: 'china-post-epacket-economy-track',
    label: '哈尔滨E邮宝特惠',
    productType: '邮政E邮宝',
    transport: '陆运',
    aliases: ['China Post ePacket Economy Track', '哈尔滨E邮宝特惠', '邮政E邮宝', '陆运'],
    kgFee: 34.75,
    extraKgFee: 2.2,
    ticketFee: 15,
    minWeightKg: 0.001,
    maxWeightKg: 5,
  },
  {
    id: 'china-post-epacket-kazakhstan',
    label: 'Ozon哈萨克斯坦e邮宝',
    productType: '哈萨克斯坦',
    transport: '空运',
    aliases: ['China Post ePacket Kazakhstan', '哈萨克斯坦e邮宝', '哈萨克斯坦', '空运'],
    kgFee: 46.75,
    ticketFee: 1.7,
    minWeightKg: 0.001,
    maxWeightKg: 5,
  },
  {
    id: 'china-post-epacket-economy-kazakhstan',
    label: 'Ozon哈萨克斯坦e邮宝特惠',
    productType: '哈萨克斯坦',
    transport: '陆运',
    aliases: ['China Post ePacket Economy Track Kazakhstan', '哈萨克斯坦e邮宝特惠', '哈萨克斯坦', '陆运'],
    kgFee: 34,
    ticketFee: 1.7,
    minWeightKg: 0.001,
    maxWeightKg: 5,
  },
  {
    id: 'china-post-pudo-economy',
    label: 'China Post to PUDO Economy',
    productType: '超级轻小件',
    transport: '陆运',
    aliases: ['China Post to PUDO Economy', 'PUDO Economy', '超级轻小件', '陆运'],
    kgFee: 26,
    extraKgFee: 2.2,
    ticketFee: 1.9,
    minWeightKg: 0.001,
    maxWeightKg: 0.5,
  },
  {
    id: 'china-post-uzbekistan',
    label: '乌兹别克斯坦',
    productType: '乌兹别克斯坦',
    transport: '空运',
    aliases: ['乌兹别克斯坦', 'Uzbekistan', '空运'],
    kgFee: 108.81,
    extraKgFee: 2,
    ticketFee: 15.81,
    minWeightKg: 0.001,
    maxWeightKg: 2,
  },
  {
    id: 'china-post-armenia',
    label: '亚美尼亚',
    productType: '亚美尼亚',
    transport: '空运',
    aliases: ['China Post ARM Armenia', '亚美尼亚', 'Armenia', '空运'],
    kgFee: 143.22,
    extraKgFee: 2,
    ticketFee: 15.81,
    minWeightKg: 0.001,
    maxWeightKg: 2,
  },
  {
    id: 'china-post-azerbaijan',
    label: '阿塞拜疆',
    productType: '阿塞拜疆',
    transport: '空运',
    aliases: ['China Post ARM Azerbaijan', '阿塞拜疆', 'Azerbaijan', '空运'],
    kgFee: 113.46,
    extraKgFee: 2,
    ticketFee: 15.81,
    minWeightKg: 0.001,
    maxWeightKg: 5,
  },
  {
    id: 'china-post-georgia',
    label: '格鲁吉亚',
    productType: '格鲁吉亚',
    transport: '空运',
    aliases: ['格鲁吉亚', 'Georgia', '空运'],
    kgFee: 90.25,
    extraKgFee: 2,
    ticketFee: 16.15,
    minWeightKg: 0.001,
    maxWeightKg: 2,
  },
  {
    id: 'china-post-belarus-air',
    label: 'Ozon白俄EUB空运',
    productType: '白俄',
    transport: '空运',
    aliases: ['China Post ePacket Belarus', '白俄EUB空运', '白俄', '空运'],
    kgFee: 86,
    ticketFee: 18,
    minWeightKg: 0.001,
    maxWeightKg: 2,
  },
  {
    id: 'china-post-belarus-economy',
    label: 'Ozon白俄EUB陆运',
    productType: '白俄',
    transport: '陆运',
    aliases: ['China Post ePacket Economy Belarus', '白俄EUB陆运', '白俄', '陆运'],
    kgFee: 35,
    ticketFee: 18,
    minWeightKg: 0.001,
    maxWeightKg: 2,
  },
];

export const PROFIT_FINANCE_CACHE_VERSION = 'v5-rfbs-sale-commission-canonical';

export const PROFIT_FINANCE_CACHE_TTL_MS = 5 * 60 * 1000;

export const PROFIT_FINANCE_ROW_LOOKBACK_DAYS = 2;

export const PROFIT_FINANCE_ROW_LOOKAHEAD_DAYS = 14;

export const PROFIT_AFTER_SALES_CACHE_TTL_MS = 5 * 60 * 1000;

export const MARKETING_ACTIVITY_CACHE_STORAGE_KEY = ['wangzai', 'marketing', 'activity', 'cache', 'v1'].join('-');

export const SALES_SOURCE_LINK_STORAGE_KEY = ['wz', 'sales', 'source', 'links'].join('-');

export const PRODUCT_SOURCE_LINK_STORAGE_KEY = ['wz', 'product', 'source', 'links'].join('-');

export const PURCHASE_SOURCE_LINK_STORAGE_KEY = ['wz', 'purchase', 'source', 'links'].join('-');

export const PURCHASE_PLUGIN_SOURCE_CONTEXT_STORAGE_KEY = ['wz', 'purchase', 'source', 'plugin', 'context'].join('-');

export const PURCHASE_ORDER_LOCAL_OVERRIDE_STORAGE_KEY = ['wz', 'purchase', 'order', 'local', 'overrides'].join('-');

export const PURCHASE_PLUGIN_BRIDGE_BASE = globalThis.__WANGZAI_PURCHASE_BRIDGE_BASE_URL__ || 'http://127.0.0.1:3788';

export const LOCAL_DATA_API_BASE = '/local-data-api';

export const LOCAL_SALES_SOURCE_FILE_KEY = 'sales-source-links';

export const LOCAL_PRODUCT_SOURCE_FILE_KEY = 'product-source-links';

export const LOCAL_PURCHASE_SOURCE_FILE_KEY = 'purchase-source-links';

export const LOCAL_PURCHASE_PLUGIN_SOURCE_CONTEXT_FILE_KEY = 'purchase-source-plugin-context';

export const LOCAL_PURCHASE_ORDER_OVERRIDES_FILE_KEY = 'purchase-order-local-overrides';

export const LOCAL_CROSS_BORDER_ORDER_RECORDS_FILE_KEY = 'cross-border-bus-order-records';

export const LOCAL_OZON_DATA_LAYER_FILE_KEY = 'ozon-local-data-layer';

export const LOCAL_PROFIT_DATA_FILE_KEY = 'profit-local-cache';

export const LOCAL_AFTER_SALES_DISPLAY_SNAPSHOT_FILE_KEY = 'after-sales-display-snapshots';

export const LOCAL_MIRROR_READ_LOG_FILE_KEY = 'local-mirror-read-log';

export const LOCAL_MIRROR_RETRY_QUEUE_FILE_KEY = 'local-mirror-retry-queue';

export const LOCAL_OZON_SHOP_SETTINGS_FILE_KEY = 'ozon-shop-settings';

export const LOCAL_MARKETING_ACTIVITY_CACHE_FILE_KEY = 'marketing-activity-cache';

export const OZON_RFBS_COMMISSION_RATE_SOURCE = 'ozon:/v5/product/info/prices#commissions.sales_percent_rfbs';

export const SALES_ORDER_PAGE_SIZE_OPTIONS = [20, 30, 50, 100];

export const CROSS_BORDER_MAIN_ACCOUNT_ID = 'cross-border-main';

export const CROSS_BORDER_ORDER_PAGE_LIMIT = 100;

export const CROSS_BORDER_ORDER_PAGINATION_SAFETY_MAX_PAGES = 1000;

export const PURCHASE_BATCH_CROSS_BORDER_CONCURRENCY = 3;

export const PURCHASE_PLUGIN_CAPTURE_POLL_ACTIVE_MS = 1500;

export const PURCHASE_PLUGIN_CAPTURE_POLL_IDLE_MS = 8000;

export const SOURCE_LINK_LIMIT = 5;

export const OZON_PRODUCT_INFO_CHUNK_SIZE = 50;

export const PURCHASE_SOURCE_PLATFORMS = ['PDD', '1688', '淘宝', '天猫', 'Ozon买家'];

export const PURCHASE_SEARCH_PLUGIN_API_BASE =
  globalThis.__WANGZAI_PURCHASE_BRIDGE_BASE_URL__ || 'http://127.0.0.1:3788';

export const LOCAL_DATA_FILE_READ_CACHE_TTL_MS = 8_000;

export const localDataFileReadCache = new Map();

export const PURCHASE_SEARCH_PLATFORM_KEY = {
  PDD: 'pdd',
  1688: '1688',
  淘宝: 'taobao',
  天猫: 'tmall',
  Ozon买家: 'ozon-buyer',
  京东: 'jd',
  Wildberries: 'wildberries',
  Amazon: 'amazon',
  Temu: 'temu',
  AliExpress: 'aliexpress',
};

export const PURCHASE_SEARCH_PLATFORM_HOME_URL = {
  PDD: 'https://mobile.yangkeduo.com/',
  1688: 'https://www.1688.com/',
  淘宝: 'https://www.taobao.com/',
  天猫: 'https://www.tmall.com/',
  Ozon买家: 'https://www.ozon.ru/',
  京东: 'https://www.jd.com/',
  Wildberries: 'https://www.wildberries.ru/',
  Amazon: 'https://www.amazon.com/',
  Temu: 'https://www.temu.com/',
  AliExpress: 'https://www.aliexpress.com/',
};

// 淘宝/天猫识图需要先由本地 Bridge 校验图片，再打开当前官方识图地址。
// 不再让页面绕过 Bridge 直接拼接已失效的旧 imgfile 链接。
export const PURCHASE_DIRECT_IMAGE_SEARCH_PLATFORMS = new Set();

export const CROSS_BORDER_LEGACY_EMPTY_TEXT = new Set([
  '2311济南七号仓 / OZON GUOO',
  '【1.5元】只贴单(建议拆包检查，降低退货率)',
]);

export const WATERMARK_SAMPLE_IMAGE_SRC = '/assets/watermark-sample-25.png';

export const WATERMARK_DEFAULT_TEXT_COLOR = '#2a3547';

export const WATERMARK_IMAGE_SIZE_MIN = 6;

export const WATERMARK_IMAGE_SIZE_MAX = 50;

export const WATERMARK_TEXT_SIZE_MIN = 10;

export const WATERMARK_TEXT_SIZE_MAX = 72;

export const WATERMARK_TEXT_COLOR_OPTIONS = [
  '#2a3547',
  '#ffffff',
  '#111827',
  '#ef4444',
  '#f59e0b',
  '#22c55e',
  '#5d87ff',
  '#8b5cf6',
];

export const defaultWatermarkTemplates = [
  {
    id: 'watermark-main-default',
    name: '主图默认水印',
    scope: 'main',
    text: 'SUPERBAISS',
    imageName: '',
    imageDataUrl: '',
    opacity: 72,
    imageSize: 18,
    imageX: 82,
    imageY: 76,
    textX: 32,
    textY: 78,
    textWidth: 42,
    textSize: 32,
    textColor: WATERMARK_DEFAULT_TEXT_COLOR,
    wrapText: true,
    savedAt: '',
  },
  {
    id: 'watermark-promo-corner',
    name: '促销角标水印',
    scope: 'main',
    text: 'СКИДКА',
    imageName: '',
    imageDataUrl: '',
    opacity: 64,
    imageSize: 16,
    imageX: 82,
    imageY: 76,
    textX: 32,
    textY: 78,
    textWidth: 38,
    textSize: 30,
    textColor: '#ef4444',
    wrapText: false,
    savedAt: '',
  },
  {
    id: 'watermark-detail-bottom',
    name: '详情页底部水印',
    scope: 'detail',
    text: 'SUPERBAISS OFFICIAL',
    imageName: '',
    imageDataUrl: '',
    opacity: 58,
    imageSize: 14,
    imageX: 82,
    imageY: 76,
    textX: 32,
    textY: 78,
    textWidth: 54,
    textSize: 28,
    textColor: WATERMARK_DEFAULT_TEXT_COLOR,
    wrapText: true,
    savedAt: '',
  },
];

export const ozonShopApiChecks = [
  {
    endpoint: 'POST /v1/roles',
    title: 'API Key 权限',
    usage: '测试连接时先确认 API Key 是否有效、有什么权限',
    risk: '只读查询',
  },
  {
    endpoint: 'POST /v1/seller/info',
    title: '店铺基础信息',
    usage: '确认已连接到对应 Ozon 卖家账号',
    risk: '只读查询',
  },
  {
    endpoint: 'POST /v1/seller/ozon-logistics/info',
    title: 'Ozon 配送接入',
    usage: '后续需要展示配送接入状态时再读取',
    risk: '只读查询',
  },
];

export const settingsModuleTabs = [
  { id: 'ozon', label: 'Ozon 店铺', caption: '店铺 / 密钥' },
  { id: 'crossBorderBus', label: '跨境巴士', caption: '物流授权' },
  { id: 'purchaseAccount', label: '拍单账号', caption: '采购账号' },
  { id: 'modelApi', label: '模型接口', caption: 'AI Key' },
  { id: 'wechatAssistant', label: '微信助理', caption: '小龙虾配置' },
  { id: 'watermark', label: '水印工具', caption: '图片模板' },
  { id: 'feeSetting', label: '费用设定', caption: '利润口径' },
  { id: 'dataMaintenance', label: '数据维护', caption: '归属 / 清理', hidden: true },
  { id: 'platformApi', label: '外部接口', caption: '统一接入' },
];

export const visibleSettingsModuleTabs = settingsModuleTabs.filter((module) => module.hidden !== true);

export const settingsModulePanels = {
  crossBorderBus: {
    title: '跨境巴士',
    description: '管理跨境巴士账号、Token、默认仓库和物流线路，后续发货前会从这里读取配置。',
    status: '本地草稿',
    items: [
      { title: '授权信息', text: '保存跨境巴士账号、Token、授权备注。', tag: '账号' },
      { title: '仓库与线路', text: '维护默认仓库、可用线路和物流偏好。', tag: '物流' },
      { title: '接口测试', text: '后续只读校验 Token 是否可用，不改订单。', tag: '只读' },
    ],
    actions: ['新增授权', '测试 Token', '查看线路'],
  },
  purchaseAccount: {
    title: '拍单账号',
    description: '集中维护采购平台账号与收货资料，给后续内置拍单流程选择使用。',
    status: '待配置',
    items: [
      { title: '平台账号', text: '固定选择拼多多、天猫、淘宝、1688 或 Ozon 买家，并自动匹配账号简称。', tag: '平台' },
      { title: '默认账号', text: '设置常用拍单账号，减少后续重复选择。', tag: '默认' },
      { title: '收货资料', text: '保存收件人昵称、手机号和完整收货地址。', tag: '收货' },
    ],
    actions: ['添加账号', '设为默认', '检查状态'],
  },
  modelApi: {
    title: '模型接口',
    description: '填写接口地址和 API Key，后台自动识别模型与多模态能力。',
    status: '自动识别',
    items: [
      { title: '接口凭证', text: '只填写接口地址和 API Key。', tag: '接口' },
      { title: '自动识别', text: '后台自动寻找 API 地址、模型和接口能力。', tag: '识别' },
      { title: '使用选择', text: '在实际使用页固定选择或多模型随机。', tag: '多模态' },
    ],
    actions: ['添加中转站', '保存并自动识别', '选择模型'],
  },
  platformApi: {
    title: '外部接口',
    description: '统一登记外部数据服务与平台接口，固定规则自动带出，凭证只允许由 local-api 加密保存。',
    status: '统一接入',
    items: [
      { title: '市场数据', text: 'Seerfar 和 LinkFox 数据接口。', tag: '数据' },
      { title: '平台官方接口', text: 'Ozon Seller 与 Performance API。', tag: 'Ozon' },
      { title: '服务端保护', text: '密钥不进入前端缓存，连接测试统一经过 local-api。', tag: '安全' },
    ],
    actions: ['添加接口', '保存资料', '打开日志'],
  },
};
