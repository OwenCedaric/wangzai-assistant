const SEERFAR_CATEGORY_TREE_URL =
  'https://seerfar-cn.tos-accelerate.volces.com/public/prod/categoryTree.txt';
const DEFAULT_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

function text(value) {
  return String(value ?? '').trim();
}

function appendPath(path, label) {
  if (!label || path[path.length - 1] === label) return path;
  return [...path, label];
}

export function normalizeSeerfarCategoryTree(payload = {}) {
  const roots = Array.isArray(payload?.oz) ? payload.oz : [];
  const nodes = [];
  const walk = (items, inheritedPath = []) => {
    for (const item of Array.isArray(items) ? items : []) {
      const id = text(item?.id);
      const cnTitle = text(item?.cnTitle);
      const title = text(item?.title);
      if (!id || (!cnTitle && !title)) continue;
      const path = appendPath(inheritedPath, cnTitle || title);
      const children = Array.isArray(item?.children) ? item.children : [];
      nodes.push({
        id,
        parentId: text(item?.pid),
        level: Number.isFinite(Number(item?.level)) ? Number(item.level) : path.length,
        cnTitle,
        title,
        enTitle: text(item?.enTitle),
        pathText: path.join(' / '),
        disabled: item?.disabled === true,
        hasChildren: children.length > 0,
      });
      walk(children, path);
    }
  };
  walk(roots);
  return nodes;
}

async function readResponseJson(response) {
  if (typeof response?.text === 'function') {
    const raw = await response.text();
    return JSON.parse(raw);
  }
  if (typeof response?.json === 'function') return response.json();
  throw new Error('Seerfar 类目服务未返回可读数据。');
}

export function createSeerfarCategoryTreeService({
  fetchImpl = fetch,
  sourceUrl = SEERFAR_CATEGORY_TREE_URL,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  now = () => Date.now(),
} = {}) {
  let cached = null;
  let pending = null;

  async function fetchTree() {
    const response = await fetchImpl(sourceUrl, {
      method: 'GET',
      headers: { Accept: 'application/json, text/plain;q=0.9' },
      signal: AbortSignal.timeout(30000),
    });
    if (!response?.ok) {
      throw new Error(`Seerfar 类目服务返回 HTTP ${response?.status || 502}。`);
    }
    const payload = await readResponseJson(response);
    const nodes = normalizeSeerfarCategoryTree(payload).filter((node) => !node.disabled);
    if (!nodes.length) throw new Error('Seerfar 类目树为空。');
    cached = {
      ok: true,
      source: 'seerfar-category-tree',
      fetchedAt: new Date(now()).toISOString(),
      count: nodes.length,
      nodes,
      expiresAt: now() + cacheTtlMs,
    };
    return cached;
  }

  return {
    async readTree({ forceRefresh = false } = {}) {
      if (!forceRefresh && cached && cached.expiresAt > now()) return cached;
      if (!pending) pending = fetchTree().finally(() => { pending = null; });
      try {
        return await pending;
      } catch (error) {
        if (cached) return { ...cached, stale: true, warning: error.message };
        throw error;
      }
    },
    async readOptions({ query = '', parentId = '0', limit = 80, forceRefresh = false } = {}) {
      const tree = await this.readTree({ forceRefresh });
      const normalizedQuery = text(query).toLocaleLowerCase();
      const terms = normalizedQuery.split(/\s+/u).filter(Boolean);
      const safeLimit = Math.min(120, Math.max(1, Number(limit) || 80));
      let rows;
      if (terms.length) {
        rows = tree.nodes
          .map((node) => {
            const haystack = [node.id, node.cnTitle, node.title, node.enTitle, node.pathText]
              .join(' ')
              .toLocaleLowerCase();
            if (!terms.every((term) => haystack.includes(term))) return null;
            const exactId = node.id === normalizedQuery ? 0 : 1;
            const startsWithName = node.cnTitle.toLocaleLowerCase().startsWith(normalizedQuery)
              || node.title.toLocaleLowerCase().startsWith(normalizedQuery) ? 0 : 1;
            return { node, rank: exactId * 10 + startsWithName };
          })
          .filter(Boolean)
          .sort((left, right) => left.rank - right.rank || left.node.level - right.node.level)
          .slice(0, safeLimit)
          .map((entry) => entry.node);
      } else {
        const safeParentId = text(parentId) || '0';
        rows = tree.nodes
          .filter((node) => node.parentId === safeParentId)
          .sort((left, right) => (
            (left.cnTitle || left.title).localeCompare(right.cnTitle || right.title, 'zh-CN')
          ))
          .slice(0, safeLimit);
      }
      return {
        ok: true,
        source: tree.source,
        fetchedAt: tree.fetchedAt,
        totalCount: tree.count,
        count: rows.length,
        query: text(query),
        parentId: text(parentId) || '0',
        nodes: rows,
        stale: tree.stale === true,
        warning: tree.warning || '',
      };
    },
  };
}

export { SEERFAR_CATEGORY_TREE_URL };
