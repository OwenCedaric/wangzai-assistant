import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CollectionProductImageWorkspace } from './CollectionProductImageWorkspace.jsx';

const draft = {
  mainImages: ['https://img.example/main-1.png', 'https://img.example/main-2.png'],
  skuImages: [],
  detailImages: [],
  skus: [],
};

const imageHistory = {
  imageCount: 2,
  batchCount: 1,
  shopId: 'shop-a',
  sourceProductId: '907805856885',
  sourceUrl: 'https://detail.1688.com/offer/907805856885.html',
  productTitle: '感光变色眼镜框',
  entries: [{
    id: 'history-1',
    shopId: 'shop-a',
    sourceProductId: '907805856885',
    sourceUrl: 'https://detail.1688.com/offer/907805856885.html',
    productKey: '1688:907805856885',
    group: 'main',
    groupLabel: '主图',
    createdAt: new Date().toISOString(),
    plannerModel: 'Chat-GPT-5.6-Sol',
    model: 'Chat-GPT-Image-2',
    items: [
      { sourceIndex: 0, assetId: 'asset-1', persistenceStatus: 'completed' },
      { sourceIndex: 1, imageUrl: 'https://img.example/generated-2.png', persistenceStatus: 'pending' },
    ],
  }],
};

const skill = {
  id: 'ozon-product-image-generation',
  title: 'Ozon 商品图生成',
  goal: '生成主图和详情图方案',
  body: '根据当前商品图片生成逐图 PromptPlan。',
  promptConfig: {
    plannerModelId: 'planner-auto',
    imageModelId: 'image-auto',
    workflowSteps: ['读取商品事实', '生成逐图方案', '调用图片模型'],
    outputRules: ['每个位置返回一张图片'],
    safetyRules: ['不得改变商品身份'],
    outputFormat: 'PromptPlan JSON',
    systemPrompt: '角色与任务。\n一、事实来源与处理优先级\n只使用当前商品事实。',
    imagePositionRules: {
      main: [{ sourceIndex: 0, purpose: '核心卖点图', instructions: '商品居中' }],
      detail: [{ sourceIndex: 0, purpose: '细节图', instructions: '展示材质' }],
    },
    attributeRules: { optimizationGoal: '保持商品身份并优化图片。' },
  },
};

describe('CollectionProductImageWorkspace', () => {
  beforeEach(() => {
    window.wangzaiDesktop = {
      localApiRequest: vi.fn(async ({ path }) => ({
        ok: true,
        status: 200,
        data: path === '/api/product-images/assets/previews'
          ? {
              ok: true,
              assets: [{
                id: 'asset-1',
                previewUrl: 'https://private.example/history-1.png',
                thumbnailUrl: 'https://private.example/history-1-thumb.webp',
                previewUrlExpiresInSeconds: 600,
              }],
            }
          : { ok: true },
      })),
      cancelLocalApiRequest: vi.fn(async () => ({ ok: true })),
    };
  });

  it('offers standard and fast generation without changing the selected source scope', () => {
    const onGenerate = vi.fn();
    render(
      <CollectionProductImageWorkspace
        draft={draft}
        generationState={{ status: 'idle', itemsByGroup: {} }}
        imageHistory={imageHistory}
        imageSkillState={{ status: 'ready', error: '', skill }}
        onChangeImages={vi.fn()}
        onGenerate={onGenerate}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '生成 2 张' }));
    expect(onGenerate).toHaveBeenLastCalledWith(expect.objectContaining({
      group: 'main', selectedIndexes: [0, 1], generationMode: 'standard',
    }));
    fireEvent.click(screen.getByRole('button', { name: '极速生成 2 张' }));
    expect(onGenerate).toHaveBeenLastCalledWith(expect.objectContaining({
      group: 'main', selectedIndexes: [0, 1], generationMode: 'fast',
    }));
  });

  it('opens the image Skill rules panel from the header button', async () => {
    render(
      <CollectionProductImageWorkspace
        draft={draft}
        generationState={{ status: 'idle', itemsByGroup: {} }}
        imageHistory={imageHistory}
        imageSkillState={{ status: 'ready', error: '', skill }}
        onChangeImages={vi.fn()}
        onGenerate={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Skill 规则' }));
    expect(screen.getByRole('dialog', { name: /图片 Skill 规则/u })).toBeInTheDocument();
    expect(screen.getByText('读取商品事实')).toBeInTheDocument();
    expect(screen.getByText('不得改变商品身份')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: '图片位置' }));
    expect(screen.getByText('核心卖点图')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: '完整提示词' }));
    expect(screen.getByText('商品事实来源')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '编辑规则' }));
    expect(screen.getByText('设置工具规则')).toBeInTheDocument();
  });

  it('shows the generated image count for this source link and opens its Ozon-style history', async () => {
    const onRestoreHistory = vi.fn(() => ({ ok: true }));
    render(
      <CollectionProductImageWorkspace
        draft={draft}
        generationState={{ status: 'idle', itemsByGroup: {} }}
        imageHistory={imageHistory}
        imageSkillState={{ status: 'ready', error: '', skill }}
        onChangeImages={vi.fn()}
        onGenerate={vi.fn()}
        onRestoreHistory={onRestoreHistory}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '生成历史，共 2 张' }));
    expect(screen.getByRole('dialog', { name: '生成历史' })).toBeInTheDocument();
    expect(screen.getByText('共 2 张')).toBeInTheDocument();
    expect(screen.getByText('1 批')).toBeInTheDocument();
    expect(screen.getByText('主图 · 2 张')).toBeInTheDocument();
    expect(screen.getAllByText(/907805856885/u).length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getByAltText('主图历史图 1')).toHaveAttribute(
      'src',
      'https://private.example/history-1-thumb.webp',
    ));
    expect(window.wangzaiDesktop.localApiRequest).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '重新应用本批' }));
    await waitFor(() => expect(onRestoreHistory).toHaveBeenCalledWith(expect.objectContaining({
      group: 'main',
      items: [
        expect.objectContaining({ sourceIndex: 0, imageUrl: 'https://private.example/history-1.png' }),
        expect.objectContaining({ sourceIndex: 1, imageUrl: 'https://img.example/generated-2.png' }),
      ],
    })));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '生成历史' })).not.toBeInTheDocument());
  });

  it('restores a saved generated image to its exact source position instead of the default first five', async () => {
    const manyImages = Array.from({ length: 7 }, (_, index) => `https://img.example/main-${index + 1}.png`);
    render(
      <CollectionProductImageWorkspace
        draft={{ ...draft, mainImages: manyImages }}
        generationState={{
          status: 'success',
          itemsByGroup: {
            main: [{ sourceIndex: 5, status: 'success', imageUrl: 'https://oss.example/saved-position-6.png' }],
          },
        }}
        imageHistory={{ ...imageHistory, entries: [], imageCount: 0, batchCount: 0 }}
        imageSkillState={{ status: 'ready', error: '', skill }}
        onChangeImages={vi.fn()}
        onGenerate={vi.fn()}
      />
    );

    expect(await screen.findByText('生图参考 1 / 7')).toBeInTheDocument();
    expect(screen.getByAltText('生成图 1')).toHaveAttribute('src', 'https://oss.example/saved-position-6.png');
  });

  it('keeps source and pending images in aligned two-row full-width grids', () => {
    const thirteenImages = Array.from({ length: 13 }, (_, index) => `https://img.example/detail-${index + 1}.png`);
    render(
      <CollectionProductImageWorkspace
        draft={{ ...draft, mainImages: thirteenImages }}
        generationState={{ status: 'idle', itemsByGroup: {} }}
        imageHistory={{ ...imageHistory, entries: [], imageCount: 0, batchCount: 0 }}
        imageSkillState={{ status: 'ready', error: '', skill }}
        onChangeImages={vi.fn()}
        onGenerate={vi.fn()}
      />,
    );

    expect(screen.getByTestId('source-image-grid')).toHaveAttribute('data-layout-rows', '2');
    expect(screen.getByTestId('source-image-grid')).toHaveAttribute('data-visible-columns', '7');
    expect(screen.getByTestId('source-image-grid')).toHaveAttribute('data-column-count', '7');
    expect(screen.getByTestId('pending-generation-grid')).toHaveAttribute('data-layout-rows', '2');
    expect(screen.getByTestId('pending-generation-grid')).toHaveAttribute('data-visible-columns', '5');
    expect(screen.getByTestId('pending-generation-grid')).toHaveAttribute('data-column-count', '5');
    expect(screen.getByTestId('pending-generation-grid')).toHaveAttribute('data-row-height', '150');
  });

  it('paginates 42 source images into three full-width 7-by-2 pages instead of squeezing every card', () => {
    const fortyTwoImages = Array.from({ length: 42 }, (_, index) => `https://img.example/main-${index + 1}.png`);
    render(
      <CollectionProductImageWorkspace
        draft={{ ...draft, mainImages: fortyTwoImages }}
        generationState={{ status: 'idle', itemsByGroup: {} }}
        imageHistory={{ ...imageHistory, entries: [], imageCount: 0, batchCount: 0 }}
        imageSkillState={{ status: 'ready', error: '', skill }}
        onChangeImages={vi.fn()}
        onGenerate={vi.fn()}
      />,
    );

    const grid = screen.getByTestId('source-image-grid');
    const pages = screen.getAllByTestId(/^source-image-page-/u);
    expect(grid).toHaveAttribute('data-visible-columns', '7');
    expect(grid).toHaveAttribute('data-column-count', '7');
    expect(grid).toHaveAttribute('data-page-count', '3');
    expect(grid).toHaveStyle({ gridAutoColumns: '100%', overflowX: 'auto' });
    expect(pages).toHaveLength(3);
    expect(pages.map((page) => page.children.length)).toEqual([14, 14, 14]);
  });

  it('renders the lightweight OSS thumbnail while keeping the full preview URL for later use', () => {
    render(
      <CollectionProductImageWorkspace
        draft={draft}
        generationState={{
          status: 'success',
          itemsByGroup: { main: [{
            sourceIndex: 0,
            status: 'success',
            imageUrl: '/api/product-images/preview/asset-1?shopId=shop-a',
            previewUrl: 'https://oss.example/full.png',
            thumbnailUrl: 'https://oss.example/thumb.webp',
          }] },
        }}
        imageHistory={{ ...imageHistory, entries: [], imageCount: 0, batchCount: 0 }}
        imageSkillState={{ status: 'ready', error: '', skill }}
        onChangeImages={vi.fn()}
        onGenerate={vi.fn()}
      />,
    );

    expect(screen.getByAltText('生成图 1')).toHaveAttribute('src', 'https://oss.example/thumb.webp');
    const viewport = screen.getByTestId('generated-image-viewport-main-0');
    expect(viewport).toHaveAttribute('data-preview-height', '112');
    expect(viewport).toHaveStyle({ height: '112px', overflow: 'hidden' });
    expect(viewport.querySelector('.collection-product-generated-image-hover')).toHaveStyle({
      width: '100%',
      height: '100%',
      overflow: 'hidden',
    });
  });

  it('opens a body-level full-image preview when hovering a generated image', () => {
    vi.useFakeTimers();
    try {
      const { container } = render(
        <CollectionProductImageWorkspace
          draft={draft}
          generationState={{
            status: 'success',
            itemsByGroup: { main: [{
              sourceIndex: 0,
              status: 'success',
              imageUrl: '/api/product-images/preview/asset-1?shopId=shop-a',
              previewUrl: 'https://oss.example/full.png',
              thumbnailUrl: 'https://oss.example/thumb.webp',
            }] },
          }}
          imageHistory={{ ...imageHistory, entries: [], imageCount: 0, batchCount: 0 }}
          imageSkillState={{ status: 'ready', error: '', skill }}
          onChangeImages={vi.fn()}
          onGenerate={vi.fn()}
        />,
      );

      act(() => {
        fireEvent.mouseEnter(container.querySelector('.collection-product-generated-image-hover'));
        vi.advanceTimersByTime(120);
      });

      const preview = document.body.querySelector('.collection-product-generated-image-preview');
      expect(preview).toBeInTheDocument();
      expect(preview).toHaveClass('prompt-library-image-hover-preview');
      expect(preview.querySelector('img')).toHaveAttribute('src', 'https://oss.example/full.png');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps generation selection separate from original upload selection', () => {
    const onToggleOriginalImage = vi.fn();
    render(
      <CollectionProductImageWorkspace
        draft={draft}
        generationState={{
          status: 'success',
          itemsByGroup: { main: [{ sourceIndex: 1, status: 'success', imageUrl: 'https://oss.example/generated.png' }] },
        }}
        imageHistory={{ ...imageHistory, entries: [], imageCount: 0, batchCount: 0 }}
        imageSkillState={{ status: 'ready', error: '', skill }}
        onChangeImages={vi.fn()}
        onGenerate={vi.fn()}
        onToggleOriginalImage={onToggleOriginalImage}
      />,
    );

    const original = screen.getByRole('checkbox', { name: '上传原图：主图 1' });
    expect(original).not.toBeChecked();
    fireEvent.click(original);
    expect(onToggleOriginalImage).toHaveBeenCalledWith(expect.objectContaining({
      group: 'main', sourceIndex: 0, sourceImageUrl: draft.mainImages[0], selected: true,
    }));
  });

  it('keeps existing generated images visible when source generation selection is cleared', async () => {
    const onRemoveGeneratedImage = vi.fn();
    render(
      <CollectionProductImageWorkspace
        draft={draft}
        generationState={{
          status: 'success',
          itemsByGroup: { main: [
            { sourceIndex: 0, status: 'success', imageUrl: 'https://oss.example/generated-1.png', assetId: 'asset-1' },
            { sourceIndex: 1, status: 'success', imageUrl: 'https://oss.example/generated-2.png', assetId: 'asset-2' },
          ] },
        }}
        imageHistory={{ ...imageHistory, entries: [], imageCount: 0, batchCount: 0 }}
        imageSkillState={{ status: 'ready', error: '', skill }}
        onChangeImages={vi.fn()}
        onGenerate={vi.fn()}
        onRemoveGeneratedImage={onRemoveGeneratedImage}
      />,
    );

    expect(await screen.findByText('生图参考 2 / 2')).toBeInTheDocument();
    expect(screen.getByAltText('生成图 1')).toHaveAttribute('src', 'https://oss.example/generated-1.png');
    expect(screen.getByAltText('生成图 2')).toHaveAttribute('src', 'https://oss.example/generated-2.png');

    fireEvent.click(screen.getByRole('button', { name: '取消全选' }));

    expect(screen.getByText('生图参考 0 / 2')).toBeInTheDocument();
    expect(screen.getByAltText('生成图 1')).toHaveAttribute('src', 'https://oss.example/generated-1.png');
    expect(screen.getByAltText('生成图 2')).toHaveAttribute('src', 'https://oss.example/generated-2.png');
    expect(onRemoveGeneratedImage).not.toHaveBeenCalled();
  });

  it('exposes a delete action for each generated image tile', () => {
    const onRemoveGeneratedImage = vi.fn();
    render(
      <CollectionProductImageWorkspace
        draft={draft}
        generationState={{
          status: 'success',
          itemsByGroup: { main: [{ sourceIndex: 1, status: 'success', imageUrl: 'https://oss.example/generated.png', assetId: 'asset-1' }] },
        }}
        imageHistory={{ ...imageHistory, entries: [], imageCount: 0, batchCount: 0 }}
        imageSkillState={{ status: 'ready', error: '', skill }}
        onChangeImages={vi.fn()}
        onGenerate={vi.fn()}
        onRemoveGeneratedImage={onRemoveGeneratedImage}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '删除生成图片：主图 2' }));
    expect(onRemoveGeneratedImage).toHaveBeenCalledWith(expect.objectContaining({
      group: 'main', sourceIndex: 1, assetId: 'asset-1',
    }));
  });

  it('uses the generated-image checkbox as the upload contract and can regenerate one exact slot', () => {
    const onToggleGeneratedImage = vi.fn();
    const onGenerate = vi.fn();
    const generated = {
      sourceIndex: 1,
      status: 'success',
      imageUrl: 'https://oss.example/generated.png',
      assetId: 'asset-1',
    };
    render(
      <CollectionProductImageWorkspace
        draft={draft}
        generationState={{ status: 'success', itemsByGroup: { main: [generated] } }}
        generatedImageSelections={{ main: { historyEntryId: 'batch-1', items: [generated] } }}
        imageHistory={{ ...imageHistory, entries: [], imageCount: 0, batchCount: 0 }}
        imageSkillState={{ status: 'ready', error: '', skill }}
        onChangeImages={vi.fn()}
        onGenerate={onGenerate}
        onToggleGeneratedImage={onToggleGeneratedImage}
        onRemoveGeneratedImage={vi.fn()}
      />,
    );

    const uploadCheckbox = screen.getByRole('checkbox', { name: '上传生成图：主图 2' });
    expect(uploadCheckbox).toBeChecked();
    expect(screen.getByText('上传清单已选 1 张')).toBeInTheDocument();
    fireEvent.click(uploadCheckbox);
    expect(onToggleGeneratedImage).toHaveBeenCalledWith(expect.objectContaining({
      group: 'main', sourceIndex: 1, assetId: 'asset-1', selected: false,
    }));

    fireEvent.click(screen.getByRole('button', { name: '重新生成图片：主图 2' }));
    expect(onGenerate).toHaveBeenCalledWith(expect.objectContaining({
      group: 'main', selectedIndexes: [1], generationMode: 'standard',
    }));
  });

  it('can regenerate every failed slot independently', () => {
    const onGenerate = vi.fn();
    render(
      <CollectionProductImageWorkspace
        draft={draft}
        generationState={{
          status: 'partial',
          itemsByGroup: {
            main: [
              { sourceIndex: 0, status: 'error', message: '第一张失败' },
              { sourceIndex: 1, status: 'error', message: '第二张失败' },
            ],
          },
        }}
        imageHistory={{ ...imageHistory, entries: [], imageCount: 0, batchCount: 0 }}
        imageSkillState={{ status: 'ready', error: '', skill }}
        onChangeImages={vi.fn()}
        onGenerate={onGenerate}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '重新生成图片：主图 1' }));
    expect(onGenerate).toHaveBeenLastCalledWith(expect.objectContaining({
      group: 'main', selectedIndexes: [0], generationMode: 'standard',
    }));

    fireEvent.click(screen.getByRole('button', { name: '重新生成图片：主图 2' }));
    expect(onGenerate).toHaveBeenLastCalledWith(expect.objectContaining({
      group: 'main', selectedIndexes: [1], generationMode: 'standard',
    }));
  });
});
