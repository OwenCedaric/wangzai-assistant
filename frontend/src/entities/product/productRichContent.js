function text(value) {
  return String(value ?? '').trim();
}

export const OZON_RICH_CONTENT_ATTRIBUTE_ID = 11254;

function attributeId(attribute = {}) {
  return text(attribute.id ?? attribute.attribute_id ?? attribute.attributeId);
}

function attributeValue(attribute = {}) {
  const values = Array.isArray(attribute.values) ? attribute.values : [];
  return [...values.map((item) => item?.value ?? item?.dictionary_value ?? item), attribute.value, attribute.dictionary_value]
    .map(text)
    .find(Boolean) || '';
}

export function parseProductRichContent(value) {
  if (!value) return null;
  if (typeof value === 'object' && !Array.isArray(value)) return JSON.parse(JSON.stringify(value));
  try {
    const parsed = JSON.parse(text(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function readProductRichContent(product = {}) {
  const raw = product.raw || {};
  const richAttribute = [product.attributes, raw.attributes, raw.attributes?.attributes, raw.detail?.attributes]
    .filter(Array.isArray)
    .flat()
    .find((attribute) => attributeId(attribute) === String(OZON_RICH_CONTENT_ATTRIBUTE_ID));
  return [
    product.richContentJson,
    product.rich_content_json,
    raw.richContentJson,
    raw.rich_content_json,
    raw.detail?.richContentJson,
    raw.detail?.rich_content_json,
    raw.attributes?.richContentJson,
    raw.attributes?.rich_content_json,
    attributeValue(richAttribute),
  ].map(parseProductRichContent).find(Boolean) || null;
}

export function replaceProductRichContentAttribute(attributes = [], richContent = {}) {
  const value = JSON.stringify(richContent);
  let replaced = false;
  const next = (Array.isArray(attributes) ? attributes : []).map((attribute) => {
    if (attributeId(attribute) !== String(OZON_RICH_CONTENT_ATTRIBUTE_ID)) return attribute;
    replaced = true;
    return { ...attribute, id: OZON_RICH_CONTENT_ATTRIBUTE_ID, values: [{ value }] };
  });
  if (!replaced) next.push({ complex_id: 0, id: OZON_RICH_CONTENT_ATTRIBUTE_ID, values: [{ value }] });
  return next;
}

export function replaceProductRichContentImages(richContent, replacements = []) {
  const source = parseProductRichContent(richContent);
  if (!source) throw new Error('当前商品没有可编辑的 Ozon 富内容 JSON，不能替换详情图。');
  const replacementMap = new Map((Array.isArray(replacements) ? replacements : [])
    .map((item) => [text(item?.sourceUrl), text(item?.targetUrl)])
    .filter(([sourceUrl, targetUrl]) => sourceUrl && targetUrl));
  if (!replacementMap.size) throw new Error('没有可替换的详情图地址。');
  const matched = new Set();
  const visit = (value) => {
    if (typeof value === 'string') {
      const target = replacementMap.get(text(value));
      if (target) { matched.add(text(value)); return target; }
      return value;
    }
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, visit(child)]));
    return value;
  };
  const next = visit(source);
  const missing = [...replacementMap.keys()].filter((sourceUrl) => !matched.has(sourceUrl));
  if (missing.length) throw new Error(`当前富内容中没有找到 ${missing.length} 张选中的详情图，已停止写入。`);
  return next;
}

const DROP_NODE = Symbol('drop-rich-content-node');

function isImageWidget(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (text(value.widgetName || value.widget_name).toLowerCase() === 'image') return true;
  const props = value.props;
  return Boolean(props && typeof props === 'object' && (text(props.src) || text(props.srcMobile) || text(props.src_mobile)));
}

function createImageWidget(url) {
  return { widgetName: 'image', props: { src: url, srcMobile: url } };
}

export function syncProductRichContentImages(richContent, imageUrls = []) {
  const urls = [...new Set((Array.isArray(imageUrls) ? imageUrls : []).map(text).filter(Boolean))];
  const source = parseProductRichContent(richContent) || { version: 2, content: [] };
  let index = 0;
  const visit = (value) => {
    if (Array.isArray(value)) return value.map(visit).filter((item) => item !== DROP_NODE);
    if (!value || typeof value !== 'object') return value;
    if (isImageWidget(value)) {
      const url = urls[index++];
      if (!url) return DROP_NODE;
      const props = { ...(value.props || {}), src: url, srcMobile: url };
      if ('src_mobile' in props) props.src_mobile = url;
      return { ...value, widgetName: value.widgetName || value.widget_name || 'image', props };
    }
    return Object.fromEntries(Object.entries(value)
      .map(([key, child]) => [key, visit(child)])
      .filter(([, child]) => child !== DROP_NODE));
  };
  const next = visit(source);
  if (!Array.isArray(next.content)) next.content = [];
  while (index < urls.length) next.content.push(createImageWidget(urls[index++]));
  return next;
}
