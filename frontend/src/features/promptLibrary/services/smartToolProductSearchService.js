import { readOzonLocalProductSnapshot, getProductListCacheKeyCandidates } from '../../../entities/product/productLocalData.jsx';
import { readLocalApiProductPage } from '../../../entities/product/productLocalMirror.jsx';
import { productStatusTabs } from '../../../entities/product/productStatusRules.jsx';
import { LOCAL_OZON_DATA_LAYER_FILE_KEY } from '../../../shared/config/appConfigCore.jsx';

function text(value) {
  return String(value ?? '').trim();
}

function firstFilled(...values) {
  return values.map(text).find(Boolean) || '';
}

function readNestedValues(row = {}, keys = []) {
  return keys.flatMap((key) => [row[key], row.raw?.[key], row.entity?.[key], row.attributes?.[key]]);
}

function collectImageUrls(value, output = []) {
  if (!value) return output;
  if (Array.isArray(value)) {
    value.forEach((item) => collectImageUrls(item, output));
    return output;
  }
  if (typeof value === 'object') {
    const directKeys = ['url', 'src', 'file_name', 'image', 'image_url', 'picture', 'picture_url', 'link'];
    const directValues = directKeys.map((key) => value[key]).filter(Boolean);
    if (directValues.length) {
      directValues.forEach((item) => collectImageUrls(item, output));
    } else {
      Object.values(value).forEach((item) => collectImageUrls(item, output));
    }
    return output;
  }
  const normalized = text(value);
  if (!normalized) return output;
  if (/^(?:https?:\/\/|data:image\/|\/)/iu.test(normalized)) {
    output.push(normalized);
    return output;
  }
  const matches = normalized.match(/https?:\/\/[^\s"'<>\\)]+?\.(?:jpg|jpeg|png|webp)(?:\?[^\s"'<>\\)]*)?/giu) || [];
  output.push(...matches);
  return output;
}

function uniqueImageUrls(values = []) {
  const output = [];
  const seen = new Set();
  values.forEach((value) => {
    collectImageUrls(value).forEach((url) => {
      if (!url || seen.has(url)) return;
      seen.add(url);
      output.push(url);
    });
  });
  return output;
}

function readValuesFromContainers(containers = [], keys = []) {
  return containers.flatMap((container) => {
    if (!container || typeof container !== 'object') return [];
    return keys.map((key) => container[key]);
  });
}

export function readLocalProductImageGroups(row = {}) {
  const raw = row.raw && typeof row.raw === 'object' ? row.raw : {};
  const containers = [
    row,
    raw,
    row.entity,
    row.attributes,
    raw.listItem,
    raw.detail,
    raw.attributes,
    raw.pictures,
  ].filter(Boolean);
  const primaryImages = uniqueImageUrls(readValuesFromContainers(containers, [
    'primaryImageUrl',
    'primary_image',
    'primaryImage',
    'mainImage',
    'main_image',
    'productMainImage',
    'image',
    'skuImage',
    'sku_image',
  ]));
  const explicitMainImages = uniqueImageUrls(readValuesFromContainers(containers, [
    'mainImages',
    'main_images',
    'productMainImages',
    'skuImages',
    'sku_images',
  ]));
  const generalImages = uniqueImageUrls(readValuesFromContainers(containers, [
    'images',
    'pictures',
    'photos',
    'photo',
    'color_photo',
    'colorImage',
    'color_image',
  ]));
  const explicitDetailImages = uniqueImageUrls(readValuesFromContainers(containers, [
    'detailImages',
    'detail_images',
    'richContentImages',
    'rich_content_images',
    'rich_content_json',
    'richContentJson',
    'description',
  ]));
  const detailSet = new Set(explicitDetailImages);
  let mainImages = uniqueImageUrls([
    primaryImages,
    explicitMainImages,
    generalImages.filter((url) => !detailSet.has(url)),
  ]);
  const mainSet = new Set(mainImages);
  let detailImages = explicitDetailImages.filter((url) => !mainSet.has(url));

  const images = uniqueImageUrls([mainImages, detailImages, primaryImages, generalImages]);
  if (!mainImages.length && detailImages.length) {
    mainImages = detailImages.slice(0, 1);
    detailImages = detailImages.slice(1);
  } else if (!mainImages.length && images.length) {
    mainImages = images;
  }
  return {
    image: mainImages[0] || images[0] || '',
    images,
    mainImages,
    detailImages,
  };
}

function readSkuFacts(row = {}, rawSku = {}) {
  const facts = [
    firstFilled(rawSku.sku, rawSku.skuId, rawSku.offerId, rawSku.offer_id),
    firstFilled(rawSku.color, rawSku.colorName, rawSku.colour),
    firstFilled(rawSku.size, rawSku.capacity, rawSku.weight, rawSku.specification),
    firstFilled(rawSku.name, rawSku.title, rawSku.label),
    firstFilled(row.color, row.colorName, row.size, row.capacity, row.weight, row.specification),
  ];
  return facts.filter(Boolean).join(' · ');
}

function normalizeSkuOption(row = {}, rawSku = {}, index = 0) {
  const sku = firstFilled(
    rawSku.sku,
    rawSku.skuId,
    rawSku.sku_id,
    rawSku.offerId,
    rawSku.offer_id,
    row.sku,
    row.skuId,
    row.sku_id,
    row.offerId,
    row.offer_id,
    row.raw?.sku,
    row.raw?.sku_id,
    row.raw?.offer_id
  );
  const label = firstFilled(rawSku.name, rawSku.title, rawSku.label, sku, `SKU ${index + 1}`);
  const id = `${sku || label}-${index}`;
  const productImages = readLocalProductImageGroups(row);
  const skuImages = readLocalProductImageGroups(rawSku);
  const mainImages = skuImages.mainImages.length ? skuImages.mainImages : productImages.mainImages;
  const detailImages = skuImages.detailImages.length ? skuImages.detailImages : productImages.detailImages;
  return {
    id,
    sku,
    label,
    facts: readSkuFacts(row, rawSku),
    image: mainImages[0] || productImages.image,
    images: uniqueImageUrls([mainImages, detailImages]),
    mainImages,
    detailImages,
  };
}

function getRawSkuOptions(row = {}) {
  const candidates = [row.skus, row.variants, row.skuList, row.skuRows, row.raw?.skus, row.raw?.variants];
  const list = candidates.find((value) => Array.isArray(value) && value.length) || [];
  return list.filter((item) => item && typeof item === 'object');
}

export function normalizeLocalProductSearchRow(row = {}, index = 0, shop = {}) {
  const imageGroups = readLocalProductImageGroups(row);
  const productId = firstFilled(
    ...readNestedValues(row, ['productId', 'product_id', 'id', 'offerId', 'offer_id'])
  );
  const offerId = firstFilled(...readNestedValues(row, ['offerId', 'offer_id', 'offer']));
  const title = firstFilled(
    ...readNestedValues(row, ['title', 'name', 'productName', 'offerName', '商品名称']),
    '未命名商品'
  );
  const rawSkuOptions = getRawSkuOptions(row);
  const skuOptions = (rawSkuOptions.length ? rawSkuOptions : [row]).map((item, itemIndex) =>
    normalizeSkuOption(row, item, itemIndex)
  );
  const stableId = firstFilled(row.localProductKey, productId, offerId, skuOptions[0]?.sku, `${title}-${index}`);
  const searchText = [
    title,
    productId,
    offerId,
    text(row.sku),
    ...skuOptions.flatMap((item) => [item.sku, item.label, item.facts]),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return {
    id: stableId,
    shopId: firstFilled(row.shopId, row.shop_id, shop.id, shop.shopId),
    title,
    productId,
    offerId,
    descriptionCategoryId: firstFilled(row.descriptionCategoryId, row.description_category_id, row.categoryId, row.category_id),
    typeId: firstFilled(row.typeId, row.type_id),
    currencyCode: firstFilled(row.currencyCode, row.currency_code),
    name: firstFilled(row.name, row.title, row.productName),
    priceValue: firstFilled(row.priceValue, row.price, row.salePrice),
    oldPriceValue: firstFilled(row.oldPriceValue, row.old_price, row.oldPrice),
    attributes: Array.isArray(row.attributes) ? row.attributes : [],
    image: imageGroups.image,
    images: imageGroups.images,
    mainImages: imageGroups.mainImages,
    detailImages: imageGroups.detailImages,
    skuOptions,
    shopName: firstFilled(row.shopName, row.shop, shop.name, shop.label),
    searchText,
    raw: row,
  };
}

function createFullSnapshotKeys(shop) {
  const statuses = productStatusTabs.map((item) => item.visibility).filter(Boolean);
  return statuses.flatMap((status) =>
    getProductListCacheKeyCandidates(shop, status).map((key) => `${key}:full`)
  );
}

export async function readLocalProductSearchRows(shops = [], options = {}) {
  const readableShops = Array.isArray(shops) ? shops.filter(Boolean) : [];
  if (!readableShops.length) return [];

  // 商品列表页面的唯一只读入口也是最接近用户当前看到的数据源：
  // 先读取 products 域 SQLite/API 缓存，再回退到旧版商品快照结构。
  const currentProductPage = await readLocalApiProductPage(readableShops, productStatusTabs[0], {
    pageSize: 1000,
    page: 1,
    sort: 'stable',
    keyword: options.keyword || '',
    timeoutMs: options.timeoutMs || 5000,
  }).catch(() => null);
  if (Array.isArray(currentProductPage?.rows) && currentProductPage.rows.length) {
    return currentProductPage.rows.map((row, index) =>
      normalizeLocalProductSearchRow(row, index, readableShops[0])
    );
  }

  const snapshots = await Promise.all(
    readableShops.flatMap((shop) =>
      createFullSnapshotKeys(shop).map(async (snapshotKey) => {
        const snapshot = await readOzonLocalProductSnapshot(
          options.fileKey || LOCAL_OZON_DATA_LAYER_FILE_KEY,
          snapshotKey
        ).catch(() => null);
        return { shop, rows: Array.isArray(snapshot?.rows) ? snapshot.rows : [] };
      })
    )
  );

  const deduped = new Map();
  snapshots.forEach(({ shop, rows }) => {
    rows.forEach((row, index) => {
      const normalized = normalizeLocalProductSearchRow(row, index, shop);
      if (!deduped.has(normalized.id)) deduped.set(normalized.id, normalized);
    });
  });
  return [...deduped.values()];
}

export function filterLocalProductSearchRows(rows = [], query = '') {
  const normalizedQuery = text(query).toLowerCase();
  if (!normalizedQuery) return Array.isArray(rows) ? rows : [];
  return (Array.isArray(rows) ? rows : []).filter((row) => row.searchText.includes(normalizedQuery));
}
