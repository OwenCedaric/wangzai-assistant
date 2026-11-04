import { describe, expect, it, vi } from 'vitest';

import {
  applyCollectionAttributeAutofillResult,
  parseCollectionAttributeAutofillResult,
  preloadCollectionAttributeAutofillDictionaryOptions,
  runCollectionAttributeAutofill,
} from './collectionAttributeAutofillService.js';

const definitions = [
  { id: '10', name: '材质', is_required: true, isDictionary: false },
  { id: '11', name: '品牌', is_required: false, isDictionary: false },
  { id: '20', name: '颜色', is_required: true, isAspect: true, isDictionary: true },
];

const draft = {
  descriptionCategoryId: '17027906',
  typeId: '970713862',
  categoryPath: '住宅和花园 > 镜框',
  title: '变色眼镜框',
  description: '',
  attributeValues: { 11: { value: '人工品牌', source: 'manual' } },
  skus: [
    { sourceSkuId: 'black', sourceSkuName: '黑色', attributeValues: {} },
  ],
};

const product = {
  id: 'p-1',
  title: '感光变色金属眼镜框',
  attributes: [{ name: '材质', value: '金属' }],
  skus: [{ id: 'black', name: '黑色', attributes: [{ name: '颜色', value: '黑色' }] }],
};

const optionsByAttributeId = {
  20: [{ id: '200', value: 'Черный', label: 'Черный' }],
};

const tool = {
  id: 'test-attribute-rules',
  title: '测试属性规则',
  promptConfig: {
    defaultModelId: 'auto',
    systemPrompt: '先核对来源字段，再填写最可靠的内容。',
    userPrompt: '本次真实资料：{{input}}',
    workflowSteps: ['核对来源事实', '输出可靠字段'],
    outputRules: ['不编造'],
    safetyRules: ['选项字段只能用真实 ID'],
  },
};

describe('collectionAttributeAutofillService', () => {
  it('keeps only known fields, real dictionary IDs, real SKU IDs and confident suggestions', () => {
    const parsed = parseCollectionAttributeAutofillResult(JSON.stringify({
      title: 'Фотохромная металлическая оправа',
      description: 'Металлическая оправа для очков.',
      globalAttributes: [
        { attributeId: '10', value: 'Металл', confidence: 0.92, evidence: '来源材质为金属' },
        { attributeId: '999', value: '伪造字段', confidence: 1 },
      ],
      skuAttributes: [
        { sourceSkuId: 'black', attributes: [
          { attributeId: '20', dictionaryValueId: '200', value: 'Черный', confidence: 0.98 },
        ] },
        { sourceSkuId: 'missing', attributes: [
          { attributeId: '20', dictionaryValueId: '200', confidence: 1 },
        ] },
      ],
      unresolved: [{ attributeId: '30', reason: '没有来源资料' }],
    }), { definitions, optionsByAttributeId, draft });

    expect(parsed.globalAttributes).toHaveLength(1);
    expect(parsed.globalAttributes[0].value.value).toBe('Металл');
    expect(parsed.skuAttributes).toHaveLength(1);
    expect(parsed.skuAttributes[0].attributes[0].value).toMatchObject({
      dictionaryValueId: '200', value: 'Черный', source: 'ai',
    });
    expect(parsed.unresolved).toHaveLength(1);
  });

  it('keeps schema-valid low-confidence text for smart completion but rejects fake dictionary ids', () => {
    const parsed = parseCollectionAttributeAutofillResult({
      globalAttributes: [{ attributeId: '10', value: '猜测', confidence: 0.3 }],
      skuAttributes: [{ sourceSkuId: 'black', attributes: [
        { attributeId: '20', dictionaryValueId: '999', value: '不存在', confidence: 1 },
      ] }],
    }, { definitions, optionsByAttributeId, draft });

    expect(parsed.globalAttributes).toHaveLength(1);
    expect(parsed.globalAttributes[0]).toMatchObject({ attributeId: '10', confidence: 0.3 });
    expect(parsed.skuAttributes).toEqual([]);
  });

  it('accepts schema-valid values when the model omits the optional confidence field', () => {
    const parsed = parseCollectionAttributeAutofillResult({
      globalAttributes: [{ attributeId: '10', value: 'Металл', evidence: '来源属性为金属' }],
      skuAttributes: [{ sourceSkuId: 'black', attributes: [
        { attributeId: '20', dictionaryValueId: '200', value: 'Черный' },
      ] }],
    }, { definitions, optionsByAttributeId, draft });

    expect(parsed.globalAttributes[0]).toMatchObject({ attributeId: '10', confidence: 1 });
    expect(parsed.skuAttributes[0].attributes[0]).toMatchObject({ attributeId: '20', confidence: 1 });
  });

  it('normalizes snake_case and object-shaped model values instead of silently dropping them', () => {
    const parsed = parseCollectionAttributeAutofillResult({
      product_title: 'Фотохромные очки',
      global_attributes: [{ attribute_id: '10', value_text: 'Металл', score: 0.93 }],
      sku_attributes: [{
        source_sku_id: 'black',
        attribute_values: [{
          attribute_id: '20',
          value: { id: '200', label: 'Черный' },
          confidence: 0.97,
        }],
      }],
      unresolved_attributes: [{ attribute_id: '30', lookup_terms: ['Нет бренда'], reason: '需查字典' }],
    }, { definitions, optionsByAttributeId, draft });

    expect(parsed.title).toBe('Фотохромные очки');
    expect(parsed.globalAttributes[0]).toMatchObject({ attributeId: '10', value: { value: 'Металл' } });
    expect(parsed.skuAttributes[0].attributes[0]).toMatchObject({
      attributeId: '20', value: { dictionaryValueId: '200', value: 'Черный' },
    });
    expect(parsed.unresolved[0]).toMatchObject({ attributeId: '30', lookupTerms: ['Нет бренда'] });
  });

  it('fills blank fields without overwriting manual values', () => {
    const suggestions = parseCollectionAttributeAutofillResult({
      title: 'Фотохромная металлическая оправа',
      description: 'Металлическая оправа.',
      globalAttributes: [
        { attributeId: '10', value: 'Металл', confidence: 0.9 },
        { attributeId: '11', value: 'AI 品牌', confidence: 0.9 },
      ],
      skuAttributes: [{ sourceSkuId: 'black', attributes: [
        { attributeId: '20', dictionaryValueId: '200', confidence: 0.9 },
      ] }],
    }, { definitions, optionsByAttributeId, draft });
    const applied = applyCollectionAttributeAutofillResult(draft, suggestions, draft);

    expect(applied.draft.title).toBe('Фотохромная металлическая оправа');
    expect(applied.draft.attributeValues[10].value).toBe('Металл');
    expect(applied.draft.attributeValues[11].value).toBe('人工品牌');
    expect(applied.draft.skus[0].attributeValues[20].dictionaryValueId).toBe('200');
    expect(applied.appliedAttributeCount).toBe(2);
    expect(applied.appliedTextCount).toBe(2);
  });

  it('uses the collection module rules without depending on a smart-tool card', async () => {
    const request = vi.fn().mockResolvedValue({
      description: JSON.stringify({
        globalAttributes: [{ attributeId: '10', value: 'Металл', confidence: 0.9 }],
        skuAttributes: [],
        unresolved: [],
      }),
      usage: { total_tokens: 100 },
    });
    const result = await runCollectionAttributeAutofill({
      product,
      draft,
      definitions,
      optionsByAttributeId,
      modelOptions: [
        { id: 'auto', accountId: 'model-1', model: 'gpt-5.6-sol', ready: true, displayName: 'Chat-GPT-5.6-Sol' },
      ],
    }, { request });

    expect(request).toHaveBeenCalledWith('/api/product-descriptions/generate', expect.objectContaining({
      method: 'POST', timeoutMs: 180000,
      body: expect.objectContaining({
        accountId: 'model-1',
        model: 'gpt-5.6-sol',
        temperature: 0.1,
        templateId: 'attribute-autofill.v1',
        templateInput: expect.objectContaining({ pipeline: 'smart-listing-single-wave-20260901' }),
        customRules: expect.stringContaining('当前单轮任务内一次性完成'),
      }),
    }));
    expect(result.suggestions.globalAttributes).toHaveLength(1);
    expect(result.modelLabel).toBe('Chat-GPT-5.6-Sol');
    expect(result.pipeline).toMatchObject({
      modelPoolSize: 1,
      modelAccountCount: 1,
      parallelPhaseExecution: true,
      strictPhaseOrder: false,
    });
  });

  it('fans single-wave jobs across ready API accounts in auto mode', async () => {
    let activeRequests = 0;
    let maximumActiveRequests = 0;
    const usedAccounts = [];
    const request = vi.fn(async (_path, init) => {
      usedAccounts.push(init.body.accountId);
      activeRequests += 1;
      maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
      await new Promise((resolve) => { globalThis.setTimeout(resolve, 5); });
      const payload = init.body.templateInput;
      const globalFields = [
        ...payload.schema.required_dropdown,
        ...payload.schema.required_text,
        ...payload.schema.required_numeric,
        ...payload.schema.optional_dropdown,
        ...payload.schema.optional_text,
        ...payload.schema.optional_numeric,
      ];
      const skuFields = globalFields;
      const response = {
        title: payload.includeTitle ? 'Название товара' : '',
        description: payload.includeDescription ? 'Описание товара в четырех предложениях.' : '',
        tags: payload.includeTags ? Array.from({ length: 11 }, (_item, index) => `тег ${index + 1}`) : [],
        skuTitles: payload.includeSkuTitles
          ? (payload.skus || []).map((sku) => ({ sourceSkuId: sku.sourceSkuId, title: `Название ${sku.sourceSkuId}` }))
          : [],
        globalAttributes: payload.mode === 'global'
          ? globalFields.map((field) => ({ attributeId: field.attributeId, value: `Значение ${field.attributeId}` }))
          : [],
        skuAttributes: payload.mode === 'sku'
          ? (payload.skus || []).map((sku) => ({
              sourceSkuId: sku.sourceSkuId,
              attributes: skuFields.map((field) => ({
                attributeId: field.attributeId,
                dictionaryValueId: field.attributeId === '20' ? '200' : '',
                value: field.attributeId === '20' ? 'Черный' : `Значение ${field.attributeId}`,
              })),
            }))
          : [],
        unresolved: [],
      };
      activeRequests -= 1;
      return { description: JSON.stringify(response), model: init.body.model };
    });

    const result = await runCollectionAttributeAutofill({
      product,
      draft,
      definitions,
      optionsByAttributeId,
      selectedModelId: 'auto',
      modelOptions: [
        { id: 'auto', accountId: 'account-a', model: 'model-a', ready: true, displayName: 'Model A' },
        { id: 'account-a', accountId: 'account-a', model: 'model-a', ready: true, isPrimary: true },
        { id: 'account-b', accountId: 'account-b', model: 'model-b', ready: true, isPrimary: true },
        { id: 'account-c', accountId: 'account-c', model: 'model-c', ready: true, isPrimary: true },
      ],
    }, { request, enableVision: false });

    expect(new Set(usedAccounts)).toEqual(new Set(['account-a', 'account-b']));
    expect(maximumActiveRequests).toBeGreaterThan(1);
    expect(result.modelLabel).toBe('3 路模型接口并行');
    expect(result.pipeline).toMatchObject({
      modelPoolSize: 3,
      modelAccountCount: 3,
      modelConcurrency: 2,
      parallelPhaseExecution: true,
      strictPhaseOrder: false,
    });
  });

  it('processes every SKU through verified batches instead of truncating the tail', async () => {
    const manySkus = Array.from({ length: 17 }, (_item, index) => ({
      sourceSkuId: `sku-${index + 1}`,
      sourceSkuName: `规格 ${index + 1}`,
      attributeValues: {},
    }));
    const batchedDraft = { ...draft, skus: manySkus };
    const batchedProduct = {
      ...product,
      skus: manySkus.map((item) => ({ id: item.sourceSkuId, name: item.sourceSkuName })),
    };
    const request = vi.fn(async (_path, init) => {
      const payload = init.body.templateInput;
      return {
        description: JSON.stringify({
          title: payload.includeTitleAndDescription ? 'Полное название' : '',
          description: payload.includeTitleAndDescription ? 'Полное описание' : '',
          globalAttributes: [],
          skuAttributes: (payload.skus || []).map((item) => ({
            sourceSkuId: item.sourceSkuId,
            attributes: [{ attributeId: '20', dictionaryValueId: '200', confidence: 0.96 }],
          })),
          unresolved: [],
        }),
      };
    });

    const result = await runCollectionAttributeAutofill({
      product: batchedProduct,
      draft: batchedDraft,
      definitions,
      optionsByAttributeId,
      tool,
      modelOptions: [{ id: 'auto', accountId: 'model-1', model: 'gpt-5.6-sol', ready: true }],
    }, { request });

    expect(request).toHaveBeenCalledTimes(4); // 1 个公共任务 + 1 个 SKU 任务；公共必填缺项局部修正 2 次
    expect(result.suggestions.skuAttributes).toHaveLength(17);
    expect(result.suggestions.skuAttributes.at(-1).sourceSkuId).toBe('sku-17');
    expect(result.pipeline.modelBatchCount).toBe(2);
    expect(result.pipeline.modelRoundCount).toBe(3);
    expect(result.pipeline.modelConcurrency).toBe(2);
    expect(result.pipeline.skuBatchSize).toBe(22);
  });

  it('keeps all 82 source SKUs in the eyeglass-frame scale scenario', async () => {
    const skus = Array.from({ length: 82 }, (_value, index) => ({
      sourceSkuId: `frame-${index + 1}`,
      sourceSkuName: `眼镜款式 ${index + 1}`,
      attributeValues: {},
    }));
    let activeRequests = 0;
    let maximumActiveRequests = 0;
    const request = vi.fn(async (_path, init) => {
      activeRequests += 1;
      maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
      await Promise.resolve();
      const payload = init.body.templateInput;
      const response = {
        description: JSON.stringify({
          title: payload.includeTitleAndDescription ? 'Очки без диоптрий' : '',
          description: '',
          globalAttributes: [],
          skuAttributes: (payload.skus || []).map((item) => ({
            sourceSkuId: item.sourceSkuId,
            attributes: [{ attributeId: '20', dictionaryValueId: '200', confidence: 0.95 }],
          })),
          unresolved: [],
        }),
      };
      activeRequests -= 1;
      return response;
    });

    const result = await runCollectionAttributeAutofill({
      product: { ...product, skus: skus.map((item) => ({ id: item.sourceSkuId, name: item.sourceSkuName })) },
      draft: { ...draft, skus },
      definitions: [definitions[2]],
      optionsByAttributeId,
      tool,
      modelOptions: [{ id: 'auto', accountId: 'model-1', model: 'gpt-5.6-sol', ready: true }],
    }, { request, enableVision: false });

    expect(request).toHaveBeenCalledTimes(5); // 1 个公共任务 + ceil(82 / 22) 个 SKU 任务
    expect(maximumActiveRequests).toBe(5);
    expect(result.pipeline.modelBatchCount).toBe(5);
    expect(result.pipeline.modelRoundCount).toBe(1);
    expect(result.pipeline.modelConcurrency).toBe(5);
    expect(result.suggestions.skuAttributes).toHaveLength(82);
    expect(result.suggestions.skuAttributes.at(-1).sourceSkuId).toBe('frame-82');
  });

  it('does not repair an omitted optional field after every required field is resolved', async () => {
    const repairDefinitions = [
      { id: '10', name: '材质', is_required: true, valueType: 'String' },
      { id: '12', name: '镜框形状', is_required: false, valueType: 'String' },
    ];
    const request = vi.fn(async (_path, init) => {
      const payload = init.body.templateInput;
      const fieldIds = [
        ...payload.schema.required_text,
        ...payload.schema.optional_text,
      ].map((field) => field.attributeId);
      if (payload.phase === 'single-wave') expect(fieldIds).toEqual(['10', '12']);
      return {
        description: JSON.stringify({
          globalAttributes: [{ attributeId: '10', value: 'Металл', confidence: 0.95 }],
          skuAttributes: [],
          unresolved: [],
        }),
      };
    });

    const result = await runCollectionAttributeAutofill({
      product,
      draft: { ...draft, attributeValues: {}, skus: [] },
      definitions: repairDefinitions,
      optionsByAttributeId: {},
      tool,
      modelOptions: [{ id: 'auto', accountId: 'model-1', model: 'gpt-5.6-sol', ready: true }],
    }, { request, enableVision: false });

    expect(request).toHaveBeenCalledTimes(1);
    expect(result.suggestions.globalAttributes.map((item) => item.attributeId)).toEqual(['10']);
    expect(result.suggestions.unresolved).toEqual([
      expect.objectContaining({ attributeId: '12', reason: expect.stringContaining('人工确认') }),
    ]);
    expect(result.pipeline.modelRoundCount).toBe(1);
    expect(result.pipeline.repairAttemptCount).toBe(0);
  });

  it('processes every live Ozon attribute through field batches instead of keeping only the first page', async () => {
    const manyDefinitions = Array.from({ length: 33 }, (_item, index) => ({
      id: String(1000 + index),
      name: `属性 ${index + 1}`,
      is_required: index < 5,
      valueType: 'String',
    }));
    const request = vi.fn(async (_path, init) => {
      const payload = init.body.templateInput;
      const fields = [
        ...payload.schema.required_dropdown,
        ...payload.schema.required_text,
        ...payload.schema.required_numeric,
        ...payload.schema.optional_dropdown,
        ...payload.schema.optional_text,
        ...payload.schema.optional_numeric,
      ];
      return {
        description: JSON.stringify({
          title: payload.includeTitleAndDescription ? 'Название' : '',
          description: '',
          globalAttributes: fields.map((field) => ({
            attributeId: field.attributeId,
            value: `Значение ${field.attributeId}`,
            confidence: 0.9,
          })),
          skuAttributes: [],
          unresolved: [],
        }),
      };
    });

    const result = await runCollectionAttributeAutofill({
      product,
      draft: { ...draft, skus: [] },
      definitions: manyDefinitions,
      optionsByAttributeId: {},
      tool,
      modelOptions: [{ id: 'auto', accountId: 'model-1', model: 'gpt-5.6-sol', ready: true }],
    }, { request });

    expect(request).toHaveBeenCalledTimes(1); // 公共文案和 33 个公共字段合并为一次
    expect(result.pipeline.modelConcurrency).toBe(1);
    expect(result.suggestions.globalAttributes).toHaveLength(33);
    expect(result.suggestions.globalAttributes.at(-1).attributeId).toBe('1032');
  });

  it('preloads Ozon choices into the model schema and writes the official option id directly', async () => {
    const dictionaryDefinitions = [
      { id: '30', name: '材质选项', is_required: true, isDictionary: true },
    ];
    const request = vi.fn().mockResolvedValue({
      description: JSON.stringify({
        globalAttributes: [{
          attributeId: '30',
          value: 'Металл',
          lookupTerms: ['Металл'],
          confidence: 0.95,
          evidence: '来源资料显示金属',
        }],
        skuAttributes: [],
        unresolved: [],
      }),
    });
    const searchAttributeOptions = vi.fn().mockResolvedValue([
      { id: '3001', label: 'Металл' },
    ]);

    const result = await runCollectionAttributeAutofill({
      product,
      draft,
      definitions: dictionaryDefinitions,
      optionsByAttributeId: {},
      tool,
      modelOptions: [{ id: 'auto', accountId: 'model-1', model: 'gpt-5.6-sol', ready: true }],
    }, { request, searchAttributeOptions });

    expect(searchAttributeOptions).toHaveBeenCalledWith('30', '', expect.objectContaining({
      preferCache: true,
      cacheOnly: true,
      bulk: true,
    }));
    const promptPayload = request.mock.calls[0][1].body.templateInput;
    expect(promptPayload.schema.required_dropdown[0].options).toEqual([
      expect.objectContaining({ id: '3001', value: 'Металл' }),
    ]);
    expect(result.suggestions.globalAttributes[0].value).toMatchObject({
      dictionaryValueId: '3001',
      value: 'Металл',
    });
    expect(result.optionsByAttributeId[30][0].id).toBe('3001');
    expect(result.pipeline.dictionaryPreloadCount).toBe(1);
    expect(result.pipeline.dictionarySearchCount).toBe(0);
  });

  it('uses the fixed official no-brand option without loading the large brand dictionary', async () => {
    const searchAttributeOptions = vi.fn();
    const result = await preloadCollectionAttributeAutofillDictionaryOptions({
      definitions: [{ id: '85', name: 'Бренд', isDictionary: true }],
      optionsByAttributeId: {},
      searchAttributeOptions,
    });

    expect(searchAttributeOptions).not.toHaveBeenCalled();
    expect(result.requestCount).toBe(0);
    expect(result.optionsByAttributeId[85]).toEqual([
      expect.objectContaining({ id: '126745801', label: 'Нет бренда' }),
    ]);
  });

  it('keeps the full UTF-8 request below 29KB and prioritizes a relevant option beyond the dictionary head', async () => {
    const largeOptions = Array.from({ length: 240 }, (_item, index) => ({
      id: `option-${index + 1}`,
      label: `无关候选-${index + 1}-${'很长'.repeat(20)}`,
    }));
    largeOptions.push({ id: 'official-red', label: 'Красный' });
    const requestBodies = [];
    const request = vi.fn(async (_path, init) => {
      requestBodies.push(init.body);
      const payload = init.body.templateInput;
      const fields = [
        ...payload.schema.required_dropdown,
        ...payload.schema.optional_dropdown,
      ];
      return {
        description: JSON.stringify({
          title: payload.includeTitle ? 'Красная модель с проверенными характеристиками' : '',
          description: payload.includeDescription ? 'Описание основано на проверенных характеристиках товара.' : '',
          tags: payload.includeTags ? Array.from({ length: 11 }, (_value, index) => `красный товар ${index}`) : [],
          skuTitles: payload.includeSkuTitles ? payload.skus.map((sku) => ({ sourceSkuId: sku.sourceSkuId, title: `Красная модель ${sku.sourceSkuId}` })) : [],
          globalAttributes: [],
          skuAttributes: payload.mode === 'sku' ? payload.skus.map((sku) => ({
            sourceSkuId: sku.sourceSkuId,
            attributes: fields.map((field) => ({ attributeId: field.attributeId, dictionaryValueId: 'official-red', value: 'Красный' })),
          })) : [],
          unresolved: [],
        }),
      };
    });
    const longSourceAttributes = Array.from({ length: 40 }, (_item, index) => ({
      name: `来源字段${index}`,
      value: `${'很长的来源资料'.repeat(80)}${index}`,
    }));
    await runCollectionAttributeAutofill({
      product: {
        ...product,
        description: '商品长描述'.repeat(2_000),
        attributes: longSourceAttributes,
        skus: [{ id: 'red-sku', name: '红色', attributes: longSourceAttributes }],
      },
      draft: {
        ...draft,
        skus: [{ sourceSkuId: 'red-sku', sourceSkuName: '红色', attributeValues: {} }],
      },
      definitions: [{ id: '20', name: '颜色', isAspect: true, isDictionary: true }],
      optionsByAttributeId: { 20: largeOptions },
      tool,
      modelOptions: [{ id: 'auto', accountId: 'model-1', model: 'gpt-5.6-sol', ready: true }],
    }, { request, enableVision: false });

    expect(requestBodies.length).toBeGreaterThan(0);
    expect(Math.max(...requestBodies.map((body) => new TextEncoder().encode(JSON.stringify(body)).byteLength))).toBeLessThan(29_000);
    const colorField = requestBodies.flatMap((body) => [
      ...body.templateInput.schema.required_dropdown,
      ...body.templateInput.schema.optional_dropdown,
    ])
      .find((field) => field.attributeId === '20');
    expect(colorField.options).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'official-red', value: 'Красный' }),
    ]));
    expect(colorField.options).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'option-1' }),
    ]));
  });

  it('uses bounded visual facts to select a legal dictionary option when source text has no value', async () => {
    const dictionary = Array.from({ length: 80 }, (_item, index) => ({ id: `other-${index}`, label: `Другой ${index}` }));
    dictionary.push({ id: 'official-black', label: 'Черный' });
    let promptedOptions = [];
    const request = vi.fn(async (path, init) => {
      if (path === '/api/image-prompt-plans/generate') return { planText: '图片事实：镜框颜色为黑色, черный.' };
      const payload = init.body.templateInput;
      const field = [...payload.schema.required_dropdown, ...payload.schema.optional_dropdown]
        .find((item) => item.attributeId === '20');
      if (field) promptedOptions = field.options;
      return {
        description: JSON.stringify({
          title: payload.includeTitle ? 'Модель с проверенными характеристиками' : '',
          description: payload.includeDescription ? 'Описание основано на проверенных характеристиках.' : '',
          tags: payload.includeTags ? Array.from({ length: 11 }, (_value, index) => `товар ${index}`) : [],
          skuTitles: payload.includeSkuTitles ? payload.skus.map((sku) => ({ sourceSkuId: sku.sourceSkuId, title: `Модель ${sku.sourceSkuId}` })) : [],
          globalAttributes: [],
          skuAttributes: field ? payload.skus.map((sku) => ({
            sourceSkuId: sku.sourceSkuId,
            attributes: [{ attributeId: '20', dictionaryValueId: 'official-black', value: 'Черный' }],
          })) : [],
          unresolved: [],
        }),
      };
    });
    const result = await runCollectionAttributeAutofill({
      product: { ...product, mainImages: ['https://img.example.com/black.jpg'], skus: [{ id: 'plain', name: '款式一' }] },
      draft: { ...draft, skus: [{ sourceSkuId: 'plain', sourceSkuName: '款式一', attributeValues: {} }] },
      definitions: [{ id: '20', name: '颜色', isAspect: true, isDictionary: true }],
      optionsByAttributeId: { 20: dictionary },
      tool,
      modelOptions: [{ id: 'auto', accountId: 'model-1', model: 'gpt-5.6-sol', ready: true }],
    }, { request });

    expect(promptedOptions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'official-black', value: 'Черный' }),
    ]));
    expect(result.suggestions.skuAttributes[0].attributes[0].value.dictionaryValueId).toBe('official-black');
  });

  it('promotes unresolved dictionary lookup terms and keeps every official multi-select match', async () => {
    const request = vi.fn().mockResolvedValue({
      description: JSON.stringify({
        global_attributes: [],
        sku_attributes: [],
        unresolved: [{
          scope: 'global',
          attribute_id: '31',
          lookup_terms: ['Мужской', 'Женский'],
          reason: '需要查询 Ozon 标准值',
        }],
      }),
    });
    const searchAttributeOptions = vi.fn(async () => ([
      { id: 'male', label: 'Мужской' },
      { id: 'female', label: 'Женский' },
    ]));
    const result = await runCollectionAttributeAutofill({
      product,
      draft: { ...draft, attributeValues: {}, skus: [] },
      definitions: [{
        id: '31', name: 'Пол', is_required: true, isDictionary: true, isCollection: true, maxValueCount: 5,
      }],
      optionsByAttributeId: {},
      tool,
      modelOptions: [{ id: 'auto', accountId: 'model-1', model: 'gpt-5.6-sol', ready: true }],
    }, { request, searchAttributeOptions, enableVision: false });

    expect(searchAttributeOptions).toHaveBeenCalledTimes(1);
    expect(result.pipeline.dictionaryPreloadCount).toBe(1);
    expect(result.suggestions.globalAttributes[0].value).toMatchObject({
      values: ['Мужской', 'Женский'],
      dictionaryValueIds: ['male', 'female'],
    });
    expect(result.suggestions.unresolved).toEqual([]);
  });

  it('prefetches a shared Ozon dictionary once for many SKU candidates without dropping any fill', async () => {
    const colors = [
      ['gold', 'Золотой'],
      ['silver', 'Серебристый'],
      ['black', 'Черный'],
      ['brown', 'Коричневый'],
    ];
    const colorSkus = colors.map(([id, label]) => ({
      sourceSkuId: id,
      sourceSkuName: label,
      attributeValues: {},
    }));
    const request = vi.fn(async (_path, init) => {
      const payload = init.body.templateInput;
      return {
        description: JSON.stringify({
          globalAttributes: [],
          skuAttributes: (payload.skus || []).map((sku) => ({
            sourceSkuId: sku.sourceSkuId,
            attributes: [{
              attributeId: '20',
              value: sku.sourceSkuName,
              lookupTerms: [sku.sourceSkuName],
              confidence: 0.98,
            }],
          })),
          unresolved: [],
        }),
      };
    });
    const searchAttributeOptions = vi.fn(async (_attributeId, query) => {
      expect(query).toBe('');
      return colors.map(([id, label]) => ({ id, label }));
    });

    const result = await runCollectionAttributeAutofill({
      product: { ...product, skus: colorSkus.map((item) => ({ id: item.sourceSkuId, name: item.sourceSkuName })) },
      draft: { ...draft, skus: colorSkus },
      definitions: [definitions[2]],
      optionsByAttributeId: {},
      tool,
      modelOptions: [{ id: 'auto', accountId: 'model-1', model: 'gpt-5.6-sol', ready: true }],
    }, { request, searchAttributeOptions, enableVision: false });

    expect(searchAttributeOptions).toHaveBeenCalledTimes(1);
    expect(result.pipeline.dictionaryPreloadCount).toBe(1);
    expect(result.pipeline.dictionarySearchCount).toBe(0);
    expect(result.suggestions.skuAttributes).toHaveLength(4);
    expect(result.suggestions.skuAttributes.every((item) => item.attributes.length === 1)).toBe(true);
  });

  it('caps each SKU response matrix so the JSON tail is not lost by compatible models', async () => {
    const skuDefinitions = Array.from({ length: 9 }, (_item, index) => ({
      id: String(200 + index), name: `SKU 属性 ${index + 1}`, isAspect: true, valueType: 'String',
    }));
    const skus = Array.from({ length: 6 }, (_item, index) => ({
      sourceSkuId: `safe-${index + 1}`, sourceSkuName: `安全规格 ${index + 1}`, attributeValues: {},
    }));
    const matrixSizes = [];
    const request = vi.fn(async (_path, init) => {
      const payload = init.body.templateInput;
      const fields = [...payload.schema.required_text, ...payload.schema.optional_text];
      if (payload.mode === 'sku') matrixSizes.push(fields.length * payload.skus.length);
      return {
        description: JSON.stringify({
          globalAttributes: [],
          skuAttributes: (payload.skus || []).map((sku) => ({
            sourceSkuId: sku.sourceSkuId,
              attributes: fields.map((field) => ({ attributeId: field.attributeId, value: 'Надежное значение' })),
          })),
          unresolved: [],
        }),
      };
    });
    const result = await runCollectionAttributeAutofill({
      product: { ...product, skus: skus.map((item) => ({ id: item.sourceSkuId, name: item.sourceSkuName })) },
      draft: { ...draft, attributeValues: {}, skus },
      definitions: skuDefinitions,
      optionsByAttributeId: {},
      tool,
      modelOptions: [{ id: 'auto', accountId: 'model-1', model: 'gpt-5.6-sol', ready: true }],
    }, { request, enableVision: false });

    expect(Math.max(...matrixSizes)).toBeLessThanOrEqual(56); // 每批固定最多 7 SKU × 8 字段
    expect(result.pipeline.schemaCellCount).toBe(54);
    expect(result.suggestions.skuAttributes).toHaveLength(6);
    expect(result.suggestions.skuAttributes.every((item) => item.attributes.length === 9)).toBe(true);
  });

  it('marks a dictionary suggestion for manual confirmation when no official Ozon option matches', async () => {
    const request = vi.fn().mockResolvedValue({
      description: JSON.stringify({
        globalAttributes: [{ attributeId: '30', value: '不存在的品牌', lookupTerms: ['不存在的品牌'] }],
        skuAttributes: [],
        unresolved: [],
      }),
    });
    const result = await runCollectionAttributeAutofill({
      product,
      draft: { ...draft, attributeValues: {}, skus: [] },
      definitions: [{ id: '30', name: '品牌', is_required: true, isDictionary: true }],
      optionsByAttributeId: {},
      tool,
      modelOptions: [{ id: 'auto', accountId: 'model-1', model: 'gpt-5.6-sol', ready: true }],
    }, { request, searchAttributeOptions: vi.fn().mockResolvedValue([]), enableVision: false });

    expect(result.suggestions.globalAttributes).toEqual([]);
    expect(result.suggestions.unresolved).toEqual([
      expect.objectContaining({ attributeId: '30', reason: expect.stringContaining('Ozon') }),
    ]);
  });

  it('does not report SKU fields that already contain a manual value', async () => {
    const request = vi.fn().mockResolvedValue({
      description: JSON.stringify({ globalAttributes: [], skuAttributes: [], unresolved: [] }),
    });
    const result = await runCollectionAttributeAutofill({
      product,
      draft: {
        ...draft,
        attributeValues: {},
        skus: [{
          ...draft.skus[0],
          attributeValues: { 20: { value: 'Черный', dictionaryValueId: '200', source: 'manual' } },
        }],
      },
      definitions: [definitions[2]],
      optionsByAttributeId,
      tool,
      modelOptions: [{ id: 'auto', accountId: 'model-1', model: 'gpt-5.6-sol', ready: true }],
    }, { request, enableVision: false });

    expect(request).toHaveBeenCalledTimes(2); // 公共文案与逐 SKU 标题同轮并行
    expect(result.pipeline.modelRoundCount).toBe(1);
    expect(result.suggestions.unresolved).toEqual([]);
  });

  it('uses image facts first and passes the visual report into the text filling request', async () => {
    const visualProduct = { ...product, mainImages: ['https://img.example.com/frame.jpg'] };
    const request = vi.fn(async (path, init) => {
      if (path === '/api/image-prompt-plans/generate') {
        expect(init.body.referenceImages).toEqual([{ url: 'https://img.example.com/frame.jpg', sourceIndex: 0 }]);
        return { planText: '{"globalFacts":[{"attributeId":"10","value":"金属","evidence":"图片可见"}]}' };
      }
      const payload = init.body.templateInput;
      expect(payload.visualReport).toContain('图片可见');
      return {
        description: JSON.stringify({
          globalAttributes: [{ attributeId: '10', value: 'Металл', confidence: 0.96, evidence: '图片可见金属框' }],
          skuAttributes: [],
          unresolved: [],
        }),
      };
    });

    const result = await runCollectionAttributeAutofill({
      product: visualProduct,
      draft: { ...draft, skus: [] },
      definitions: definitions.filter((item) => !item.isAspect),
      optionsByAttributeId,
      tool,
      modelOptions: [{ id: 'auto', accountId: 'model-1', model: 'gpt-5.6-sol', ready: true }],
    }, { request });

    expect(request.mock.calls[0][0]).toBe('/api/image-prompt-plans/generate');
    expect(result.pipeline.visualAnalysisUsed).toBe(true);
    expect(result.suggestions.globalAttributes[0].attributeId).toBe('10');
  });

  it('accepts real numeric values and rejects nonnumeric guesses', () => {
    const numericDefinitions = [
      { id: '40', name: '重量', is_required: true, valueType: 'Decimal' },
      { id: '41', name: '高度', is_required: false, valueType: 'Integer' },
    ];
    const parsed = parseCollectionAttributeAutofillResult({
      globalAttributes: [
        { attributeId: '40', value: '12,5', confidence: 0.9 },
        { attributeId: '41', value: '猜测', confidence: 0.99 },
      ],
    }, { definitions: numericDefinitions, draft });

    expect(parsed.globalAttributes).toHaveLength(1);
    expect(parsed.globalAttributes[0]).toMatchObject({ attributeId: '40', value: { value: '12.5' } });
  });

  it('does not create model jobs for Russian text and attribute cells that are already filled', async () => {
    const request = vi.fn();
    const searchAttributeOptions = vi.fn();
    const filledTags = Array.from({ length: 11 }, (_item, index) => `готовый тег ${index + 1}`);
    const result = await runCollectionAttributeAutofill({
      product,
      draft: {
        ...draft,
        title: 'Готовое название товара',
        description: 'Готовое описание товара.',
        tags: filledTags,
        attributeValues: { 10: { value: 'Металл', source: 'manual' } },
        skus: [{
          ...draft.skus[0],
          title: 'Готовое название варианта',
          attributeValues: { 20: { value: 'Черный', dictionaryValueId: '200', source: 'manual' } },
        }],
      },
      definitions: [definitions[0], definitions[2]],
      optionsByAttributeId: {},
      tool,
      modelOptions: [{ id: 'auto', accountId: 'model-1', model: 'gpt-5.6-sol', ready: true }],
    }, { request, searchAttributeOptions, enableVision: false });

    expect(request).not.toHaveBeenCalled();
    expect(searchAttributeOptions).not.toHaveBeenCalled();
    expect(result.pipeline.modelBatchCount).toBe(0);
    expect(result.pipeline.modelRequestCount).toBe(0);
    expect(result.pipeline.dictionaryPreloadCount).toBe(0);
  });

  it('still preloads official options when any dictionary cell is pending', async () => {
    const searchAttributeOptions = vi.fn().mockResolvedValue([
      { id: 'official-black', label: 'Черный' },
    ]);
    const request = vi.fn(async (_path, init) => {
      const payload = init.body.templateInput;
      return {
        description: JSON.stringify({
          skuAttributes: payload.skus.map((sku) => ({
            sourceSkuId: sku.sourceSkuId,
            attributes: [{ attributeId: '20', dictionaryValueId: 'official-black', value: 'Черный' }],
          })),
          unresolved: [],
        }),
      };
    });
    const result = await runCollectionAttributeAutofill({
      product,
      draft: {
        ...draft,
        title: 'Готовое название товара',
        description: 'Готовое описание товара.',
        tags: Array.from({ length: 11 }, (_item, index) => `готовый тег ${index}`),
        skus: [{ ...draft.skus[0], title: 'Готовое название варианта', attributeValues: {} }],
      },
      definitions: [definitions[2]],
      optionsByAttributeId: {},
      tool,
      modelOptions: [{ id: 'auto', accountId: 'model-1', model: 'gpt-5.6-sol', ready: true }],
    }, { request, searchAttributeOptions, enableVision: false });

    expect(searchAttributeOptions).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
    expect(result.pipeline).toMatchObject({ dictionaryPreloadCount: 1, modelRequestCount: 1 });
  });

  it('uses a compact response contract without repeating evidence or lookup explanations', async () => {
    const requestBodies = [];
    const request = vi.fn(async (_path, init) => {
      requestBodies.push(init.body);
      const payload = init.body.templateInput;
      const fields = [
        ...payload.schema.required_dropdown,
        ...payload.schema.required_text,
        ...payload.schema.required_numeric,
        ...payload.schema.optional_dropdown,
        ...payload.schema.optional_text,
        ...payload.schema.optional_numeric,
      ];
      const attributes = fields.map((field) => ({
        attributeId: field.attributeId,
        value: field.options?.[0]?.value || `Значение ${field.attributeId}`,
        dictionaryValueId: field.options?.[0]?.id || '',
        confidence: 0.99,
      }));
      return {
        description: JSON.stringify({
          title: payload.includeTitle ? 'Проверенное название товара' : undefined,
          description: payload.includeDescription ? 'Проверенное описание товара.' : undefined,
          tags: payload.includeTags ? Array.from({ length: 11 }, (_item, index) => `проверенный тег ${index}`) : undefined,
          globalAttributes: payload.mode === 'global' ? attributes : undefined,
          skuAttributes: payload.mode === 'sku' ? payload.skus.map((sku) => ({
            sourceSkuId: sku.sourceSkuId,
            attributes,
          })) : undefined,
          unresolved: [],
        }),
      };
    });

    await runCollectionAttributeAutofill({
      product,
      draft: { ...draft, attributeValues: {}, skus: [draft.skus[0]] },
      definitions: [definitions[0], definitions[2]],
      optionsByAttributeId,
      tool,
      modelOptions: [{ id: 'auto', accountId: 'model-1', model: 'gpt-5.6-sol', ready: true }],
    }, { request, enableVision: false, sharedSkuTitle: true });

    expect(requestBodies.length).toBeGreaterThan(0);
    requestBodies.forEach((body) => {
      const contract = JSON.stringify(body.templateInput.outputContract);
      expect(contract).not.toContain('evidence');
      expect(contract).not.toContain('lookupTerms');
      expect(contract).not.toContain('reason');
      expect(body.customRules).toContain('禁止输出长原因');
      expect(body.reasoningEffort).toBe('low');
    });
  });

  it('starts every planned model job in one concurrency wave', async () => {
    const starts = [];
    let activeRequests = 0;
    let maximumActiveRequests = 0;
    const request = vi.fn(async (_path, init) => {
      const payload = init.body.templateInput;
      starts.push(payload.phase);
      activeRequests += 1;
      maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
      await new Promise((resolve) => { globalThis.setTimeout(resolve, 4); });
      const fields = [
        ...payload.schema.required_dropdown,
        ...payload.schema.required_text,
        ...payload.schema.required_numeric,
        ...payload.schema.optional_dropdown,
        ...payload.schema.optional_text,
        ...payload.schema.optional_numeric,
      ];
      activeRequests -= 1;
      return {
        description: JSON.stringify({
          title: payload.includeTitle ? 'Проверенное название товара' : '',
          description: payload.includeDescription ? 'Проверенное описание товара.' : '',
          tags: payload.includeTags ? Array.from({ length: 11 }, (_item, index) => `проверенный тег ${index}`) : [],
          skuTitles: payload.includeSkuTitles ? payload.skus.map((sku) => ({ sourceSkuId: sku.sourceSkuId, title: `Проверенный вариант ${sku.sourceSkuId}` })) : [],
          globalAttributes: payload.mode === 'global' ? fields.map((field) => ({
            attributeId: field.attributeId,
            value: field.options?.[0]?.value || `Значение ${field.attributeId}`,
            dictionaryValueId: field.options?.[0]?.id || '',
          })) : [],
          skuAttributes: payload.mode === 'sku' ? payload.skus.map((sku) => ({
            sourceSkuId: sku.sourceSkuId,
            attributes: fields.map((field) => ({ attributeId: field.attributeId, value: `Значение ${field.attributeId}` })),
          })) : [],
          unresolved: [],
        }),
      };
    });
    const waveSkus = Array.from({ length: 45 }, (_item, index) => ({
      sourceSkuId: `wave-${index + 1}`,
      sourceSkuName: `规格 ${index + 1}`,
      attributeValues: {},
    }));
    await runCollectionAttributeAutofill({
      product: { ...product, skus: waveSkus.map((item) => ({ id: item.sourceSkuId, name: item.sourceSkuName })) },
      draft: { ...draft, attributeValues: {}, skus: waveSkus },
      definitions: [
        { id: 'select', name: 'Тип', isDictionary: true },
        { id: 'sku-text', name: 'Материал SKU', valueType: 'String', isAspect: true },
      ],
      optionsByAttributeId: {
        select: [{ id: 'select-1', label: 'Тип один' }],
      },
      tool,
      modelOptions: [{ id: 'auto', accountId: 'model-1', model: 'gpt-5.6-sol', ready: true }],
    }, { request, enableVision: false });

    expect(starts).toEqual(Array(4).fill('single-wave'));
    expect(maximumActiveRequests).toBe(4);
  });

  it('keeps 109 SKUs in one six-request wave without touching the 60-second rate-limit wait', async () => {
    const skus = Array.from({ length: 109 }, (_item, index) => ({
      sourceSkuId: `sku-${index + 1}`,
      sourceSkuName: `规格 ${index + 1}`,
      attributeValues: {},
    }));
    const scaleDefinitions = [
      ...Array.from({ length: 4 }, (_item, index) => ({
        id: `select-${index + 1}`, name: `选择 ${index + 1}`, isAspect: true, isDictionary: true,
      })),
      ...Array.from({ length: 4 }, (_item, index) => ({
        id: `text-${index + 1}`, name: `文本 ${index + 1}`, isAspect: true, valueType: 'String',
      })),
    ];
    const scaleOptions = Object.fromEntries(scaleDefinitions.filter((item) => item.isDictionary).map((item) => [
      item.id,
      [{ id: `${item.id}-value`, label: `Значение ${item.id}` }],
    ]));
    let simulatedNow = 0;
    const requestStarts = [];
    const requestBodies = [];
    let activeRequests = 0;
    let maximumActiveRequests = 0;
    const request = vi.fn(async (_path, init) => {
      requestStarts.push(simulatedNow);
      requestBodies.push(init.body);
      activeRequests += 1;
      maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
      await Promise.resolve();
      const payload = init.body.templateInput;
      const fields = [
        ...payload.schema.required_dropdown,
        ...payload.schema.required_text,
        ...payload.schema.optional_dropdown,
        ...payload.schema.optional_text,
      ];
      const response = {
        description: JSON.stringify({
          title: payload.includeTitle ? 'Проверенное название товара' : '',
          description: payload.includeDescription ? 'Проверенное описание товара.' : '',
          tags: payload.includeTags ? Array.from({ length: 11 }, (_item, index) => `тег товара ${index}`) : [],
          skuTitles: payload.includeSkuTitles ? payload.skus.map((sku) => ({ sourceSkuId: sku.sourceSkuId, title: `Проверенный вариант ${sku.sourceSkuId}` })) : [],
          globalAttributes: [],
          skuAttributes: payload.mode === 'sku' ? payload.skus.map((sku) => ({
            sourceSkuId: sku.sourceSkuId,
            attributes: fields.map((field) => ({
              attributeId: field.attributeId,
              value: field.options?.[0]?.value || `Значение ${field.attributeId}`,
              dictionaryValueId: field.options?.[0]?.id || '',
            })),
          })) : [],
          unresolved: [],
        }),
      };
      activeRequests -= 1;
      return response;
    });
    const result = await runCollectionAttributeAutofill({
      product: { ...product, skus: skus.map((item) => ({ id: item.sourceSkuId, name: item.sourceSkuName })) },
      draft: { ...draft, attributeValues: {}, skus },
      definitions: scaleDefinitions,
      optionsByAttributeId: scaleOptions,
      tool,
      selectedModelId: 'auto',
      modelOptions: [
        { id: 'auto', accountId: 'account-a', model: 'model-a', ready: true },
        { id: 'account-b', accountId: 'account-b', model: 'model-b', ready: true },
      ],
    }, {
      request,
      enableVision: false,
      modelRateLimitNow: () => simulatedNow,
      modelRateLimitWait: async (delayMs) => { simulatedNow += delayMs; },
    });

    expect(result.pipeline.modelBatchCount).toBe(6);
    expect(result.pipeline.modelConcurrency).toBe(6);
    expect(result.pipeline.skuBatchSize).toBe(22);
    expect(requestStarts).toEqual(Array(6).fill(0));
    expect(maximumActiveRequests).toBe(6);
    expect(Math.max(...requestBodies.map((body) => new TextEncoder().encode(JSON.stringify(body)).byteLength))).toBeLessThan(29_000);
    expect(Math.max(...requestBodies.map((body) => body.templateInput.skus.length))).toBe(22);
    expect(result.pipeline).toMatchObject({
      phaseCount: 1,
      parallelPhaseExecution: true,
      strictPhaseOrder: false,
      modelRequestsPerWindow: 30,
      modelRequestWindowMs: 60_000,
    });
  });

  it('retries an incomplete JSON batch once without rerunning completed work', async () => {
    const validResponse = {
      description: JSON.stringify({
        title: 'Готовый товар',
        description: 'Описание',
        globalAttributes: [{ attributeId: '10', value: 'Металл', confidence: 0.98 }],
        skuAttributes: [],
        unresolved: [],
      }),
    };
    const request = vi.fn()
      .mockResolvedValueOnce({ description: '{"globalAttributes":[' })
      .mockResolvedValueOnce(validResponse)
      .mockResolvedValue(validResponse);
    const result = await runCollectionAttributeAutofill({
      product,
      draft: { ...draft, skus: [] },
      definitions: [definitions[0]],
      optionsByAttributeId,
      tool,
      checkpointKey: 'scope-1',
      modelOptions: [{ id: 'auto', accountId: 'model-1', model: 'gpt-5.6-sol', ready: true }],
    }, { request, enableVision: false });

    expect(request).toHaveBeenCalledTimes(2);
    expect(result.pipeline.modelRoundCount).toBe(2);
    expect(result.pipeline.failedModelBatchCount).toBe(0);
    expect(result.suggestions.globalAttributes[0]).toMatchObject({ attributeId: '10' });
  });

  it.each([
    'PAID_CAPABILITY_PROVIDER_OUTCOME_UNKNOWN',
    'PAID_CAPABILITY_PROVIDER_COST_UNATTRIBUTABLE',
  ])('does not retry the billing-unsafe model outcome %s', async (code) => {
    const providerError = new Error('模型结果正在安全核对，禁止自动重复调用。');
    providerError.name = 'LocalApiError';
    providerError.status = 503;
    providerError.code = code;
    providerError.payload = { error: { code } };
    const request = vi.fn().mockRejectedValue(providerError);

    await expect(runCollectionAttributeAutofill({
      product,
      draft: {
        ...draft,
        title: 'Готовое название товара',
        description: 'Готовое описание товара.',
        tags: Array.from({ length: 11 }, (_item, index) => `готовый тег ${index}`),
        attributeValues: {},
        skus: [],
      },
      definitions: [{ id: '10', name: 'Материал', valueType: 'String' }],
      optionsByAttributeId: {},
      tool,
      modelOptions: [{ id: 'auto', accountId: 'model-1', model: 'gpt-5.6-sol', ready: true }],
    }, { request, enableVision: false })).rejects.toMatchObject({ code });

    expect(request).toHaveBeenCalledTimes(1);
  });

  it('does not spend repair requests on omitted optional fields', async () => {
    const request = vi.fn().mockResolvedValue({
      description: JSON.stringify({
        globalAttributes: [{ attributeId: '10', value: 'Металл' }],
        unresolved: [],
      }),
    });

    const result = await runCollectionAttributeAutofill({
      product,
      draft: {
        ...draft,
        title: 'Готовое название товара',
        description: 'Готовое описание товара.',
        tags: Array.from({ length: 11 }, (_item, index) => `готовый тег ${index}`),
        attributeValues: {},
        skus: [],
      },
      definitions: [
        { id: '10', name: 'Материал', valueType: 'String', isRequired: true },
        { id: '12', name: 'Форма', valueType: 'String', isRequired: false },
      ],
      optionsByAttributeId: {},
      tool,
      modelOptions: [{ id: 'auto', accountId: 'model-1', model: 'gpt-5.6-sol', ready: true }],
    }, { request, enableVision: false });

    expect(request).toHaveBeenCalledTimes(1);
    expect(result.suggestions.globalAttributes).toEqual([
      expect.objectContaining({ attributeId: '10' }),
    ]);
    expect(result.suggestions.unresolved).toEqual([
      expect.objectContaining({ attributeId: '12' }),
    ]);
  });

  it('rechecks every JSON retry and local repair body below 29KB without changing batch business fields', async () => {
    const requestBodies = [];
    const request = vi.fn(async (_path, init) => {
      requestBodies.push(init.body);
      if (requestBodies.length === 1) return { description: '{"globalAttributes":[' };
      if (requestBodies.length === 2) {
        return {
          description: JSON.stringify({
            globalAttributes: [{ attributeId: '10', value: 'Металл' }],
            unresolved: [],
          }),
        };
      }
      return {
        description: JSON.stringify({
          globalAttributes: [{ attributeId: '12', value: 'Овальная' }],
          unresolved: [],
        }),
      };
    });
    const longFacts = Array.from({ length: 60 }, (_item, index) => ({
      name: `来源字段 ${index}`,
      value: `真实资料 ${index} ${'详细内容'.repeat(120)}`,
    }));
    const result = await runCollectionAttributeAutofill({
      product: { ...product, description: '真实商品说明'.repeat(2_000), attributes: longFacts },
      draft: {
        ...draft,
        title: 'Готовое название товара',
        description: 'Готовое описание товара.',
        tags: Array.from({ length: 11 }, (_item, index) => `готовый тег ${index}`),
        attributeValues: {},
        skus: [],
      },
      definitions: [
        { id: '10', name: 'Материал', valueType: 'String', isRequired: true },
        { id: '12', name: 'Форма', valueType: 'String', isRequired: true },
      ],
      optionsByAttributeId: {},
      tool: {
        ...tool,
        promptConfig: {
          ...tool.promptConfig,
          systemPrompt: '只依据真实资料。'.repeat(1_000),
          workflowSteps: Array.from({ length: 40 }, (_item, index) => `核对真实步骤 ${index} ${'说明'.repeat(40)}`),
        },
      },
      modelOptions: [{ id: 'auto', accountId: 'model-1', model: 'gpt-5.6-sol', ready: true }],
    }, { request, enableVision: false });

    expect(requestBodies).toHaveLength(3);
    expect(requestBodies.slice(1).every((body) => body.userInstruction)).toBe(true);
    expect(requestBodies.every((body) => (
      new TextEncoder().encode(JSON.stringify(body)).byteLength < 29_000
    ))).toBe(true);
    expect(requestBodies.map((body) => body.templateInput))
      .toEqual(requestBodies.map(() => requestBodies[0].templateInput));
    expect(result.suggestions.globalAttributes).toEqual(expect.arrayContaining([
      expect.objectContaining({ attributeId: '10' }),
      expect.objectContaining({ attributeId: '12' }),
    ]));
  });

  it('keeps valid cells from a batch whose local repair request fails and checkpoints that batch for continuation', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({
        description: JSON.stringify({
          globalAttributes: [{ attributeId: '10', value: 'Металл' }],
          unresolved: [],
        }),
      })
      .mockRejectedValueOnce(new Error('temporary repair failure'));
    const result = await runCollectionAttributeAutofill({
      product,
      draft: {
        ...draft,
        title: 'Готовое название товара',
        description: 'Готовое описание товара.',
        tags: Array.from({ length: 11 }, (_item, index) => `готовый тег ${index}`),
        attributeValues: {},
        skus: [],
      },
      definitions: [
        { id: '10', name: 'Материал', valueType: 'String', isRequired: true },
        { id: '12', name: 'Форма', valueType: 'String', isRequired: true },
      ],
      optionsByAttributeId: {},
      tool,
      checkpointKey: 'partial-repair',
      modelOptions: [{ id: 'auto', accountId: 'model-1', model: 'gpt-5.6-sol', ready: true }],
    }, { request, enableVision: false });

    expect(result.suggestions.globalAttributes).toEqual([
      expect.objectContaining({ attributeId: '10', value: expect.objectContaining({ value: 'Металл' }) }),
    ]);
    expect(result.suggestions.unresolved).toEqual([
      expect.objectContaining({ attributeId: '12' }),
    ]);
    expect(result.pipeline).toMatchObject({ completedModelBatchCount: 0, failedModelBatchCount: 1 });
    expect(result.checkpoint.failedJobIds).toHaveLength(1);
  });

  it('keeps successful batches and continues only failed batches from a checkpoint', async () => {
    const checkpointSkus = Array.from({ length: 45 }, (_item, index) => ({
      sourceSkuId: `checkpoint-${index + 1}`,
      sourceSkuName: `规格 ${index + 1}`,
      attributeValues: {},
    }));
    const checkpointDefinitions = [
      { id: '100', name: '公共材质', valueType: 'String', is_required: true },
      { id: '200', name: 'SKU 颜色', valueType: 'String', is_required: true, isAspect: true },
    ];
    const firstRequest = vi.fn(async (_path, init) => {
      const payload = init.body.templateInput;
      const fields = [
        ...payload.schema.required_text,
        ...payload.schema.optional_text,
      ];
      if (payload.skus.some((item) => item.sourceSkuId === 'checkpoint-45')) throw new Error('temporary model failure');
      return {
        description: JSON.stringify({
          title: payload.includeTitle ? 'Проверенное название' : '',
          description: payload.includeDescription ? 'Проверенное описание.' : '',
          tags: payload.includeTags ? Array.from({ length: 11 }, (_item, index) => `тег ${index}`) : [],
          skuTitles: payload.includeSkuTitles ? payload.skus.map((item) => ({ sourceSkuId: item.sourceSkuId, title: `Вариант ${item.sourceSkuId}` })) : [],
          globalAttributes: payload.mode === 'global'
            ? fields.map((item) => ({ attributeId: item.attributeId, value: `Значение-${item.attributeId}`, confidence: 0.99 }))
            : [],
          skuAttributes: payload.mode === 'sku' ? payload.skus.map((sku) => ({
            sourceSkuId: sku.sourceSkuId,
            attributes: fields.map((item) => ({ attributeId: item.attributeId, value: `Значение-${item.attributeId}`, confidence: 0.99 })),
          })) : [],
          unresolved: [],
        }),
      };
    });
    const first = await runCollectionAttributeAutofill({
      product: { ...product, skus: checkpointSkus.map((item) => ({ id: item.sourceSkuId, name: item.sourceSkuName })) },
      draft: { ...draft, attributeValues: {}, skus: checkpointSkus },
      definitions: checkpointDefinitions,
      optionsByAttributeId: {},
      tool,
      checkpointKey: 'scope-checkpoint',
      modelOptions: [{ id: 'auto', accountId: 'model-1', model: 'gpt-5.6-sol', ready: true }],
    }, { request: firstRequest, enableVision: false });

    expect(first.pipeline.completedModelBatchCount).toBe(3);
    expect(first.pipeline.failedModelBatchCount).toBe(1);
    expect(first.checkpoint.failedJobIds).toHaveLength(1);

    const secondRequest = vi.fn(async (_path, init) => {
      const payload = init.body.templateInput;
      const fields = [...payload.schema.required_text, ...payload.schema.optional_text];
      return {
        description: JSON.stringify({
          skuTitles: payload.skus.map((item) => ({ sourceSkuId: item.sourceSkuId, title: `Вариант ${item.sourceSkuId}` })),
          globalAttributes: [],
          skuAttributes: payload.skus.map((sku) => ({
            sourceSkuId: sku.sourceSkuId,
            attributes: fields.map((item) => ({ attributeId: item.attributeId, value: `Значение-${item.attributeId}`, confidence: 0.99 })),
          })),
          unresolved: [],
        }),
      };
    });
    const second = await runCollectionAttributeAutofill({
      product: { ...product, skus: checkpointSkus.map((item) => ({ id: item.sourceSkuId, name: item.sourceSkuName })) },
      draft: { ...draft, attributeValues: {}, skus: checkpointSkus },
      definitions: checkpointDefinitions,
      optionsByAttributeId: {},
      tool,
      checkpointKey: 'scope-checkpoint',
      checkpoint: first.checkpoint,
      modelOptions: [{ id: 'auto', accountId: 'model-1', model: 'gpt-5.6-sol', ready: true }],
    }, { request: secondRequest, enableVision: false });

    expect(secondRequest).toHaveBeenCalledTimes(1);
    expect(second.pipeline.reusedModelBatchCount).toBe(3);
    expect(second.pipeline.failedModelBatchCount).toBe(0);
    expect(second.suggestions.globalAttributes).toHaveLength(1);
    expect(second.suggestions.skuAttributes).toHaveLength(45);
  });
});
