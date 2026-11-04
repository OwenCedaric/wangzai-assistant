import fs from 'node:fs';
import path from 'node:path';
import { createPurchaseForecastFixture } from '../test/fixtures/purchaseForecastFixture.js';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeCrossBorderOrderInfo } from '../entities/order/orderSourceLinkFields.jsx';
import {
  buildPurchaseCrossBorderCreateBody,
  normalizeCrossBorderOrderCreateResult,
} from './purchaseCrossBorderRuntime.js';

let fixture;
afterEach(() => { fixture?.cleanup(); fixture = null; });

describe('forecast full simulation', () => {
  it('returns the direct normalized result without any external write', () => {
    fixture = createPurchaseForecastFixture();
    const { base, settings } = fixture;
    const OUTPUT_PATH = path.join(fixture.directory, 'simulation.json');

    const simulatedFields = {
      ...base.fields,
      purchasePlatform: '1',
      purchaseOrderNo: 'SIM-1688-90000000-0001-1',
      logisticsOrder: 'SIM-DOMESTIC-90000000',
      sheetOrderSn: 'SIM-LABEL-90000000-0001-1',
      sheetUrl: 'https://preview.invalid/labels/90000000-0001-1.pdf',
      requiredServiceId: '3590',
      optionalServiceIds: [],
    };
    const generated = buildPurchaseCrossBorderCreateBody(
      settings,
      base.purchaseOrder,
      simulatedFields,
      {
        requireSheet: true,
        productSourceLinks: {},
        legacySourceLinks: {},
        routeText: base.purchaseOrder.deliveryMethod,
      },
    );
    expect(generated.missing).toEqual([]);

    const createResponse = {
      code: 1,
      message: '预报成功（模拟）',
      data: [{ order_number: base.postingNumber, order_id: 990000000 }],
    };
    const created = normalizeCrossBorderOrderCreateResult(createResponse);
    const associationResponse = { code: 1, message: '关联成功（模拟）' };
    const statusSyncResponse = { code: 1, message: '更新完成（模拟）' };
    const orderStatusResponse = {
      code: 1,
      message: '获取成功（模拟）',
      data: {
        id: 990000000,
        platform_order: base.postingNumber,
        collection_number: 'SIM-COLLECTION-90000000',
        data_status: 1,
        order_status: 0,
        is_prepare: 0,
        status_name: '待打包',
        status_type: 'pending',
        storehouse_name: '2311济南七号仓',
      },
    };
    const normalizedReadback = normalizeCrossBorderOrderInfo(
      orderStatusResponse.data,
      orderStatusResponse,
      null,
    );
    const output = {
      mode: 'simulation-only',
      externalWrites: 0,
      realPostingNumber: base.postingNumber,
      simulatedInputs: {
        purchasePlatform: '1688',
        purchaseOrderNo: simulatedFields.purchaseOrderNo,
        domesticTrackingNumber: simulatedFields.logisticsOrder,
        sheetOrderSn: simulatedFields.sheetOrderSn,
        sheetUrl: simulatedFields.sheetUrl,
      },
      generatedRequest: generated.body,
      directReturns: {
        create: createResponse,
        normalizedCreate: created,
        association: associationResponse,
        statusSync: statusSyncResponse,
        statusReadback: orderStatusResponse,
        normalizedReadback,
      },
    };
    fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
    expect(JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8')).externalWrites).toBe(0);
    expect(output.externalWrites).toBe(0);
    expect(output.directReturns.normalizedCreate.orderId).toBe('990000000');
    expect(output.directReturns.normalizedReadback.readStatus).toBe('待打包');
  });
});
