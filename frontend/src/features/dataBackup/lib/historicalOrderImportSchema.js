const FIELD_DEFINITIONS = [
  {
    field: 'orderNumber',
    label: 'Ozon订单号',
    group: 'identity',
    valueType: 'text',
    aliases: [
      'ozon订单号',
      '销售订单号',
      '订单号',
      'postingnumber',
      'posting_number',
      'ordernumber',
      'order_number',
    ],
  },
  {
    field: 'purchaseCostCny',
    label: '商品成本（人民币）',
    group: 'data',
    valueType: 'nonnegative-number',
    aliases: ['商品成本', '采购成本', '采购价', '成本', 'purchasecost', 'purchase_cost_cny'],
  },
  {
    field: 'crossBorderCostCny',
    label: '跨境巴士成本（人民币）',
    group: 'data',
    valueType: 'nonnegative-number',
    aliases: ['跨境巴士成本', '跨境巴士费用', '巴士费', '跨境运费', 'crossbordercost'],
  },
  {
    field: 'domesticFreightCny',
    label: '国内运费（人民币）',
    group: 'data',
    valueType: 'nonnegative-number',
    aliases: ['国内运费', '境内运费', '国内物流费', 'domesticfreight'],
  },


  {
    field: 'sourcePlatform',
    label: '采购平台',
    group: 'data',
    valueType: 'text',
    aliases: ['采购平台', '货源平台', '平台', 'sourceplatform'],
  },
  {
    field: 'sourceUrl',
    label: '货源链接',
    group: 'data',
    valueType: 'text',
    aliases: ['货源链接', '采购链接', '商品链接', '链接', 'sourceurl', 'url'],
  },
  {
    field: 'purchaseOrderNumber',
    label: '采购订单号',
    group: 'data',
    valueType: 'text',
    aliases: ['采购订单号', '采购单号', 'purchaseordernumber'],
  },
  {
    field: 'trackingNumber',
    label: '采购运单号',
    group: 'data',
    valueType: 'text',
    aliases: ['采购运单号', '运单号', '物流单号', '快递单号', 'trackingnumber'],
  },
  {
    field: 'lengthCm',
    label: '长度（cm）',
    group: 'data',
    valueType: 'positive-number',
    aliases: ['长度', '长', '长度cm', '长cm', 'length', 'lengthcm'],
  },
  {
    field: 'widthCm',
    label: '宽度（cm）',
    group: 'data',
    valueType: 'positive-number',
    aliases: ['宽度', '宽', '宽度cm', '宽cm', 'width', 'widthcm'],
  },
  {
    field: 'heightCm',
    label: '高度（cm）',
    group: 'data',
    valueType: 'positive-number',
    aliases: ['高度', '高', '高度cm', '高cm', 'height', 'heightcm'],
  },
  {
    field: 'weightKg',
    label: '重量（kg）',
    group: 'data',
    valueType: 'positive-number',
    aliases: ['重量', '重量kg', '重kg', 'weight', 'weightkg'],
  },
  {
    field: 'note',
    label: '备注',
    group: 'data',
    valueType: 'text',
    aliases: ['备注', '说明', 'note', 'notes', 'remark'],
  },
];

export const HISTORICAL_ORDER_IMPORT_FIELDS = Object.freeze(
  FIELD_DEFINITIONS.map((definition) => Object.freeze({ ...definition })),
);

export const HISTORICAL_ORDER_DIMENSION_FIELDS = Object.freeze([
  'lengthCm',
  'widthCm',
  'heightCm',
  'weightKg',
]);

const DEFINITION_BY_FIELD = new Map(
  HISTORICAL_ORDER_IMPORT_FIELDS.map((definition) => [definition.field, definition]),
);

function normalizedHeader(value) {
  return String(value ?? '')
    .trim()
    .toLocaleLowerCase('zh-CN')
    .replace(/[\s\p{P}]+/gu, '');
}

const FIELD_BY_ALIAS = new Map();
HISTORICAL_ORDER_IMPORT_FIELDS.forEach((definition) => {
  [definition.field, definition.label, ...definition.aliases].forEach((alias) => {
    FIELD_BY_ALIAS.set(normalizedHeader(alias), definition.field);
  });
});

export function getHistoricalOrderImportField(field) {
  return DEFINITION_BY_FIELD.get(String(field || '').trim()) || null;
}

export function autoMapHistoricalOrderColumns(headers = []) {
  const claimedFields = new Set();
  return headers.map((sourceHeader, columnIndex) => {
    const candidate = FIELD_BY_ALIAS.get(normalizedHeader(sourceHeader)) || '';
    const field = candidate && !claimedFields.has(candidate) ? candidate : '';
    if (field) claimedFields.add(field);
    return {
      columnIndex,
      sourceHeader: String(sourceHeader || `第 ${columnIndex + 1} 列`).trim(),
      field,
    };
  });
}

function hasValue(value) {
  if (value === 0) return true;
  if (value === null || value === undefined) return false;
  return String(value).trim() !== '';
}

function normalizedValue(value, definition) {
  if (!hasValue(value)) return { present: false };
  if (definition.group === 'identity' && typeof value === 'number' && !Number.isSafeInteger(value)) {
    return { present: true, invalid: 'unsafe-order-number' };
  }
  if (definition.valueType === 'text') {
    return { present: true, value: String(value).trim() };
  }
  const text = typeof value === 'string'
    ? value.trim().replace(/[￥¥,，\s]/gu, '')
    : value;
  const number = Number(text);
  const positiveRequired = definition.valueType === 'positive-number';
  if (!Number.isFinite(number) || (positiveRequired ? number <= 0 : number < 0)) {
    return { present: true, invalid: positiveRequired ? 'positive-number' : 'nonnegative-number' };
  }
  return { present: true, value: number };
}

export function buildHistoricalOrderImportRows({ rows = [], mappings = [] } = {}) {
  const activeMappings = mappings
    .map((mapping) => ({
      columnIndex: Number(mapping?.columnIndex),
      sourceHeader: String(mapping?.sourceHeader || '').trim(),
      field: String(mapping?.field || '').trim(),
      definition: getHistoricalOrderImportField(mapping?.field),
    }))
    .filter((mapping) => Number.isInteger(mapping.columnIndex) && mapping.definition);
  const duplicateFields = activeMappings
    .map((mapping) => mapping.field)
    .filter((field, index, fields) => fields.indexOf(field) !== index);
  if (duplicateFields.length) {
    return {
      rows: [],
      issues: [{ rowNumber: 1, code: 'DUPLICATE_FIELD_MAPPING', message: '同一个导入字段不能对应多列。' }],
      skippedRows: rows.length,
    };
  }

  const output = [];
  const issues = [];
  let skippedRows = 0;
  rows.forEach((sourceRow, rowIndex) => {
    const target = {};
    let invalid = false;
    activeMappings.forEach((mapping) => {
      const normalized = normalizedValue(sourceRow?.[mapping.columnIndex], mapping.definition);
      if (!normalized.present) return;
      if (normalized.invalid) {
        invalid = true;
        let message = `第 ${rowIndex + 2} 行“${mapping.definition.label}”不是有效的非负数字。`;
        if (normalized.invalid === 'unsafe-order-number') {
          message = `第 ${rowIndex + 2} 行“Ozon订单号”超过 Excel 可安全保存的数字范围，请将该列设为文本后重新导入。`;
        } else if (normalized.invalid === 'positive-number') {
          message = `第 ${rowIndex + 2} 行“${mapping.definition.label}”填写后必须大于 0。`;
        }
        issues.push({
          rowNumber: rowIndex + 2,
          field: mapping.field,
          code: normalized.invalid === 'unsafe-order-number'
            ? 'ORDER_NUMBER_UNSAFE'
            : normalized.invalid === 'positive-number' ? 'POSITIVE_NUMBER_REQUIRED' : 'NUMBER_INVALID',
          message,
        });
        return;
      }
      target[mapping.field] = normalized.value;
    });
    if (invalid) {
      skippedRows += 1;
      return;
    }
    if (!Object.keys(target).length) {
      skippedRows += 1;
      return;
    }
    if (!hasValue(target.orderNumber)) {
      issues.push({
        rowNumber: rowIndex + 2,
        code: 'ORDER_NUMBER_REQUIRED',
        message: `第 ${rowIndex + 2} 行缺少“Ozon订单号”。`,
      });
      skippedRows += 1;
      return;
    }
    output.push(target);
  });

  return { rows: output, issues, skippedRows };
}

export function historicalOrderTemplateHeaders() {
  return HISTORICAL_ORDER_IMPORT_FIELDS.map((definition) => definition.label);
}
