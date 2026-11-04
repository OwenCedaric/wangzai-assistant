const CATEGORY_PATH_SEPARATOR_PATTERN = /\s*(?:>|\/|\\|→|›|»|\||::)+\s*/gu;
const CATEGORY_CONTEXT_SEPARATOR_PATTERN = /[、,，;；]+/gu;

function text(value, maximum = 2_000) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/\p{Cc}/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maximum);
}

function identity(value) {
  return text(value, 160).toLocaleLowerCase();
}

function definitionId(definition = {}) {
  return text(definition.id ?? definition.attributeId ?? definition.attribute_id, 80);
}

function categoryKey(option = {}) {
  const source = option && typeof option === 'object' ? option : {};
  return [source.descriptionCategoryId, source.typeId].map((item) => text(item, 80)).join(':');
}

function splitCategoryPath(option = {}) {
  const source = text(option.pathText || option.path || option.name, 2_000);
  const segments = source
    .split(CATEGORY_PATH_SEPARATOR_PATTERN)
    .flatMap((segment) => segment.split(CATEGORY_CONTEXT_SEPARATOR_PATTERN))
    .map((segment) => text(segment, 300))
    .filter(Boolean);
  const leafName = text(option.name, 300);
  if (leafName && segments.at(-1) !== leafName) segments.push(leafName);
  return segments.length ? segments : [leafName || '未命名类目'];
}

function sortNodes(nodes = []) {
  return nodes
    .map((node) => ({ ...node, children: sortNodes(node.children) }))
    .sort((left, right) => (
      Number(Boolean(left.option)) - Number(Boolean(right.option))
      || left.name.localeCompare(right.name, 'zh-CN')
    ));
}

export function buildCollectionCategoryTree(options = []) {
  const roots = [];
  const nodesByPath = new Map();
  (Array.isArray(options) ? options : []).forEach((option) => {
    if (!option?.descriptionCategoryId || !option?.typeId) return;
    const segments = splitCategoryPath(option);
    let parentChildren = roots;
    let path = '';
    segments.forEach((name, index) => {
      path = path ? `${path} > ${name}` : name;
      let node = nodesByPath.get(path);
      if (!node) {
        node = { id: path, name, pathText: path, depth: index, children: [], option: null };
        nodesByPath.set(path, node);
        parentChildren.push(node);
      }
      if (index === segments.length - 1) node.option = { ...option, pathText: option.pathText || path };
      parentChildren = node.children;
    });
  });
  return sortNodes(roots);
}

export function searchCollectionCategoryOptions(options = [], query = '', { limit = 300 } = {}) {
  const search = identity(query);
  const rows = (Array.isArray(options) ? options : []).filter((option) => (
    option?.descriptionCategoryId && option?.typeId
  ));
  const matched = search
    ? rows.filter((option) => identity(`${option.pathText || ''} ${option.name || ''}`).includes(search))
    : rows;
  return matched
    .sort((left, right) => (
      text(left.pathText || left.name).localeCompare(text(right.pathText || right.name), 'zh-CN')
    ))
    .slice(0, Math.max(1, Math.min(2_000, Number(limit) || 300)));
}

export function getCollectionCategoryManagedFieldLabel(definition = {}) {
  const id = definitionId(definition);
  const name = text(definition.name, 300);
  if (id === '85' || /^(бренд|品牌|brand)$/iu.test(name)) return '系统填写：无品牌';
  if (/(原产国|制造国|страна|country)/iu.test(name)) return '系统填写：中国';
  if (id === '4180' || /(型号名称|合并.*商品卡|название модели)/iu.test(name)) return '系统填写';
  if (id === '9070' || /(评论.*奖励|отзыв.*балл)/iu.test(name)) return '系统填写';
  if (id === '11650' || id === '23249' || /(统一计量单位.*数量|количество.*единиц)/iu.test(name)) return '系统填写';
  return '';
}

export function getCollectionCategoryAttributeTypeLabel(definition = {}) {
  if (definition.isDictionary) return definition.isCollection ? '多选' : '选项';
  const valueType = identity(definition.valueType || definition.type);
  if (/(decimal|double|float|number|integer|int|число)/u.test(valueType)) return '小数';
  return '文本';
}

export function buildCollectionCategoryAttributeRows({
  definitions = [],
  optionsByAttributeId = {},
  dictionaryLoadedIds = [],
  dictionaryFailedIds = [],
} = {}) {
  const loaded = new Set((Array.isArray(dictionaryLoadedIds) ? dictionaryLoadedIds : []).map(String));
  const failed = new Set((Array.isArray(dictionaryFailedIds) ? dictionaryFailedIds : []).map(String));
  return (Array.isArray(definitions) ? definitions : [])
    .map((definition) => {
      const id = definitionId(definition);
      const managedLabel = getCollectionCategoryManagedFieldLabel(definition);
      let status = managedLabel ? 'managed' : 'model';
      let statusLabel = managedLabel;
      if (!managedLabel && definition.isDictionary) {
        if (failed.has(id)) {
          status = 'failed';
          statusLabel = '选项加载失败';
        } else if (loaded.has(id)) {
          status = 'loaded';
          statusLabel = '已加载';
        } else {
          status = 'loading';
          statusLabel = '加载选项中…';
        }
      }
      return {
        id,
        name: text(definition.name, 500) || `属性 ${id}`,
        description: text(definition.description, 1_000),
        required: Boolean(definition.is_required ?? definition.isRequired),
        typeLabel: getCollectionCategoryAttributeTypeLabel(definition),
        isDictionary: Boolean(definition.isDictionary),
        isCollection: Boolean(definition.isCollection),
        optionCount: Array.isArray(optionsByAttributeId[id]) ? optionsByAttributeId[id].length : 0,
        status,
        statusLabel,
        definition,
      };
    })
    .sort((left, right) => (
      Number(right.required) - Number(left.required)
      || Number(left.status === 'managed') - Number(right.status === 'managed')
      || left.name.localeCompare(right.name, 'zh-CN')
    ));
}

export function collectionCategoryOptionKey(option = {}) {
  return categoryKey(option);
}
