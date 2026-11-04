import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  editProductImage: vi.fn(),
  generateProductImage: vi.fn(),
  waitForProductImagePersistenceTask: vi.fn(),
  requestLocalApi: vi.fn(),
}));

vi.mock('../../products/services/productImageAssetService.js', () => ({
  editProductImage: mocks.editProductImage,
  generateProductImage: mocks.generateProductImage,
  waitForProductImagePersistenceTask: mocks.waitForProductImagePersistenceTask,
}));

vi.mock('../../../api/localApiClient.js', () => ({
  requestLocalApi: mocks.requestLocalApi,
}));

import {
  createSmartToolImageGenerationRequest,
  runSmartToolImageGenerationBatch,
  runSmartToolImageGeneration,
} from './smartToolImageGenerationService.js';

describe('smartToolImageGenerationService', () => {
  it('builds a compact fast request while keeping the standard request unchanged', () => {
    const base = {
      shopId: 'shop-a',
      productTitle: '黑色保温杯',
      productImageUrl: 'https://img.example/source.png',
      skuFacts: '黑色·500ml',
      sourceIndex: 0,
      modelSelection: { accountId: 'image-a', model: 'gpt-image-2', ready: true },
      promptConfig: { imagePositionRules: { main: [{ purpose: '主卖点' }] } },
      promptPlan: { items: [{ sourceIndex: 0, prompt: '商品居中、柔和光线' }] },
      persistGeneratedAsset: true,
    };
    const standard = createSmartToolImageGenerationRequest(base);
    const fast = createSmartToolImageGenerationRequest({ ...base, generationMode: 'fast' });
    expect(standard.generationMode).toBe('standard');
    expect(standard.persistGeneratedAsset).toBe(true);
    expect(standard.sourceType).toContain('main-test');
    expect(fast.generationMode).toBe('fast');
    expect(fast.sourceType).toContain('main-fast-test');
    expect(fast.promptTemplateId).toBe('product-image-generation.v1');
    expect(fast).not.toHaveProperty('prompt');
    expect(fast.promptTemplateInput.approvedPlan.items[0].prompt).toBe('商品居中、柔和光线');
    expect(standard.promptTemplateInput.generationMode).toBe('standard');
  });
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requestLocalApi.mockResolvedValue({ ok: true });
  });

  it('builds a fixed model request without exposing credentials', () => {
    const request = createSmartToolImageGenerationRequest({
      shopId: 'shop-a',
      productTitle: '保温杯',
      productImageUrl: 'https://cdn.example/cup.jpg',
      skuFacts: '黑色 · 500ml',
      targetScene: '户外露营',
      modelSelection: { accountId: 'account-a', model: 'gpt-image-2', ready: true },
    });

    expect(request).toMatchObject({
      shopId: 'shop-a',
      sourceUrl: 'https://cdn.example/cup.jpg',
      accountId: 'account-a',
      model: 'gpt-image-2',
      size: '1008x1344',
      quality: 'high',
    });
    expect(request).not.toHaveProperty('apiKey');
    expect(request.promptTemplateInput.product.skuFacts).toBe('黑色 · 500ml');
  });

  it('passes a user-selected output size and quality to the image service request', () => {
    const request = createSmartToolImageGenerationRequest({
      productTitle: '保温杯',
      modelSelection: { accountId: 'account-a', model: 'gpt-image-2', ready: true },
      imageSize: '1024x1024',
      imageQuality: 'medium',
    });

    expect(request).toMatchObject({ size: '1024x1024', quality: 'medium' });
  });

  it('keeps product identity and the complete approved plan in the image relay prompt', () => {
    const request = createSmartToolImageGenerationRequest({
      productTitle: '保温杯',
      productKey: 'BX-500',
      offerId: 'BX-500',
      productId: '12345',
      sku: 'SKU-BLACK',
      skuFacts: '黑色 · 500ml',
      sourceIndex: 2,
      skillExecutionContext: {
        policyVersion: 'ozon-product-image-skill.v1',
        toolId: 'ozon-product-image-generation',
        systemPrompt: '只供规划阶段读取的完整长提示词',
        workflowSteps: ['先核对商品身份'],
        safetyRules: ['禁止复制源图中文广告'],
        qaRules: ['检查成图不得出现中文'],
      },
      promptPlan: {
        globalNegativePrompt: '不要水印',
        items: [
          {
            sourceIndex: 2,
            prompt: '黑色保温杯户外主图',
            negativePrompt: '不要改变杯盖',
            mustKeep: ['黑色', '500ml'],
            mustAvoid: ['吸管'],
            acceptanceChecks: ['杯盖结构一致'],
          },
        ],
      },
      modelSelection: { accountId: 'account-a', model: 'gpt-image-2', ready: true },
    });

    expect(request.promptTemplateInput.product).toMatchObject({
      productKey: 'BX-500',
      offerId: 'BX-500',
      productId: '12345',
      sku: 'SKU-BLACK',
      skuFacts: '黑色 · 500ml',
    });
    expect(request.promptTemplateInput.approvedPlan.items[0]).toMatchObject({
      prompt: '黑色保温杯户外主图',
      mustKeep: ['黑色', '500ml'],
      acceptanceChecks: ['杯盖结构一致'],
    });
    expect(request.promptTemplateInput.skillContext).toMatchObject({
      policyVersion: 'ozon-product-image-skill.v1',
      toolId: 'ozon-product-image-generation',
      workflowSteps: ['先核对商品身份'],
      safetyRules: ['禁止复制源图中文广告'],
      qaRules: ['检查成图不得出现中文'],
    });
    expect(request.promptTemplateInput.skillContext).not.toHaveProperty('systemPrompt');
  });

  it('adds the selected image position rules to the matching generation request', () => {
    const request = createSmartToolImageGenerationRequest({
      productTitle: '保温杯',
      skuFacts: '黑色 · 500ml',
      imageGroup: 'detail',
      sourceIndex: 1,
      promptConfig: {
        imagePositionRules: {
          detail: [
            {},
            {
              purpose: '展示杯盖密封结构',
              instructions: '近距离侧面特写',
              visibleText: 'Герметичная крышка',
              mustAvoid: '不要添加吸管',
            },
          ],
        },
      },
      modelSelection: { accountId: 'account-a', model: 'gpt-image-2', ready: true },
    });

    expect(request.promptTemplateInput.image).toEqual({ group: 'detail', sourceIndex: 1 });
    expect(request.promptTemplateInput.positionRules.detail[1]).toMatchObject({
      purpose: '展示杯盖密封结构',
      visibleText: 'Герметичная крышка',
      mustAvoid: '不要添加吸管',
    });
  });

  it('lets a bound position request a white background without the global scene fallback', () => {
    const request = createSmartToolImageGenerationRequest({
      productTitle: '保温杯',
      sourceIndex: 5,
      promptConfig: {
        imagePositionRules: {
          main: [{ sourceIndex: 5, purpose: '标准白底主图', instructions: '纯白背景，商品居中' }],
        },
      },
      modelSelection: { accountId: 'account-a', model: 'gpt-image-2', ready: true },
    });

    expect(request.promptTemplateInput.image).toEqual({ group: 'main', sourceIndex: 5 });
    expect(request.promptTemplateInput.positionRules.main[0]).toMatchObject({
      sourceIndex: 5,
      purpose: '标准白底主图',
      instructions: '纯白背景，商品居中',
    });
  });

  it('uses reference edit for a public product image and pure generation otherwise', async () => {
    mocks.editProductImage.mockResolvedValue({ asset: { localUrl: '/api/profile-assets/edit-1' } });
    mocks.generateProductImage.mockResolvedValue({ asset: { localUrl: '/api/profile-assets/gen-1' } });
    const common = {
      shopId: 'shop-a',
      productTitle: '保温杯',
      skuFacts: '黑色 · 500ml',
      modelSelection: { accountId: 'account-a', model: 'gpt-image-2', ready: true },
    };

    const edited = await runSmartToolImageGeneration({ ...common, productImageUrl: 'https://cdn.example/cup.jpg' });
    const generated = await runSmartToolImageGeneration({ ...common, productImageUrl: '' });

    expect(mocks.editProductImage).toHaveBeenCalledTimes(1);
    expect(edited.mode).toBe('reference-edit');
    expect(edited.imageUrl).toBe('/api/product-images/preview/edit-1');
    expect(mocks.generateProductImage).toHaveBeenCalledTimes(1);
    expect(generated.mode).toBe('text-to-image');
    expect(generated.imageUrl).toBe('/api/product-images/preview/gen-1');
  });

  it('does not fall back when the approved image API key is rejected', async () => {
    mocks.editProductImage.mockRejectedValueOnce(new Error('API Key 不存在或已被停用'));

    await expect(
      runSmartToolImageGeneration({
        shopId: 'shop-a',
        productTitle: '眼镜',
        productImageUrl: 'https://cdn.example/glasses.jpg',
        allowPaidFallback: true,
        modelSelection: { id: 'auto', accountId: 'stale-account', model: 'gpt-image-2', ready: true },
      })
    ).rejects.toThrow('API Key 不存在或已被停用');

    expect(mocks.editProductImage).toHaveBeenCalledTimes(1);
  });

  it('does not retry a fixed image account or an uncertain POST failure', async () => {
    mocks.editProductImage.mockRejectedValue(new Error('上游超时'));

    await expect(
      runSmartToolImageGeneration({
        shopId: 'shop-a',
        productTitle: '眼镜',
        productImageUrl: 'https://cdn.example/glasses.jpg',
        allowPaidFallback: true,
        modelSelection: { id: 'auto', accountId: 'account-a', model: 'gpt-image-2', ready: true },
      })
    ).rejects.toThrow('上游超时');

    expect(mocks.editProductImage).toHaveBeenCalledTimes(1);
  });

  it('keeps the approved provider error without trying another image service', async () => {
    const gatewayError = new Error('Paid capability server rejected the request.');
    gatewayError.code = 'PAID_CAPABILITY_SOURCE_IMAGE_REJECTED';
    mocks.editProductImage.mockRejectedValueOnce(gatewayError);

    await expect(
      runSmartToolImageGeneration({
        shopId: 'shop-a',
        productTitle: '眼镜',
        productImageUrl: 'https://cdn.example/glasses.jpg',
        allowPaidFallback: true,
        modelSelection: { id: 'auto', accountId: 'stale-account', model: 'gpt-image-2', ready: true },
      })
    ).rejects.toMatchObject({ code: 'PAID_CAPABILITY_SOURCE_IMAGE_REJECTED' });
    expect(mocks.editProductImage).toHaveBeenCalledTimes(1);
  });

  it('uploads local and inline product images to the image relay instead of dropping them', async () => {
    mocks.editProductImage.mockResolvedValue({ asset: { localUrl: '/api/profile-assets/edit-local' } });
    mocks.requestLocalApi.mockResolvedValueOnce({ ok: true, asset: { id: 'asset-local', previewUrl: 'https://oss.example/source?signature=verified' } });
    const common = {
      shopId: 'shop-a',
      productTitle: '保温杯',
      modelSelection: { accountId: 'account-a', model: 'gpt-image-2', ready: true },
    };

    await runSmartToolImageGeneration({ ...common, productImageUrl: '/api/product-images/preview/asset-local' });
    await runSmartToolImageGeneration({ ...common, productImageUrl: 'data:image/png;base64,aW1hZ2U=' });

    expect(mocks.editProductImage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ sourceUrl: 'https://oss.example/source?signature=verified', assetShopId: 'shop-a' }),
      expect.any(Object)
    );
    expect(mocks.editProductImage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ dataBase64: 'data:image/png;base64,aW1hZ2U=' }),
      expect.any(Object)
    );
  });

  it('does not silently fall back to text-to-image when a selected reference cannot be transferred', async () => {
    await expect(
      runSmartToolImageGeneration({
        shopId: 'shop-a',
        productTitle: '保温杯',
        productImageUrl: 'http://unsafe.example/cup.jpg',
        modelSelection: { accountId: 'account-a', model: 'gpt-image-2', ready: true },
      })
    ).rejects.toThrow('当前参考图无法发送给图片中转站');
    expect(mocks.generateProductImage).not.toHaveBeenCalled();
    expect(mocks.editProductImage).not.toHaveBeenCalled();
  });

  it('generates four images in parallel and keeps an individual failure', async () => {
    mocks.generateProductImage
      .mockResolvedValueOnce({ asset: { localUrl: '/api/profile-assets/gen-1' } })
      .mockRejectedValueOnce(new Error('上游超时'))
      .mockResolvedValueOnce({ asset: { localUrl: '/api/profile-assets/gen-3' } })
      .mockResolvedValueOnce({ asset: { localUrl: '/api/profile-assets/gen-4' } });

    const batch = await runSmartToolImageGenerationBatch({
      shopId: 'shop-a',
      productTitle: '保温杯',
      skuFacts: '黑色 · 500ml',
      modelSelection: { accountId: 'account-a', model: 'gpt-image-2', ready: true },
    });

    expect(mocks.generateProductImage).toHaveBeenCalledTimes(4);
    expect(batch).toMatchObject({ count: 4, successCount: 3, failedCount: 1 });
    expect(batch.items.map((item) => item.status)).toEqual(['success', 'error', 'success', 'success']);
    expect(batch.items[1].message).toContain('上游超时');
  });

  it('never expands an explicit one-position retry into the previous batch count', async () => {
    mocks.editProductImage.mockResolvedValue({ asset: { localUrl: '/api/profile-assets/retry-one' } });

    const batch = await runSmartToolImageGenerationBatch(
      {
        shopId: 'shop-a',
        productTitle: '保温杯',
        sourceImageIndexes: [3],
        productImageUrls: ['https://cdn.example/main-4.jpg'],
        modelSelection: { accountId: 'account-a', model: 'gpt-image-2', ready: true },
      },
      3
    );

    expect(mocks.editProductImage).toHaveBeenCalledTimes(1);
    expect(batch).toMatchObject({ count: 1, successCount: 1, failedCount: 0 });
    expect(batch.items[0].sourceIndex).toBe(3);
  });

  it('reports each completed image before the slowest request finishes', async () => {
    let resolveSecondImage;
    mocks.generateProductImage
      .mockResolvedValueOnce({ asset: { localUrl: '/api/profile-assets/gen-fast' } })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecondImage = resolve;
          })
      );
    const onItemSettled = vi.fn();

    const batchPromise = runSmartToolImageGenerationBatch(
      {
        shopId: 'shop-a',
        productTitle: '保温杯',
        sourceImageIndexes: [0, 1],
        modelSelection: { accountId: 'account-a', model: 'gpt-image-2', ready: true },
      },
      2,
      { onItemSettled }
    );

    await vi.waitFor(() => expect(onItemSettled).toHaveBeenCalledTimes(1));
    expect(onItemSettled).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceIndex: 0,
        status: 'success',
      })
    );

    resolveSecondImage({ asset: { localUrl: '/api/profile-assets/gen-slow' } });
    const batch = await batchPromise;

    expect(onItemSettled).toHaveBeenCalledTimes(2);
    expect(batch).toMatchObject({ count: 2, successCount: 2, failedCount: 0 });
  });

  it('cycles through every source image while generating a five-image detail group', async () => {
    mocks.editProductImage.mockImplementation(async (request) => ({
      asset: { localUrl: `/api/profile-assets/${request.sourceUrl.split('/').pop()}` },
    }));
    const productImageUrls = [
      'https://cdn.example/detail-1.jpg',
      'https://cdn.example/detail-2.jpg',
      'https://cdn.example/detail-3.jpg',
    ];

    const batch = await runSmartToolImageGenerationBatch(
      {
        shopId: 'shop-a',
        productTitle: '保温杯',
        skuFacts: '黑色 · 500ml',
        imageGroup: 'detail',
        productImageUrls,
        modelSelection: { accountId: 'account-a', model: 'gpt-image-2', ready: true },
      },
      5
    );

    expect(mocks.editProductImage.mock.calls.map(([request]) => request.sourceUrl)).toEqual([
      productImageUrls[0],
      productImageUrls[1],
      productImageUrls[2],
      productImageUrls[0],
      productImageUrls[1],
    ]);
    expect(batch).toMatchObject({ count: 5, successCount: 5, failedCount: 0 });
    expect(mocks.editProductImage.mock.calls[0][0].promptTemplateInput.image.group).toBe('detail');
  });

  it('keeps duplicate source URLs aligned with their original source positions', async () => {
    mocks.editProductImage.mockResolvedValue({ asset: { localUrl: '/api/profile-assets/generated' } });
    const productImageUrls = [
      'https://cdn.example/same.jpg',
      'https://cdn.example/same.jpg',
      'https://cdn.example/third.jpg',
    ];

    await runSmartToolImageGenerationBatch(
      {
        shopId: 'shop-a',
        sourceImageIndexes: [4, 5, 6],
        productImageUrls,
        modelSelection: { accountId: 'account-a', model: 'gpt-image-2', ready: true },
      },
      3
    );

    expect(mocks.editProductImage.mock.calls.map(([request]) => ({
      sourceIndex: request.promptTemplateInput.image.sourceIndex,
      sourceUrl: request.sourceUrl,
    }))).toEqual([
      { sourceIndex: 4, sourceUrl: productImageUrls[0] },
      { sourceIndex: 5, sourceUrl: productImageUrls[1] },
      { sourceIndex: 6, sourceUrl: productImageUrls[2] },
    ]);
  });

  it('reads the stored asset as an inline image instead of rendering a JSON endpoint', async () => {
    mocks.generateProductImage.mockResolvedValue({
      asset: {
        id: 'pimg-generated',
        profileAssetId: 'asset-generated',
        localUrl: '/api/product-images/preview/pimg-generated',
      },
    });
    mocks.requestLocalApi.mockResolvedValue({
      asset: { mimeType: 'image/png', dataBase64: 'aW1hZ2UtYnl0ZXM=' },
    });

    const result = await runSmartToolImageGeneration({
      shopId: 'shop-a',
      productTitle: '保温杯',
      skuFacts: '黑色 · 500ml',
      modelSelection: { accountId: 'account-a', model: 'gpt-image-2', ready: true },
    });

    expect(mocks.requestLocalApi).toHaveBeenCalledWith(
      '/api/profile-assets/asset-generated',
      expect.objectContaining({ timeoutMs: 15_000 })
    );
    expect(result.imageUrl).toBe('data:image/png;base64,aW1hZ2UtYnl0ZXM=');
  });

  it('renders a signed OSS preview immediately without rereading multi-megabyte base64 through IPC', async () => {
    mocks.generateProductImage.mockResolvedValue({
      asset: {
        id: 'pimg-fast-preview',
        profileAssetId: 'asset-fast-preview',
        previewUrl: 'https://private-oss.example/preview.png?signature=short-lived',
      },
    });

    const result = await runSmartToolImageGeneration({
      shopId: 'shop-a',
      productTitle: '保温杯',
      modelSelection: { accountId: 'account-a', model: 'gpt-image-2', ready: true },
    });

    expect(result.imageUrl).toBe('https://private-oss.example/preview.png?signature=short-lived');
    expect(mocks.requestLocalApi).not.toHaveBeenCalledWith(
      expect.stringMatching(/^\/api\/profile-assets\//u),
      expect.anything()
    );
    expect(mocks.requestLocalApi).toHaveBeenCalledWith(
      '/api/image-provenance/jobs',
      expect.objectContaining({
        method: 'POST',
        observe: false,
        body: expect.objectContaining({
          shopId: 'shop-a',
          sourceAssetId: 'pimg-fast-preview',
        }),
      })
    );
  });

  it('shows the provider URL immediately and replaces it with the signed OSS asset after background persistence', async () => {
    let finishPersistence;
    mocks.generateProductImage.mockResolvedValue({
      taskId: 'pimg-task-fast-return',
      pending: true,
      asset: {
        status: 'persisting',
        previewUrl: 'https://provider.example/result.png',
      },
    });
    mocks.waitForProductImagePersistenceTask.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishPersistence = resolve;
        })
    );
    const onItemSettled = vi.fn();

    const batch = await runSmartToolImageGenerationBatch(
      {
        shopId: 'shop-a',
        productTitle: '保温杯',
        sourceImageIndexes: [0],
        modelSelection: { accountId: 'account-a', model: 'gpt-image-2', ready: true },
      },
      1,
      { onItemSettled }
    );

    expect(batch.items[0]).toMatchObject({
      imageUrl: 'https://provider.example/result.png',
      persistenceStatus: 'pending',
    });
    expect(onItemSettled).toHaveBeenCalledTimes(1);
    expect(mocks.waitForProductImagePersistenceTask).toHaveBeenCalledWith(
      'pimg-task-fast-return',
      expect.objectContaining({ shopId: 'shop-a' })
    );

    finishPersistence({
      asset: {
        id: 'pimg-stored',
        previewUrl: 'https://private-oss.example/stored.png?signature=ready',
      },
    });
    await vi.waitFor(() => expect(onItemSettled).toHaveBeenCalledTimes(2));
    expect(onItemSettled).toHaveBeenLastCalledWith(
      expect.objectContaining({
        assetId: 'pimg-stored',
        imageUrl: 'https://private-oss.example/stored.png?signature=ready',
        persistenceStatus: 'completed',
      })
    );
  });
});
