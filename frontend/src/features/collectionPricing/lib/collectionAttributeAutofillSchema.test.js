import { describe, expect, it } from 'vitest';

import {
  buildCollectionAttributeAiSchema,
  buildCollectionAttributeAiSchemas,
  countCollectionAttributeAiSchemaFields,
} from './collectionAttributeAutofillSchema.js';

describe('collectionAttributeAutofillSchema', () => {
  it('compiles the live Ozon fields into the six verified workflow groups', () => {
    const schema = buildCollectionAttributeAiSchema({
      categoryTitle: '住宅和花园 > 镜框',
      definitions: [
        { id: '1', name: '品牌', is_required: true, isDictionary: true },
        { id: '2', name: '型号名称', is_required: true, valueType: 'String' },
        { id: '3', name: '重量', is_required: true, valueType: 'Decimal', unit: 'g' },
        { id: '4', name: '颜色', is_required: false, isDictionary: true, isCollection: true, maxValueCount: 3 },
        { id: '5', name: '简介', is_required: false, valueType: 'TextArea' },
        { id: '6', name: '高度', is_required: false, valueType: 'Integer', unit: 'cm' },
      ],
      optionsByAttributeId: {
        1: [{ id: '101', label: 'Нет бренда' }],
        4: [{ id: '401', value: 'Черный' }],
      },
    });

    expect(schema.required_dropdown[0]).toMatchObject({ attributeId: '1', options: [{ id: '101', value: 'Нет бренда' }] });
    expect(schema.required_text[0]).toMatchObject({ attributeId: '2', valueKind: 'text' });
    expect(schema.required_numeric[0]).toMatchObject({ attributeId: '3', unit: 'g' });
    expect(schema.optional_dropdown[0]).toMatchObject({ attributeId: '4', isCollection: true, maxValues: 3 });
    expect(schema.optional_text[0]).toMatchObject({ attributeId: '5', valueKind: 'textarea' });
    expect(schema.optional_numeric[0]).toMatchObject({ attributeId: '6', unit: 'cm' });
    expect(countCollectionAttributeAiSchemaFields(schema)).toBe(6);
  });

  it('omits already-filled global fields and keeps SKU fields separate', () => {
    const schemas = buildCollectionAttributeAiSchemas({
      definitions: [
        { id: '10', name: '材质', is_required: true, valueType: 'String' },
        { id: '20', name: '颜色', is_required: true, isAspect: true, isDictionary: true },
      ],
      currentValues: { 10: { value: '金属', source: 'manual' } },
    });

    expect(countCollectionAttributeAiSchemaFields(schemas.global)).toBe(0);
    expect(schemas.sku.required_dropdown).toHaveLength(1);
    expect(schemas.sku.required_dropdown[0].attributeId).toBe('20');
  });

  it('does not ask the text model to invent upload-only media fields', () => {
    const schema = buildCollectionAttributeAiSchema({
      definitions: [
        { id: '10', name: '材质' },
        { id: '8789', name: 'PDF 文件名' },
        { id: '8790', name: 'PDF 文档' },
        { id: '11254', name: '富内容' },
        { id: '21837', name: '视频名称' },
        { id: '21841', name: '视频链接' },
        { id: '21845', name: '视频封面链接' },
        { id: '22273', name: '视频中的商品' },
      ],
    });

    expect(schema.optional_text.map((item) => item.attributeId)).toEqual(['10']);
  });
});
