// Renderer L0 projection only.  The canonical category catalog lives in the
// profile SQLite database and is read through local-api.  This module must not
// import the packaged JSON seed or persist its projection in browser storage.

const CATEGORY_PATH_SEPARATOR = ' > ';

let ozonCategoryIndex = {
  categoryById: new Map(),
  typeById: new Map(),
  searchEntries: [],
};

function normalizeId(value) {
  if (value === undefined || value === null || value === '') return '';
  return String(value).trim();
}

function normalizeTitle(node = {}) {
  return String(node.title || node.name || node.categoryName || node.typeName || '').trim();
}

function normalizeCacheNode(node = {}) {
  const categoryId = normalizeId(node.categoryId ?? node.category_id ?? node.descriptionCategoryId);
  const typeId = normalizeId(node.typeId ?? node.type_id);
  return {
    nodeKind: node.nodeKind === 'type' || typeId ? 'type' : 'category',
    categoryId,
    typeId,
    parentCategoryId: normalizeId(node.parentCategoryId ?? node.parent_category_id),
    title: normalizeTitle(node),
    isDisabled: Boolean(node.isDisabled ?? node.is_disabled ?? node.disabled),
  };
}

function normalizeSearchText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u200b\u200c\u200d]/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function compactSearchText(value) {
  return normalizeSearchText(value).replace(/\s+/gu, '');
}

function categoryMatchDetails(entry, queryText) {
  const query = compactSearchText(queryText);
  const title = entry.searchTitle;
  if (!query || !title) return { score: 0, matchKind: '' };
  const typeBonus = entry.nodeKind === 'type' ? 80 : 0;
  const depthBonus = Math.min(20, entry.path.length * 4);
  if (query === title) {
    return { score: 10_000 + typeBonus + depthBonus + title.length, matchKind: 'exact' };
  }
  if (query.includes(title)) {
    return { score: 7_000 + typeBonus + depthBonus + title.length * 8, matchKind: 'query-contains-title' };
  }
  if (title.includes(query) && query.length >= 2) {
    return {
      score: 4_000 + typeBonus + depthBonus + query.length * 6 - (title.length - query.length),
      matchKind: 'title-contains-query',
    };
  }
  return { score: 0, matchKind: '' };
}

export const ozonCategoryTreeMeta = {
  source: 'local-api-shared-catalog',
  language: 'DEFAULT',
  fetchedAt: null,
  rootCount: 0,
  nodeCount: 0,
  hydrated: false,
};

export function hydrateOzonCategoryIndexFromCacheNodes(nodes = [], meta = {}) {
  const normalized = (Array.isArray(nodes) ? nodes : [])
    .map(normalizeCacheNode)
    .filter((node) => node.title && (node.categoryId || node.typeId));
  const rawCategoryById = new Map();
  const rawTypeById = new Map();

  for (const node of normalized) {
    if (node.nodeKind === 'category' && node.categoryId && !rawCategoryById.has(node.categoryId)) {
      rawCategoryById.set(node.categoryId, node);
    }
    if (node.typeId && !rawTypeById.has(node.typeId)) rawTypeById.set(node.typeId, node);
  }

  function buildPath(node, seen = new Set()) {
    if (!node) return [];
    const key = node.typeId ? `type:${node.typeId}` : `category:${node.categoryId}`;
    if (seen.has(key)) return [node.title];
    seen.add(key);
    const parent = node.parentCategoryId ? rawCategoryById.get(node.parentCategoryId) : null;
    return [...buildPath(parent, seen), node.title].filter(Boolean);
  }

  const categoryById = new Map();
  for (const [categoryId, node] of rawCategoryById) {
    const path = buildPath(node);
    categoryById.set(categoryId, {
      descriptionCategoryId: categoryId,
      name: node.title,
      path,
      pathText: path.join(CATEGORY_PATH_SEPARATOR),
    });
  }
  const typeById = new Map();
  for (const [typeId, node] of rawTypeById) {
    const path = buildPath(node);
    typeById.set(typeId, {
      typeId,
      descriptionCategoryId: node.categoryId,
      name: node.title,
      path,
      pathText: path.join(CATEGORY_PATH_SEPARATOR),
    });
  }

  const searchEntries = [
    ...[...categoryById.values()].map((item) => ({
      nodeKind: 'category',
      id: item.descriptionCategoryId,
      descriptionCategoryId: item.descriptionCategoryId,
      typeId: '',
      name: item.name,
      path: item.path,
      pathText: item.pathText,
      searchTitle: compactSearchText(item.name),
    })),
    ...[...typeById.values()].map((item) => ({
      nodeKind: 'type',
      id: item.typeId,
      descriptionCategoryId: item.descriptionCategoryId,
      typeId: item.typeId,
      name: item.name,
      path: item.path,
      pathText: item.pathText,
      searchTitle: compactSearchText(item.name),
    })),
  ].filter((entry) => entry.searchTitle);

  ozonCategoryIndex = { categoryById, typeById, searchEntries };
  ozonCategoryTreeMeta.source = 'local-api-shared-catalog';
  ozonCategoryTreeMeta.language = String(meta.locale || meta.language || 'DEFAULT');
  ozonCategoryTreeMeta.fetchedAt = meta.fetchedAt || meta.updatedAt || null;
  ozonCategoryTreeMeta.rootCount = normalized.filter((node) => !node.parentCategoryId).length;
  ozonCategoryTreeMeta.nodeCount = normalized.length;
  ozonCategoryTreeMeta.hydrated = true;
  return ozonCategoryIndex;
}

export function resetOzonCategoryIndexProjection() {
  ozonCategoryIndex = { categoryById: new Map(), typeById: new Map(), searchEntries: [] };
  ozonCategoryTreeMeta.fetchedAt = null;
  ozonCategoryTreeMeta.rootCount = 0;
  ozonCategoryTreeMeta.nodeCount = 0;
  ozonCategoryTreeMeta.hydrated = false;
}

export function isOzonCategoryIndexHydrated() {
  return ozonCategoryTreeMeta.hydrated && ozonCategoryIndex.searchEntries.length > 0;
}

export function findOzonCategoryMatchesByTitle(value, { limit = 8, typesOnly = false } = {}) {
  const query = compactSearchText(value);
  if (!query) return [];
  const boundedLimit = Math.max(1, Math.min(50, Number(limit) || 8));
  return ozonCategoryIndex.searchEntries
    .filter((entry) => !typesOnly || entry.nodeKind === 'type')
    .map((entry) => ({ ...entry, ...categoryMatchDetails(entry, query) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => (
      right.score - left.score
      || right.searchTitle.length - left.searchTitle.length
      || left.pathText.localeCompare(right.pathText, 'zh-CN')
    ))
    .slice(0, boundedLimit)
    .map(({ searchTitle: _searchTitle, ...entry }) => entry);
}

export function getOzonCategoryPathByIds({ typeId, descriptionCategoryId } = {}) {
  const typeKey = normalizeId(typeId);
  if (typeKey) {
    const typeMatch = ozonCategoryIndex.typeById.get(typeKey);
    if (typeMatch?.pathText) return typeMatch.pathText;
  }

  const categoryKey = normalizeId(descriptionCategoryId);
  if (categoryKey) {
    const categoryMatch = ozonCategoryIndex.categoryById.get(categoryKey);
    if (categoryMatch?.pathText) return categoryMatch.pathText;
  }

  return '';
}
