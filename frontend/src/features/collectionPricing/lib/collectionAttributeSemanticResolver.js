import { normalizeCollectionFactText } from './collectionSourceFactNormalizer.js';

const SEMANTIC_ALIASES = Object.freeze({
  brand: ['品牌', '商标', '牌子', 'brand', 'trademark', 'бренд', 'торговая марка'],
  model: ['型号', '款号', '货号', '产品编号', 'model', 'model name', 'article', 'модель', 'модели', 'артикул'],
  color: ['颜色', '色号', '色系', 'color', 'colour', 'цвет'],
  material: ['材质', '材料', '面料', '成分', 'material', 'fabric', 'composition', 'материал', 'состав'],
  country: ['产地', '原产地', '原产国', '生产国', 'country of origin', 'country', 'страна производства', 'страна изготовитель'],
  gender: ['性别', '适用性别', 'gender', 'sex', 'пол'],
  audience: ['适用人群', '适用对象', '适用年龄', '目标人群', 'audience', 'target audience', 'целевая аудитория', 'назначение для'],
  age: ['年龄', '年龄段', 'age', 'возраст'],
  season: ['季节', '上市季节', 'season', 'collection season', 'сезон', 'коллекция'],
  productType: ['产品类别', '商品类别', '商品类型', '品类', '类型', 'product type', 'item type', 'тип товара', 'вид товара', 'тип'],
  style: ['风格', '款式', '造型', 'style', 'design', 'стиль', 'дизайн'],
  shape: ['形状', '外形', '款式', 'shape', 'form', 'форма'],
  pattern: ['图案', '花型', '纹理', 'pattern', 'print', 'рисунок', 'принт'],
  size: ['尺寸', '规格', '尺码', 'size', 'размер'],
  length: ['长度', '长', 'length', 'длина'],
  width: ['宽度', '宽', 'width', 'ширина'],
  height: ['高度', '高', 'height', 'высота'],
  depth: ['深度', '厚深', 'depth', 'глубина'],
  diameter: ['直径', 'diameter', 'диаметр'],
  thickness: ['厚度', 'thickness', 'толщина'],
  weight: ['重量', '净重', '毛重', 'weight', 'mass', 'вес', 'масса'],
  package: ['包装', '包裹', '装箱', 'package', 'packaging', 'packed', 'упаковка', 'в упаковке'],
  quantity: ['数量', '件数', '个数', '支数', '套数', 'quantity', 'count', 'number of pieces', 'количество', 'число штук'],
  capacity: ['容量', '容积', 'capacity', 'volume capacity', 'емкость', 'объем'],
  adult: ['成人', '18+', 'adult', 'для взрослых'],
  purpose: ['用途', '使用场景', '适用范围', 'purpose', 'use', 'назначение', 'применение'],
  feature: ['功能', '特点', '特性', 'feature', 'function', 'особенности', 'функции'],
  coating: ['涂层', '镀层', '表面处理', 'coating', 'покрытие'],
  frame: ['镜框', '镜架', '框架', 'frame', 'оправа', 'оправы', 'каркас'],
  lens: ['镜片', 'lens', 'линза', 'линзы'],
  body: ['主体', '机身', '外壳', 'body', 'housing', 'корпус', 'корпуса'],
  handle: ['手柄', '把手', 'handle', 'ручка', 'ручки'],
  cover: ['盖', '外罩', 'cover', 'lid', 'крышка'],
  cable: ['线材', '电线', '数据线', 'cable', 'wire', 'кабель', 'провод'],
  screen: ['屏幕', '显示屏', 'screen', 'display', 'экран', 'дисплей'],
  compatibility: ['适配', '兼容', '适用型号', 'compatibility', 'compatible', 'совместимость'],
  power: ['功率', 'power', 'мощность'],
  voltage: ['电压', 'voltage', 'напряжение'],
  battery: ['电池', '电池容量', 'battery', 'аккумулятор', 'батарея'],
  name: ['商品名称', '产品名称', '名称', 'name', 'product name', 'название товара', 'наименование'],
  description: ['描述', '商品描述', '简介', 'description', 'описание'],
});

const NUMERIC_TYPE_PATTERN = /(?:integer|decimal|number|numeric|float|double|int|long|short|数字|数值|整数|小数)/iu;
const BOOLEAN_TYPE_PATTERN = /(?:boolean|bool|checkbox|布尔|真假|是否)/iu;
const PACKAGING_PATTERN = /(?:包装|包裹|装箱|package|packaging|packed|упаков|в упаковке)/iu;
const PART_SEMANTICS = new Set(['frame', 'lens', 'body', 'handle', 'cover', 'cable', 'battery', 'screen']);
const SEMANTIC_PROFILE_CACHE = new Map();
const SEMANTIC_PROFILE_CACHE_LIMIT = 2_000;

function clean(value, maximum = 2_000) {
  return String(value ?? '').normalize('NFKC').replace(/\p{Cc}/gu, '').replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function containsAlias(text, alias) {
  const target = normalizeCollectionFactText(text);
  const normalizedAlias = normalizeCollectionFactText(alias);
  if (!target || !normalizedAlias) return false;
  if (/\p{Script=Han}/u.test(normalizedAlias)) return target.replace(/\s+/gu, '').includes(normalizedAlias.replace(/\s+/gu, ''));
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(normalizedAlias).replace(/ /gu, '[^\\p{L}\\p{N}]+')}($|[^\\p{L}\\p{N}])`, 'iu').test(target);
}

function ngrams(value, size = 2) {
  const compact = normalizeCollectionFactText(value).replace(/\s+/gu, '');
  if (!compact) return new Set();
  if (compact.length <= size) return new Set([compact]);
  const result = new Set();
  for (let index = 0; index <= compact.length - size; index += 1) result.add(compact.slice(index, index + size));
  return result;
}

function dice(left, right) {
  if (!left.size || !right.size) return 0;
  let shared = 0;
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  small.forEach((value) => { if (large.has(value)) shared += 1; });
  return (2 * shared) / (left.size + right.size);
}

function semanticKeys(value) {
  const source = clean(value, 1_000);
  return Object.entries(SEMANTIC_ALIASES).flatMap(([key, aliases]) => (
    aliases.some((alias) => containsAlias(source, alias)) ? [key] : []
  ));
}

function definitionType(definition = {}) {
  return clean(
    definition.valueType
      ?? definition.value_type
      ?? definition.attributeType
      ?? definition.attribute_type
      ?? definition.type,
    120,
  );
}

export function getCollectionAttributeValueKind(definition = {}) {
  if (definition.isDictionary || definition.dictionaryId || definition.dictionary_id) return 'dictionary';
  const type = definitionType(definition);
  if (BOOLEAN_TYPE_PATTERN.test(type)) return 'boolean';
  if (NUMERIC_TYPE_PATTERN.test(type)) return 'numeric';
  return 'text';
}

export function resolveCollectionAttributeSemanticProfile(value = {}) {
  const isDefinition = value && typeof value === 'object' && !Array.isArray(value);
  const name = clean(isDefinition ? value.name ?? value.title ?? value.attributeName ?? value.attribute_name : value, 400);
  const description = clean(isDefinition ? value.description ?? value.info : '', 1_000);
  const unit = clean(isDefinition ? value.unit ?? value.measurementUnit ?? value.measurement_unit : '', 80);
  const cacheKey = `${isDefinition ? 'definition' : 'text'}::${name}::${description}::${unit}::${isDefinition ? definitionType(value) : ''}::${Boolean(isDefinition && value.isDictionary)}`;
  const cached = SEMANTIC_PROFILE_CACHE.get(cacheKey);
  if (cached) return cached;
  const combined = [name, description].filter(Boolean).join(' ');
  const profile = {
    name,
    normalizedName: normalizeCollectionFactText(name),
    description,
    unit,
    semantics: new Set(semanticKeys(combined)),
    nameBigrams: ngrams(name),
    packaging: PACKAGING_PATTERN.test(combined),
    kind: isDefinition ? getCollectionAttributeValueKind(value) : 'text',
  };
  if (SEMANTIC_PROFILE_CACHE.size >= SEMANTIC_PROFILE_CACHE_LIMIT) SEMANTIC_PROFILE_CACHE.clear();
  SEMANTIC_PROFILE_CACHE.set(cacheKey, profile);
  return profile;
}

function semanticIntersection(left = new Set(), right = new Set()) {
  const result = [];
  left.forEach((value) => { if (right.has(value)) result.push(value); });
  return result;
}

function selectedSemantics(values = new Set(), allowed = new Set()) {
  return new Set([...values].filter((value) => allowed.has(value)));
}

function unitFamily(value) {
  const unit = clean(value, 80).toLocaleLowerCase();
  if (/(?:mg|毫克|мг)/u.test(unit)) return 'weight';
  if (/(?:kg|千克|公斤|кг)/u.test(unit)) return 'weight';
  if (/(?:g|克|г)/u.test(unit)) return 'weight';
  if (/(?:mm|毫米|мм)/u.test(unit)) return 'length';
  if (/(?:cm|厘米|см)/u.test(unit)) return 'length';
  if (/(?:\bm\b|米|м)/u.test(unit)) return 'length';
  if (/(?:ml|毫升|мл)/u.test(unit)) return 'capacity';
  if (/(?:\bl\b|升|л)/u.test(unit)) return 'capacity';
  if (/(?:w|瓦|вт)/u.test(unit)) return 'power';
  if (/(?:v|伏|в)/u.test(unit)) return 'voltage';
  return unit ? 'other' : '';
}

export function scoreCollectionSourceFact(definition = {}, sourceFact = {}) {
  if (!sourceFact?.normalizedName || !sourceFact?.normalizedValue) return { score: 0, reasons: [] };
  const target = resolveCollectionAttributeSemanticProfile(definition);
  const source = resolveCollectionAttributeSemanticProfile(sourceFact.name);
  const reasons = [];
  let score = 0;
  if (target.normalizedName === source.normalizedName) {
    score = 1;
    reasons.push('exact-name');
  } else {
    const nameSimilarity = dice(target.nameBigrams, source.nameBigrams);
    if (nameSimilarity >= 0.45) {
      score = Math.max(score, 0.5 + nameSimilarity * 0.42);
      reasons.push(`name-similarity:${nameSimilarity.toFixed(3)}`);
    }
    const sharedSemantics = semanticIntersection(target.semantics, source.semantics);
    if (sharedSemantics.length) {
      const semanticScore = sharedSemantics.length >= 2 ? 0.9 : 0.76;
      score = Math.max(score, semanticScore);
      reasons.push(`semantic:${sharedSemantics.join(',')}`);
    }
  }
  if (!score) return { score: 0, reasons: [] };
  if (target.packaging !== source.packaging) {
    score -= 0.34;
    reasons.push('packaging-mismatch');
  }
  const targetParts = selectedSemantics(target.semantics, PART_SEMANTICS);
  const sourceParts = selectedSemantics(source.semantics, PART_SEMANTICS);
  if (targetParts.size || sourceParts.size) {
    const sharedParts = semanticIntersection(targetParts, sourceParts);
    if (targetParts.size && sourceParts.size && !sharedParts.length) {
      score -= 0.48;
      reasons.push('product-part-conflict');
    } else if (targetParts.size && !sourceParts.size) {
      score -= 0.2;
      reasons.push('target-part-missing-in-source');
    } else if (!targetParts.size && sourceParts.size) {
      score -= 0.12;
      reasons.push('source-part-not-in-target');
    }
  }
  const targetUnit = unitFamily(target.unit);
  const sourceUnit = unitFamily(sourceFact.unit);
  if (targetUnit && sourceUnit) {
    if (targetUnit === sourceUnit) {
      score += 0.04;
      reasons.push('unit-compatible');
    } else {
      score -= 0.28;
      reasons.push('unit-mismatch');
    }
  }
  if (sourceFact.kind === 'context') {
    const contextAllowed = target.semantics.has('productType')
      || target.semantics.has('name')
      || target.semantics.has('description');
    score = Math.min(score, contextAllowed ? 0.68 : 0.48);
    reasons.push('context-only');
  }
  score *= Math.max(0.2, Math.min(1, Number(sourceFact.confidence) || 0));
  return { score: Math.max(0, Math.min(1, score)), reasons };
}

export function rankCollectionSourceFacts(definition = {}, sourceFacts = [], { minimumScore = 0.4 } = {}) {
  return (Array.isArray(sourceFacts) ? sourceFacts : [])
    .map((sourceFact) => ({ sourceFact, ...scoreCollectionSourceFact(definition, sourceFact) }))
    .filter((item) => item.score >= minimumScore)
    .sort((left, right) => right.score - left.score || left.sourceFact.path.localeCompare(right.sourceFact.path));
}

export function collectionAttributeSemantics(value = {}) {
  return [...resolveCollectionAttributeSemanticProfile(value).semantics];
}
