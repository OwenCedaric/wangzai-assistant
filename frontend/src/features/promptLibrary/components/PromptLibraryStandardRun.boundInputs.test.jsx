import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PromptLibraryStandardRun } from './PromptLibraryStandardRun.jsx';

const SHOP_LABEL = '店铺、市场与语言';
const PRODUCT_LABEL = '商品、SPU/SKC 与 SKU 信息';

const selectedPrompt = {
  id: 'prompt-installed-ozon-card',
  title: 'Ozon 商品卡优化与生图',
  goal: '准备商品卡内容',
  skillProfile: {
    installType: 'github-skill',
    runType: 'local-ai-preview',
    usageInputs: ['处理模式', SHOP_LABEL, PRODUCT_LABEL],
  },
  promptConfig: {},
};

describe('PromptLibraryStandardRun installed Skill bindings', () => {
  it('直接绑定已配置店铺和现有商品，不再要求手写店铺与 SKU 信息', async () => {
    const onChangeValue = vi.fn();
    const onSelectedShopChange = vi.fn();
    const onSelectProduct = vi.fn();
    const shops = [
      { id: 'shop-1', shopAlias: 'Ozon 1店' },
      { id: 'shop-2', shopAlias: 'Ozon 2店' },
    ];
    const product = {
      id: 'product-1',
      title: '保温杯',
      offerId: 'WZ-1001',
      image: 'https://example.com/product.webp',
      skuOptions: [{ id: 'sku-row-1', sku: '123456', label: '黑色', facts: '黑色 · 500ml' }],
    };

    render(
      <PromptLibraryStandardRun
        selectedPrompt={selectedPrompt}
        selectedShop={shops[1]}
        shops={shops}
        usageInputs={selectedPrompt.skillProfile.usageInputs}
        values={{ 处理模式: 'full-card', [SHOP_LABEL]: '', [PRODUCT_LABEL]: '' }}
        onChangeValue={onChangeValue}
        onSelectedShopChange={onSelectedShopChange}
        productSelection={{
          products: [product],
          selectedProduct: null,
          selectedSku: null,
          loading: false,
          onSelectProduct,
          onSelectSku: vi.fn(),
        }}
      />
    );

    expect(screen.getByRole('combobox', { name: SHOP_LABEL })).toHaveTextContent('Ozon 2店');
    await waitFor(() => {
      expect(onChangeValue).toHaveBeenCalledWith(SHOP_LABEL, 'Ozon 2店 / 俄罗斯站 / 俄语');
    });

    fireEvent.mouseDown(screen.getByLabelText(SHOP_LABEL));
    fireEvent.click(screen.getByRole('option', { name: 'Ozon 1店' }));
    expect(onSelectedShopChange).toHaveBeenCalledWith(shops[0]);

    const productInput = screen.getByLabelText(PRODUCT_LABEL);
    expect(productInput.tagName).toBe('INPUT');
    fireEvent.change(productInput, { target: { value: '保温杯' } });
    const productOption = await screen.findByRole('option', { name: /保温杯.*货号 WZ-1001.*SKU 123456/u });
    expect(productOption.querySelector('img')).toHaveAttribute('src', 'https://example.com/product.webp');
    fireEvent.click(productOption);
    expect(onSelectProduct).toHaveBeenCalledWith(product);
    expect(onChangeValue).toHaveBeenCalledWith(PRODUCT_LABEL, expect.stringContaining('货号：WZ-1001'));
  });
});
