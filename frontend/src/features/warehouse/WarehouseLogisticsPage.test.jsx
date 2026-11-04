import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({
  requestConfigSnapshot: vi.fn(),
  requestProductSnapshot: vi.fn(),
  recordReadLog: vi.fn(),
}));

vi.mock('../../entities/product/productLocalData.jsx', async (importOriginal) => ({
  ...(await importOriginal()),
  PRODUCT_PAGE_SIZE_OPTIONS: [20, 50],
  recordLocalMirrorReadLog: runtime.recordReadLog,
}));

vi.mock('../../entities/product/productOzonApi.jsx', () => ({
  getDeliveryMethodStatusColor: () => 'default',
  getDeliveryMethodStatusLabel: (status) => status || '未知',
  getDefaultOzonWarehouse: (warehouses, preferredId) =>
    warehouses.find((warehouse) => warehouse.id === preferredId) || warehouses[0] || null,
  getOzonApiErrorMessage: (error) => error?.message || String(error),
  getOzonDeliveryMethodDisplayName: (method) => method?.name || '未命名配送方式',
  getWarehouseStatusColor: () => 'default',
  getWarehouseStatusLabel: (status) => status || '未知',
  requestOzonWarehouseConfigSnapshot: runtime.requestConfigSnapshot,
  requestOzonWarehouseProductsSnapshot: runtime.requestProductSnapshot,
}));

vi.mock('../../shared/config/appConfigCore.jsx', async (importOriginal) => ({
  ...(await importOriginal()),
  defaultOzonShops: [],
  LOCAL_OZON_DATA_LAYER_FILE_KEY: 'test-local-data',
}));

vi.mock('../../shared/ozon/ozonRuntime.jsx', () => ({
  readSavedOzonDefaultWarehouseIds: () => ({}),
  saveOzonDefaultWarehouseIds: vi.fn(),
}));

vi.mock('./ui/WarehouseFreightEstimatorCard.jsx', () => ({
  WarehouseFreightEstimatorCard: () => <div data-testid="freight-estimator" />,
}));

vi.mock('./ui/WarehouseProductIdentity.jsx', () => ({
  WarehouseProductIdentity: ({ product }) => <span>{product?.name || product?.offerId || '商品'}</span>,
}));

import { WarehouseLogisticsPage } from './WarehouseLogisticsPage.jsx';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

const shops = [
  {
    id: 'shop-a',
    name: '店铺 A',
    shopAlias: '店铺 A',
    clientId: 'client-a',
    hasApiKey: true,
    shopIncarnation: 'inc-a',
    credentialRevision: 1,
  },
  {
    id: 'shop-b',
    name: '店铺 B',
    shopAlias: '店铺 B',
    clientId: 'client-b',
    hasApiKey: true,
    shopIncarnation: 'inc-b',
    credentialRevision: 1,
  },
];

describe('WarehouseLogisticsPage shop switching', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtime.requestConfigSnapshot.mockResolvedValue({
      status: 'success', warehouses: [], deliveryMethods: [], warnings: [],
    });
    runtime.requestProductSnapshot.mockResolvedValue({ rows: [], total: 0, warnings: [] });
    runtime.recordReadLog.mockResolvedValue(undefined);
  });

  it('clears an old shop loading state and drops its late responses after switching shops', async () => {
    const configA = deferred();
    const productsA = deferred();
    const refreshConfigB = deferred();
    const refreshProductsB = deferred();
    const configB = {
      status: 'success',
      warehouses: [{ id: 'warehouse-b', rawId: 'warehouse-b', name: 'B 仓', status: '启用' }],
      deliveryMethods: [],
      fetchedAt: '2026-08-01 10:00:00',
      warnings: [],
    };
    const productsB = {
      rows: [{ id: 'product-b', productId: 'product-b', offerId: 'offer-b', name: 'B 商品', status: '在售' }],
      total: 1,
      fetchedAt: '2026-08-01 10:00:01',
      warnings: [],
    };
    runtime.requestConfigSnapshot.mockImplementation((shop, options) => {
      if (shop.id === 'shop-a') return configA.promise;
      return options.forceRefresh ? refreshConfigB.promise : Promise.resolve(configB);
    });
    runtime.requestProductSnapshot.mockImplementation((shop, options) => {
      if (shop.id === 'shop-a') return productsA.promise;
      return options.forceRefresh ? refreshProductsB.promise : Promise.resolve(productsB);
    });

    const view = render(<WarehouseLogisticsPage shops={shops} activeShopId="shop-a" isActive />);

    fireEvent.click(screen.getByRole('button', { name: '刷新真实数据' }));
    expect(screen.getByRole('button', { name: '刷新真实数据' })).toBeDisabled();

    view.rerender(<WarehouseLogisticsPage shops={shops} activeShopId="shop-b" isActive />);

    await waitFor(() => expect(screen.getByRole('button', { name: '刷新真实数据' })).toBeEnabled());
    expect(screen.queryByText(/客户编号：/u)).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('搜索配送方式')).toBeInTheDocument();

    await act(async () => {
      configA.resolve({
        status: 'success',
        warehouses: [{ id: 'warehouse-a', rawId: 'warehouse-a', name: 'A 仓', status: '启用' }],
        deliveryMethods: [],
        fetchedAt: '2026-08-01 09:00:00',
        warnings: [],
      });
      productsA.resolve({
        rows: [{ id: 'product-a', productId: 'product-a', offerId: 'offer-a', name: 'A 商品', status: '在售' }],
        total: 1,
        fetchedAt: '2026-08-01 09:00:01',
        warnings: [],
      });
      await Promise.all([configA.promise, productsA.promise]);
    });

    expect(screen.queryByText('A 仓')).not.toBeInTheDocument();
    expect(screen.queryByText('A 商品')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '刷新真实数据' })).toBeEnabled();

    await waitFor(() => expect(screen.getAllByText('B 仓').length).toBeGreaterThan(0));
    expect(screen.getAllByText('B 商品').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: '刷新真实数据' }));

    expect(screen.getByRole('button', { name: '刷新真实数据' })).toBeDisabled();
    expect(screen.getAllByText('B 仓').length).toBeGreaterThan(0);
    expect(screen.getAllByText('B 商品').length).toBeGreaterThan(0);
    expect(runtime.requestConfigSnapshot).toHaveBeenLastCalledWith(
      shops[1], expect.objectContaining({ forceRefresh: true })
    );
    expect(runtime.requestProductSnapshot).toHaveBeenLastCalledWith(
      shops[1], expect.objectContaining({ forceRefresh: true })
    );

    await act(async () => {
      refreshConfigB.resolve(configB);
      await refreshConfigB.promise;
    });
    expect(screen.getByRole('button', { name: '刷新真实数据' })).toBeDisabled();
    expect(screen.getAllByText('B 商品').length).toBeGreaterThan(0);

    await act(async () => {
      refreshProductsB.resolve(productsB);
      await refreshProductsB.promise;
    });

    await waitFor(() => {
      expect(screen.getAllByText('B 仓').length).toBeGreaterThan(0);
      expect(screen.getAllByText('B 商品').length).toBeGreaterThan(0);
      expect(screen.getByText('Ozon 返回总数 1')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '刷新真实数据' })).toBeEnabled();
      expect(screen.queryByText('A 仓')).not.toBeInTheDocument();
      expect(screen.queryByText('A 商品')).not.toBeInTheDocument();
    });
  });

  it('keeps visible SQLite snapshots when the background refresh times out', async () => {
    runtime.requestConfigSnapshot.mockResolvedValueOnce({
      status: 'success',
      warehouses: [{ id: 'warehouse-a', rawId: 'warehouse-a', name: '缓存 A 仓', status: '启用' }],
      deliveryMethods: [],
      fetchedAt: '2026-08-07 15:00:00',
      warnings: [],
    }).mockRejectedValueOnce(new Error('仓库刷新超时'));
    runtime.requestProductSnapshot.mockResolvedValueOnce({
      rows: [{ id: 'product-a', productId: 'product-a', offerId: 'offer-a', name: '缓存 A 商品', status: '在售' }],
      total: 1,
      fetchedAt: '2026-08-07 15:00:01',
      warnings: [],
    }).mockRejectedValueOnce(new Error('/v3/product/list 请求超时'));

    render(<WarehouseLogisticsPage shops={shops} activeShopId="shop-a" isActive />);

    await waitFor(() => expect(screen.getAllByText('缓存 A 仓').length).toBeGreaterThan(0));
    expect(screen.getAllByText('缓存 A 商品').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: '刷新真实数据' }));

    await waitFor(() => expect(screen.getByText('后台刷新未完成，已保留本机商品数据')).toBeInTheDocument());
    expect(screen.getByText('后台刷新未完成，已保留本机仓库和配送方式')).toBeInTheDocument();
    expect(screen.getAllByText('缓存 A 仓').length).toBeGreaterThan(0);
    expect(screen.getAllByText('缓存 A 商品').length).toBeGreaterThan(0);
    expect(screen.queryByText(/商品读取失败/u)).not.toBeInTheDocument();
    expect(runtime.requestConfigSnapshot).toHaveBeenCalledWith(
      shops[0],
      expect.objectContaining({ forceRefresh: true, timeoutMs: 25_000, logisticsSyncTimeoutMs: 20_000 })
    );
    expect(runtime.requestConfigSnapshot.mock.calls.at(-1)?.[1]?.backgroundRefresh).toBeUndefined();
    expect(runtime.requestProductSnapshot).toHaveBeenCalledWith(
      shops[0],
      expect.objectContaining({ hydrate: false, autoSync: true, forceRefresh: true })
    );
  });

  it('opens Ozon warehouse and delivery-method management from the warehouse page', async () => {
    runtime.requestConfigSnapshot.mockResolvedValue({
      status: 'success',
      warehouses: [{
        id: 'warehouse-a', rawId: '1020005007227510', name: 'rFBS 仓', status: 'created',
        raw: { is_rfbs: true, phone: '+86 188 0537 2111' },
      }],
      deliveryMethods: [{
        id: 'method-a', rawId: '20296961', warehouseId: '1020005007227510',
        name: 'GUOO PUDO', status: 'ACTIVE', raw: { tpl_integration_type: 'aggregator' },
      }],
      fetchedAt: '2026-08-27 20:00:00',
      warnings: [],
    });
    runtime.requestProductSnapshot.mockResolvedValue({ rows: [], total: 0, warnings: [] });

    render(<WarehouseLogisticsPage shops={shops} activeShopId="shop-a" isActive />);
    await waitFor(() => expect(screen.getAllByText('rFBS 仓').length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole('button', { name: '新建仓库/配送方式' }));
    expect(screen.getByRole('dialog', { name: '新建 Ozon 仓库与配送方式' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '新建 Ozon 仓库与配送方式' })).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '管理 Ozon 仓库' }));
    expect(screen.getByRole('dialog', { name: '管理 Ozon 仓库' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '管理 Ozon 仓库' })).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '修改' }));
    expect(screen.getByRole('dialog', { name: '修改 Ozon 配送方式' })).toBeInTheDocument();
  });
});
