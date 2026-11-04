import { describe, expect, it } from 'vitest';
import {
  createHistoricalOrderImportTemplateCsv,
  parseHistoricalOrderImportFile,
} from './historicalOrderSpreadsheetService.js';

describe('historicalOrderSpreadsheetService', () => {
  it('parses UTF-8 CSV quoting and maps the Ozon order identity without a product code', async () => {
    const content = '\uFEFFOzon订单号,采购成本,长度cm,备注\r\n"order,1",0,12,"第一行\n第二行"\r\n';
    const result = await parseHistoricalOrderImportFile({
      name: '历史订单.csv',
      size: content.length,
      text: async () => content,
    });
    expect(result).toMatchObject({
      fileName: '历史订单.csv',
      fileType: 'csv',
      headers: ['Ozon订单号', '采购成本', '长度cm', '备注'],
      mappings: [
        expect.objectContaining({ field: 'orderNumber' }),
        expect.objectContaining({ field: 'purchaseCostCny' }),
        expect.objectContaining({ field: 'lengthCm' }),
        expect.objectContaining({ field: 'note' }),
      ],
    });
    expect(result.rows[0]).toEqual(['order,1', '0', '12', '第一行\n第二行']);
  });

  it('parses the first XLSX worksheet without shipping exceljs in the application bundle', async () => {
    const exceljs = await import('exceljs');
    const Workbook = exceljs.Workbook || exceljs.default.Workbook;
    const workbook = new Workbook();
    const worksheet = workbook.addWorksheet('历史订单');
    worksheet.addRow(['Ozon订单号', '跨境巴士成本', '重量kg', '日期', '已核对', '公式结果']);
    worksheet.addRow([
      'ozon-order-a',
      0,
      0.35,
      new Date('2024-01-01T00:00:00.000Z'),
      true,
      { formula: '1+2', result: 3 },
    ]);
    const bytes = await workbook.xlsx.writeBuffer();
    const result = await parseHistoricalOrderImportFile({
      name: '历史订单.xlsx',
      size: bytes.byteLength,
      arrayBuffer: async () => bytes,
    });
    expect(result.fileType).toBe('xlsx');
    expect(result.rows).toEqual([[
      'ozon-order-a',
      0,
      0.35,
      '2024-01-01T00:00:00.000Z',
      true,
      3,
    ]]);
    expect(result.mappings.map((mapping) => mapping.field)).toEqual([
      'orderNumber',
      'crossBorderCostCny',
      'weightKg',
      '',
      '',
      '',
    ]);
  });

  it('creates a Chinese template with only the Ozon order identity and optional facts', () => {
    const template = createHistoricalOrderImportTemplateCsv();
    expect(template).toContain('Ozon订单号');
    expect(template).toContain('商品成本（人民币）');
    expect(template).toContain('长度（cm）');
    expect(template).toContain('重量（kg）');
    expect(template).not.toMatch(/商家编码|SKU|商品编码/u);
    expect(template.split(/\r?\n/u)).toHaveLength(2);
  });

  it('rejects unsupported and oversized files before reading them', async () => {
    await expect(parseHistoricalOrderImportFile({ name: 'history.xls', size: 1 })).rejects.toMatchObject({
      code: 'HISTORICAL_ORDER_IMPORT_FILE_TYPE_INVALID',
    });
    await expect(parseHistoricalOrderImportFile({
      name: 'history.csv',
      size: 8 * 1024 * 1024 + 1,
    })).rejects.toMatchObject({ code: 'HISTORICAL_ORDER_IMPORT_FILE_TOO_LARGE' });
  });

  it('rejects a damaged XLSX archive with a stable business error', async () => {
    const bytes = new TextEncoder().encode('not-an-xlsx');
    await expect(parseHistoricalOrderImportFile({
      name: 'damaged.xlsx',
      size: bytes.byteLength,
      arrayBuffer: async () => bytes.buffer,
    })).rejects.toMatchObject({ code: 'HISTORICAL_ORDER_IMPORT_XLSX_INVALID' });
  });

  it('enforces explicit 20,000-row and 200-column limits before staging', async () => {
    const tooManyRows = `Ozon订单号,备注\n${Array.from({ length: 20_001 }, (_, index) => `order-${index},x`).join('\n')}`;
    await expect(parseHistoricalOrderImportFile({
      name: 'too-many.csv',
      size: tooManyRows.length,
      text: async () => tooManyRows,
    })).rejects.toMatchObject({ code: 'HISTORICAL_ORDER_IMPORT_ROWS_LIMIT_EXCEEDED' });

    const tooManyColumns = `${Array.from({ length: 201 }, (_, index) => `列${index}`).join(',')}\n${Array.from({ length: 201 }, () => 'x').join(',')}`;
    await expect(parseHistoricalOrderImportFile({
      name: 'too-wide.csv',
      size: tooManyColumns.length,
      text: async () => tooManyColumns,
    })).rejects.toMatchObject({ code: 'HISTORICAL_ORDER_IMPORT_COLUMNS_LIMIT_EXCEEDED' });
  });
});
