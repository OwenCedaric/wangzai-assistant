export const emptyMarketingSummary = {
  activityTotal: 0,
  joinedActivityTotal: 0,
  joinedProductTotal: 0,
  issueProductTotal: 0,
};

export const MARKETING_ACTIVITY_CACHE_ACTIVITY_FIELDS = [
  'id',
  'title',
  'originalTitle',
  'source',
  'sourceTone',
  'count',
  'description',
  'available',
  'hasAvailableCount',
  'estimate',
  'dateStart',
  'dateEnd',
  'isOnline',
  'sourceType',
];

export function filterMarketingProductsByScope(products = [], scope = 'all') {
  if (scope === 'joined') return products.filter((product) => product.status === '已添加');
  if (scope === 'available') return products.filter((product) => product.status === '可添加');
  return products;
}

export function countJoinedMarketingActivities(activities = []) {
  const joinedActivityIds = new Set();

  (Array.isArray(activities) ? activities : []).forEach((activity, index) => {
    if ((Number(activity?.count) || 0) <= 0) return;
    const activityId = String(activity?.id || activity?.activityId || activity?.title || index).trim();
    const sourceType = String(activity?.sourceType || 'official').trim().toLowerCase() || 'official';
    const activityKey = `${activityId}::${sourceType}`;
    if (activityKey) joinedActivityIds.add(activityKey);
  });

  return joinedActivityIds.size;
}
