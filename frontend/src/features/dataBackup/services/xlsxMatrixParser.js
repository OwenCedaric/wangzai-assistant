import { strFromU8, unzipSync } from 'fflate';

const OFFICE_RELATIONSHIP_NAMESPACE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const STANDARD_DATE_FORMAT_IDS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36,
  45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58,
]);
const MAX_XLSX_ARCHIVE_FILES = 1_024;
const MAX_XLSX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;

function xlsxError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function parseXml(bytes, label) {
  if (!bytes) throw xlsxError(`XLSX 文件缺少${label}。`, 'HISTORICAL_ORDER_IMPORT_XLSX_INVALID');
  const parser = new DOMParser();
  const document = parser.parseFromString(strFromU8(bytes), 'application/xml');
  if (document.getElementsByTagName('parsererror').length) {
    throw xlsxError(`XLSX 文件的${label}无法解析。`, 'HISTORICAL_ORDER_IMPORT_XLSX_INVALID');
  }
  return document;
}

function elementsByLocalName(root, name) {
  return Array.from(root.getElementsByTagName('*')).filter((element) => element.localName === name);
}

function firstElementByLocalName(root, name) {
  return elementsByLocalName(root, name)[0] || null;
}

function relationshipId(element) {
  return element.getAttributeNS(OFFICE_RELATIONSHIP_NAMESPACE, 'id')
    || element.getAttribute('r:id')
    || '';
}

function normalizedArchivePath(basePath, target) {
  const cleanTarget = String(target || '').replace(/\\/gu, '/');
  const initial = cleanTarget.startsWith('/')
    ? cleanTarget.slice(1).split('/')
    : `${basePath}/${cleanTarget}`.split('/');
  const output = [];
  for (const part of initial) {
    if (!part || part === '.') continue;
    if (part === '..') output.pop();
    else output.push(part);
  }
  return output.join('/');
}

function firstWorksheetPath(archive) {
  const workbook = parseXml(archive['xl/workbook.xml'], '工作簿信息');
  const firstSheet = firstElementByLocalName(workbook, 'sheet');
  if (!firstSheet) {
    throw xlsxError('XLSX 文件没有可读取的工作表。', 'HISTORICAL_ORDER_IMPORT_SHEET_REQUIRED');
  }
  const relationId = relationshipId(firstSheet);
  const relationships = parseXml(
    archive['xl/_rels/workbook.xml.rels'],
    '工作表关系信息',
  );
  const relation = elementsByLocalName(relationships, 'Relationship')
    .find((item) => item.getAttribute('Id') === relationId);
  if (!relation) {
    throw xlsxError('XLSX 文件的首个工作表关系无效。', 'HISTORICAL_ORDER_IMPORT_XLSX_INVALID');
  }
  return normalizedArchivePath('xl', relation.getAttribute('Target'));
}

function sharedStrings(archive) {
  const bytes = archive['xl/sharedStrings.xml'];
  if (!bytes) return [];
  const document = parseXml(bytes, '共享文本');
  return elementsByLocalName(document, 'si').map((item) => (
    elementsByLocalName(item, 't').map((text) => text.textContent || '').join('')
  ));
}

function dateStyleIndexes(archive) {
  const bytes = archive['xl/styles.xml'];
  if (!bytes) return new Set();
  const document = parseXml(bytes, '样式信息');
  const formats = new Map();
  for (const format of elementsByLocalName(document, 'numFmt')) {
    formats.set(Number(format.getAttribute('numFmtId')), format.getAttribute('formatCode') || '');
  }
  const cellFormats = elementsByLocalName(document, 'cellXfs')[0];
  if (!cellFormats) return new Set();
  const result = new Set();
  elementsByLocalName(cellFormats, 'xf').forEach((format, index) => {
    const formatId = Number(format.getAttribute('numFmtId'));
    const custom = String(formats.get(formatId) || '')
      .replace(/"[^"]*"/gu, '')
      .replace(/\\./gu, '')
      .replace(/\[[^\]]*\]/gu, '')
      .toLocaleLowerCase('en-US');
    if (STANDARD_DATE_FORMAT_IDS.has(formatId) || /[ymdhis]/u.test(custom)) result.add(index);
  });
  return result;
}

function uses1904DateSystem(archive) {
  const workbook = parseXml(archive['xl/workbook.xml'], '工作簿信息');
  const properties = firstElementByLocalName(workbook, 'workbookPr');
  return ['1', 'true'].includes(String(properties?.getAttribute('date1904') || '').toLowerCase());
}

function excelSerialToIso(value, date1904) {
  const serial = Number(value);
  if (!Number.isFinite(serial)) return value;
  const adjusted = date1904 ? serial + 1_462 : serial - (serial >= 60 ? 1 : 0);
  const milliseconds = Date.UTC(1899, 11, 31) + adjusted * 86_400_000;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

function columnIndex(reference) {
  const letters = String(reference || '').match(/^[A-Za-z]+/u)?.[0] || '';
  if (!letters) return -1;
  let value = 0;
  for (const letter of letters.toUpperCase()) value = value * 26 + letter.charCodeAt(0) - 64;
  return value - 1;
}

function cellValue(cell, strings, dateStyles, date1904) {
  const type = cell.getAttribute('t') || '';
  if (type === 'inlineStr') {
    const inline = firstElementByLocalName(cell, 'is');
    return inline ? elementsByLocalName(inline, 't').map((item) => item.textContent || '').join('') : '';
  }
  const raw = firstElementByLocalName(cell, 'v')?.textContent ?? '';
  if (type === 's') return strings[Number(raw)] ?? '';
  if (type === 'b') return raw === '1';
  if (type === 'str' || type === 'e' || type === 'd') return raw;
  if (raw === '') return '';
  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) return raw;
  const styleIndex = Number(cell.getAttribute('s'));
  return dateStyles.has(styleIndex) ? excelSerialToIso(numeric, date1904) : numeric;
}

function assertArchiveLimits(archive) {
  const entries = Object.entries(archive);
  if (entries.length > MAX_XLSX_ARCHIVE_FILES) {
    throw xlsxError('XLSX 文件包含的内部文件过多。', 'HISTORICAL_ORDER_IMPORT_XLSX_INVALID');
  }
  const totalBytes = entries.reduce((sum, [, bytes]) => sum + bytes.byteLength, 0);
  if (totalBytes > MAX_XLSX_UNCOMPRESSED_BYTES) {
    throw xlsxError('XLSX 文件解压后的内容过大。', 'HISTORICAL_ORDER_IMPORT_FILE_TOO_LARGE');
  }
}

export function parseFirstXlsxWorksheet(bytes, { maxRows, maxColumns }) {
  let archive;
  try {
    archive = unzipSync(new Uint8Array(bytes));
  } catch {
    throw xlsxError('XLSX 文件损坏或格式不正确。', 'HISTORICAL_ORDER_IMPORT_XLSX_INVALID');
  }
  assertArchiveLimits(archive);
  const sheet = parseXml(archive[firstWorksheetPath(archive)], '首个工作表');
  const strings = sharedStrings(archive);
  const dateStyles = dateStyleIndexes(archive);
  const date1904 = uses1904DateSystem(archive);
  const matrix = [];
  for (const row of elementsByLocalName(sheet, 'row')) {
    const values = [];
    let fallbackColumn = 0;
    for (const cell of Array.from(row.children).filter((item) => item.localName === 'c')) {
      const referencedColumn = columnIndex(cell.getAttribute('r'));
      const index = referencedColumn >= 0 ? referencedColumn : fallbackColumn;
      if (index >= maxColumns) {
        throw xlsxError(`导入文件最多允许 ${maxColumns} 列。`, 'HISTORICAL_ORDER_IMPORT_COLUMNS_LIMIT_EXCEEDED');
      }
      values[index] = cellValue(cell, strings, dateStyles, date1904);
      fallbackColumn = index + 1;
    }
    if (values.some((value) => String(value ?? '').trim() !== '')) matrix.push(values);
    if (matrix.length > maxRows) {
      throw xlsxError(`导入文件最多允许 ${maxRows - 1} 行数据。`, 'HISTORICAL_ORDER_IMPORT_ROWS_LIMIT_EXCEEDED');
    }
  }
  return matrix;
}
