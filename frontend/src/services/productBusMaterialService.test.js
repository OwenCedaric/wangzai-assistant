import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  configureProductBusMaterialService,
  crossBorderOrderMatchesProduct,
  findLatestProductBusTarget,
  getCompleteProductMaterialFromVolumeItem,
  getProductBusOfferId,
  pickProductBusCrossBorderOrder,
  readAndSaveProductBusMeasurement,
  resetProductBusMaterialServiceForTest,
} from './productBusMaterialService';
import {
  PRODUCT_MATERIAL_SOURCE_CROSS_BORDER,
  configureProductMaterialProfileStore,
  readProductMaterialProfiles,
  resetProductMaterialProfileStoreForTest,
} from './productMaterialProfileStore';

describe('productBusMaterialService', () => {
  afterEach(() => {
    resetProductBusMaterialServiceForTest();
    resetProductMaterialProfileStoreForTest();
    vi.restoreAllMocks();
  });

  it('normalizes cross-border bus volume item into product material kg/cm', () => {
    expect(
      getCompleteProductMaterialFromVolumeItem({
        grossWeight: '250 g',
        length: '120 mm',
        width: '8 cm',
        height: '0.05 m',
      })
    ).toEqual({ weight: '0.25', length: '12', width: '8', height: '5' });
  });

  it('matches orders by offer id and picks material-rich latest order', () => {
    const product = { offerId: 'MZ-001' };
    const weakOrder = { order_id: 'old', goods_name: 'mz-001', created_at: '2026-06-28T00:00:00.000Z' };
    const strongOrder = {
      order_id: 'new',
      goods: [{ offer_id: 'mz-001' }],
      packageWeight: '0.2kg',
      packageSize: '10*8*5cm',
      updated_at: '2026-06-29T00:00:00.000Z',
    };

    expect(getProductBusOfferId(product)).toBe('MZ-001');
    expect(crossBorderOrderMatchesProduct(strongOrder, product)).toBe(true);
    expect(pickProductBusCrossBorderOrder([weakOrder, strongOrder])).toBe(strongOrder);
  });

  it('finds target from local cross-border order records and saves bus material profile through local material store', async () => {
    const writeLocalDataFile = vi.fn(async () => undefined);
    const saveProfileToLocalApi = vi.fn(async () => ({ ok: true }));
    const requestCrossBorderReadOnly = vi.fn(async () => ({
      volumes: [{ grossWeight: '300g', length: 20, width: 10, height: 8 }],
    }));
    configureProductMaterialProfileStore({ writeLocalDataFile, saveProfileToLocalApi });
    configureProductBusMaterialService({
      canUseCrossBorderOrderOutInfoRead: () => true,
      readLocalCrossBorderOrderRecords: vi.fn(async () => [
        {
          order_id: 'bus-1',
          order_number: 'section-1',
          from_order: 'purchase-1',
          goods: [{ offer_id: 'offer-1' }],
          packageWeight: '300g',
          updated_at: '2026-06-29T12:00:00.000Z',
        },
      ]),
      normalizeCrossBorderLocalOrderRecord: (record) => record,
      requestCrossBorderReadOnly,
      getCrossBorderOrderId: (item) => item?.order_id || '',
      getPurchaseOrderVolumeItems: (payload) => payload.volumes || [],
      getOzonShopClientId: (shop) => shop.clientId || '',
    });

    const result = await readAndSaveProductBusMeasurement({
      shop: { id: 'shop-1', clientId: '4616153' },
      settings: { enabled: true },
      product: { offerId: 'offer-1', productId: '101' },
    });

    expect(result).toMatchObject({ status: 'saved-local', offerId: 'offer-1', orderId: 'bus-1' });
    expect(requestCrossBorderReadOnly).toHaveBeenCalledWith(
      '/erpapi/order/get_order_out_info',
      { enabled: true },
      {
        order_id: 'bus-1',
        section_code: 'section-1',
      }
    );
    expect(readProductMaterialProfiles()['shop-1:offer-1']).toMatchObject({
      source: PRODUCT_MATERIAL_SOURCE_CROSS_BORDER,
      sourceOrderId: 'bus-1',
      sourceOrderNumber: 'section-1',
      sourcePurchaseOrderNumber: 'purchase-1',
      weight: '0.3',
      length: '20',
      width: '10',
      height: '8',
    });
    expect(writeLocalDataFile).not.toHaveBeenCalled();
    expect(saveProfileToLocalApi).toHaveBeenCalledWith(
      expect.objectContaining({ source: PRODUCT_MATERIAL_SOURCE_CROSS_BORDER }),
      {
        timeoutMs: 3000,
      }
    );
  });

  it('uses saved bus target before scanning local orders and reports no-data safely', async () => {
    configureProductMaterialProfileStore({
      writeLocalDataFile: vi.fn(async () => undefined),
      saveProfileToLocalApi: vi.fn(async () => ({})),
    });
    configureProductBusMaterialService({
      canUseCrossBorderOrderOutInfoRead: () => true,
      readLocalCrossBorderOrderRecords: vi.fn(async () => []),
      requestCrossBorderReadOnly: vi.fn(async () => ({ volumes: [] })),
      getPurchaseOrderVolumeItems: (payload) => payload.volumes || [],
    });

    const target = await findLatestProductBusTarget({
      shop: { id: 'shop-1' },
      product: { offerId: 'unknown' },
      recentOrders: [],
    });
    expect(target).toBeNull();

    const result = await readAndSaveProductBusMeasurement({
      shop: { id: 'shop-1' },
      settings: {},
      product: { offerId: 'unknown' },
      recentOrders: [],
    });
    expect(result).toMatchObject({ status: 'no-data', offerId: 'unknown' });
  });

  it('blocks reads when cross-border bus settings are incomplete', async () => {
    configureProductBusMaterialService({ canUseCrossBorderOrderOutInfoRead: () => false });

    await expect(readAndSaveProductBusMeasurement({ settings: {}, product: { offerId: 'offer-1' } })).rejects.toThrow(
      '请先在设置里保存跨境巴士企业接口和账号授权。'
    );
  });
});
