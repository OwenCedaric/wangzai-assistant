import { ACCOUNT_REMOVAL_ERROR_CODES } from './accountRemovalErrors.js';

/** Node's built-in SQLite exposes ERR_SQLITE_ERROR plus an integer errcode. */
export function isAccountRemovalSqliteBusyError(error) {
  const seen = new Set();
  let current = error;
  for (let depth = 0; current && depth < 8 && !seen.has(current); depth += 1) {
    seen.add(current);
    const code = String(current?.code || '').toUpperCase();
    if (code === ACCOUNT_REMOVAL_ERROR_CODES.DATABASE_BUSY || /^SQLITE_(?:BUSY|LOCKED)/u.test(code)) return true;
    const sqliteWrapper = !code || /^ERR_SQLITE/u.test(code)
      || code === ACCOUNT_REMOVAL_ERROR_CODES.SQLITE_EXECUTION_FAILED;
    if (!sqliteWrapper) return false; // Preserve explicit safety/authorization failures.
    const numericCode = Number(current?.errcode ?? current?.sqliteErrcode);
    if (Number.isSafeInteger(numericCode) && numericCode > 0 && [5, 6].includes(numericCode & 0xff)) return true;
    const message = String(current?.message || current || '');
    if (/database(?: table| schema)? is (?:locked|busy)|SQLITE_(?:BUSY|LOCKED)/iu.test(message)) return true;
    current = current?.cause;
  }
  return false;
}

export function accountRemovalOperationErrorCode(error) {
  if (isAccountRemovalSqliteBusyError(error)) return ACCOUNT_REMOVAL_ERROR_CODES.DATABASE_BUSY;
  const explicitCode = typeof error?.code === 'string' ? error.code : '';
  if (explicitCode) return explicitCode;
  const message = error instanceof Error ? error.message : String(error || '');
  const match = message.match(/^(ACCOUNT_REMOVAL_[A-Z0-9_]+|PERFORMANCE_[A-Z0-9_]+|OZON_[A-Z0-9_]+|CATALOG_[A-Z0-9_]+)/u);
  return match?.[1] || 'ACCOUNT_REMOVAL_EXECUTION_FAILED';
}
