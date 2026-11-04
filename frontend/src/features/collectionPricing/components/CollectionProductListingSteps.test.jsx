import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  AttributeInput,
  CollectionProductDetailsStep,
  CollectionProductCategoryStep,
  CollectionProductListingPreviewStep,
  CollectionProductListingReadbackStep,
  CollectionProductSetupStep,
  CollectionProductSkuPriceStep,
} from './CollectionProductListingSteps.jsx';
import { ListingTaskStatusCard } from './ListingTaskStatusCard.jsx';

const definitions = [
  { id: '10', name: '品牌', is_required: true, isDictionary: false },
  { id: '20', name: '颜色', is_required: true, isAspect: true, isDictionary: false },
];

const draft = {
  title: '商品标题',
  description: '',
  attributeValues: { 10: { value: '旺崽' } },
  weightG: '100',
  packageLengthCm: '10',
  packageWidthCm: '8',
  packageHeightCm: '5',
  skus: [
    {
      sourceSkuId: 'red', sourceSkuName: '红色', offerId: 'RED-1',
      price: '100', oldPrice: '160', minPrice: '70', stock: '', warehouseId: '',
      attributeValues: { 20: { value: '红色' } },
    },
  ],
};

describe('collection product Ozon attribute steps', () => {
  it('shows readable Chinese task states for a daily Ozon creation quota failure', () => {
    render(
      <ListingTaskStatusCard
        listingState={{
          status: 'failed',
          error: 'Ozon 今日新建商品额度已用完，当前批次无法继续创建。',
          result: {
            results: [{
              kind: 'product-info',
              label: '商品卡 1/2',
              writeStatus: 'write_failed_after_accept',
              readBackStatus: 'failed',
              response: { error: { code: 'OZON_PRODUCT_DAILY_CREATION_LIMIT_EXCEEDED' } },
            }],
          },
        }}
      />,
    );

    expect(screen.getByText('已停止')).toBeInTheDocument();
    expect(screen.getByText('今日创建额度已用完 / 已停止')).toBeInTheDocument();
    expect(screen.queryByText(/write_failed_after_accept/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/\/ failed/u)).not.toBeInTheDocument();
  });

  it('replaces repeated Russian Ozon validation details with concise Chinese shop errors', () => {
    render(
      <ListingTaskStatusCard
        listingState={{
          status: 'failed',
          result: {
            shopResults: [{
              shopId: 'shop-a',
              shopLabel: '一店 · shop-a',
              status: 'failed',
              error: 'SKU-1: VALUE_MUST_BE_BOOLEAN: Значение должно быть булевым; SKU-2: pics_PIC_limit_exceeded',
            }],
          },
        }}
      />,
    );

    expect(screen.getByText('一店 · shop-a')).toBeInTheDocument();
    expect(screen.getByText(/布尔属性/u)).toBeInTheDocument();
    expect(screen.getByText(/1 张主图加 29 张附加图/u)).toBeInTheDocument();
    expect(screen.queryByText(/Значение/u)).not.toBeInTheDocument();
  });

  it('offers readback-only continuation when an accepted product chunk is still becoming visible', () => {
    const onResumeReadBack = vi.fn();
    render(
      <CollectionProductListingReadbackStep
        state={{
          status: 'pending_readback',
          result: {
            shopResults: [{
              result: {
                results: [{
                  kind: 'info',
                  readBackStatus: 'pending',
                  response: { readBack: { importTask: { taskId: 7799 } } },
                }],
              },
            }],
          },
        }}
        onResumeReadBack={onResumeReadBack}
        onBackToPreview={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '继续回读（不重复上传）' }));
    expect(onResumeReadBack).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: '返回预览' })).toBeInTheDocument();
  });

  it('offers readback-only continuation for a non-terminal product mismatch', () => {
    render(
      <CollectionProductListingReadbackStep
        state={{
          status: 'pending_readback',
          result: {
            shopResults: [{
              result: {
                results: [{
                  kind: 'info',
                  readBackStatus: 'mismatch',
                  response: {
                    readBack: {
                      status: 'mismatch',
                      verification: { terminal: false },
                      importTask: { taskId: 8801, failed: false },
                    },
                  },
                }],
              },
            }],
          },
        }}
        onResumeReadBack={vi.fn()}
        onBackToPreview={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: '继续回读（不重复上传）' })).toBeInTheDocument();
  });

  it('offers readback-only continuation for an accepted price write', () => {
    render(
      <CollectionProductListingReadbackStep
        state={{
          status: 'pending_readback',
          result: {
            shopResults: [{
              result: {
                results: [{
                  kind: 'price',
                  writeConnected: true,
                  readBackStatus: 'pending',
                  response: { readBack: { status: 'pending' } },
                }],
              },
            }],
          },
        }}
        onResumeReadBack={vi.fn()}
        onBackToPreview={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: '继续回读（不重复上传）' })).toBeInTheDocument();
  });

  it('shows a directly filled official option even before the dropdown cache rerenders', () => {
    render(
      <AttributeInput
        definition={{ id: '31', name: 'Пол', is_required: true, isDictionary: true }}
        value={{ value: 'Женский', dictionaryValueId: 'female' }}
        options={[]}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByLabelText('适用性别 *')).toHaveValue('Женский');
  });

  it('shows live chunk progress and lets the user cancel preview generation', () => {
    const onCancelPreview = vi.fn();
    render(
      <CollectionProductListingPreviewStep
        preview={null}
        state={{
          status: 'previewing',
          message: '正在生成上架预览分片 3/9（商品卡 3/7）…',
        }}
        onCreatePreview={vi.fn()}
        onCancelPreview={onCancelPreview}
        onSubmit={vi.fn()}
      />,
    );

    expect(screen.getByText(/分片 3\/9/u)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '取消生成' }));
    expect(onCancelPreview).toHaveBeenCalledTimes(1);
  });

  it('selects multiple upload shops beside the stock action in the SKU and price step', () => {
    const onChangeSelectedShops = vi.fn();
    render(
      <CollectionProductSkuPriceStep
        draft={{ ...draft, shopId: 'shop-a' }}
        shops={[{ id: 'shop-a', name: '店铺 A' }, { id: 'shop-b', name: '店铺 B' }]}
        selectedShopIds={['shop-a']}
        onChangeSelectedShops={onChangeSelectedShops}
        definitions={[]}
        onChange={vi.fn()}
        onChangeSku={vi.fn()}
        onChangeSkuAttribute={vi.fn()}
      />,
    );

    expect(screen.getByTestId('collection-upload-target-controls')).toContainElement(screen.getByRole('button', { name: '库存' }));
    fireEvent.click(screen.getByRole('button', { name: '选择上传店铺' }));
    fireEvent.click(screen.getByText('店铺 B · shop-b'));
    expect(onChangeSelectedShops).toHaveBeenCalledWith(['shop-a', 'shop-b']);
  });

  it('does not allow changing upload shops from the preview step', () => {
    render(
      <CollectionProductListingPreviewStep
        preview={null}
        state={{ status: 'idle', message: '' }}
        selectedShopIds={['shop-a', 'shop-b']}
        onCreatePreview={vi.fn()}
        onCancelPreview={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: '选择上传店铺' })).not.toBeInTheDocument();
    expect(screen.getByText('已选 2 家店铺')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '生成上架预览' })).not.toBeInTheDocument();
    expect(screen.getByText('正在生成完整上架预览')).toBeInTheDocument();
  });

  it('only offers retry after automatic preview generation fails', () => {
    const onCreatePreview = vi.fn();
    render(
      <CollectionProductListingPreviewStep
        preview={null}
        state={{ status: 'error', error: '仓库校验失败。', message: '' }}
        selectedShopIds={['shop-a']}
        onCreatePreview={onCreatePreview}
        onCancelPreview={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: '生成上架预览' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重新生成预览' }));
    expect(onCreatePreview).toHaveBeenCalledTimes(1);
  });

  it('shows each selected shop preview independently and uploads only ready shops', () => {
    render(
      <CollectionProductListingPreviewStep
        preview={{
          multiShop: true,
          operationId: 'multi-preview-1',
          selectedShopIds: ['shop-a', 'shop-b'],
          readyCount: 1,
          shopPreviews: [
            {
              shopId: 'shop-a', shopLabel: '店铺 A · shop-a', status: 'ready', warehouseName: 'A 仓',
              preview: {
                draftSnapshot: { activityPriceUpload: false, skus: [{ offerId: 'offer-1', priceCny: '100', oldPriceCny: '130' }] },
                product: { description_category_id: 100, type_id: 200, images: ['https://img.example/1.jpg'], attributes: [] },
                products: [{ offer_id: 'offer-1', name: '商品标题' }],
                prices: [{ offer_id: 'offer-1', price: '100', old_price: '130' }],
                stocks: [{ offer_id: 'offer-1', stock: 100 }],
                validation: { warnings: [] },
              },
            },
            { shopId: 'shop-b', shopLabel: '店铺 B · shop-b', status: 'failed', error: '没有可用仓库', preview: null },
          ],
        }}
        state={{ status: 'preview-ready', message: '' }}
        selectedShopIds={['shop-a', 'shop-b']}
        onCreatePreview={vi.fn()}
        onCancelPreview={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    expect(screen.getByText('店铺 A · shop-a')).toBeInTheDocument();
    expect(screen.getByText('店铺 B · shop-b')).toBeInTheDocument();
    expect(screen.getByText('预览就绪')).toBeInTheDocument();
    expect(screen.getByText('无法上传')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '上传到 1 个店铺' })).toBeDisabled();
  });

  it('shows global attributes only in details and aspect attributes only in the SKU workspace', () => {
    const onChangeAttribute = vi.fn();
    const onChangeSkuAttribute = vi.fn();
    const { unmount } = render(
      <CollectionProductDetailsStep
        draft={draft}
        definitions={definitions}
        onChange={vi.fn()}
        onChangeAttribute={onChangeAttribute}
      />,
    );

    expect(screen.getByLabelText('品牌 *')).toHaveValue('旺崽');
    expect(screen.queryByLabelText('颜色 *')).not.toBeInTheDocument();
    unmount();

    render(
      <CollectionProductSkuPriceStep
        draft={draft}
        definitions={definitions}
        onChange={vi.fn()}
        onChangeSku={vi.fn()}
        onChangeSkuAttribute={onChangeSkuAttribute}
      />,
    );

    expect(screen.getByText('每个 SKU 的规格属性')).toBeInTheDocument();
    expect(screen.getByTestId('collection-sku-attribute-workspace')).toHaveAttribute('data-layout-position', 'bottom');
    expect(screen.getByTestId('collection-sku-table-viewport')).toHaveAttribute('data-layout-fill', 'remaining');
    const colorInput = screen.getByLabelText('颜色 *');
    expect(colorInput).toHaveValue('红色');
    fireEvent.change(colorInput, { target: { value: '暗红色' } });
    expect(onChangeSkuAttribute).toHaveBeenCalledWith(0, '20', expect.objectContaining({ value: '暗红色' }));
  });

  it('opens from the selected shop warehouse cache without forcing Ozon and applies one stock value', async () => {
    const onReloadWarehouses = vi.fn(async () => []);
    const onApplyBatchStock = vi.fn(() => ({ ok: true, appliedCount: 1 }));
    render(
      <CollectionProductSkuPriceStep
        draft={{ ...draft, shopId: 'shop-1' }}
        shops={[{ id: 'shop-1', name: '店铺 1' }]}
        selectedShopIds={['shop-1']}
        warehousesByShopId={{ 'shop-1': [{ rawId: 'warehouse-1', name: '莫斯科仓' }] }}
        warehouseStatesByShopId={{ 'shop-1': { status: 'ready', error: '', shopId: 'shop-1' } }}
        definitions={[]}
        onChange={vi.fn()}
        onChangeSku={vi.fn()}
        onChangeSkuAttribute={vi.fn()}
        onReloadWarehouses={onReloadWarehouses}
        onApplyBatchStock={onApplyBatchStock}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '库存' }));
    expect(onReloadWarehouses).not.toHaveBeenCalled();
    expect(screen.queryByText('读取中…')).not.toBeInTheDocument();
    expect(screen.getByText('店铺 1 · shop-1')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('库存数量 shop-1'), { target: { value: '35' } });
    fireEvent.click(screen.getByRole('button', { name: '应用到 1 家店铺' }));

    await waitFor(() => expect(onApplyBatchStock).toHaveBeenCalledWith({
      shopInventories: [{ shopId: 'shop-1', warehouseId: 'warehouse-1', stock: 35 }],
    }));
  });

  it('only refreshes the Ozon warehouse list after the user explicitly asks', () => {
    const onReloadWarehouses = vi.fn(async () => []);
    render(
      <CollectionProductSkuPriceStep
        draft={{ ...draft, shopId: 'shop-1' }}
        shops={[{ id: 'shop-1', name: '店铺 1' }]}
        selectedShopIds={['shop-1']}
        warehousesByShopId={{ 'shop-1': [{ rawId: 'warehouse-1', name: '莫斯科仓' }] }}
        warehouseStatesByShopId={{ 'shop-1': { status: 'ready', error: '', shopId: 'shop-1' } }}
        definitions={[]}
        onChange={vi.fn()}
        onChangeSku={vi.fn()}
        onChangeSkuAttribute={vi.fn()}
        onReloadWarehouses={onReloadWarehouses}
        onApplyBatchStock={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '库存' }));
    expect(onReloadWarehouses).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '重新读取' }));
    expect(onReloadWarehouses).toHaveBeenCalledWith('shop-1');
  });

  it('shows and applies a different warehouse and stock for every selected upload shop', async () => {
    const onApplyBatchStock = vi.fn(() => ({ ok: true, appliedCount: 1, appliedShopCount: 2 }));
    render(
      <CollectionProductSkuPriceStep
        draft={{ ...draft, shopId: 'shop-a' }}
        shops={[{ id: 'shop-a', name: '店铺 A' }, { id: 'shop-b', name: '店铺 B' }]}
        selectedShopIds={['shop-a', 'shop-b']}
        warehousesByShopId={{
          'shop-a': [{ rawId: 'warehouse-a', name: 'A 仓库' }],
          'shop-b': [{ rawId: 'warehouse-b', name: 'B 仓库' }],
        }}
        warehouseStatesByShopId={{
          'shop-a': { status: 'ready', error: '', shopId: 'shop-a' },
          'shop-b': { status: 'ready', error: '', shopId: 'shop-b' },
        }}
        definitions={[]}
        onChange={vi.fn()}
        onChangeSku={vi.fn()}
        onChangeSkuAttribute={vi.fn()}
        onReloadWarehouses={vi.fn()}
        onApplyBatchStock={onApplyBatchStock}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '库存' }));
    expect(screen.getByText('店铺 A · shop-a')).toBeInTheDocument();
    expect(screen.getByText('店铺 B · shop-b')).toBeInTheDocument();
    expect(screen.getByLabelText('Ozon 仓库 shop-a')).toHaveTextContent('A 仓库');
    expect(screen.getByLabelText('Ozon 仓库 shop-b')).toHaveTextContent('B 仓库');
    fireEvent.change(screen.getByLabelText('库存数量 shop-a'), { target: { value: '20' } });
    fireEvent.change(screen.getByLabelText('库存数量 shop-b'), { target: { value: '35' } });
    fireEvent.click(screen.getByRole('button', { name: '应用到 2 家店铺' }));

    await waitFor(() => expect(onApplyBatchStock).toHaveBeenCalledWith({
      shopInventories: [
        { shopId: 'shop-a', warehouseId: 'warehouse-a', stock: 20 },
        { shopId: 'shop-b', warehouseId: 'warehouse-b', stock: 35 },
      ],
    }));
  });

  it('renders inventory columns only for the currently selected shop and never falls back to the source shop', () => {
    const onChangeSku = vi.fn();
    render(
      <CollectionProductSkuPriceStep
        draft={{
          ...draft,
          shopId: 'shop-a',
          skus: [{
            ...draft.skus[0],
            inventoryByShopId: {
              'shop-a': { warehouseId: 'warehouse-a', stock: '100' },
              'shop-b': { warehouseId: 'warehouse-b', stock: '35' },
            },
          }],
        }}
        shops={[{ id: 'shop-a', name: '店铺 A' }, { id: 'shop-b', name: '店铺 B' }]}
        selectedShopIds={['shop-b']}
        warehousesByShopId={{
          'shop-a': [{ rawId: 'warehouse-a', name: 'A 仓库' }],
          'shop-b': [{ rawId: 'warehouse-b', name: 'B 仓库' }],
        }}
        warehouseStatesByShopId={{ 'shop-b': { status: 'ready', error: '', shopId: 'shop-b' } }}
        definitions={[]}
        onChange={vi.fn()}
        onChangeSku={onChangeSku}
        onChangeSkuAttribute={vi.fn()}
      />,
    );

    expect(screen.getByRole('columnheader', { name: '店铺 B库存' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: '店铺 B仓库' })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: '店铺 A库存' })).not.toBeInTheDocument();
    expect(screen.queryByText('A 仓库')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Ozon 库存 shop-b 1')).toHaveValue('35');
    expect(screen.getByLabelText('Ozon 仓库 shop-b 1')).toHaveTextContent('B 仓库');

    fireEvent.change(screen.getByLabelText('Ozon 库存 shop-b 1'), { target: { value: '48' } });
    expect(onChangeSku).toHaveBeenCalledWith(0, {
      inventoryByShopId: {
        'shop-a': { warehouseId: 'warehouse-a', stock: '100' },
        'shop-b': { warehouseId: 'warehouse-b', stock: '48' },
      },
    });
  });

  it('shows CNY pricing metrics and edits SKU sale prices in RMB', () => {
    const onChangeSku = vi.fn();
    render(
      <CollectionProductSkuPriceStep
        draft={{
          ...draft,
          skus: [{
            ...draft.skus[0],
            sourcePriceCny: '35.5', priceCny: '58.8', oldPriceCny: '76.44', minPriceCny: '45.2',
          }],
        }}
        definitions={[]}
        onChange={vi.fn()}
        onChangeSku={onChangeSku}
        onChangeSkuAttribute={vi.fn()}
        pricing={{
          summary: {
            logisticsLabel: 'GUOO 经济线', commissionPercent: 17,
            totalCostRange: { minimum: 44, maximum: 44 },
            profitRange: { minimum: 11.76, maximum: 11.76 },
            marginRange: { minimum: 20, maximum: 20 },
            breakEvenRange: { minimum: 49, maximum: 49 },
            generatedSkuCount: 1, enabledSkuCount: 1,
          },
          logisticsDraft: { providerId: 'guoo', routeId: 'guoo-route' }, providers: [{ id: 'guoo', label: 'GUOO 经济线' }], routes: [{ id: 'guoo-route', label: 'GUOO 经济线' }],
          pricingDraft: {}, pricingQuoteState: { status: 'idle' }, pricingPreview: {},
          freightState: { status: 'success', message: '已按当前物流为每个 SKU 重新测算运费。' },
          applyState: { status: 'success', message: '已按完整成本为 SKU 反推出人民币销售价。' },
          filledFieldCount: 0, canRequestQuote: false,
          canGenerateSkuPrices: true, changeLogistics: vi.fn(), calculateFreight: vi.fn(),
          changePricingField: vi.fn(), requestQuote: vi.fn(), applySuggestedPrice: vi.fn(),
        }}
      />,
    );

    expect(screen.getByLabelText('所属物流')).toHaveTextContent('GUOO 经济线');
    expect(screen.getByLabelText('预期利润 / 单')).toBeInTheDocument();
    expect(screen.getByLabelText('目标净利润率')).toBeInTheDocument();
    expect(screen.getByTestId('collection-pricing-summary')).toBeInTheDocument();
    expect(screen.getByText('¥44')).toBeInTheDocument();
    expect(screen.getByText('¥ 35.5')).toBeInTheDocument();
    expect(screen.queryByText('售价 RUB')).not.toBeInTheDocument();
    expect(screen.queryByText(/已按当前物流为每个 SKU/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/已按完整成本为 SKU/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/换算.*RUB/u)).not.toBeInTheDocument();
    expect(screen.queryByText('物流运费与利润核价')).not.toBeInTheDocument();
    expect(screen.queryByText('SKU 自动核价结果')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Ozon 货号 1')).toHaveAttribute('readonly');
    fireEvent.change(screen.getByLabelText('人民币销售价 1'), { target: { value: '60' } });
    expect(onChangeSku).toHaveBeenCalledWith(0, expect.objectContaining({ priceCny: '60', price: '' }));
  });

  it('batch-fills enabled SKU attributes and exposes specification plus color columns', async () => {
    const onChange = vi.fn();
    render(
      <CollectionProductSkuPriceStep
        draft={{
          ...draft,
          skus: [
            {
              ...draft.skus[0], sourceSkuId: 'red', sourceSkuName: '左手红色',
              attributeValues: { 10: { value: '230x170x15', source: 'manual' } },
            },
            {
              ...draft.skus[0], sourceSkuId: 'blue', sourceSkuName: '右手蓝色', offerId: 'BLUE-1',
              attributeValues: {},
            },
            {
              ...draft.skus[0], sourceSkuId: 'green', sourceSkuName: '右手绿色', offerId: 'GREEN-1',
              enabled: false, attributeValues: {},
            },
            {
              ...draft.skus[0], sourceSkuId: 'pink-right', sourceSkuName: '右手粉色', offerId: 'PINK-R',
              enabled: false,
              attributeValues: {
                10: { value: '230x170x15', source: 'manual' },
                20: { value: 'Розовый', dictionaryValueId: 'pink-id', source: 'manual' },
              },
            },
            {
              ...draft.skus[0], sourceSkuId: 'pink-left', sourceSkuName: '左手粉色', offerId: 'PINK-L',
              attributeValues: {},
            },
          ],
        }}
        definitions={[
          { id: '10', name: 'Ozon 属性（中文名称待补充）', isAspect: true, isDictionary: false },
          { id: '20', name: '商品颜色', isAspect: true, isDictionary: true },
        ]}
        optionsByAttributeId={{
          20: [
            { id: 'red-id', label: 'Красный' },
            { id: 'blue-id', label: 'Синий' },
            { id: 'green-id', label: 'Зеленый' },
          ],
        }}
        onChange={onChange}
        onChangeSku={vi.fn()}
        onChangeSkuAttribute={vi.fn()}
        onSearchAttributeOptions={vi.fn(async () => [])}
      />,
    );

    expect(screen.getByRole('columnheader', { name: '规格属性' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: '商品颜色' })).toBeInTheDocument();
    expect(screen.getAllByText('230x170x15').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: '一键填充属性' }));

    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    const nextSkus = onChange.mock.calls[0][0].skus;
    expect(nextSkus[0].attributeValues).toMatchObject({
      10: { value: '230x170x15', source: 'manual' },
      20: { value: 'Красный', dictionaryValueId: 'red-id' },
    });
    expect(nextSkus[1].attributeValues).toMatchObject({
      10: { value: '230x170x15', source: 'manual' },
      20: { value: 'Синий', dictionaryValueId: 'blue-id' },
    });
    expect(nextSkus[2].attributeValues).toEqual({});
    expect(nextSkus[4].attributeValues).toMatchObject({
      10: { value: '230x170x15', source: 'manual' },
      20: { value: 'Розовый', dictionaryValueId: 'pink-id', source: 'manual' },
    });
  });

  it('shows a compact activity-price control and keeps manual sale-price edits at a 50% relationship', () => {
    const onChangeSku = vi.fn();
    const toggleActivityPriceUpload = vi.fn();
    render(
      <CollectionProductSkuPriceStep
        draft={{
          ...draft,
          activityPriceUpload: true,
          skus: [{ ...draft.skus[0], priceCny: '100', oldPriceCny: '200', sourcePriceCny: '35' }],
        }}
        definitions={[]}
        onChange={vi.fn()}
        onChangeSku={onChangeSku}
        onChangeSkuAttribute={vi.fn()}
        pricing={{
          activityPriceUpload: true,
          toggleActivityPriceUpload,
          pricingDraft: {},
          summary: {
            logisticsLabel: 'GUOO', totalCostRange: null, profitRange: null,
            marginRange: null, breakEvenRange: null,
          },
          logisticsDraft: {}, providers: [], commissionState: {}, applyState: {},
          canGenerateSkuPrices: true, changeLogistics: vi.fn(), changePricingField: vi.fn(),
        }}
      />,
    );

    expect(screen.getByRole('button', { name: '活动价已开启' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('活动成交价 ¥')).toBeInTheDocument();
    expect(screen.getByText('活动原价 ¥')).toBeInTheDocument();
    expect(screen.getByTestId('collection-package-fields')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('人民币销售价 1'), { target: { value: '120' } });
    expect(onChangeSku).toHaveBeenCalledWith(0, expect.objectContaining({
      priceCny: '120', oldPriceCny: '240', price: '', oldPrice: '',
    }));
    fireEvent.click(screen.getByRole('button', { name: '活动价已开启' }));
    expect(toggleActivityPriceUpload).toHaveBeenCalledTimes(1);
  });

  it('runs one-click analysis from the category and attribute page', () => {
    const onAnalyzeAndFill = vi.fn();
    render(
      <CollectionProductSetupStep
        draft={{ ...draft, shopId: 'shop-1', descriptionCategoryId: '10', typeId: '20', categorySelectionSource: 'manual' }}
        shops={[{ id: 'shop-1', name: '测试店铺' }]}
        categoryOptions={[{ descriptionCategoryId: '10', typeId: '20', pathText: '眼镜 > 镜框' }]}
        categoryState={{ status: 'ready' }}
        definitions={definitions}
        attributeState={{ status: 'ready' }}
        attributeAutofillState={{ status: 'idle' }}
        onChange={vi.fn()}
        onSelectCategory={vi.fn()}
        onChangeAttribute={vi.fn()}
        onAnalyzeAndFill={onAnalyzeAndFill}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '一键分析并填充' }));
    expect(onAnalyzeAndFill).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('collection-product-setup-workspace')).toBeInTheDocument();
    expect(screen.getByTestId('collection-product-copy-card')).toBeInTheDocument();
    expect(screen.queryByLabelText('上架店铺')).not.toBeInTheDocument();
    expect(screen.getByText(/上传店铺在 SKU\/价格步骤统一选择/u)).toBeInTheDocument();
  });

  it('uses the complete category library as the only formal category selector', () => {
    render(
      <CollectionProductCategoryStep
        draft={{
          ...draft,
          descriptionCategoryId: '200001542',
          typeId: '96686',
          categorySelectionSource: 'manual',
          categoryPath: '医疗保健 > 光学 > 视力眼镜',
        }}
        options={[{
          descriptionCategoryId: '200001542',
          typeId: '96686',
          pathText: '医疗保健 > 光学 > 视力眼镜',
        }]}
        state={{ status: 'ready' }}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.queryByLabelText('搜索或选择 Ozon 类目')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('输入中文商品名称或类目')).not.toBeInTheDocument();
    expect(screen.getByTestId('collection-category-confirmation-card')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '更换完整类目' })).toBeInTheDocument();
    expect(screen.getByText('已通过完整类目库确认')).toBeInTheDocument();
    expect(screen.getByText('医疗保健 > 光学 > 视力眼镜')).toBeInTheDocument();
  });

  it('keeps the image-analysis fallback but does not display an unresolved-field warning panel', () => {
    render(
      <CollectionProductSetupStep
        draft={{ ...draft, shopId: 'shop-1', descriptionCategoryId: '10', typeId: '20' }}
        shops={[{ id: 'shop-1', name: '测试店铺' }]}
        categoryOptions={[{ descriptionCategoryId: '10', typeId: '20', pathText: '眼镜 > 镜框' }]}
        categoryState={{ status: 'ready' }}
        definitions={definitions}
        attributeState={{ status: 'ready' }}
        attributeAutofillState={{
          status: 'success',
          message: '已核对 3 个属性单元格。',
          warning: '图片识别未完成，本次已改用来源资料继续填写。',
          unresolvedCount: 1,
          unresolvedItems: [{
            scope: 'sku', sourceSkuId: 'red', skuLabel: '红色', attributeId: '20',
            attributeLabel: '颜色', required: true, reason: '没有匹配到 Ozon 标准值',
          }],
        }}
        onChange={vi.fn()}
        onSelectCategory={vi.fn()}
        onChangeAttribute={vi.fn()}
        onAnalyzeAndFill={vi.fn()}
      />,
    );

    expect(screen.getByText(/图片识别未完成/u)).toBeInTheDocument();
    expect(screen.queryByText('查看未确认字段')).not.toBeInTheDocument();
    expect(screen.queryByText(/需要人工确认/u)).not.toBeInTheDocument();
  });

  it('does not show the SKU-limit warning inside the attribute-fill page', () => {
    render(
      <CollectionProductSetupStep
        draft={{
          ...draft,
          shopId: 'shop-1',
          descriptionCategoryId: '10',
          typeId: '20',
          skus: Array.from({ length: 82 }, (_, index) => ({ sourceSkuId: `sku-${index + 1}` })),
        }}
        shops={[{ id: 'shop-1', name: '测试店铺' }]}
        categoryOptions={[{ descriptionCategoryId: '10', typeId: '20', pathText: '眼镜 > 镜框' }]}
        categoryState={{ status: 'ready' }}
        definitions={definitions}
        attributeState={{ status: 'ready' }}
        attributeAutofillState={{ status: 'idle' }}
        onChange={vi.fn()}
        onSelectCategory={vi.fn()}
        onChangeAttribute={vi.fn()}
        onAnalyzeAndFill={vi.fn()}
      />,
    );

    expect(screen.queryByText(/当前商品有 82 个 SKU/u)).not.toBeInTheDocument();
  });

  it('keeps empty optional fields behind the explicit more-fields control', () => {
    render(
      <CollectionProductDetailsStep
        draft={draft}
        definitions={[
          ...definitions,
          { id: '30', name: '视频链接', is_required: false, isAspect: false, isDictionary: false },
        ]}
        onChange={vi.fn()}
        onChangeAttribute={vi.fn()}
      />,
    );

    expect(screen.queryByLabelText('视频链接')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '更多可选属性（1）' }));
    expect(screen.getByLabelText('视频链接')).toBeInTheDocument();
  });

  it('groups related attributes into aligned two-column rows without helper-text clutter', () => {
    const layoutDefinitions = [
      { id: '4180', name: 'Название', is_required: true },
      { id: '85', name: 'Бренд', is_required: true },
      { id: '9048', name: 'Название модели', is_required: true },
      { id: '5287', name: 'Материал оправы', is_required: true },
      { id: '5306', name: 'Материал линзы', is_required: true },
      { id: '4383', name: 'Вес товара, г', valueType: 'Decimal', is_required: true },
      { id: '8016', name: 'Ширина линзы, мм', valueType: 'Integer', is_required: true },
      { id: '4191', name: 'Аннотация', is_required: true },
      { id: '21837', name: 'Озон.Видео: название', is_required: true },
      { id: '21841', name: 'Озон.Видео: ссылка', is_required: true },
    ];
    const { container } = render(
      <CollectionProductDetailsStep
        compact
        draft={{
          ...draft,
          attributeValues: Object.fromEntries(layoutDefinitions.map((item) => [item.id, { value: `值-${item.id}` }])),
        }}
        definitions={layoutDefinitions}
        onChange={vi.fn()}
        onChangeAttribute={vi.fn()}
      />,
    );

    expect([...container.querySelectorAll('[data-testid^="attribute-group-"]')].map((item) => item.dataset.testid)).toEqual([
      'attribute-group-basic',
      'attribute-group-appearance',
      'attribute-group-dimensions',
      'attribute-group-content',
      'attribute-group-media',
    ]);
    expect(container.querySelectorAll('[data-layout-span="standard"]')).toHaveLength(8);
    expect(container.querySelectorAll('[data-layout-span="wide"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-layout-width="half"]')).toHaveLength(8);
    expect(container.querySelectorAll('[data-layout-width="full"]')).toHaveLength(2);
    expect(screen.queryByText('按商品实际资料填写')).not.toBeInTheDocument();
  });
});
