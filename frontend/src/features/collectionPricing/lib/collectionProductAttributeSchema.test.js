import { describe, expect, it } from 'vitest';

import {
  buildListingAttributeList,
  normalizeListingAttributeValues,
  splitListingAttributeDefinitions,
  validateListingAttributeValues,
} from './collectionProductAttributeSchema.js';

describe('collection product Ozon attribute schema', () => {
  it('splits Ozon product fields from per-SKU aspect fields without losing complex ids', () => {
    const definitions = [
      { id: '10', name: '品牌', complexId: 0 },
      { id: '20', name: '颜色', isAspect: true, complexId: 7 },
    ];

    const result = splitListingAttributeDefinitions(definitions);

    expect(result.global.map((item) => item.id)).toEqual(['10']);
    expect(result.sku.map((item) => item.id)).toEqual(['20']);
    expect(buildListingAttributeList({ 20: { value: '红色' } }, result.sku)).toEqual([{
      complex_id: 7,
      id: 20,
      values: [{ value: '红色' }],
    }]);
  });

  it('keeps catalog-proven Ozon variation fields per SKU when a later schema omits or resets is_aspect', () => {
    const result = splitListingAttributeDefinitions([
      { id: '9048', name: 'Название модели', isAspect: false },
      { id: '10096', name: 'Цвет товара', isAspect: false },
      { id: '10097', name: 'Название цвета', isAspect: false },
    ]);

    expect(result.global.map((item) => item.id)).toEqual(['9048']);
    expect(result.sku.map((item) => item.id)).toEqual(['10096', '10097']);
  });

  it('requires real Ozon dictionary ids and enforces max_value_count', () => {
    const definition = {
      id: '30', name: '颜色', is_required: true, isDictionary: true,
      isCollection: true, maxValueCount: 2,
    };

    expect(validateListingAttributeValues({ 30: { value: '红色' } }, [definition]).ok).toBe(false);
    const validation = validateListingAttributeValues({
      30: {
        values: ['红色', '蓝色', '黑色'],
        dictionaryValueIds: ['301', '302', '303'],
      },
    }, [definition]);
    expect(validation.ok).toBe(false);
    expect(validation.errors[0]).toContain('最多填写 2 个值');
  });

  it('normalizes localized Boolean values to the canonical strings required by Ozon protobuf', () => {
    const definitions = [
      { id: '40', name: '需要电池', valueType: 'Boolean', is_required: true },
      { id: '41', name: '防水', attribute_type: 'bool' },
    ];

    expect(buildListingAttributeList({
      40: { value: '是' },
      41: { value: 'false' },
    }, definitions)).toEqual([
      { complex_id: 0, id: 40, values: [{ value: 'true' }] },
      { complex_id: 0, id: 41, values: [{ value: 'false' }] },
    ]);
    expect(validateListingAttributeValues({ 40: { value: '可能' } }, definitions).errors[0])
      .toContain('必须填写“是”或“否”');
  });

  it('keeps the real eyewear Boolean attributes as protobuf-safe strings', () => {
    const attributes = buildListingAttributeList({
      9070: { value: 'false' },
      23536: { value: 'Нет' },
    }, [
      { id: '9070', name: '是否为处方镜片', valueType: 'Boolean' },
      { id: '23536', name: '是否支持更换镜片', valueType: 'Boolean' },
    ]);

    expect(attributes).toEqual([
      { complex_id: 0, id: 9070, values: [{ value: 'false' }] },
      { complex_id: 0, id: 23536, values: [{ value: 'false' }] },
    ]);
    expect(attributes.flatMap((attribute) => attribute.values)
      .every(({ value }) => typeof value === 'string')).toBe(true);
    expect(JSON.stringify(attributes)).not.toContain('"value":false');
  });

  it('keeps a complete Rich Content JSON value instead of truncating it at the old 2000 character limit', () => {
    const richContent = JSON.stringify({ content: [{ widgetName: 'raTextBlock', text: 'т'.repeat(5_000) }], version: 0.3 });
    const [attribute] = buildListingAttributeList({ 11254: { value: richContent } }, [{ id: '11254' }]);
    expect(attribute.values[0].value).toBe(richContent);
    expect(attribute.values[0].value.length).toBeGreaterThan(5_000);
  });

  it('omits invented media placeholders and their dependent fields before Ozon upload', () => {
    const attributes = buildListingAttributeList({
      8789: { value: 'Документ PDF отсутствует' },
      8790: { value: 'Документ PDF отсутствует' },
      11254: { value: '{"blocks":[]}' },
      21837: { value: 'Видео не предоставлено' },
      21841: { value: 'Ссылка на видео отсутствует' },
      21845: { value: 'Видео не предоставлено' },
      22273: { value: 'SKU-1' },
    }, [
      { id: '8789' }, { id: '8790' }, { id: '11254' }, { id: '21837' },
      { id: '21841' }, { id: '21845' }, { id: '22273' },
    ]);

    expect(attributes).toEqual([]);
  });

  it('keeps valid PDF and text Rich Content but removes supplier media before upload', () => {
    const richContent = JSON.stringify({
      version: 0.3,
      content: [
        { widgetName: 'raTextBlock', text: 'Описание' },
        { widgetName: 'raVideo', sources: [{ src: 'https://cdn.example.com/video.mp4' }] },
        { widgetName: 'raShowcase', blocks: [{ img: { src: 'https://cdn.example.com/source.jpg' } }] },
      ],
    });
    const attributes = buildListingAttributeList({
      8789: { value: 'Инструкция' },
      8790: { value: 'https://cdn.example.com/manual.pdf' },
      11254: { value: richContent },
      21837: { value: 'Демонстрация' },
      21841: { value: 'https://cdn.example.com/video.mp4' },
      21845: { value: 'https://cdn.example.com/cover.jpg' },
      22273: { value: 'SKU-1' },
    }, [
      { id: '8789' }, { id: '8790' }, { id: '11254' }, { id: '21837' },
      { id: '21841' }, { id: '21845' }, { id: '22273' },
    ]);

    expect(attributes.map((attribute) => attribute.id)).toEqual([8789, 8790, 11254]);
    const persistedRichContent = JSON.parse(attributes.find((attribute) => attribute.id === 11254).values[0].value);
    expect(persistedRichContent.content).toEqual([{ widgetName: 'raTextBlock', text: 'Описание' }]);
  });

  it('clears previously saved invalid media placeholders when reopening a draft', () => {
    const normalized = normalizeListingAttributeValues({
      8789: { value: 'Документ PDF отсутствует', source: 'ai' },
      8790: { value: 'Документ PDF отсутствует', source: 'ai' },
      11254: { value: '{"blocks":[]}', source: 'ai' },
      21837: { value: 'Видео не предоставлено', source: 'ai' },
      21841: { value: 'Ссылка на видео отсутствует', source: 'ai' },
      21845: { value: 'Видео не предоставлено', source: 'ai' },
      22273: { value: 'SKU-1', source: 'ai' },
      10: { value: 'Металл', source: 'manual' },
    });

    expect(normalized).toEqual({
      10: expect.objectContaining({ value: 'Металл', source: 'manual' }),
    });
  });
});
