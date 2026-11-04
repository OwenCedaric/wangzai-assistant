import { describe, expect, it } from 'vitest';
import {
  createProductDescriptionGenerationRequest,
  filterSmartToolOptimizableAttributeRows,
  parseProductFieldSuggestions,
  readSmartToolProductDescription,
  resolveConfiguredTextModel,
} from './smartToolProductDescriptionService.js';

describe('smartToolProductDescriptionService', () => {
  it('prefers GPT-5.5 but allows every ready configured text model', () => {
    const options = [
      { id: 'a', accountId: 'a', model: 'gpt-5.4', ready: true },
      { id: 'b', accountId: 'b', model: 'gpt-5.5', ready: false },
      { id: 'c', accountId: 'c', model: 'gpt-5.5', ready: true },
    ];
    expect(resolveConfiguredTextModel(options)).toMatchObject({ accountId: 'c', model: 'gpt-5.5' });
    expect(resolveConfiguredTextModel(options, 'a')).toMatchObject({ accountId: 'a', model: 'gpt-5.4' });
    expect(resolveConfiguredTextModel([{ id: 'a', accountId: 'a', model: 'gpt-5.4', ready: true }])).toMatchObject({
      model: 'gpt-5.4',
    });
  });

  it('reads attribute 4191 and includes current product facts in the generation request', () => {
    const product = {
      title: '保温杯',
      offerId: 'BX-500',
      attributes: [
        { id: 4191, values: [{ value: 'Старое описание' }] },
        { id: 10096, values: [{ value: 'черный' }] },
      ],
    };
    expect(readSmartToolProductDescription(product)).toBe('Старое описание');
    const request = createProductDescriptionGenerationRequest({
      product,
      sku: { sku: 'SKU-BLACK', facts: '黑色 · 500ml' },
      modelSelection: { accountId: 'text-account', model: 'gpt-5.5', ready: true },
    });
    expect(request).toMatchObject({
      accountId: 'text-account',
      model: 'gpt-5.5',
      templateId: 'product-description.v1',
    });
    expect(request.templateInput).toMatchObject({
      offerId: 'BX-500',
      currentDescription: 'Старое описание',
      sku: 'SKU-BLACK',
    });
  });

  it('keeps generated values as separate known Ozon fields', () => {
    const rows = [
      { id: '4180', attributeId: '4180', label: '商品名称' },
      { id: '4191', attributeId: '4191', label: '商品描述' },
    ];
    expect(
      parseProductFieldSuggestions(
        '{"fields":[{"id":"4191","value":"Новое описание"},{"id":"9999","value":"未知字段"}]}',
        rows
      )
    ).toEqual([{ id: '4191', value: 'Новое описание' }]);
  });

  it('sends only the fields selected by the user as generation targets', () => {
    const request = createProductDescriptionGenerationRequest({
      product: { title: '毛绒玩具', offerId: 'TOY-1' },
      modelSelection: { accountId: 'text-account', model: 'gpt-5.5', ready: true },
      selectedFieldIds: ['4191'],
      attributeRules: {
        optimizationGoal: '只优化当前商品，不创建新商品资料。',
      },
      globalSkillPrompt: '一、商品身份锁定\n不得改变当前 SKU。\n\n二、SKU 专属主图规则\n使用 3:4 构图。',
      editorContext: {
        attributeRows: [
          { id: '4191', attributeId: '4191', label: '商品简介', value: '', filled: false },
          { id: '85', attributeId: '85', label: '品牌', value: '无品牌', filled: true },
        ],
      },
    });

    expect(JSON.stringify(request.templateInput.allowedFields)).toContain('"id":"4191"');
    expect(JSON.stringify(request.templateInput.allowedFields)).not.toContain('"id":"85"');
    expect(request.templateInput.attributeFacts).toContain('品牌：无品牌');
    expect(request.customRules).toContain('只优化当前商品，不创建新商品资料。');
    expect(request.customRules).toContain('不得改变当前 SKU。');
    expect(request.customRules).not.toContain('使用 3:4 构图。');
  });

  it('keeps only copy-optimization fields out of category choices, structural fields and media helpers', () => {
    const rows = [
      { id: '4180', attributeId: '4180', label: '商品标题', isDictionary: false },
      { id: '4191', attributeId: '4191', label: '商品简介', isDictionary: false },
      { id: '7173', attributeId: '7173', label: '毛绒玩具类型', isDictionary: true },
      { id: '8229', attributeId: '8229', label: '商品类型（Ozon 类目）', isDictionary: false },
      { id: '9024', attributeId: '9024', label: '商家货号（Offer ID）', isDictionary: false },
      { id: '21841', attributeId: '21841', label: '视频链接', isDictionary: false },
      { id: '8790', attributeId: '8790', label: 'PDF 文档', isDictionary: false },
    ];

    expect(filterSmartToolOptimizableAttributeRows(rows).map((item) => item.attributeId)).toEqual(['4180', '4191']);
  });
});
