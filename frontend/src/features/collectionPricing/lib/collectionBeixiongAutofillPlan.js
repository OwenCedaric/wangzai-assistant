import { COLLECTION_BEIXIONG_PHASES } from '../constants/collectionBeixiongAutofillRules.js';

const NUMERIC_TYPE_PATTERN = /(?:integer|decimal|number|numeric|float|double|int|long|short|数字|数值|整数|小数)/iu;
const DESCRIPTION_PATTERN = /(?:description|rich[-\s]*content|richcontent|описан|аннотац|简介|详情|描述)/iu;
const TAG_PATTERN = /(?:^|\s)(?:tag|tags|keyword|keywords)(?:\s|$)|тег|ключев|标签|关键词/iu;

function clean(value, maximum = 500) {
  return String(value ?? '').replace(/\p{Cc}/gu, '').replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

export function collectionBeixiongDefinitionKind(definition = {}) {
  if (definition.isDictionary) return definition.isCollection ? 'multi-select' : 'select';
  const type = clean(
    definition.valueType
      ?? definition.value_type
      ?? definition.attributeType
      ?? definition.attribute_type
      ?? definition.type,
    120,
  );
  return NUMERIC_TYPE_PATTERN.test(type) ? 'number' : 'text';
}

export function collectionBeixiongDefinitionPhase(definition = {}) {
  const label = clean([
    definition.name,
    definition.title,
    definition.groupName,
    definition.group_name,
  ].filter(Boolean).join(' '), 1_200);
  if (TAG_PATTERN.test(label)) return 'tags';
  if (DESCRIPTION_PATTERN.test(label)) return 'description';
  const kind = collectionBeixiongDefinitionKind(definition);
  if (kind === 'multi-select') return 'multi-select';
  if (kind === 'select') return 'structured-title';
  return 'text-number';
}

export function groupCollectionBeixiongDefinitions(definitions = []) {
  const grouped = Object.fromEntries(COLLECTION_BEIXIONG_PHASES.map((phase) => [phase.id, []]));
  (Array.isArray(definitions) ? definitions : []).forEach((definition) => {
    grouped[collectionBeixiongDefinitionPhase(definition)].push(definition);
  });
  return grouped;
}

export function isCollectionBeixiongSharedDefinition(definition = {}) {
  const scope = clean(
    definition.scope
      ?? definition.fillScope
      ?? definition.fill_scope
      ?? definition.valueScope
      ?? definition.value_scope,
    80,
  ).toLowerCase();
  return definition.shared === true
    || definition.isShared === true
    || definition.is_shared === true
    || scope === 'shared';
}

export function createCollectionBeixiongPhasePlan({ globalDefinitions = [], skuDefinitions = [] } = {}) {
  const globalByPhase = groupCollectionBeixiongDefinitions(globalDefinitions);
  const skuByPhase = groupCollectionBeixiongDefinitions(skuDefinitions);
  return COLLECTION_BEIXIONG_PHASES.map((phase) => ({
    ...phase,
    globalDefinitions: globalByPhase[phase.id],
    skuDefinitions: skuByPhase[phase.id],
    includeTitle: phase.id === 'structured-title',
    includeDescription: phase.id === 'description',
    includeTags: phase.id === 'tags',
  }));
}
