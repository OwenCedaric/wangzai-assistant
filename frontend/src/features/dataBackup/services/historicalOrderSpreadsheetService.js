import {
  autoMapHistoricalOrderColumns,
  historicalOrderTemplateHeaders,
} from '../lib/historicalOrderImportSchema.js';
import { parseFirstXlsxWorksheet } from './xlsxMatrixParser.js';

const MAX_IMPORT_FILE_BYTES = 8 * 1024 * 1024;
const MAX_IMPORT_DATA_ROWS = 20_000;
const MAX_IMPORT_COLUMNS = 200;
const SUPPORTED_EXTENSIONS = new Set(['csv', 'xlsx']);

function extensionOf(fileName) {
  return String(fileName || '').trim().split('.').at(-1)?.toLocaleLowerCase('en-US') || '';
}

function spreadsheetError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertImportFile(file) {
  if (!file || typeof file !== 'object') {
    throw spreadsheetError('请选择需要导入的历史订单文件。', 'HISTORICAL_ORDER_IMPORT_FILE_REQUIRED');
  }
  const extension = extensionOf(file.name);
  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    throw spreadsheetError('仅支持 CSV 或 XLSX 文件。', 'HISTORICAL_ORDER_IMPORT_FILE_TYPE_INVALID');
  }
  if (Number(file.size) > MAX_IMPORT_FILE_BYTES) {
    throw spreadsheetError('导入文件不能超过 8 MB。', 'HISTORICAL_ORDER_IMPORT_FILE_TOO_LARGE');
  }
  return extension;
}

function parseCsvText(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const source = String(text || '').replace(/^\uFEFF/u, '');
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '"') {
      if (quoted && source[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (!quoted && character === ',') {
      row.push(cell);
      if (row.length > MAX_IMPORT_COLUMNS) {
        throw spreadsheetError(`导入文件最多允许 ${MAX_IMPORT_COLUMNS} 列。`, 'HISTORICAL_ORDER_IMPORT_COLUMNS_LIMIT_EXCEEDED');
      }
      cell = '';
      continue;
    }
    if (!quoted && (character === '\n' || character === '\r')) {
      if (character === '\r' && source[index + 1] === '\n') index += 1;
      row.push(cell);
      if (row.length > MAX_IMPORT_COLUMNS) {
        throw spreadsheetError(`导入文件最多允许 ${MAX_IMPORT_COLUMNS} 列。`, 'HISTORICAL_ORDER_IMPORT_COLUMNS_LIMIT_EXCEEDED');
      }
      rows.push(row);
      if (rows.length > MAX_IMPORT_DATA_ROWS + 1) {
        throw spreadsheetError(`导入文件最多允许 ${MAX_IMPORT_DATA_ROWS} 行数据。`, 'HISTORICAL_ORDER_IMPORT_ROWS_LIMIT_EXCEEDED');
      }
      row = [];
      cell = '';
      continue;
    }
    cell += character;
  }
  if (quoted) {
    throw spreadsheetError('CSV 文件存在未闭合的引号。', 'HISTORICAL_ORDER_IMPORT_CSV_INVALID');
  }
  if (cell || row.length) {
    row.push(cell);
    if (row.length > MAX_IMPORT_COLUMNS) {
      throw spreadsheetError(`导入文件最多允许 ${MAX_IMPORT_COLUMNS} 列。`, 'HISTORICAL_ORDER_IMPORT_COLUMNS_LIMIT_EXCEEDED');
    }
    rows.push(row);
    if (rows.length > MAX_IMPORT_DATA_ROWS + 1) {
      throw spreadsheetError(`导入文件最多允许 ${MAX_IMPORT_DATA_ROWS} 行数据。`, 'HISTORICAL_ORDER_IMPORT_ROWS_LIMIT_EXCEEDED');
    }
  }
  return rows;
}

function trimMatrix(matrix) {
  const rows = matrix.map((row) => (Array.isArray(row) ? row : []));
  while (rows.length && rows.at(-1).every((value) => String(value ?? '').trim() === '')) rows.pop();
  const width = rows.reduce((maximum, row) => Math.max(maximum, row.length), 0);
  let lastNonEmptyColumn = -1;
  for (let columnIndex = 0; columnIndex < width; columnIndex += 1) {
    if (rows.some((row) => String(row[columnIndex] ?? '').trim() !== '')) lastNonEmptyColumn = columnIndex;
  }
  return rows.map((row) => row.slice(0, lastNonEmptyColumn + 1));
}

async function fileText(file) {
  if (typeof file.text === 'function') return file.text();
  const bytes = await file.arrayBuffer();
  return new TextDecoder('utf-8').decode(bytes);
}

async function parseXlsx(file) {
  return parseFirstXlsxWorksheet(await file.arrayBuffer(), {
    maxRows: MAX_IMPORT_DATA_ROWS + 1,
    maxColumns: MAX_IMPORT_COLUMNS,
  });
}

export async function parseHistoricalOrderImportFile(file) {
  const extension = assertImportFile(file);
  const matrix = trimMatrix(
    extension === 'csv' ? parseCsvText(await fileText(file)) : await parseXlsx(file),
  );
  if (!matrix.length || !matrix[0].some((value) => String(value ?? '').trim())) {
    throw spreadsheetError('导入文件没有有效表头。', 'HISTORICAL_ORDER_IMPORT_HEADER_REQUIRED');
  }
  const width = matrix.reduce((maximum, row) => Math.max(maximum, row.length), 0);
  if (width > MAX_IMPORT_COLUMNS) {
    throw spreadsheetError(`导入文件最多允许 ${MAX_IMPORT_COLUMNS} 列。`, 'HISTORICAL_ORDER_IMPORT_COLUMNS_LIMIT_EXCEEDED');
  }
  const headers = Array.from({ length: width }, (_, columnIndex) => (
    String(matrix[0]?.[columnIndex] ?? '').trim() || `第 ${columnIndex + 1} 列`
  ));
  const rows = matrix.slice(1).map((row) => (
    Array.from({ length: width }, (_, columnIndex) => row[columnIndex] ?? '')
  ));
  if (rows.length > MAX_IMPORT_DATA_ROWS) {
    throw spreadsheetError(`导入文件最多允许 ${MAX_IMPORT_DATA_ROWS} 行数据。`, 'HISTORICAL_ORDER_IMPORT_ROWS_LIMIT_EXCEEDED');
  }
  if (!rows.length) {
    throw spreadsheetError('导入文件没有历史订单数据。', 'HISTORICAL_ORDER_IMPORT_ROWS_REQUIRED');
  }
  return {
    fileName: String(file.name || '').split(/[\\/]/u).at(-1) || `历史订单数据.${extension}`,
    fileType: extension,
    fileSize: Number(file.size) || 0,
    headers,
    rows,
    mappings: autoMapHistoricalOrderColumns(headers),
  };
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

export function createHistoricalOrderImportTemplateCsv() {
  return `\uFEFF${historicalOrderTemplateHeaders().map(csvCell).join(',')}\r\n`;
}

export function downloadHistoricalOrderImportTemplate() {
  const content = createHistoricalOrderImportTemplateCsv();
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
  const objectUrl = globalThis.URL?.createObjectURL?.(blob);
  if (!objectUrl || !globalThis.document?.createElement) {
    throw spreadsheetError('当前环境无法下载模板。', 'HISTORICAL_ORDER_IMPORT_TEMPLATE_DOWNLOAD_UNAVAILABLE');
  }
  const anchor = globalThis.document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = '历史订单导入模板.csv';
  anchor.style.display = 'none';
  globalThis.document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  globalThis.URL.revokeObjectURL?.(objectUrl);
}
