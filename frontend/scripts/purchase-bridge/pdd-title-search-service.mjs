import { isLocalImageUrl } from './image-proxy.mjs';
import { search1688ByImage } from './search-service.mjs';
import { buildPddSearchUrl, normalizeImageUrl } from './search-utils.mjs';

const PDD_IMAGE_TITLE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const PDD_IMAGE_TITLE_CACHE_LIMIT = 120;
const pddImageTitleCache = new Map();

function readCached1688Title(imageUrl, now = Date.now()) {
  const key = String(imageUrl || '');
  const current = pddImageTitleCache.get(key);
  if (!current || current.expiresAt <= now) {
    pddImageTitleCache.delete(key);
    return null;
  }
  return current.value;
}

function remember1688Title(imageUrl, value, now = Date.now()) {
  const key = String(imageUrl || '');
  if (!key || !value?.searchTitle) return;
  pddImageTitleCache.delete(key);
  pddImageTitleCache.set(key, {
    value,
    expiresAt: now + PDD_IMAGE_TITLE_CACHE_TTL_MS,
  });
  while (pddImageTitleCache.size > PDD_IMAGE_TITLE_CACHE_LIMIT) {
    pddImageTitleCache.delete(pddImageTitleCache.keys().next().value);
  }
}

async function readPddSearchTitleFrom1688(imageUrl) {
  const cached = readCached1688Title(imageUrl);
  if (cached) {
    return {
      ...cached,
      cached: true,
      ok: true,
      status: 200,
    };
  }

  const sourceSearch = await search1688ByImage(imageUrl);
  if (sourceSearch.searchTitle) remember1688Title(imageUrl, sourceSearch);
  return sourceSearch;
}

export async function handlePddTitleSearch(payload = {}) {
  const imageUrl = normalizeImageUrl(payload.imageUrl);
  if (!imageUrl) {
    return {
      statusCode: 422,
      body: { ok: false, message: '当前商品没有可用于搜款的公网图片。' },
    };
  }
  if (isLocalImageUrl(imageUrl)) {
    return {
      statusCode: 422,
      body: { ok: false, message: '当前图片是本地地址，1688 无法直接识图，请使用 Ozon 返回的公网商品图。' },
    };
  }

  const sourceSearch = await readPddSearchTitleFrom1688(imageUrl);
  if (!sourceSearch?.searchTitle) {
    return {
      statusCode: 422,
      body: {
        ok: false,
        message: '1688 以图搜款没有返回有效的同款商品标题，请更换商品图后重试。',
        imageUrl,
        sourceSearch,
        results: [],
      },
    };
  }

  const pddUrl = buildPddSearchUrl(sourceSearch.searchTitle);
  return {
    statusCode: 200,
    body: {
      ok: true,
      externalOnly: false,
      provider: 'pdd',
      providerLabel: 'PDD 搜款',
      imageUrl,
      searchTitle: sourceSearch.searchTitle,
      searchUrl: pddUrl,
      targetUrl: pddUrl,
      titleSearchAvailable: true,
      titleSource: {
        platform: '1688',
        title: sourceSearch.searchTitle,
        url: sourceSearch.titleSource?.url || sourceSearch.titleSource?.link || sourceSearch.searchUrl || '',
        imageUrl: sourceSearch.titleSource?.imageUrl || '',
      },
      sourceSearch,
      results: sourceSearch.results || [],
      message: `已通过 1688 以图搜款回读同款标题，并打开 PDD 搜索：${sourceSearch.searchTitle}`,
    },
  };
}
