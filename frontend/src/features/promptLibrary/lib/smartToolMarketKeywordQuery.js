const RANGE_FIELDS = Object.freeze([
  { field: 'searchVolume', labels: ['搜索量', '月搜热度', '热度', 'searchvolume'] },
  { field: 'searchChange30', labels: ['搜索增长', '月搜增长', '30天增长', '增长', 'searchchange30'] },
  { field: 'monthlySales', labels: ['月销量', '销量', 'monthlysales'] },
  { field: 'monthlyRevenue', labels: ['月销售额', '销售额', 'monthlyrevenue'] },
  { field: 'price', labels: ['均价', '价格', 'price'] },
  { field: 'productViews', labels: ['商品浏览量', '浏览量', 'productviews'] },
  { field: 'products', labels: ['商品数', 'products'] },
  { field: 'volume', labels: ['体量', 'volume'] },
  { field: 'marketSpace', labels: ['市场空间', 'marketspace'] },
  { field: 'conversionSharing', labels: ['转化集中度', 'conversionsharing'] },
  { field: 'reviews', labels: ['评论数', 'reviews'] },
  { field: 'ratings', labels: ['评分', 'ratings'] },
  { field: 'sellers', labels: ['卖家数', 'sellers'] },
  { field: 'weight', labels: ['权重', 'weight'] },
]);

const SORT_FIELDS = Object.freeze([
  { field: 'searchVolume', labels: ['搜索量', '月搜热度', '热度', 'searchvolume'] },
  { field: 'count30GrowthRate', labels: ['月搜增长', '搜索增长', '30天增长', '增长', 'count30growthrate'] },
  { field: 'avgPrice', labels: ['均价', '价格', 'avgprice'] },
  { field: 'sales', labels: ['销量', 'sales'] },
  { field: 'revenue', labels: ['销售额', 'revenue'] },
  { field: 'productCount', labels: ['商品数', 'productcount'] },
  { field: 'sellers', labels: ['卖家数', 'sellers'] },
  { field: 'competingProducts', labels: ['竞品数', 'competingproducts'] },
  { field: 'reviews', labels: ['评论数', 'reviews'] },
  { field: 'ratings', labels: ['评分', 'ratings'] },
  { field: 'marketSpace', labels: ['市场空间', 'marketspace'] },
  { field: 'itemsViews', labels: ['商品可见度', '可见度', 'itemsviews'] },
  { field: 'conversionSharing', labels: ['转化集中度', 'conversionsharing'] },
  { field: 'returnCancellationRate', labels: ['退货取消率', 'returncancellationrate'] },
  { field: 'weight', labels: ['权重', 'weight'] },
  { field: 'volume', labels: ['体量', 'volume'] },
]);

function text(value) {
  return String(value ?? '').trim();
}

function normalizedLabel(value) {
  return text(value).normalize('NFKC').toLocaleLowerCase().replace(/[\s_-]/gu, '');
}

function findField(definitions, label) {
  const normalized = normalizedLabel(label);
  return definitions.find((item) => item.labels.some((alias) => normalizedLabel(alias) === normalized))?.field || '';
}

function numberValue(value) {
  const normalized = text(value).replace(/[,，\s]/gu, '');
  if (!/^-?\d+(?:\.\d+)?$/u.test(normalized)) return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function parseRangeValue(rawValue, comparator = '') {
  const normalizedComparator = comparator === '≥' ? '>=' : comparator === '≤' ? '<=' : comparator;
  const raw = text(rawValue);
  const between = raw.match(/^(-?\d+(?:\.\d+)?)\s*(?:~|～|至|到|—|–)\s*(-?\d+(?:\.\d+)?)$/u);
  if (between) {
    const left = numberValue(between[1]);
    const right = numberValue(between[2]);
    if (left === null || right === null) return null;
    return { min: Math.min(left, right), max: Math.max(left, right) };
  }
  const value = numberValue(raw);
  if (value === null) return null;
  if (normalizedComparator === '>=' || normalizedComparator === '>') return { min: value };
  if (normalizedComparator === '<=' || normalizedComparator === '<') return { max: value };
  return { min: value, max: value };
}

function parsePlatformFilter(value) {
  const normalized = normalizedLabel(value);
  if (!normalized || ['全部', 'all', '不限'].includes(normalized)) return [];
  const result = [];
  if (/ozon|0/u.test(normalized)) result.push(0);
  if (/wildberries|wildberry|wb|1/u.test(normalized)) result.push(1);
  return [...new Set(result)];
}

function presetFor(value) {
  const normalized = normalizedLabel(value);
  if (['热门词', '热词', '热门'].includes(normalized)) {
    return { order: { field: 'searchVolume', direction: 'DESC' } };
  }
  if (['上升词', '增长词', '趋势词'].includes(normalized)) {
    return { order: { field: 'count30GrowthRate', direction: 'DESC' } };
  }
  if (['低竞争词', '低竞争'].includes(normalized)) {
    return { order: { field: 'sellers', direction: 'ASC' } };
  }
  if (['蓝海词', '蓝海'].includes(normalized)) {
    return {
      order: { field: 'searchVolume', direction: 'DESC' },
      ranges: { searchVolume: { min: 10000 }, sellers: { max: 50 } },
    };
  }
  return null;
}

export function parseSmartToolMarketKeywordItems(items = []) {
  const keywords = [];
  const categories = [];
  const ranges = {};
  let searchDate = '';
  let matchType = 1;
  let platformFilter = [];
  let order = { field: 'searchVolume', direction: 'DESC' };

  (Array.isArray(items) ? items : []).map(text).filter(Boolean).forEach((item) => {
    const preset = presetFor(item);
    if (preset) {
      order = preset.order || order;
      Object.assign(ranges, preset.ranges || {});
      return;
    }

    const directive = item.match(/^([^:：<>=≤≥]+?)\s*(?:(>=|<=|>|<|=|≥|≤)|[:：])\s*(.+)$/u);
    if (!directive) {
      keywords.push(item);
      return;
    }
    const [, rawLabel, comparator = '', rawValue] = directive;
    const label = normalizedLabel(rawLabel);
    if (['日期', '查询日期', '数据日期', 'searchdate'].includes(label)) {
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(text(rawValue))) {
        throw new Error('市场热词查询日期请填写 YYYY-MM-DD，例如 2026-04-01。');
      }
      searchDate = text(rawValue);
      return;
    }
    if (['类目', '类目id', 'category', 'categories'].includes(label)) {
      const categoryId = text(rawValue);
      if (!/^\d+(?:_\d+)*$/u.test(categoryId)) throw new Error(`市场热词类目 ID 不正确：${categoryId}`);
      categories.push(categoryId);
      return;
    }
    if (['匹配', '匹配方式', 'matchtype'].includes(label)) {
      const mode = normalizedLabel(rawValue);
      if (['精准', '精确', '0', 'exact'].includes(mode)) matchType = 0;
      else if (['模糊', '1', 'fuzzy'].includes(mode)) matchType = 1;
      else throw new Error('市场热词匹配方式只能填写“精准”或“模糊”。');
      return;
    }
    if (['平台', 'platform'].includes(label)) {
      platformFilter = parsePlatformFilter(rawValue);
      return;
    }
    if (['排序', '排序方式', 'order', 'sort'].includes(label)) {
      const direction = /升序|asc/iu.test(rawValue) ? 'ASC' : 'DESC';
      const sortLabel = text(rawValue).replace(/升序|降序|asc|desc/giu, '').trim();
      const field = findField(SORT_FIELDS, sortLabel);
      if (!field) throw new Error(`市场热词不支持按“${sortLabel}”排序。`);
      order = { field, direction };
      return;
    }
    const rangeField = findField(RANGE_FIELDS, rawLabel);
    if (rangeField) {
      const range = parseRangeValue(rawValue, comparator);
      if (!range) throw new Error(`市场热词筛选值不正确：${item}`);
      ranges[rangeField] = range;
      return;
    }
    keywords.push(item);
  });

  return {
    keywords: [...new Set(keywords)],
    categories: [...new Set(categories)],
    ranges,
    searchDate,
    matchType,
    platformFilter,
    order,
  };
}

export function marketKeywordPlatformMatches(record = {}, platformFilter = []) {
  const platforms = Array.isArray(platformFilter) ? platformFilter.map(Number) : [];
  if (!platforms.length) return true;
  return platforms.includes(Number(record?.platform));
}
