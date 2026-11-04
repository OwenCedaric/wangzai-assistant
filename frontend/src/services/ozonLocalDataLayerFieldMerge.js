import { hasProtectedManualValue, isProtectedManualDataField } from './manualDataProtection.js';
import {
  mergeAfterSalesFinanceEvidenceValue,
  shouldKeepAfterSalesStrongField,
} from './ozonAfterSalesCacheMergePolicy.js';
import { isAfterSalesSnapshot } from './ozonLocalDataLayerIdentity.js';
import {
  AFTER_SALES_CLEARABLE_CLASSIFICATION_FIELDS,
  OZON_LOCAL_DATA_LAYER_VERSION,
  cloneJsonSafe,
  createSignature,
  hasEffectiveFieldValue,
  isMissingTextValue,
  isPlainObject,
  mergeEffectiveObjectValue,
  normalizeText,
} from './ozonLocalDataLayerShared.js';

export function mergeFieldValues(currentFields = {}, currentFieldMeta = {}, freshFields = {}, timestamp, options = {}) {
  const fields = { ...(isPlainObject(currentFields) ? currentFields : {}) };
  const fieldMeta = { ...(isPlainObject(currentFieldMeta) ? currentFieldMeta : {}) };
  const source = normalizeText(options.source || 'ozon');
  const endpoint = normalizeText(options.endpoint || options.snapshotKey || '');
  const isManualSource = /(manual|local|override|user|人工)/i.test(source);
  const freshClassificationVersion = Number(freshFields?.classificationVersion);
  const currentClassificationVersion = Number(fields?.classificationVersion);
  const canClearAfterSalesClassificationField =
    isAfterSalesSnapshot(options) &&
    Number.isFinite(freshClassificationVersion) &&
    freshClassificationVersion > 0 &&
    (!Number.isFinite(currentClassificationVersion) || freshClassificationVersion >= currentClassificationVersion);

  for (const [field, value] of Object.entries(freshFields || {})) {
    const cloned = cloneJsonSafe(value);
    const hasFreshValue = hasEffectiveFieldValue(cloned);
    if (hasFreshValue) {
      if (isAfterSalesSnapshot(options) && shouldKeepAfterSalesStrongField(fields, field, cloned)) {
        continue;
      }
      if (!isManualSource && isProtectedManualDataField(field) && hasProtectedManualValue(fields[field])) {
        continue;
      }
      const mergedValue =
        isAfterSalesSnapshot(options) && field === 'financeRefundEvidence'
          ? mergeAfterSalesFinanceEvidenceValue(fields[field], cloned, fields, freshFields)
          : isPlainObject(cloned)
            ? mergeEffectiveObjectValue(fields[field], cloned)
            : cloned;
      const hash = createSignature(mergedValue);
      fields[field] = mergedValue;
      fieldMeta[field] = {
        status: 'fresh',
        source,
        endpoint,
        readAt: timestamp,
        verifiedAt: timestamp,
        updatedAt: fieldMeta[field]?.hash === hash ? fieldMeta[field].updatedAt || timestamp : timestamp,
        hash,
        version: OZON_LOCAL_DATA_LAYER_VERSION,
      };
      continue;
    }

    if (canClearAfterSalesClassificationField && AFTER_SALES_CLEARABLE_CLASSIFICATION_FIELDS.has(field)) {
      const clearedValue = cloned === undefined ? '' : cloned;
      const hash = createSignature(clearedValue);
      fields[field] = clearedValue;
      fieldMeta[field] = {
        status: 'fresh',
        source,
        endpoint,
        readAt: timestamp,
        verifiedAt: timestamp,
        updatedAt: fieldMeta[field]?.hash === hash ? fieldMeta[field].updatedAt || timestamp : timestamp,
        hash,
        version: OZON_LOCAL_DATA_LAYER_VERSION,
      };
      continue;
    }

    const previous = fieldMeta[field];
    fieldMeta[field] = {
      ...(previous || {}),
      status: fields[field] !== undefined ? 'cached' : 'missing',
      source: previous?.source || source,
      endpoint: previous?.endpoint || endpoint,
      lastMissingAt: timestamp,
      lastMissingReason: isMissingTextValue(cloned) ? normalizeText(cloned) || '未返回' : '未返回',
      version: OZON_LOCAL_DATA_LAYER_VERSION,
    };
  }

  return { fields, fieldMeta };
}
