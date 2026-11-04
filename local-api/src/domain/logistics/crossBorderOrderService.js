import { createCrossBorderOrderRepository } from '../../db/repositories/crossBorderOrderRepository.js';

function hasCrossBorderOrderTable(db) {
  try {
    return Boolean(db?.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cross_border_order_records'").get());
  } catch {
    return false;
  }
}

export function createCrossBorderOrderService({ db } = {}) {
  const repository = db && hasCrossBorderOrderTable(db) ? createCrossBorderOrderRepository(db) : null;

  function ensureRepository() {
    if (!repository) {
      const error = new Error('cross-border order SQLite table is not connected.');
      error.code = 'CROSS_BORDER_ORDER_RECORDS_NOT_CONNECTED';
      throw error;
    }
    return repository;
  }

  function listOrderRecords(query = {}) {
    return ensureRepository().listRecords(query);
  }

  function saveOrderRecord(payload = {}) {
    if (Array.isArray(payload?.records) || Array.isArray(payload?.items)) {
      return ensureRepository().upsertRecords(payload);
    }
    return ensureRepository().upsertRecord(payload);
  }

  function deleteOrderRecord(payload = {}) {
    return ensureRepository().deleteRecord(payload);
  }

  return {
    domain: 'cross-border-orders',
    listOrderRecords,
    saveOrderRecord,
    deleteOrderRecord,
  };
}
