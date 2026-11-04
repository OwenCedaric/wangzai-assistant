import { describe, expect, it } from 'vitest';
import {
  HISTORICAL_ORDER_IMPORT_FIELDS,
  autoMapHistoricalOrderColumns,
  buildHistoricalOrderImportRows,
} from './historicalOrderImportSchema.js';

describe('historicalOrderImportSchema', () => {
  it('uses Ozon订单号 as the only spreadsheet identity field', () => {
    const identityFields = HISTORICAL_ORDER_IMPORT_FIELDS
      .filter((definition) => definition.group === 'identity')
      .map((definition) => definition.field);
    expect(identityFields).toEqual(['orderNumber']);
    expect(HISTORICAL_ORDER_IMPORT_FIELDS.map((definition) => definition.field)).not.toEqual(
      expect.arrayContaining(['offerId', 'sku', 'productKey']),
    );
    expect(HISTORICAL_ORDER_IMPORT_FIELDS.map((definition) => definition.field)).not.toEqual(
      expect.arrayContaining(['packagingCostCny', 'otherCostCny']),
    );
    expect(autoMapHistoricalOrderColumns(['Ozon订单号', '采购成本', '长度cm'])).toEqual([
      expect.objectContaining({ field: 'orderNumber' }),
      expect.objectContaining({ field: 'purchaseCostCny' }),
      expect.objectContaining({ field: 'lengthCm' }),
    ]);
  });

  it('keeps explicit zero costs, omits blanks, and accepts positive dimensions', () => {
    const result = buildHistoricalOrderImportRows({
      rows: [['ozon-order-1', '0', '', '12.5', 0.8]],
      mappings: [
        { columnIndex: 0, sourceHeader: 'Ozon订单号', field: 'orderNumber' },
        { columnIndex: 1, sourceHeader: '商品成本', field: 'purchaseCostCny' },
        { columnIndex: 2, sourceHeader: '货源链接', field: 'sourceUrl' },
        { columnIndex: 3, sourceHeader: '长度cm', field: 'lengthCm' },
        { columnIndex: 4, sourceHeader: '重量kg', field: 'weightKg' },
      ],
    });
    expect(result).toEqual({
      rows: [{
        orderNumber: 'ozon-order-1',
        purchaseCostCny: 0,
        lengthCm: 12.5,
        weightKg: 0.8,
      }],
      issues: [],
      skippedRows: 0,
    });
  });

  it('allows an order-only row because every non-identity field is optional', () => {
    expect(buildHistoricalOrderImportRows({
      rows: [['ozon-order-2', '']],
      mappings: [
        { columnIndex: 0, sourceHeader: 'Ozon订单号', field: 'orderNumber' },
        { columnIndex: 1, sourceHeader: '备注', field: 'note' },
      ],
    })).toEqual({
      rows: [{ orderNumber: 'ozon-order-2' }],
      issues: [],
      skippedRows: 0,
    });
  });

  it('rejects missing order numbers and non-positive dimensions without converting blanks to zero', () => {
    const result = buildHistoricalOrderImportRows({
      rows: [
        ['', '12'],
        ['ozon-order-3', '0'],
        ['ozon-order-4', ''],
      ],
      mappings: [
        { columnIndex: 0, sourceHeader: 'Ozon订单号', field: 'orderNumber' },
        { columnIndex: 1, sourceHeader: '长度cm', field: 'lengthCm' },
      ],
    });
    expect(result.rows).toEqual([{ orderNumber: 'ozon-order-4' }]);
    expect(result.skippedRows).toBe(2);
    expect(result.issues.map((issue) => issue.code)).toEqual([
      'ORDER_NUMBER_REQUIRED',
      'POSITIVE_NUMBER_REQUIRED',
    ]);
  });

  it('rejects an Excel-rounded unsafe numeric order number', () => {
    const result = buildHistoricalOrderImportRows({
      rows: [[9_007_199_254_740_992, '1']],
      mappings: [
        { columnIndex: 0, sourceHeader: 'Ozon订单号', field: 'orderNumber' },
        { columnIndex: 1, sourceHeader: '成本', field: 'purchaseCostCny' },
      ],
    });
    expect(result.rows).toEqual([]);
    expect(result.issues[0]).toMatchObject({ code: 'ORDER_NUMBER_UNSAFE' });
  });
});
