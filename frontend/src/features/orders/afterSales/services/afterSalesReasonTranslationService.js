import { requestLocalApi } from '../../../../api/localApiClient.js';

export const AFTER_SALES_REASON_TRANSLATING_LABEL = '售后原因翻译中';
export const AFTER_SALES_REASON_TRANSLATION_FAILED_LABEL = '售后原因翻译暂不可用';

export function containsCyrillicReason(value = '') {
  return /[\u0400-\u04FF]/u.test(String(value));
}

function normalizeText(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function getReasonRaw(row = {}) {
  const explicit = normalizeText(
    row.reasonRaw ?? row.reason_raw ?? row.return_reason_raw,
  );
  if (explicit) return explicit;
  const visible = normalizeText(row.reason ?? row.return_reason);
  return containsCyrillicReason(visible) ? visible : '';
}

function getResolvedChineseReason(row = {}) {
  const explicit = normalizeText(
    row.reasonZh ?? row.reason_zh ?? row.return_reason_zh,
  );
  if (explicit && !containsCyrillicReason(explicit)) return explicit;
  const visible = normalizeText(row.reason ?? row.return_reason);
  if (
    visible &&
    !containsCyrillicReason(visible) &&
    visible !== AFTER_SALES_REASON_TRANSLATING_LABEL &&
    visible !== AFTER_SALES_REASON_TRANSLATION_FAILED_LABEL
  ) {
    return visible;
  }
  return '';
}

export function buildAfterSalesReasonTranslationMessages(rows = []) {
  const messages = [];
  const seen = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const text = getReasonRaw(row);
    if (!containsCyrillicReason(text) || getResolvedChineseReason(row)) continue;
    const shopId = normalizeText(row.shopId ?? row.shop_id);
    const key = `${shopId}\u0000${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    messages.push({
      id: `after-sales-reason-${messages.length + 1}`,
      shopId,
      text,
    });
  }
  return messages;
}

export async function requestAfterSalesReasonTranslations(messages = [], options = {}) {
  if (!messages.length) return { ok: true, rows: [], translatedCount: 0, failedCount: 0 };
  return requestLocalApi('/api/returns/reasons/translate', {
    method: 'POST',
    body: { messages },
    timeoutMs: options.timeoutMs ?? 45_000,
    signal: options.signal,
  });
}

export function createAfterSalesReasonTranslationMap(payload = {}) {
  const map = new Map();
  for (const row of Array.isArray(payload?.rows) ? payload.rows : []) {
    const source = normalizeText(row.text);
    const translatedText = normalizeText(row.translatedText);
    if (!source) continue;
    map.set(source, {
      translatedText:
        row.translated === true && translatedText && !containsCyrillicReason(translatedText)
          ? translatedText
          : '',
      failed: row.translated !== true,
      provider: normalizeText(row.provider),
    });
  }
  return map;
}

export function applyAfterSalesReasonTranslations(rows = [], translations = new Map()) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const rawReason = getReasonRaw(row);
    if (!containsCyrillicReason(rawReason)) return row;
    const resolved = getResolvedChineseReason(row);
    const dynamic = translations.get(rawReason);
    const translatedText = resolved || normalizeText(dynamic?.translatedText);
    const reason = translatedText ||
      (dynamic?.failed
        ? AFTER_SALES_REASON_TRANSLATION_FAILED_LABEL
        : AFTER_SALES_REASON_TRANSLATING_LABEL);
    return {
      ...row,
      reason,
      reasonZh: translatedText,
      reason_zh: translatedText,
      reasonRaw: rawReason,
      reason_raw: rawReason,
      reasonTranslationStatus: translatedText
        ? 'translated'
        : dynamic?.failed
          ? 'failed'
          : 'pending',
      reasonTranslationProvider: dynamic?.provider || row.reasonTranslationProvider || '',
    };
  });
}
