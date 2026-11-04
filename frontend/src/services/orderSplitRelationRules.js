function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function toPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function firstFilled(...values) {
  for (const value of values) {
    const text = normalizeText(value);
    if (text && !['0', '\u672a\u8fd4\u56de', 'null', 'undefined', 'nan'].includes(text.toLowerCase())) return text;
  }
  return '';
}

function getOrderPostingNumber(order = {}) {
  const source = toPlainObject(order);
  return firstFilled(source.posting_number, source.postingNumber, source.posting, source.salesOrder, source.id);
}

function getOrderSplitRole(order = {}) {
  const source = toPlainObject(order);
  const relation = getOrderSplitRelation(source);
  const role = normalizeText(source.splitRole || source.split_role || relation?.role).toLowerCase();
  if (role === 'parent' || role === 'child') return role;
  if (source.isSplitParent === true || source.splitParent === true) return 'parent';
  if (source.isSplitChild === true || source.splitChild === true) return 'child';
  return '';
}

export function getOrderSplitRelation(order = {}) {
  const source = toPlainObject(order);
  const raw = toPlainObject(source.raw);
  const relation = source.splitRelation || source.split_relation || raw.splitRelation || raw.split_relation;
  return relation && typeof relation === 'object' ? relation : null;
}

export function isSplitParentOrder(order = {}) {
  return getOrderSplitRole(order) === 'parent';
}

export function isSplitChildOrder(order = {}) {
  return getOrderSplitRole(order) === 'child';
}

export function isSplitParentBusinessLocked(order = {}) {
  const source = toPlainObject(order);
  if (!isSplitParentOrder(source)) return false;
  if (source.splitBusinessLocked === false || source.split_business_locked === false) return false;
  const relation = getOrderSplitRelation(source);
  if (relation?.parentOzonVisible === true) return false;
  return true;
}

export function getSplitOrderLockReason(order = {}) {
  const source = toPlainObject(order);
  if (!isSplitParentBusinessLocked(source)) return '';
  const relation = getOrderSplitRelation(source);
  const direct = normalizeText(source.splitLockReason || source.split_lock_reason);
  if (direct) return direct;
  const status = normalizeText(source.splitReadbackStatus || source.split_readback_status || relation?.readbackStatus).toLowerCase();
  if (status === 'merged') return '\u8be5\u8ba2\u5355\u5df2\u62c6\u5355\uff0c\u6bcd\u5355\u4ec5\u6309 Ozon \u5f53\u524d\u663e\u793a\u53ea\u8bfb\u4fdd\u7559\u3002';
  if (status === 'partial') return '\u62c6\u5355\u5df2\u63d0\u4ea4 Ozon\uff0c\u4f46\u56de\u8bfb\u7ed3\u679c\u4e0d\u5b8c\u6574\uff0c\u9700\u8981\u91cd\u65b0\u5237\u65b0\u786e\u8ba4\u3002';
  if (status === 'mismatch') return '\u62c6\u5355\u56de\u8bfb\u4e0e\u63d0\u4ea4\u6570\u91cf\u4e0d\u4e00\u81f4\uff0c\u9700\u8981\u91cd\u65b0\u5bf9\u8d26\u3002';
  return '\u62c6\u5355\u5df2\u63d0\u4ea4 Ozon\uff0c\u7b49\u5f85\u56de\u8bfb\u786e\u8ba4\u3002';
}

export function doesSplitOrderMatchKeyword(order = {}, keyword = '') {
  const source = toPlainObject(order);
  const needle = normalizeText(keyword).toLowerCase();
  if (!needle) return false;
  const relation = getOrderSplitRelation(source);
  const haystack = [
    getOrderPostingNumber(source),
    source.order_id,
    source.orderId,
    source.splitParentPostingNumber,
    relation?.parentPostingNumber,
    ...(Array.isArray(source.splitChildPostingNumbers) ? source.splitChildPostingNumbers : []),
    ...(Array.isArray(relation?.childPostingNumbers) ? relation.childPostingNumbers : []),
  ]
    .map((item) => normalizeText(item).toLowerCase())
    .filter(Boolean);
  return haystack.some((item) => item.includes(needle));
}

export function shouldShowOrderInOzonDisplayList(order = {}, options = {}) {
  const source = toPlainObject(order);
  const safeOptions = toPlainObject(options);
  if (!isSplitParentOrder(source)) return true;
  if (source.splitDefaultBusinessHidden !== true && source.split_default_business_hidden !== true) return true;
  return doesSplitOrderMatchKeyword(source, safeOptions.keyword);
}

export function shouldIncludeOrderInBusinessFlow(order = {}, options = {}) {
  const source = toPlainObject(order);
  const safeOptions = toPlainObject(options);
  if (!isSplitParentBusinessLocked(source)) return true;
  if (safeOptions.allowSearchReveal === true && doesSplitOrderMatchKeyword(source, safeOptions.keyword)) return true;
  return false;
}

export function attachSplitRelationFields(target = {}, source = {}) {
  const safeTarget = toPlainObject(target);
  const safeSource = toPlainObject(source);
  const relation = getOrderSplitRelation(safeSource);
  if (!relation && !safeSource.splitRole && !safeSource.isSplitParent && !safeSource.isSplitChild) return safeTarget;
  const splitRole = safeSource.splitRole || safeSource.split_role || '';
  const hasExplicitBusinessLock =
    typeof safeSource.splitBusinessLocked === 'boolean' || typeof safeSource.split_business_locked === 'boolean';
  const splitBusinessLocked = hasExplicitBusinessLock
    ? safeSource.splitBusinessLocked === true || safeSource.split_business_locked === true
    : (splitRole === 'parent' || safeSource.isSplitParent === true) && relation?.parentOzonVisible !== true;
  return {
    ...safeTarget,
    splitRelation: relation,
    splitRole,
    isSplitParent: safeSource.isSplitParent === true || splitRole === 'parent',
    isSplitChild: safeSource.isSplitChild === true || splitRole === 'child',
    splitParentPostingNumber:
      safeSource.splitParentPostingNumber || safeSource.split_parent_posting_number || relation?.parentPostingNumber || '',
    splitChildPostingNumbers:
      safeSource.splitChildPostingNumbers || safeSource.split_child_posting_numbers || relation?.childPostingNumbers || [],
    splitReadbackStatus: safeSource.splitReadbackStatus || safeSource.split_readback_status || relation?.readbackStatus || '',
    splitBusinessLocked,
    splitLockReason: safeSource.splitLockReason || safeSource.split_lock_reason || '',
    splitDefaultBusinessHidden:
      safeSource.splitDefaultBusinessHidden === true || safeSource.split_default_business_hidden === true,
    splitOzonDisplayStatus: safeSource.splitOzonDisplayStatus || safeSource.split_ozon_display_status || '',
  };
}
