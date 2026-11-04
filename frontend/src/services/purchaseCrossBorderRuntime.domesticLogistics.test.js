import { describe, expect, it } from 'vitest';
import { getPurchaseOperationInitialFields } from './purchaseCrossBorderRuntime.js';

describe('采购操作共用国内物流字段', () => {
  it('预报和补录入口直接复用订单上的快递公司与快递单号', () => {
    const fields = getPurchaseOperationInitialFields('createForecast', {
      id: '64720469-0563-1',
      domesticCourierCompany: '中通快递(ZTO)',
      domesticTrackingNumber: '79028134877723',
    });
    expect(fields.logisticsCompany).toBe('中通快递(ZTO)');
    expect(fields.logisticsOrder).toBe('79028134877723');
  });

  it('当前精确回读优先于订单里的旧物流值', () => {
    const fields = getPurchaseOperationInitialFields('createForecast', {
      id: '64720469-0563-1',
      domesticCourierCompany: '旧快递',
      domesticTrackingNumber: 'OLD001',
    }, {
      carrier: '中通快递(ZTO)',
      trackingNumber: '79028134877723',
    });
    expect(fields.logisticsCompany).toBe('中通快递(ZTO)');
    expect(fields.logisticsOrder).toBe('79028134877723');
  });
});
