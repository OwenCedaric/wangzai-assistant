import { getOzonCategoryPathByIds } from '../../data/ozonCategoryIndex';
import {
  calculateDeliveryServiceFeeCny,
  calculateGuooFreightCny,
  GUOO_REALFBS_VOLUME_DIVISOR,
  normalizeEstimatedCommissionPercent,
  OZON_MILEAGE_FEE_RUB,
} from '../../services/feeCalculationService';
import { GUOO_REALFBS_ROUTES } from '../../shared/config/appConfigCore.jsx';
import { firstFilled, normalizeOzonId } from '../order/orderIdentityRules.jsx';
import {
  buildOzonProductMap,
  collectWarehouseProductStockItems,
  formatOzonPrice,
  getOzonPayloadItems,
  requestOzonReadOnlyVariants,
} from './productOzonApi.jsx';
import { normalizeImageList } from './productImageRules.jsx';

export function isNumericOzonSkuValue(value) {
  const text = normalizeOzonId(value).trim();
  return /^\d+$/.test(text);
}

function dedupeFilledOzonIds(values = []) {
  return values
    .map((value) => normalizeOzonId(value).trim())
    .filter((value, index, list) => value && value !== '-' && value !== '未返回' && list.indexOf(value) === index);
}

export function collectOzonWarehouseStockRequestIds(products = []) {
  const offerIds = dedupeFilledOzonIds(
    products.flatMap((product) => {
      const skuText = normalizeOzonId(product?.sku).trim();
      return [
        product?.offerId,
        product?.offer_id,
        product?.offer,
        product?.offerCode,
        product?.offer_code,
        skuText && !isNumericOzonSkuValue(skuText) ? skuText : '',
      ];
    })
  );
  const skuIds = dedupeFilledOzonIds(
    products.flatMap((product) => [
      product?.ozonSku,
      product?.skuId,
      isNumericOzonSkuValue(product?.sku) ? product?.sku : '',
    ])
  );
  return { offerIds, skuIds };
}

export async function requestOzonProductStocksByWarehouse(shop, products = [], warehouseId = '') {
  const safeWarehouseId = normalizeOzonId(warehouseId);
  if (!safeWarehouseId) return [];
  const numericWarehouseId = Number(safeWarehouseId);
  const { offerIds, skuIds } = collectOzonWarehouseStockRequestIds(products);
  const requestBodies = [];

  if (offerIds.length > 0) {
    requestBodies.push(
      { offer_id: offerIds, warehouse_id: numericWarehouseId, limit: 1000 },
      { offer_id: offerIds, warehouse_ids: [numericWarehouseId], limit: 1000 }
    );
  }
  if (skuIds.length > 0) {
    requestBodies.push(
      { sku: skuIds, warehouse_id: numericWarehouseId, limit: 1000 },
      { sku: skuIds, warehouse_ids: [numericWarehouseId], limit: 1000 }
    );
  }

  if (requestBodies.length === 0) return [];
  const data = await requestOzonReadOnlyVariants('/v2/product/info/stocks-by-warehouse/fbs', shop, requestBodies);
  return getOzonPayloadItems(data);
}

export async function requestOzonProductStocksForBatchWarehouse(shop, products = [], warehouseId = '') {
  // Exact warehouse reads must stay on the v2 seller-warehouse contract. A
  // v4 fallback is an all-channel total and cannot be used as the base for a
  // selected warehouse stock write.
  return buildOzonProductMap(await requestOzonProductStocksByWarehouse(shop, products, warehouseId));
}

export function toFiniteNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(String(value).replace(/[^\d.-]/g, ''));
  return Number.isFinite(number) ? number : null;
}

export function firstFiniteNumber(...values) {
  for (const value of values) {
    const number = toFiniteNumber(value);
    if (number !== null) return number;
  }
  return null;
}

export function getOzonStockItemWarehouseId(item = {}) {
  return normalizeOzonId(
    firstFilled(
      item?.warehouse_id,
      item?.warehouseId,
      item?.warehouse?.id,
      item?.warehouse?.warehouse_id,
      item?.fbs_warehouse_id,
      item?.rfbs_warehouse_id
    )
  );
}

export function getOzonStockItemQuantity(item = {}) {
  return firstFiniteNumber(
    item?.present,
    item?.presentQuantity,
    item?.present_quantity,
    item?.stock,
    item?.stockValue,
    item?.stock_value,
    item?.available_stock_count,
    item?.valid_stock_count,
    item?.quantity,
    item?.available,
    item?.available_quantity
  );
}

export function getOzonWarehouseStockQuantity(stockInfo, warehouseId = '') {
  const safeWarehouseId = normalizeOzonId(warehouseId);
  if (!safeWarehouseId) return null;
  const matchedItems = collectWarehouseProductStockItems(stockInfo).filter(
    (item) => getOzonStockItemWarehouseId(item) === safeWarehouseId
  );
  if (matchedItems.length === 0) return null;
  const quantities = matchedItems.map(getOzonStockItemQuantity).filter((value) => value !== null);
  if (quantities.length === 0) return null;
  return quantities.reduce((sum, value) => sum + value, 0);
}

export function formatPlainNumber(value) {
  const number = toFiniteNumber(value);
  if (number === null) return '';
  return Number.isInteger(number) ? String(number) : String(Number(number.toFixed(3)));
}

export function formatTrimmedNumber(value) {
  const number = toFiniteNumber(value);
  if (number === null) return '';
  return String(Number(number.toFixed(6)));
}

export function getInlineUnit(value) {
  const text = String(value ?? '').toLowerCase();
  if (/毫米|mm\b/.test(text)) return 'mm';
  if (/厘米|cm\b/.test(text)) return 'cm';
  if (/千克|公斤|kg\b/.test(text)) return 'kg';
  if (/克|g\b/.test(text)) return 'g';
  if (/米|m\b/.test(text)) return 'm';
  return '';
}

export function normalizeMaterialDimensionCm(value, unit = 'cm') {
  const number = toFiniteNumber(value);
  if (number === null) return '';
  const normalizedUnit = getInlineUnit(value) || String(unit || 'cm').toLowerCase();
  if (normalizedUnit === 'mm') return formatTrimmedNumber(number / 10);
  if (normalizedUnit === 'm') return formatTrimmedNumber(number * 100);
  return formatTrimmedNumber(number);
}

export function normalizeMaterialWeightKg(value, unit = 'kg') {
  const number = toFiniteNumber(value);
  if (number === null) return '';
  const normalizedUnit = getInlineUnit(value) || String(unit || 'kg').toLowerCase();
  if (normalizedUnit === 'g') return formatTrimmedNumber(number / 1000);
  return formatTrimmedNumber(number);
}

export function toDisplayWeightKg(value, unit = 'g') {
  const number = toFiniteNumber(value);
  if (number === null) return '';
  const normalizedUnit = String(unit || 'g').toLowerCase();
  return formatTrimmedNumber(normalizedUnit === 'kg' ? number : number / 1000);
}

export function toDisplayDimensionCm(value, unit = 'mm') {
  const number = toFiniteNumber(value);
  if (number === null) return '';
  const normalizedUnit = String(unit || 'mm').toLowerCase();
  return formatTrimmedNumber(normalizedUnit === 'cm' ? number : number / 10);
}

export function toOzonWeightGrams(value) {
  const number = toFiniteNumber(value);
  return number === null ? null : Math.round(number * 1000);
}

export function toOzonDimensionMm(value) {
  const number = toFiniteNumber(value);
  return number === null ? null : Math.round(number * 10);
}

export function findDeepByKeys(source, keys) {
  if (!source || typeof source !== 'object') return undefined;
  if (!Array.isArray(source)) {
    for (const key of keys) {
      if (source[key] !== undefined && source[key] !== null && source[key] !== '') return source[key];
    }
  }
  const values = Array.isArray(source) ? source : Object.values(source);
  for (const value of values) {
    if (value && typeof value === 'object') {
      const found = findDeepByKeys(value, keys);
      if (found !== undefined && found !== null && found !== '') return found;
    }
  }
  return undefined;
}

export function findDirectByKeys(source, keys) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return undefined;
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null && source[key] !== '') return source[key];
  }
  return undefined;
}

export function getAttributeList(source) {
  return Array.isArray(source?.attributes) ? source.attributes : [];
}

export function getAttributeValue(source, names) {
  const lowerNames = names.map((name) => String(name).toLowerCase());
  const attribute = getAttributeList(source).find((item) => {
    const label = String(item.name ?? item.attribute_name ?? item.id ?? '').toLowerCase();
    return lowerNames.some((name) => label.includes(name));
  });
  const values = attribute?.values;
  if (Array.isArray(values) && values.length > 0) {
    return values[0]?.value ?? values[0]?.dictionary_value ?? values[0]?.name ?? values[0];
  }
  return attribute?.value ?? '';
}

export const productAttributeNameMap = [
  ['title', '商品标题'],
  ['название товара', '商品名称'],
  ['название модели', '型号名称'],
  ['название цвета', '颜色名称'],
  ['название бренда', '品牌名称'],
  ['rich', '富内容'],
  ['json', 'JSON 内容'],
  ['pdf', 'PDF 文档'],
  ['video', '视频'],
  ['видео', '视频'],
  ['обложк', '封面'],
  ['хештег', '话题标签'],
  ['тн вэд', '海关编码'],
  ['тнвэд', '海关编码'],
  ['brand', '品牌'],
  ['бренд', '品牌'],
  ['нет бренда', '品牌'],
  ['color', '颜色'],
  ['цвет', '颜色'],
  ['название цвета', '颜色名称'],
  ['material', '材质'],
  ['материал', '材质'],
  ['age', '适用年龄'],
  ['возраст', '适用年龄'],
  ['gender', '适用性别'],
  ['пол', '适用性别'],
  ['пол ребенка', '儿童适用性别'],
  ['унисекс', '适用性别'],
  ['country', '产地'],
  ['страна', '产地'],
  ['страна-изготовитель', '产地'],
  ['battery', '电池'],
  ['батаре', '电池'],
  ['type', '类型'],
  ['тип', '类型'],
  ['вид', '类型'],
  ['интерактив', '互动功能'],
  ['функц', '功能'],
  ['дополнительные', '附加功能'],
  ['model', '型号'],
  ['модель', '型号'],
  ['название модели', '型号名称'],
  ['size', '尺寸'],
  ['размер', '尺寸'],
  ['weight', '重量'],
  ['вес', '重量'],
  ['length', '长度'],
  ['длина', '长度'],
  ['width', '宽度'],
  ['ширина', '宽度'],
  ['height', '高度'],
  ['высота', '高度'],
  ['package', '包装'],
  ['упаков', '包装'],
  ['manufacturer', '生产商'],
  ['производител', '生产商'],
  ['composition', '组成'],
  ['состав', '组成'],
  ['description', '商品描述'],
  ['описан', '商品描述'],
  ['название', '名称'],
  ['name', '名称'],
  ['артикул', '货号'],
  ['групп', '分组'],
  ['объедин', '合并同款分组'],
  ['комплектац', '套装内容'],
  ['количество', '数量'],
  ['количество заводских упаковок', '出厂包装数量'],
  ['назначение', '用途'],
  ['особенност', '特点'],
  ['warranty', '质保'],
  ['гарант', '质保'],
  ['barcode', '条码'],
  ['штрихкод', '条码'],
];

export const productAttributeIdNameMap = new Map([
  ['85', '品牌'],
  ['4180', '商品标题'],
  ['4191', '商品简介'],
  ['4383', '商品重量（克）'],
  ['4384', '套装内容'],
  ['4389', '生产国家或地区'],
  ['4497', '含包装重量（克）'],
  ['4975', '材质'],
  ['5156', '外壳材质'],
  ['6429', '镜子类型'],
  ['6430', '镜子结构'],
  ['6437', '镜子特点'],
  ['7147', '玩具高度（厘米）'],
  ['7173', '毛绒玩具类型'],
  ['8044', '重量（克）'],
  ['8048', '使用方法'],
  ['8050', '成分'],
  ['8081', '光线颜色'],
  ['8094', '模式数量'],
  ['8111', '防尘防水等级'],
  ['8132', '电池规格'],
  ['8133', '最大光通量（流明）'],
  ['8141', '电池最长续航（小时）'],
  ['8145', '功率（瓦）'],
  ['8163', '容量（毫升）'],
  ['8170', '用途'],
  ['8172', '适用肤质'],
  ['8176', '使用部位'],
  ['8187', '配方特点'],
  ['8188', '适用年龄'],
  ['8198', 'SPF 防晒指数'],
  ['8205', '保质期（天）'],
  ['8229', '商品类型（Ozon 类目）'],
  ['8414', '高度（厘米）'],
  ['8416', '宽度（厘米）'],
  ['8730', '儿童化妆品用途'],
  ['8781', '是否为防晒化妆品'],
  ['8953', '附加功能'],
  ['8962', '单件商品数量'],
  ['9024', '商家货号（Offer ID）'],
  ['9048', '型号名称（用于合并同一卡片）'],
  ['9070', '18+ 成人商品标识'],
  ['9390', '目标人群'],
  ['9577', '护肤效果'],
  ['9646', '光束距离（米）'],
  ['9889', '商品尺寸（长×宽×高，厘米）'],
  ['10096', '商品颜色'],
  ['10097', '颜色名称'],
  ['10400', '保修期'],
  ['10901', '电池类型'],
  ['11254', '富内容'],
  ['11284', '是否为全身镜'],
  ['11650', '原厂包装数量'],
  ['11955', '照明距离（米）'],
  ['11958', '是否含电池'],
  ['11959', '是否含充电器'],
  ['11960', 'LED 型号'],
  ['11962', '手电筒特点'],
  ['12393', '美容成分'],
  ['13216', '适用性别'],
  ['20975', '香味'],
  ['21899', '产品形态'],
  ['22219', '镜子形状'],
  ['22232', '欧亚经济联盟海关商品编码'],
  ['22315', 'LED 数量'],
  ['22390', '合并为相似商品'],
  ['23171', '商品话题标签（可填写多个）'],
  ['23249', '单个销售单位内的商品数量'],
  ['23401', '手电筒类型'],
  ['23487', '生产商'],
  ['23536', '是否需要商品标识码'],
  // Exact names from Ozon /v1/description-category/attribute. These media
  // helper fields are hidden from the normal editor, but remain translatable
  // for diagnostics and preservation of existing values.
  ['8789', 'PDF 文件名'],
  ['8790', 'PDF 文档'],
  ['21837', '视频名称'],
  ['21841', '视频链接'],
  ['21845', '视频封面链接'],
  ['21890', '镜框形状'],
  ['21893', '内部尺寸（厘米）'],
  ['21894', '镜槽厚度（毫米）'],
  ['21895', '镜框材质'],
  ['22273', '视频中的商品'],
]);

const productAttributeCyrillicStemKeywords = new Set([
  'обложк',
  'батаре',
  'интерактив',
  'функц',
  'дополнительные',
  'упаков',
  'производител',
  'описан',
  'групп',
  'объедин',
  'комплектац',
  'особенност',
  'гарант',
]);

function escapeAttributeKeyword(keyword) {
  return String(keyword).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesAttributeNameKeyword(text, keyword) {
  if (!hasCyrillicText(keyword)) return text.includes(keyword);
  const suffix = productAttributeCyrillicStemKeywords.has(keyword) ? '[\\p{L}]*' : '';
  return new RegExp(`(?:^|[^\\p{L}])${escapeAttributeKeyword(keyword)}${suffix}(?:$|[^\\p{L}])`, 'iu').test(text);
}

export function translateProductAttributeName(name, id, index) {
  const text = String(name || '').trim();
  const safeId = String(id ?? '').trim();
  const idName = productAttributeIdNameMap.get(safeId);
  const fallbackName = safeId ? 'Ozon 属性名称未返回' : '字段名称未返回';
  if (!text) return idName || fallbackName;
  if (safeId === '4180') return '商品标题';
  if (idName) return idName;
  if (hasChineseText(text) && !hasCyrillicText(text)) return text;
  const lowerText = text.toLowerCase();
  const match = [...productAttributeNameMap]
    .sort(([left], [right]) => right.length - left.length)
    .find(([keyword]) => matchesAttributeNameKeyword(lowerText, keyword));
  if (match) {
    if (match[0] === 'название' || match[0] === 'name') {
      return idName || match[1];
    }
    return match[1];
  }
  if (hasCyrillicText(text)) return 'Ozon 属性（中文名称待补充）';
  return idName || text || fallbackName;
}

export const productAttributeValueMap = new Map([
  ['true', '是'],
  ['false', '否'],
  ['нет бренда', '无品牌'],
  ['унисекс', '男女通用'],
  ['зеленый', '绿色'],
  ['зелёный', '绿色'],
  ['черный', '黑色'],
  ['чёрный', '黑色'],
  ['белый', '白色'],
  ['красный', '红色'],
  ['синий', '蓝色'],
  ['желтый', '黄色'],
  ['жёлтый', '黄色'],
  ['серый', '灰色'],
  ['пластик', '塑料'],
  ['металл', '金属'],
  ['текстиль', '纺织物'],
  ['китай', '中国'],
  ['для мальчиков', '男孩'],
  ['для девочек', '女孩'],
]);

export function stripHtmlText(value) {
  return String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function translateProductAttributeValue(value) {
  const text = stripHtmlText(value);
  if (!text) return '';
  if (hasChineseText(text) && !hasCyrillicText(text)) return text;
  const lowerText = text.toLowerCase();
  return productAttributeValueMap.get(lowerText) || text;
}

export function formatAttributeDisplayValue(attribute) {
  const values = Array.isArray(attribute?.values) ? attribute.values : [];
  if (values.length > 0) {
    return values
      .map((item) => item?.value ?? item?.dictionary_value ?? item?.name ?? item)
      .map(translateProductAttributeValue)
      .filter((value) => value !== undefined && value !== null && value !== '')
      .join('、');
  }
  return translateProductAttributeValue(attribute?.value ?? attribute?.dictionary_value ?? attribute?.name ?? '');
}

export function getAttributeId(attribute) {
  const id = attribute?.id ?? attribute?.attribute_id;
  return id === undefined || id === null || id === '' ? '' : String(id);
}

export function getProductFilledAttributes(product) {
  const rawAttributes = getAttributeList(product?.raw?.attributes);
  if (rawAttributes.length > 0) return rawAttributes;
  return Array.isArray(product?.attributes) ? product.attributes : [];
}

export function getAttributeDefinitionLabel(definition, index) {
  const id = getAttributeId(definition);
  return translateProductAttributeName(definition?.name ?? definition?.attribute_name ?? definition?.title, id, index);
}

export function normalizeOzonBooleanFlag(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return false;
  return !['0', 'false', 'no', 'n', 'off', 'null', 'undefined'].includes(text);
}

export function isOzonAttributeDictionary(item = {}) {
  return normalizeOzonBooleanFlag(
    item.isDictionary
      ?? item.is_dictionary
      ?? item.definition?.isDictionary
      ?? item.definition?.is_dictionary
      ?? item.definition?.dictionary_id,
  );
}

export function isOzonAttributeCollection(item = {}) {
  return normalizeOzonBooleanFlag(
    item.isCollection
      ?? item.is_collection
      ?? item.definition?.isCollection
      ?? item.definition?.is_collection,
  );
}

export function isOzonAttributeManualEntryAllowed(item = {}) {
  const description = String(
    item.manualEntryDescription
      ?? item.description
      ?? item.definition?.manualEntryDescription
      ?? item.definition?.description
      ?? '',
  ).trim();
  return /укажите\s+вручную|ввести\s+вручную|manual(?:ly)?|手动(?:填写|输入)|可手动(?:填写|输入)/iu.test(description);
}

export function buildFilledAttributeMap(attributes) {
  const map = new Map();
  attributes.forEach((attribute, index) => {
    const id = getAttributeId(attribute);
    const value = formatAttributeDisplayValue(attribute);
    const labelKey = String(attribute?.name ?? attribute?.attribute_name ?? '')
      .trim()
      .toLowerCase();
    const row = { attribute, index, value };
    if (id) map.set(`id:${id}`, row);
    if (labelKey) map.set(`label:${labelKey}`, row);
  });
  return map;
}

export function buildProductAttributeEditRows(product, definitions = []) {
  const filledAttributes = getProductFilledAttributes(product);
  const filledMap = buildFilledAttributeMap(filledAttributes);
  const rows = [];
  const usedIds = new Set();

  definitions.forEach((definition, index) => {
    const id = getAttributeId(definition);
    const label = getAttributeDefinitionLabel(definition, index);
    const labelKey = String(definition?.name ?? definition?.attribute_name ?? '')
      .trim()
      .toLowerCase();
    const filled = (id && filledMap.get(`id:${id}`)) || (labelKey && filledMap.get(`label:${labelKey}`));
    if (id) usedIds.add(id);
    rows.push({
      id: id || `definition-${index}`,
      attributeId: id,
      label,
      value: filled?.value || '',
      filled: Boolean(filled?.value),
      required: normalizeOzonBooleanFlag(definition?.is_required ?? definition?.required),
      isDictionary: isOzonAttributeDictionary(definition),
      isCollection: isOzonAttributeCollection(definition),
      valueType: definition?.valueType ?? definition?.value_type ?? definition?.type ?? '',
      definition,
      sourceAttribute: filled?.attribute || null,
    });
  });

  filledAttributes.forEach((attribute, index) => {
    const id = getAttributeId(attribute);
    if (id && usedIds.has(id)) return;
    const value = formatAttributeDisplayValue(attribute);
    if (!value) return;
    rows.push({
      id: id || `filled-${index}`,
      attributeId: id,
      label: translateProductAttributeName(attribute?.name ?? attribute?.attribute_name, id, index),
      value,
      filled: true,
      required: false,
      isDictionary: false,
      isCollection: false,
      valueType: '',
      definition: null,
      sourceAttribute: attribute,
    });
  });

  return rows;
}

export function collectImageUrlsFromValue(value, urls = new Set()) {
  if (!value) return urls;
  if (typeof value === 'string') {
    const matches = value.match(/https?:\/\/[^\s"'<>\\)]+?\.(?:jpg|jpeg|png|webp)(?:\?[^\s"'<>\\)]*)?/gi);
    if (matches) matches.forEach((url) => urls.add(url));
    return urls;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectImageUrlsFromValue(item, urls));
    return urls;
  }
  if (typeof value === 'object') {
    Object.values(value).forEach((item) => collectImageUrlsFromValue(item, urls));
  }
  return urls;
}

export function getImageUrlFromValue(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value !== 'object') return '';

  const directKeys = ['url', 'src', 'file_name', 'image', 'image_url', 'picture', 'picture_url', 'link'];
  for (const key of directKeys) {
    const url = getImageUrlFromValue(value[key]);
    if (url) return url;
  }

  const collected = collectImageUrlsFromValue(value);
  return collected.values().next().value || '';
}

export function getOzonDetailImages(product) {
  const mainImages = new Set(normalizeImageList(product?.images));
  const urls = collectImageUrlsFromValue([
    product?.raw?.detail?.rich_content_json,
    product?.raw?.detail?.description,
    product?.raw?.attributes?.rich_content_json,
    product?.raw?.attributes?.attributes,
  ]);
  return [...urls].filter((url) => !mainImages.has(url));
}

export function hasCyrillicText(value) {
  return /[\u0400-\u04FF]/.test(String(value || ''));
}

export function hasChineseText(value) {
  return /[\u4E00-\u9FFF]/.test(String(value || ''));
}

export function getOzonCategoryName(detail, attributes, listItem) {
  const categoryPath = getOzonCategoryPathByIds({
    typeId: detail?.type_id ?? attributes?.type_id ?? listItem?.type_id,
    descriptionCategoryId:
      detail?.description_category_id ?? attributes?.description_category_id ?? listItem?.description_category_id,
  });

  if (categoryPath) return categoryPath;

  const candidate =
    detail?.softwareCategoryPath ??
    detail?.softwareCategoryName ??
    attributes?.softwareCategoryPath ??
    attributes?.softwareCategoryName ??
    listItem?.softwareCategoryPath ??
    listItem?.softwareCategoryName ??
    detail?.description_category_name ??
    detail?.category_name ??
    attributes?.description_category_name ??
    attributes?.category_name ??
    getAttributeValue(attributes, ['类目', 'category']);

  if (candidate && hasChineseText(candidate) && !hasCyrillicText(candidate)) return String(candidate);
  return '未分类';
}

export function getOzonImages(detail, attributes, pictures) {
  const candidates = [
    pictures?.images,
    pictures?.pictures,
    pictures?.primary_image ? [pictures.primary_image, ...(pictures.images || [])] : null,
    attributes?.images,
    detail?.images,
  ];
  const images = candidates
    .flatMap((value) => (Array.isArray(value) ? value : []))
    .map(getImageUrlFromValue)
    .filter(Boolean);
  const primary =
    pictures?.primary_image ?? attributes?.primary_image ?? detail?.primary_image ?? detail?.images?.[0] ?? '';
  return [...new Set(normalizeImageList([primary, ...images]))];
}

export function getOzonPriceValue(detail, priceInfo) {
  // Archived rows may contain zero marketing-price placeholders before a
  // positive price.price. Do not let the placeholder hide the actual price.
  return firstPositiveFiniteNumber(
    priceInfo?.price?.marketing_price,
    priceInfo?.marketing_price,
    priceInfo?.price?.marketing_seller_price,
    priceInfo?.marketing_seller_price,
    priceInfo?.price?.price,
    priceInfo?.price,
    priceInfo?.old_price,
    detail?.price
  );
}

export function getOzonOldPriceValue(detail, priceInfo) {
  return toFiniteNumber(priceInfo?.price?.old_price ?? priceInfo?.old_price ?? detail?.old_price);
}

export function getOzonCurrency(detail, priceInfo) {
  return priceInfo?.price?.currency_code ?? priceInfo?.currency_code ?? detail?.currency_code ?? 'CNY';
}

export function getOzonCommissionPercentByMode(priceInfo, mode = 'rFBS') {
  const commissions = priceInfo?.commissions ?? {};
  const normalizedMode = String(mode || '').toUpperCase();
  const commissionPercent = normalizedMode.includes('FBO')
    ? commissions.sales_percent_fbo
    : normalizedMode.includes('FBP')
      ? commissions.sales_percent_fbp
      : normalizedMode.includes('FBS') && !normalizedMode.includes('RFBS')
        ? commissions.sales_percent_fbs
        : commissions.sales_percent_rfbs;
  return normalizeEstimatedCommissionPercent(commissionPercent);
}

export function getOzonRealFbsCommissionPercent(priceInfo) {
  return getOzonCommissionPercentByMode(priceInfo, 'rFBS');
}

export function getOzonCommissionBasePrice(detail, priceInfo) {
  return firstPositiveFiniteNumber(
    priceInfo?.price?.marketing_price,
    priceInfo?.marketing_price,
    priceInfo?.price?.marketing_seller_price,
    priceInfo?.marketing_seller_price,
    priceInfo?.price?.price,
    priceInfo?.old_price,
    detail?.price
  );
}

export function getOzonCommissionAmount(detail, priceInfo, commissionPercent) {
  const basePrice = getOzonCommissionBasePrice(detail, priceInfo);
  return basePrice === null || commissionPercent === null ? null : (basePrice * commissionPercent) / 100;
}

export function getOzonAcquiringFee(priceInfo) {
  return firstPositiveFiniteNumber(
    priceInfo?.acquiring,
    priceInfo?.acquiring_amount,
    priceInfo?.price?.acquiring,
    priceInfo?.financial_data?.acquiring,
    priceInfo?.financial_data?.acquiring_amount,
    findDeepByKeys(priceInfo, ['acquiring'])
  );
}

export function getOzonMileageFeeCny(rubToCnyRate = null) {
  return calculateDeliveryServiceFeeCny({
    deliveryServiceFeeRub: OZON_MILEAGE_FEE_RUB,
    rubToCnyRate,
  });
}

export function normalizeGuooRouteMatchText(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .trim();
}

export function getGuooRouteMatchScore(route = {}, routeText = '') {
  const normalizedText = normalizeGuooRouteMatchText(routeText);
  if (!normalizedText) return 0;
  return (route.aliases ?? []).reduce((score, alias) => {
    const normalizedAlias = normalizeGuooRouteMatchText(alias);
    return normalizedAlias && normalizedText.includes(normalizedAlias)
      ? score + Math.max(1, normalizedAlias.length / 4)
      : score;
  }, 0);
}

export function findGuooRealFbsRoute(routeText = '') {
  const matches = GUOO_REALFBS_ROUTES.map((route) => ({ route, score: getGuooRouteMatchScore(route, routeText) }))
    .filter((item) => item.score >= 1.5)
    .sort((left, right) => right.score - left.score);
  return matches[0]?.route ?? null;
}

export function getGuooDimensionProfile(lengthCm, widthCm, heightCm) {
  const dimensions = [lengthCm, widthCm, heightCm]
    .map(toFiniteNumber)
    .filter((value) => value !== null && value > 0)
    .sort((left, right) => right - left);
  if (dimensions.length !== 3) return null;
  return {
    longest: dimensions[0],
    middle: dimensions[1],
    shortest: dimensions[2],
    sum: dimensions.reduce((total, value) => total + value, 0),
    volumeWeight: (dimensions[0] * dimensions[1] * dimensions[2]) / GUOO_REALFBS_VOLUME_DIVISOR,
  };
}

export function normalizeGuooRealFbsInput(input = {}) {
  const weightKg = firstFiniteNumber(input.weightKg, input.weight, input.grossWeight, input.grossWeightKg);
  const lengthCm = firstFiniteNumber(input.lengthCm, input.length, input.long);
  const widthCm = firstFiniteNumber(input.widthCm, input.width);
  const heightCm = firstFiniteNumber(input.heightCm, input.height);
  const productValueRub = firstFiniteNumber(input.productValueRub, input.valueRub, input.orderValueRub);
  return {
    weightKg,
    lengthCm,
    widthCm,
    heightCm,
    productValueRub,
    routeText: input.routeText || input.deliveryMethod || input.logistics || '',
    routeConfirmed: input.routeConfirmed === true,
  };
}

export function isGuooRouteWithinLimit(route = {}, input = {}, dimensions = null) {
  if (input.weightKg === null || input.weightKg <= 0) return { ok: false, reason: '缺少重量' };
  if (!dimensions) return { ok: false, reason: '缺少长宽高' };
  if (!input.routeConfirmed && route.minWeightKg !== undefined && input.weightKg < route.minWeightKg)
    return { ok: false, reason: '重量低于线路范围' };
  if (route.maxWeightKg !== undefined && input.weightKg > route.maxWeightKg)
    return { ok: false, reason: '重量超出线路范围' };
  if (
    !input.routeConfirmed &&
    (route.minValueRub !== undefined || route.maxValueRub !== undefined) &&
    input.productValueRub === null
  ) {
    return { ok: false, reason: '缺少卢布货值' };
  }
  if (!input.routeConfirmed && route.minValueRub !== undefined && input.productValueRub < route.minValueRub)
    return { ok: false, reason: '货值低于线路范围' };
  if (!input.routeConfirmed && route.maxValueRub !== undefined && input.productValueRub > route.maxValueRub)
    return { ok: false, reason: '货值超出线路范围' };
  if (route.maxDimensionSumCm !== undefined && dimensions.sum > route.maxDimensionSumCm) {
    return { ok: false, reason: '三边和超出线路范围' };
  }
  if (route.maxLongestCm !== undefined && dimensions.longest > route.maxLongestCm) {
    return { ok: false, reason: '最长边超出线路范围' };
  }
  if (route.maxMiddleCm !== undefined && dimensions.middle > route.maxMiddleCm) {
    return { ok: false, reason: '第二边超出线路范围' };
  }
  if (route.maxShortestCm !== undefined && dimensions.shortest > route.maxShortestCm) {
    return { ok: false, reason: '第三边超出线路范围' };
  }
  return { ok: true, reason: '' };
}

export function calculateGuooRealFbsRouteFreight(route = {}, sourceInput = {}) {
  const input = normalizeGuooRealFbsInput(sourceInput);
  const dimensions = getGuooDimensionProfile(input.lengthCm, input.widthCm, input.heightCm);
  const limit = isGuooRouteWithinLimit(route, input, dimensions);
  if (!limit.ok) {
    return {
      ok: false,
      route,
      reason: limit.reason,
      amount: null,
      display: '待确认',
      candidates: [],
    };
  }

  const billedWeightKg = input.routeConfirmed
    ? Math.max(input.weightKg, firstFiniteNumber(route.minWeightKg) ?? 0)
    : input.weightKg;
  const freight = calculateGuooFreightCny({
    weightKg: billedWeightKg,
    lengthCm: input.lengthCm,
    widthCm: input.widthCm,
    heightCm: input.heightCm,
    kgFee: route.kgFee,
    ticketFee: route.ticketFee,
    extraKgFee: route.extraKgFee ?? 0,
    useVolumeWeight: Boolean(route.useVolumeWeight),
    volumeDivisor: GUOO_REALFBS_VOLUME_DIVISOR,
  });
  if (!freight.ok) {
    return {
      ok: false,
      route,
      reason: freight.reason,
      amount: null,
      display: '待确认',
      candidates: [],
    };
  }

  return {
    ok: true,
    route,
    routeId: route.id,
    routeLabel: route.label,
    amount: freight.amount,
    display: formatOzonPrice(freight.amount, 'CNY'),
    chargeWeight: freight.chargeWeight,
    actualWeight: input.weightKg,
    billedWeight: billedWeightKg,
    volumeWeight: dimensions.volumeWeight,
    productValueRub: input.productValueRub,
    kgFee: freight.kgFee,
    extraKgFee: freight.extraKgFee,
    ticketFee: freight.ticketFee,
    routeConfirmed: input.routeConfirmed,
    candidates: [],
  };
}

export function calculateGuooRealFbsFreight(sourceInput = {}) {
  const input = normalizeGuooRealFbsInput(sourceInput);
  const matchedRoute = findGuooRealFbsRoute(input.routeText);
  if (matchedRoute) return calculateGuooRealFbsRouteFreight(matchedRoute, input);

  const candidates = GUOO_REALFBS_ROUTES.map((route) => calculateGuooRealFbsRouteFreight(route, input))
    .filter((result) => result.ok)
    .sort((left, right) => left.amount - right.amount);
  if (candidates.length === 1) return { ...candidates[0], candidates };
  return {
    ok: false,
    route: null,
    reason: candidates.length ? '需要选择配送方式' : '没有匹配线路',
    amount: null,
    display: '待确认',
    candidates,
  };
}

export function getOzonStockItemsFromSource(source) {
  if (!source || typeof source !== 'object') return [];
  const nestedStocks = source?.stocks;
  if (Array.isArray(nestedStocks)) return nestedStocks;
  if (Array.isArray(nestedStocks?.stocks)) return nestedStocks.stocks;
  if (nestedStocks && typeof nestedStocks === 'object') return [nestedStocks];
  if (Array.isArray(source?.warehouse_stocks)) return source.warehouse_stocks;
  if (Array.isArray(source?.warehouseStocks)) return source.warehouseStocks;
  return [];
}

export function firstPositiveFiniteNumber(...values) {
  for (const value of values) {
    const number = toFiniteNumber(value);
    if (number !== null && number > 0) return number;
  }
  return null;
}
