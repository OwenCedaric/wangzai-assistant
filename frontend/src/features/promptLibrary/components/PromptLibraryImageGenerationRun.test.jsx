import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PromptLibraryImageGenerationRun } from './PromptLibraryImageGenerationRun.jsx';

describe('PromptLibraryImageGenerationRun', () => {
  it('selects a product and carries its SKU facts into the local preview inputs', () => {
    const onChangeValue = vi.fn();
    const onSelectProduct = vi.fn();
    const product = {
      id: 'product-1',
      shopId: 'shop-a',
      title: '保温杯',
      offerId: 'BX-500',
      image: '',
      skuOptions: [{ id: 'sku-1', sku: 'SKU-BLACK', label: 'SKU-BLACK', facts: 'SKU-BLACK · 黑色 · 500ml' }],
    };

    render(
      <PromptLibraryImageGenerationRun
        values={{}}
        productSelection={{
          visibleProducts: [product],
          selectedProduct: null,
          selectedSku: null,
          loading: false,
          hasLocalProducts: true,
          query: '',
          onQueryChange: vi.fn(),
          onSelectProduct,
          onSelectSku: vi.fn(),
          onRefresh: vi.fn(),
        }}
        onChangeValue={onChangeValue}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /保温杯/ }));

    expect(onSelectProduct).toHaveBeenCalledWith(product);
    expect(onChangeValue).toHaveBeenCalledWith('商品图片或商品 SKU', '保温杯 · BX-500');
    expect(onChangeValue).toHaveBeenCalledWith('SKU 信息', 'SKU-BLACK · 黑色 · 500ml');
  });

  it('marks an empty detail-image group so the responsive layout can stay compact', () => {
    const mainImages = ['https://img.example/main-1.jpg'];
    const selectedSku = {
      id: 'sku-1',
      sku: 'SKU-1',
      label: 'SKU-1',
      facts: '白色 · 1 件',
      mainImages,
      detailImages: [],
    };
    const product = {
      id: 'product-1',
      shopId: 'shop-a',
      title: '毛绒玩具',
      offerId: 'OFFER-1',
      image: mainImages[0],
      mainImages,
      detailImages: [],
      skuOptions: [selectedSku],
    };

    const { container } = render(
      <PromptLibraryImageGenerationRun
        values={{}}
        workbench={{ kind: 'product-content', modules: ['product-selector'], imageJobs: [] }}
        productSelection={{
          visibleProducts: [product],
          selectedProduct: product,
          selectedSku,
          loading: false,
          hasLocalProducts: true,
          query: '',
        }}
      />
    );

    expect(container.querySelector('.prompt-library-image-preview')).toHaveClass('has-empty-detail-source');
    expect(container.querySelector('.prompt-library-image-group-module.is-detail')).toHaveClass(
      'has-no-slot-intents',
      'is-source-empty'
    );
  });

  it('shows dynamic main/detail image counts and generates each group independently', () => {
    const onGenerateImage = vi.fn();
    const mainImages = Array.from({ length: 7 }, (_, index) => `https://img.example/main-${index + 1}.jpg`);
    const detailImages = Array.from({ length: 3 }, (_, index) => `https://img.example/detail-${index + 1}.jpg`);
    const selectedSku = {
      id: 'sku-1',
      sku: 'SKU-BLACK',
      label: 'SKU-BLACK',
      facts: 'SKU-BLACK · 黑色 · 500ml',
      mainImages,
      detailImages,
    };
    const product = {
      id: 'product-1',
      shopId: 'shop-a',
      title: '保温杯',
      offerId: 'BX-500',
      image: mainImages[0],
      images: [...mainImages, ...detailImages],
      mainImages,
      detailImages,
      skuOptions: [selectedSku],
    };

    const { container } = render(
      <PromptLibraryImageGenerationRun
        selectedPrompt={{ id: 'ozon-product-image-generation', promptConfig: { defaultModelId: 'auto' } }}
        values={{ '商品图片或商品 SKU': '保温杯 · BX-500', 'SKU 信息': selectedSku.facts }}
        modelOptions={[
          {
            id: 'auto',
            accountId: 'image-account',
            model: 'gpt-image-2',
            label: '配置 1 / gpt-image-2',
            statusLabel: '已配置',
            ready: true,
          },
        ]}
        textModelOptions={[
          {
            id: 'text-auto',
            accountId: 'text-account',
            model: 'gpt-5.5',
            label: '配置 2 / gpt-5.5',
            statusLabel: '已配置',
            ready: true,
          },
        ]}
        productSelection={{
          visibleProducts: [product],
          selectedProduct: product,
          selectedSku,
          loading: false,
          hasLocalProducts: true,
          query: '',
        }}
        imageGenerationHistory={[
          {
            id: 'history-1',
            accountId: 'default',
            shopId: 'shop-a',
            productKey: 'BX-500',
            sku: 'SKU-BLACK',
            group: 'main',
            groupLabel: '主图',
            productTitle: '保温杯',
            model: 'gpt-image-2',
            createdAt: new Date().toISOString(),
            items: [{ sourceIndex: 0, imageUrl: '/api/product-images/preview/history-1' }],
          },
        ]}
        onGenerateImage={onGenerateImage}
      />
    );

    expect(screen.getByText('主图模块')).toBeInTheDocument();
    expect(screen.getByText('详情图模块')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '输出尺寸' })).toHaveTextContent('3:4');
    expect(screen.getByRole('combobox', { name: '生成质量' })).toHaveTextContent('高清');
    expect(screen.getByText('商品资料智能填写')).not.toBeVisible();
    expect(screen.queryByText('商品图片对比')).not.toBeInTheDocument();
    expect(screen.queryByText('主图和详情图分别生成、分别对比')).not.toBeInTheDocument();
    const sharedActionGroups = [
      ...container.querySelectorAll('.prompt-library-image-mode-panel.is-active .prompt-library-workbench-actions'),
    ];
    expect(sharedActionGroups).toHaveLength(2);
    sharedActionGroups.forEach((group) => {
      const labels = [...group.querySelectorAll('button')].map((button) => button.textContent.trim());
      expect(labels[0]).toBe('全选');
      expect(labels[1]).toBe('取消全选');
      expect(labels[2]).toMatch(/生成|请选择/);
      expect(labels[3]).toMatch(/^极速生成|^极速生图/);
      expect(labels[4]).toMatch(/^替换选中/);
    });
    expect(screen.getByAltText('主图原图 7')).toHaveAttribute('src', mainImages[6]);
    expect(screen.getByAltText('详情图原图 3')).toHaveAttribute('src', detailImages[2]);

    fireEvent.click(screen.getAllByRole('button', { name: '取消全选' })[0]);
    expect(screen.getByRole('button', { name: '请选择主图' })).toBeDisabled();
    fireEvent.click(screen.getAllByRole('button', { name: '全选' })[0]);
    expect(screen.getByRole('button', { name: '生成 7 张主图' })).toBeEnabled();

    const firstMainCheckbox = screen.getByRole('checkbox', { name: '取消选择主图原图 1' });
    fireEvent.click(firstMainCheckbox);
    expect(screen.getByRole('button', { name: '生成 6 张主图' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: '选择主图原图 1' }));

    fireEvent.click(screen.getByRole('button', { name: '生成 7 张主图' }));
    expect(onGenerateImage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        accountId: 'default',
        shopId: 'shop-a',
        group: 'main',
        imageGroup: 'main',
        count: 7,
        productImageUrls: mainImages,
        sourceImageIndexes: [0, 1, 2, 3, 4, 5, 6],
        imageSize: '1008x1344',
        imageQuality: 'high',
        generationMode: 'standard',
      })
    );

    fireEvent.click(screen.getByRole('button', { name: '极速生成 7 张' }));
    expect(onGenerateImage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        group: 'main',
        count: 7,
        generationMode: 'fast',
      })
    );

    fireEvent.click(screen.getByRole('button', { name: '生成 3 张详情图' }));
    expect(onGenerateImage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        group: 'detail',
        imageGroup: 'detail',
        count: 3,
        productImageUrls: detailImages,
        sourceImageIndexes: [0, 1, 2],
        generationMode: 'standard',
      })
    );
  });

  it('falls back to the selected page shop when a cached product row omits shopId', () => {
    const onGenerateImage = vi.fn();
    const product = {
      id: 'product-without-shop-field',
      title: '保温杯',
      offerId: 'BX-500',
      mainImages: ['https://img.example/main-1.jpg'],
      skuOptions: [],
    };

    render(
      <PromptLibraryImageGenerationRun
        selectedPrompt={{ id: 'ozon-product-image-generation', promptConfig: {} }}
        shops={[{ id: 'shop-a', profileId: 'profile-a', shopAlias: 'Ozon A店' }]}
        values={{ '商品图片或商品 SKU': '保温杯 · BX-500', 'SKU 信息': '黑色 · 500ml' }}
        modelOptions={[
          {
            id: 'auto',
            accountId: 'image-account',
            model: 'gpt-image-2',
            ready: true,
            label: '图片模型',
            statusLabel: '已配置',
          },
        ]}
        textModelOptions={[
          {
            id: 'auto',
            accountId: 'text-account',
            model: 'gpt-5.5',
            ready: true,
            label: '文案模型',
            statusLabel: '已配置',
          },
        ]}
        productSelection={{
          selectedProduct: product,
          selectedSku: null,
          visibleProducts: [product],
          loading: false,
          hasLocalProducts: true,
        }}
        onGenerateImage={onGenerateImage}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '生成 1 张主图' }));
    expect(onGenerateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'profile-a',
        shopId: 'shop-a',
        productImageUrls: product.mainImages,
      })
    );
  });

  it('shows the product attribute workspace without removing the fixed left settings', () => {
    render(
      <PromptLibraryImageGenerationRun
        workspaceMode="attributes"
        values={{
          '商品图片或商品 SKU': '保温杯 · BX-500',
          'SKU 信息': 'SKU-BLACK · 黑色 · 500ml',
        }}
        productSelection={{
          visibleProducts: [],
          selectedProduct: null,
          selectedSku: null,
          loading: false,
          hasLocalProducts: false,
          query: '',
        }}
      />
    );

    expect(screen.getByText('生成前设置')).toBeInTheDocument();
    expect(screen.getByLabelText('商品图片或商品 SKU')).toHaveValue('保温杯 · BX-500');
    expect(screen.getByText('商品资料智能填写')).toBeInTheDocument();
    expect(screen.getByText('主图模块')).not.toBeVisible();
    expect(screen.getByText('详情图模块')).not.toBeVisible();
  });

  it('retries only the failed image position and does not regenerate successful positions', () => {
    const onGenerateImage = vi.fn();
    const mainImages = ['https://img.example/main-1.jpg', 'https://img.example/main-2.jpg'];
    const product = {
      id: 'product-retry',
      shopId: 'shop-a',
      title: '保温杯',
      offerId: 'BX-500',
      mainImages,
      skuOptions: [],
    };

    render(
      <PromptLibraryImageGenerationRun
        selectedPrompt={{ id: 'ozon-product-image-generation', promptConfig: {} }}
        values={{ '商品图片或商品 SKU': '保温杯 · BX-500', 'SKU 信息': '黑色 · 500ml' }}
        modelOptions={[
          {
            id: 'auto',
            accountId: 'image-account',
            model: 'gpt-image-2',
            ready: true,
            label: '图片模型',
            statusLabel: '已配置',
          },
        ]}
        textModelOptions={[
          {
            id: 'auto',
            accountId: 'text-account',
            model: 'gpt-5.5',
            ready: true,
            label: '文案模型',
            statusLabel: '已配置',
          },
        ]}
        productSelection={{
          selectedProduct: product,
          selectedSku: null,
          visibleProducts: [product],
          loading: false,
          hasLocalProducts: true,
        }}
        imageGeneration={{
          main: {
            status: 'partial',
            result: {
              count: 2,
              successCount: 1,
              items: [
                { sourceIndex: 0, status: 'success', imageUrl: 'data:image/png;base64,success' },
                { sourceIndex: 1, status: 'error', message: '上游失败' },
              ],
            },
          },
        }}
        onGenerateImage={onGenerateImage}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '重试此张' }));
    expect(onGenerateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        group: 'main',
        sourceImageIndexes: [1],
        productImageUrls: [mainImages[1]],
        count: 1,
      })
    );
  });

  it('keeps the planner loading state limited to the requested retry position', () => {
    const mainImages = [
      'https://img.example/main-1.jpg',
      'https://img.example/main-2.jpg',
      'https://img.example/main-3.jpg',
    ];
    const product = {
      id: 'product-planning-retry',
      shopId: 'shop-a',
      title: '保温杯',
      offerId: 'BX-500',
      mainImages,
      skuOptions: [],
    };

    const { container } = render(
      <PromptLibraryImageGenerationRun
        selectedPrompt={{ id: 'ozon-product-image-generation', promptConfig: {} }}
        values={{ '商品图片或商品 SKU': '保温杯 · BX-500', 'SKU 信息': '黑色 · 500ml' }}
        productSelection={{
          selectedProduct: product,
          selectedSku: null,
          visibleProducts: [product],
          loading: false,
          hasLocalProducts: true,
        }}
        imageGeneration={{
          main: {
            status: 'partial',
            result: {
              items: [
                { sourceIndex: 0, status: 'success', imageUrl: 'data:image/png;base64,success' },
                { sourceIndex: 1, status: 'error', message: '上游失败' },
                { sourceIndex: 2, status: 'error', message: '上游失败' },
              ],
            },
          },
        }}
        imagePromptPlan={{
          main: {
            status: 'planning',
            input: { sourceImageIndexes: [1] },
          },
        }}
      />
    );

    expect(
      container.querySelectorAll(
        '.prompt-library-image-group-module.is-main .prompt-library-image-comparison-tile.is-loading'
      )
    ).toHaveLength(1);
    expect(
      container.querySelectorAll(
        '.prompt-library-image-group-module.is-main .prompt-library-image-comparison-tile.is-error'
      )
    ).toHaveLength(1);
    expect(screen.getByAltText('主图生成图 1')).toBeInTheDocument();
  });

  it('keeps fixed source and generated image frames before any image link is selected', () => {
    const { container } = render(
      <PromptLibraryImageGenerationRun
        productSelection={{
          visibleProducts: [],
          selectedProduct: null,
          selectedSku: null,
          loading: false,
          hasLocalProducts: false,
          query: '',
        }}
      />
    );

    expect(screen.getAllByText('链接原图')).toHaveLength(2);
    expect(screen.getAllByText('生成图片')).toHaveLength(2);
    expect(screen.getAllByText(/原图空位/u)).toHaveLength(10);
    expect(screen.getAllByText('未选择')).toHaveLength(10);
    expect(
      container.querySelectorAll('.prompt-library-image-group-module.is-main .prompt-library-image-comparison-tile')
    ).toHaveLength(10);
    expect(
      container.querySelectorAll('.prompt-library-image-group-module.is-detail .prompt-library-image-comparison-tile')
    ).toHaveLength(10);
  });

  it('shows eight native image positions and keeps the full product result list available for scrolling', () => {
    const products = Array.from({ length: 30 }, (_, index) => ({
      id: `product-${index + 1}`,
      shopId: 'shop-a',
      title: `商品 ${index + 1}`,
      offerId: `OFFER-${index + 1}`,
      image: '',
      skuOptions: [],
    }));
    const { container } = render(
      <PromptLibraryImageGenerationRun
        selectedPrompt={{ id: 'ozon-product-image-generation', promptConfig: {} }}
        productSelection={{
          filteredProducts: products,
          visibleProducts: products.slice(0, 20),
          selectedProduct: null,
          selectedSku: null,
          loading: false,
          hasLocalProducts: true,
          query: '',
        }}
      />
    );

    expect(screen.getAllByText(/原图空位/u)).toHaveLength(16);
    expect(screen.getAllByText('未选择')).toHaveLength(16);
    expect(container.querySelectorAll('.prompt-library-image-product-option')).toHaveLength(30);
    expect(
      container.querySelectorAll('.prompt-library-image-group-module.is-main .prompt-library-image-comparison-tile')
    ).toHaveLength(16);
    expect(
      container.querySelectorAll('.prompt-library-image-group-module.is-detail .prompt-library-image-comparison-tile')
    ).toHaveLength(16);
  });

  it('reuses the eight-slot product image workspace for every installed image-capable Skill', () => {
    const products = Array.from({ length: 24 }, (_, index) => ({
      id: `installed-product-${index + 1}`,
      shopId: 'shop-a',
      title: `安装 Skill 商品 ${index + 1}`,
      offerId: `INSTALLED-${index + 1}`,
      image: '',
      skuOptions: [],
    }));
    const { container } = render(
      <PromptLibraryImageGenerationRun
        selectedPrompt={{
          id: 'any-installed-image-skill',
          skillProfile: { installType: 'github-skill' },
        }}
        workbench={{
          kind: 'product-content',
          supportsImages: true,
          modules: ['product-selector', 'image-slots'],
          requiresExplicitImageSelection: true,
          imageJobs: [],
        }}
        productSelection={{
          filteredProducts: products,
          visibleProducts: products.slice(0, 20),
          selectedProduct: null,
          selectedSku: null,
          loading: false,
          hasLocalProducts: true,
          query: '',
        }}
      />
    );

    expect(screen.getAllByText(/原图空位/u)).toHaveLength(16);
    expect(screen.getAllByText('未选择')).toHaveLength(16);
    expect(container.querySelectorAll('.prompt-library-image-product-option')).toHaveLength(24);
  });

  it('opens the controlled image history for the selected product', () => {
    const product = {
      id: 'product-1',
      shopId: 'shop-a',
      title: '保温杯',
      offerId: 'BX-500',
      skuOptions: [],
    };

    render(
      <PromptLibraryImageGenerationRun
        historyOpen
        productSelection={{
          visibleProducts: [product],
          selectedProduct: product,
          selectedSku: null,
          loading: false,
          hasLocalProducts: true,
          query: '',
        }}
        imageGenerationHistory={[
          {
            id: 'history-1',
            accountId: 'default',
            shopId: 'shop-a',
            productKey: 'BX-500',
            group: 'main',
            groupLabel: '主图',
            productTitle: '保温杯',
            createdAt: new Date().toISOString(),
            items: [{ sourceIndex: 0, imageUrl: '/api/product-images/preview/history-1' }],
          },
        ]}
      />
    );

    expect(screen.getByRole('dialog', { name: '生图历史' })).toBeInTheDocument();
    expect(screen.getByAltText('主图历史图 1')).toHaveAttribute('src', '/api/product-images/preview/history-1');
  });

  it('keeps model progress out of the page header and shows estimated progress in selected image slots', async () => {
    const mainImages = ['https://img.example/main-1.jpg', 'https://img.example/main-2.jpg'];
    const product = {
      id: 'product-1',
      title: '保温杯',
      mainImages,
      skuOptions: [],
    };

    const { container } = render(
      <PromptLibraryImageGenerationRun
        selectedPrompt={{ id: 'ozon-product-image-generation', promptConfig: {} }}
        productSelection={{
          visibleProducts: [product],
          selectedProduct: product,
          selectedSku: null,
          loading: false,
          hasLocalProducts: true,
          query: '',
        }}
        imagePromptPlan={{
          main: {
            status: 'planning',
            message: '正在调用 gpt-5.5，整理 2 张主图的逐图方案…',
            input: { sourceImageIndexes: [0, 1] },
          },
        }}
      />
    );

    expect(screen.queryByText(/gpt-5\.5/iu)).not.toBeInTheDocument();
    expect(container.querySelector('.prompt-library-image-plan-progress')).not.toBeInTheDocument();
    expect(await screen.findAllByText('18%')).toHaveLength(2);
    expect(screen.getAllByText('规划中（预计）')).toHaveLength(2);
  });
});
