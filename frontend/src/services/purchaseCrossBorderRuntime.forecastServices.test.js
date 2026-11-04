import { describe, expect, it } from 'vitest';
import { normalizeCrossBorderServices } from '../shared/ozon/ozonRuntime.jsx';
import {
  buildPurchaseCrossBorderCreateBody,
  getPurchaseForecastServiceSelection,
} from './purchaseCrossBorderRuntime.js';

const servicePayload = {
  data: {
    core_data: [
      { id: 10, name: '免费贴单', gold: 0 },
      { id: 11, name: '打包', gold: 3 },
    ],
    optional_data: [
      { id: 20, name: '库存退回', gold: 2 },
      { id: 21, name: '编织袋', gold: 5 },
    ],
  },
};

describe('purchase forecast service options', () => {
  it('preserves required and optional service groups returned by the warehouse', () => {
    const options = normalizeCrossBorderServices(servicePayload);
    expect(options.map((option) => [option.id, option.selectionType])).toEqual([
      ['10', 'required'],
      ['11', 'required'],
      ['20', 'optional'],
      ['21', 'optional'],
    ]);
  });

  it('submits one required service and all user-selected optional services', () => {
    const serviceOptions = normalizeCrossBorderServices(servicePayload);
    const fields = {
      forecastServiceOptions: serviceOptions,
      requiredServiceId: '11',
      optionalServiceIds: ['20', '21'],
      orderNumber: 'posting-forecast-services-1',
      country: 'RU',
      dataStatus: '1',
      sheetOrderSn: 'label-1',
      sheetUrl: 'https://label.example.test/1.pdf',
      purchasePlatform: '1',
      purchaseOrderNo: 'purchase-1',
      packageDesc: 'test package',
    };
    const settings = {
      cooperationWarehouse: 'section-1:warehouse-1',
      packageService: '10',
      serviceOptions,
    };
    const order = {
      id: 'posting-forecast-services-1',
      productNo: 'offer-1',
      products: [{ name: 'Product 1', offerId: 'offer-1', sku: 'sku-1', qty: 1 }],
    };

    const selection = getPurchaseForecastServiceSelection(settings, fields);
    expect(selection.serviceIds).toEqual(['11', '20', '21']);
    const result = buildPurchaseCrossBorderCreateBody(settings, order, fields);
    expect(result.missing).toEqual([]);
    expect(result.body.is_check_section_order).toBe(0);
    expect(result.body.order_data[0].add_service).toEqual([{ id: 11 }, { id: 20 }, { id: 21 }]);
    expect(result.body.order_data[0]).not.toHaveProperty('is_show_img');
    expect(result.body.order_data[0]).not.toHaveProperty('is_show_sku');
    expect(result.body.order_data[0].package_list[0]).toMatchObject({
      sku_id: 0,
      sku: 'offer-1',
    });
  });

  it('rejects a missing required choice or an optional id not returned by the warehouse', () => {
    const serviceOptions = normalizeCrossBorderServices(servicePayload);
    const settings = {
      cooperationWarehouse: 'section-1:warehouse-1',
      serviceOptions,
    };
    const order = {
      id: 'posting-forecast-services-2',
      productNo: 'offer-2',
      products: [{ name: 'Product 2', offerId: 'offer-2', sku: 'sku-2', qty: 1 }],
    };
    const result = buildPurchaseCrossBorderCreateBody(settings, order, {
      forecastServiceOptions: serviceOptions,
      requiredServiceId: '',
      optionalServiceIds: ['not-returned-by-warehouse'],
      orderNumber: 'posting-forecast-services-2',
      country: 'RU',
      sheetOrderSn: 'label-2',
      sheetUrl: 'https://label.example.test/2.pdf',
      purchasePlatform: '1',
      purchaseOrderNo: 'purchase-2',
      packageDesc: 'test package',
    });
    expect(result.missing).toContain('必选打包服务');
    expect(result.missing).toContain('有效的可选增值服务');
  });
});
