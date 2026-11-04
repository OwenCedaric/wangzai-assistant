import { getDataDomain } from '../data/dataDomainRegistry.js';
import { createRecoveryStorageAdapter } from './recoveryStorageAdapter.js';

/** Controlled historical SQL shares the backup authority/transaction contract. */
export function createHistoricalImportStorage({ db, storageAdapter, safetyErrorCode } = {}) {
  const adapter = storageAdapter || createRecoveryStorageAdapter({ db });
  let operationDatabases = null;

  function databaseFor(domain, shopId) {
    const key = JSON.stringify([shopId, domain]);
    if (operationDatabases?.has(key)) return operationDatabases.get(key);
    const resolved = adapter.resolveDatabase({ db, shopId, policy: getDataDomain(domain) });
    operationDatabases?.set(key, resolved);
    return resolved;
  }

  function statement(domain, sql) {
    const statements = new WeakMap();
    function prepare(shopId) {
      const source = databaseFor(domain, shopId);
      let prepared = statements.get(source);
      if (!prepared) {
        prepared = source.prepare(sql);
        statements.set(source, prepared);
      }
      return prepared;
    }
    return Object.freeze({
      get(...args) { return prepare(args[0]).get(...args); },
      all(...args) { return prepare(args[0]).all(...args); },
    });
  }

  function withScope(work) {
    const previous = operationDatabases;
    operationDatabases = new Map();
    try { return work(); } finally { operationDatabases = previous; }
  }

  function safety(shopId, domains) {
    const result = adapter.getImportSafety({ shopId, domains });
    return result.writeAllowed ? result : { ...result, errorCode: safetyErrorCode || result.errorCode };
  }

  function openConfirmation(shopId, domains) {
    try {
      const session = adapter.openImportSession({ shopId, domains });
      operationDatabases?.clear(); // Subsequent reads must use the attached transaction connection.
      return session;
    } catch (error) {
      if (error?.code === 'DATA_BACKUP_IMPORT_SAFE_RESTORE_REQUIRED' && safetyErrorCode) {
        const translated = new Error(safetyErrorCode);
        translated.code = safetyErrorCode;
        throw translated;
      }
      throw error;
    }
  }

  return Object.freeze({ databaseFor, statement, withScope, safety, openConfirmation });
}
