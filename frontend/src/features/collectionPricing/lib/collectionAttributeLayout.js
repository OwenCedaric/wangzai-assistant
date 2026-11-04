const ATTRIBUTE_LAYOUT_GROUPS = Object.freeze([
  Object.freeze({ id: 'basic', title: '基础与归类', order: 10 }),
  Object.freeze({ id: 'appearance', title: '材质、颜色与款式', order: 20 }),
  Object.freeze({ id: 'dimensions', title: '尺寸与重量', order: 30 }),
  Object.freeze({ id: 'package', title: '包装与数量', order: 40 }),
  Object.freeze({ id: 'compliance', title: '编码、合规与售后', order: 50 }),
  Object.freeze({ id: 'content', title: '文案与展示', order: 60 }),
  Object.freeze({ id: 'media', title: '视频与文件', order: 70 }),
  Object.freeze({ id: 'other', title: '其他属性', order: 80 }),
]);

const GROUP_BY_ID = new Map(ATTRIBUTE_LAYOUT_GROUPS.map((group) => [group.id, group]));

const MEDIA_PATTERN = /(?:pdf|\.pdf|озон\.видео|видеооблож|video|视频|文件)/iu;
const CONTENT_PATTERN = /(?:rich[-\s]*контент|rich[-\s]*content|аннотац|описан|хештег|hashtag|тег|简介|描述|富文本|标签|关键词)/iu;
const COMPLIANCE_PATTERN = /(?:тн\s*вэд|код\s*(?:продавца|маркировки)|маркиров|признак\s*18|гарант|seller\s*code|海关|报关|商品编码|标识码|成人|保修|质保|合规)/iu;
const PACKAGE_PATTERN = /(?:комплект|упаковк|количество|packing|package|包装|清单|套装|数量|件数)/iu;
const DIMENSION_PATTERN = /(?:вес|ширин|высот|размер|длин|мост|заушник|weight|width|height|length|重量|尺寸|长度|宽度|高度|鼻梁|镜腿)/iu;
const APPEARANCE_PATTERN = /(?:материал|цвет|покрыти|поляризац|затемнен|защит[аы]\s*линз|флекс|форма\s*очк|material|color|材质|颜色|涂层|偏光|镜片|镜框|款式|形状)/iu;
const BASIC_PATTERN = /(?:бренд|^тип$|название|^пол$|целевая\s*аудитория|страна|коллекция|вид\s*аксессуара|объединить|brand|type|name|gender|country|collection|品牌|类型|名称|标题|型号|性别|人群|国家|系列|配件|合并)/iu;

const WIDE_PATTERN = /(?:rich[-\s]*контент|rich[-\s]*content|аннотац|описан|хештег|hashtag|简介|描述|富文本|标签|关键词)/iu;
const PRODUCT_TITLE_PATTERN = /(?:^название$|商品标题|product\s*title)/iu;

const ATTRIBUTE_ORDER = new Map([
  ['4180', 10], ['85', 20], ['9048', 30], ['9163', 40], ['8229', 50], ['23323', 60],
  ['9725', 70], ['4389', 80], ['9390', 90], ['22390', 100],
  ['5287', 110], ['5306', 120], ['9609', 130], ['9751', 140], ['6570', 150], ['6586', 160],
  ['10096', 170], ['10097', 180], ['22327', 190], ['9610', 200], ['22333', 210], ['20774', 220],
  ['4383', 230], ['8014', 240], ['8016', 250], ['8018', 260], ['8020', 270], ['8022', 280],
  ['4384', 290], ['4386', 300], ['11650', 310], ['23249', 320],
  ['9024', 330], ['9070', 340], ['10400', 350], ['22232', 360], ['23536', 370],
  ['4191', 380], ['23171', 390], ['11254', 400],
  ['21837', 410], ['21841', 420], ['21845', 430], ['22273', 440], ['8789', 450], ['8790', 460],
]);

function clean(value, maximum = 1_000) {
  return String(value ?? '').replace(/\p{Cc}/gu, '').replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function attributeText(definition = {}) {
  return clean([
    definition.name,
    definition.title,
    definition.groupName,
    definition.group_name,
  ].filter(Boolean).join(' '));
}

function definitionId(definition = {}) {
  return clean(definition.id ?? definition.attributeId ?? definition.attribute_id, 80);
}

export function collectionAttributeLayoutGroup(definition = {}) {
  const text = attributeText(definition);
  const groupId = MEDIA_PATTERN.test(text)
    ? 'media'
    : CONTENT_PATTERN.test(text)
      ? 'content'
      : COMPLIANCE_PATTERN.test(text)
        ? 'compliance'
        : PACKAGE_PATTERN.test(text)
          ? 'package'
          : DIMENSION_PATTERN.test(text)
            ? 'dimensions'
            : APPEARANCE_PATTERN.test(text)
              ? 'appearance'
              : BASIC_PATTERN.test(text)
                ? 'basic'
                : 'other';
  return GROUP_BY_ID.get(groupId);
}

export function collectionAttributeLayoutSpan(definition = {}) {
  const text = attributeText(definition);
  return WIDE_PATTERN.test(text) || PRODUCT_TITLE_PATTERN.test(text) ? 'wide' : 'standard';
}

export function sortCollectionAttributeDefinitions(definitions = []) {
  return [...(Array.isArray(definitions) ? definitions : [])].sort((left, right) => {
    const leftGroup = collectionAttributeLayoutGroup(left);
    const rightGroup = collectionAttributeLayoutGroup(right);
    return leftGroup.order - rightGroup.order
      || (ATTRIBUTE_ORDER.get(definitionId(left)) ?? 10_000) - (ATTRIBUTE_ORDER.get(definitionId(right)) ?? 10_000)
      || Number(Boolean(right.is_required ?? right.isRequired)) - Number(Boolean(left.is_required ?? left.isRequired))
      || clean(left.name ?? left.title).localeCompare(clean(right.name ?? right.title), 'zh-CN');
  });
}

export function groupCollectionAttributeDefinitions(definitions = []) {
  const groups = new Map(ATTRIBUTE_LAYOUT_GROUPS.map((group) => [group.id, { ...group, items: [] }]));
  sortCollectionAttributeDefinitions(definitions).forEach((definition) => {
    groups.get(collectionAttributeLayoutGroup(definition).id).items.push(definition);
  });
  groups.forEach((group) => {
    group.items = [
      ...group.items.filter((item) => collectionAttributeLayoutSpan(item) === 'wide'),
      ...group.items.filter((item) => collectionAttributeLayoutSpan(item) !== 'wide'),
    ];
  });
  return [...groups.values()].filter((group) => group.items.length);
}

export { ATTRIBUTE_LAYOUT_GROUPS };
