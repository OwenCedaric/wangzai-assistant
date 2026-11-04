import { toFiniteNumber } from '../product/productAttributes.jsx';

export function getProfitLedgerRowKey(row = {}) {
  return String(row?.ledgerKey || row?.orderKey || '').trim();
}

export function getProfitLedgerEntryValue(entry = null) {
  if (!entry || typeof entry !== 'object') return toFiniteNumber(entry);
  const status = String(entry.status ?? '').trim();
  if (status && status !== 'ready' && status !== 'provisional') return null;
  return toFiniteNumber(entry.value);
}
