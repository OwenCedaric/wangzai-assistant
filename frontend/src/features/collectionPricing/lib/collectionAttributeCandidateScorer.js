import {
  getCollectionAttributeValueKind,
  resolveCollectionAttributeSemanticProfile,
} from './collectionAttributeSemanticResolver.js';
import { normalizeCollectionFactText } from './collectionSourceFactNormalizer.js';

const VALUE_ALIAS_GROUPS = Object.freeze([
  ['no-brand', ['无品牌', '没有品牌', 'no brand', 'unbranded', 'нет бренда', 'без бренда']],
  ['china', ['中国', '中华人民共和国', 'china', 'cn', 'китай']],
  ['male', ['男', '男性', '男士', 'male', 'men', 'man', 'мужской', 'для мужчин']],
  ['female', ['女', '女性', '女士', 'female', 'women', 'woman', 'женский', 'для женщин']],
  ['unisex', ['男女通用', '中性', 'unisex', 'унисекс']],
  ['adult', ['成人', '成年人', 'adult', 'взрослый', 'взрослая', 'для взрослых']],
  ['child', ['儿童', '孩子', '童', 'child', 'children', 'детский', 'для детей']],
  ['yes', ['是', '有', '支持', 'yes', 'true', 'да']],
  ['no', ['否', '无', '不支持', 'no', 'false', 'нет']],
  ['black', ['黑', '黑色', 'black', 'черный', 'чёрный']],
  ['white', ['白', '白色', 'white', 'белый']],
  ['red', ['红', '红色', 'red', 'красный']],
  ['blue', ['蓝', '蓝色', 'blue', 'синий', 'голубой']],
  ['green', ['绿', '绿色', 'green', 'зеленый', 'зелёный']],
  ['yellow', ['黄', '黄色', 'yellow', 'желтый', 'жёлтый']],
  ['pink', ['粉', '粉色', 'pink', 'розовый']],
  ['purple', ['紫', '紫色', 'purple', 'фиолетовый']],
  ['gray', ['灰', '灰色', 'gray', 'grey', 'серый']],
  ['brown', ['棕', '棕色', '茶色', 'brown', 'коричневый']],
  ['gold', ['金色', '金', 'gold', 'golden', 'золотой']],
  ['silver', ['银色', '银', 'silver', 'серебристый']],
  ['transparent', ['透明', 'transparent', 'прозрачный']],
  ['multicolor', ['多色', '彩色', 'multicolor', 'разноцветный']],
  ['metal', ['金属', 'metal', 'металл']],
  ['steel', ['钢', '不锈钢', 'steel', 'stainless steel', 'сталь', 'нержавеющая сталь']],
  ['aluminum', ['铝', '铝合金', 'aluminum', 'aluminium', 'алюминий']],
  ['plastic', ['塑料', 'plastic', 'пластик']],
  ['polycarbonate', ['pc', '聚碳酸酯', 'polycarbonate', 'поликарбонат']],
  ['silicone', ['硅胶', 'silicone', 'силикон']],
  ['rubber', ['橡胶', 'rubber', 'резина']],
  ['wood', ['木', '木质', 'wood', 'дерево']],
  ['glass', ['玻璃', 'glass', 'стекло']],
  ['ceramic', ['陶瓷', 'ceramic', 'керамика']],
  ['cotton', ['棉', '纯棉', 'cotton', 'хлопок']],
  ['polyester', ['涤纶', '聚酯纤维', 'polyester', 'полиэстер']],
  ['leather', ['皮', '皮革', 'leather', 'кожа']],
  ['spring-summer', ['春', '夏', '春季', '夏季', '春夏', 'spring', 'summer', 'весна-лето']],
  ['autumn-winter', ['秋', '冬', '秋季', '冬季', '秋冬', 'autumn', 'winter', 'осень-зима']],
  ['all-season', ['四季', '全年', 'all season', 'всесезонный']],
  ['square', ['方形', '方框', '正方形', 'square', 'квадратный', 'квадратные']],
  ['round', ['圆形', '圆框', 'round', 'круглый', 'круглые']],
  ['photochromic', ['变色', '感光变色', 'photochromic', 'фотохромный', 'фотохромное']],
  ['blue-blocker', ['防蓝光', 'blue blocker', 'blueblocker', 'защита от синего света']],
  ['non-prescription-glasses', ['平光镜', '无度数眼镜', 'non prescription glasses', 'очки без диоптрий']],
]);

const NORMALIZED_VALUE_ALIAS_GROUPS = VALUE_ALIAS_GROUPS.map(([key, aliases]) => [
  key,
  aliases.map((alias) => normalizeCollectionFactText(alias)).filter(Boolean),
]);
const PREPARED_DICTIONARY_OPTIONS = new WeakMap();

function clean(value, maximum = 2_000) {
  return String(value ?? '').normalize('NFKC').replace(/\p{Cc}/gu, '').replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function normalizedOption(option = {}) {
  const id = clean(option.id ?? option.valueId ?? option.value_id, 80);
  const label = clean(option.label ?? option.value ?? option.valueText ?? option.value_text, 500);
  return id && label ? { ...option, id, label, value: label } : null;
}

function aliasGroup(value) {
  const target = normalizeCollectionFactText(value);
  if (!target) return '';
  return NORMALIZED_VALUE_ALIAS_GROUPS.find(([, aliases]) => aliases.some((normalizedAlias) => {
    return target === normalizedAlias
      || (normalizedAlias.length >= 2 && (target.includes(normalizedAlias) || normalizedAlias.includes(target)));
  }))?.[0] || '';
}

function aliasesForGroup(group) {
  return VALUE_ALIAS_GROUPS.find(([key]) => key === group)?.[1] || [];
}

function bigrams(value) {
  const source = normalizeCollectionFactText(value).replace(/\s+/gu, '');
  if (!source) return new Set();
  if (source.length <= 2) return new Set([source]);
  const result = new Set();
  for (let index = 0; index < source.length - 1; index += 1) result.add(source.slice(index, index + 2));
  return result;
}

function dice(left, right) {
  if (!left.size || !right.size) return 0;
  let shared = 0;
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  small.forEach((item) => { if (large.has(item)) shared += 1; });
  return (2 * shared) / (left.size + right.size);
}

export function splitCollectionSourceValues(value) {
  const source = clean(value, 2_000);
  if (!source) return [];
  const rows = source.split(/\s*(?:,|，|、|;|；|\||\/|\+|\band\b|\bи\b)\s*/iu).map((item) => clean(item, 500)).filter(Boolean);
  return [...new Set(rows.length ? rows : [source])].slice(0, 50);
}

export function collectionDictionaryLookupTerms(sourceFact = {}, definition = {}) {
  const profile = resolveCollectionAttributeSemanticProfile(definition);
  const terms = splitCollectionSourceValues(sourceFact.value);
  const expanded = terms.flatMap((term) => {
    const group = aliasGroup(term);
    if (!group) return [term];
    const aliases = aliasesForGroup(group);
    const russian = aliases.filter((item) => /\p{Script=Cyrillic}/u.test(item));
    const english = aliases.filter((item) => /[a-z]/iu.test(item));
    return [term, ...russian, ...english];
  });
  if (profile.semantics.has('season')) {
    const year = clean(sourceFact.value, 500).match(/20\d{2}/u)?.[0];
    if (year) expanded.unshift(year);
  }
  return [...new Set(expanded.map((item) => clean(item, 300)).filter(Boolean))].slice(0, 8);
}

function prepareDictionaryOptions(options = []) {
  const rows = Array.isArray(options) ? options : [];
  const cached = PREPARED_DICTIONARY_OPTIONS.get(rows);
  if (cached) return cached;
  const prepared = rows.map(normalizedOption).filter(Boolean).map((option) => ({
    option,
    normalizedLabel: normalizeCollectionFactText(option.label),
    aliasGroup: aliasGroup(option.label),
    bigrams: bigrams(option.label),
  }));
  PREPARED_DICTIONARY_OPTIONS.set(rows, prepared);
  return prepared;
}

function optionScore(source, sourceGroup, sourceBigrams, preparedOption) {
  const option = preparedOption.normalizedLabel;
  if (!source || !option) return 0;
  if (source === option) return 1;
  if (sourceGroup && sourceGroup === preparedOption.aliasGroup) return 0.97;
  if (Math.min(source.length, option.length) >= 2 && (source.includes(option) || option.includes(source))) return 0.88;
  const similarity = dice(sourceBigrams, preparedOption.bigrams);
  return similarity >= 0.72 ? 0.55 + similarity * 0.4 : 0;
}

function bestOptionForValue(value, options = []) {
  const source = normalizeCollectionFactText(value);
  const sourceGroup = aliasGroup(value);
  const sourceBigrams = bigrams(value);
  const ranked = prepareDictionaryOptions(options)
    .map((prepared) => ({
      option: prepared.option,
      score: optionScore(source, sourceGroup, sourceBigrams, prepared),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.option.label.localeCompare(right.option.label));
  const best = ranked[0];
  if (!best || best.score < 0.78) return null;
  const runnerUp = ranked[1];
  if (runnerUp && best.option.id !== runnerUp.option.id && best.score - runnerUp.score < 0.06) return null;
  return best;
}

export function rankCollectionDictionaryOptionsForValues(values = [], definition = {}, options = []) {
  const sourceValues = (Array.isArray(values) ? values : [values])
    .flatMap((value) => splitCollectionSourceValues(value));
  const matched = sourceValues.flatMap((value) => {
    const result = bestOptionForValue(value, options);
    return result ? [{ ...result, sourceValue: value }] : [];
  });
  return [...new Map(matched.map((item) => [item.option.id, item])).values()]
    .sort((left, right) => right.score - left.score);
}

export function rankCollectionDictionaryOptions(sourceFact = {}, definition = {}, options = []) {
  return rankCollectionDictionaryOptionsForValues([sourceFact.value], definition, options);
}

function unitScale(value) {
  const unit = clean(value, 80).toLocaleLowerCase();
  if (/(?:mg|毫克|мг)/u.test(unit)) return { family: 'weight', scale: 0.001 };
  if (/(?:kg|千克|公斤|кг)/u.test(unit)) return { family: 'weight', scale: 1_000 };
  if (/(?:g|克|г)/u.test(unit)) return { family: 'weight', scale: 1 };
  if (/(?:mm|毫米|мм)/u.test(unit)) return { family: 'length', scale: 0.1 };
  if (/(?:cm|厘米|см)/u.test(unit)) return { family: 'length', scale: 1 };
  if (/(?:\bm\b|米|метр|м)/u.test(unit)) return { family: 'length', scale: 100 };
  if (/(?:ml|毫升|мл)/u.test(unit)) return { family: 'capacity', scale: 1 };
  if (/(?:\bl\b|升|литр|л)/u.test(unit)) return { family: 'capacity', scale: 1_000 };
  return null;
}

function inlineUnit(value) {
  return clean(value, 500).match(/(?:毫克|千克|公斤|毫米|厘米|毫升|升|mg|kg|mm|cm|ml|g|m|l|мг|кг|мм|см|мл|г|м|л)\b/iu)?.[0] || '';
}

export function normalizeCollectionNumericCandidate(sourceFact = {}, definition = {}) {
  const raw = clean(sourceFact.value, 500).replace(/,/gu, '.');
  const match = raw.match(/[-+]?\d+(?:\.\d+)?/u);
  if (!match) return '';
  let value = Number(match[0]);
  if (!Number.isFinite(value)) return '';
  const sourceScale = unitScale(inlineUnit(raw) || sourceFact.unit);
  const targetScale = unitScale(definition.unit ?? definition.measurementUnit ?? definition.measurement_unit);
  if (sourceScale && targetScale && sourceScale.family === targetScale.family) {
    value = (value * sourceScale.scale) / targetScale.scale;
  }
  return Number.isFinite(value) ? String(Number(value.toFixed(6))) : '';
}

function maxValueCount(definition = {}) {
  return Math.max(0, Number(definition.maxValueCount ?? definition.max_value_count ?? 0) || 0);
}

export function createCollectionAttributeCandidateValue({ definition = {}, sourceFact = {}, options = [] } = {}) {
  const kind = getCollectionAttributeValueKind(definition);
  const source = sourceFact.source || 'source-attribute';
  const evidence = [{ source, path: sourceFact.path, value: sourceFact.value }];
  if (kind === 'dictionary') {
    const matches = rankCollectionDictionaryOptions(sourceFact, definition, options);
    const limit = maxValueCount(definition) || (definition.isCollection ? 100 : 1);
    const selected = matches.slice(0, definition.isCollection ? limit : 1);
    if (!selected.length) return null;
    const confidence = Math.min(sourceFact.confidence || 1, selected[0].score);
    return definition.isCollection
      ? {
          value: selected.map((item) => item.option.label).join(', '),
          values: selected.map((item) => item.option.label),
          dictionaryValueId: '',
          dictionaryValueIds: selected.map((item) => item.option.id),
          source,
          status: confidence >= 0.96 ? 'verified' : 'mapped',
          confidence,
          evidence,
        }
      : {
          value: selected[0].option.label,
          values: [],
          dictionaryValueId: selected[0].option.id,
          dictionaryValueIds: [],
          source,
          status: confidence >= 0.96 ? 'verified' : 'mapped',
          confidence,
          evidence,
        };
  }
  if (kind === 'numeric') {
    const value = normalizeCollectionNumericCandidate(sourceFact, definition);
    if (!value) return null;
    return { value, values: [], dictionaryValueId: '', dictionaryValueIds: [], source, status: 'verified', confidence: sourceFact.confidence, evidence };
  }
  const value = clean(sourceFact.value, 2_000);
  if (!value) return null;
  return { value, values: [], dictionaryValueId: '', dictionaryValueIds: [], source, status: 'verified', confidence: sourceFact.confidence, evidence };
}
