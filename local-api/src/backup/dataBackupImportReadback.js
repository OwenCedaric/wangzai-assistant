import { fail, normalizeText, publicGenericPlan } from "./dataBackupImportPlan.js";
import { canonicalJson } from "./recoveryChunkCodec.js";

export function parseEncryptedJson(decryptShopSecret, encrypted) {
  try {
    const plaintext = decryptShopSecret(encrypted);
    const value = JSON.parse(String(plaintext || ''));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid');
    return value;
  } catch {
    fail('DATA_BACKUP_IMPORT_READBACK_FAILED');
  }
}

export function restoredTaskStatus(value) {
  const status = normalizeText(value);
  if (['confirmed', 'executing', 'receipt_pending'].includes(status)) return 'interrupted';
  return status;
}

export function sameScalar(left, right) {
  if (left === right || (left == null && right == null)) return true;
  return String(left) === String(right);
}

export function assertReadbackFields(actual, expected) {
  if (!actual) fail('DATA_BACKUP_IMPORT_READBACK_FAILED');
  for (const [field, value] of Object.entries(expected)) {
    if (!sameScalar(actual[field], value)) fail('DATA_BACKUP_IMPORT_READBACK_FAILED');
  }
}

export function assertProfileReadback(db, expected, { decryptShopSecret }) {
  for (const expectedSetting of expected.settings) {
    const settingRow = db.prepare(`
      SELECT value_json, created_at, updated_at
      FROM profile_settings WHERE namespace = ?
    `).get(expectedSetting.namespace);
    try {
      const value = JSON.parse(settingRow?.value_json || '');
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid');
      if (
        canonicalJson(value) !== canonicalJson(expectedSetting.value)
        || normalizeText(settingRow.created_at) !== normalizeText(expectedSetting.createdAt)
        || normalizeText(settingRow.updated_at) !== normalizeText(expectedSetting.updatedAt)
      ) throw new Error('mismatch');
    } catch {
      fail('DATA_BACKUP_IMPORT_READBACK_FAILED');
    }
  }
  for (const task of expected.tasks) {
    const row = db.prepare(`
      SELECT id, owner_id, owner_incarnation, shop_id, order_key, product_key,
        idempotency_key_hash, request_fingerprint, preview_encrypted,
        preview_fingerprint, status, attempt_count, receipt_id, last_error_code,
        created_at, updated_at, confirmed_at, completed_at
      FROM purchase_browser_tasks WHERE id = ?
    `).get(task.id);
    assertReadbackFields(row, {
      id: task.id,
      owner_id: task.record.owner_id,
      owner_incarnation: task.record.owner_incarnation,
      shop_id: task.shopId,
    });
    if (task.disposition !== 'preserved') {
      const status = restoredTaskStatus(task.record.status);
      assertReadbackFields(row, {
        order_key: task.record.order_key,
        product_key: task.record.product_key,
        idempotency_key_hash: task.record.idempotency_key_hash,
        request_fingerprint: task.record.request_fingerprint,
        preview_fingerprint: task.record.preview_fingerprint,
        status,
        attempt_count: Number(task.record.attempt_count),
        receipt_id: task.record.receipt_id || null,
        last_error_code: status === 'interrupted'
          ? 'PURCHASE_BROWSER_PROCESS_INTERRUPTED'
          : task.record.last_error_code || null,
        created_at: task.record.created_at,
        updated_at: task.record.updated_at,
        confirmed_at: task.record.confirmed_at || null,
        completed_at: status === 'completed' ? task.record.completed_at || null : null,
      });
      if (
        canonicalJson(parseEncryptedJson(decryptShopSecret, row.preview_encrypted))
        !== canonicalJson(task.record.preview)
      ) fail('DATA_BACKUP_IMPORT_READBACK_FAILED');
    }
  }
  for (const receipt of expected.receipts) {
    const row = db.prepare(`
      SELECT id, task_id, owner_id, shop_id, attempt_id, receipt_encrypted,
        receipt_hash, website_readback_hash, created_at
      FROM purchase_browser_receipts WHERE id = ?
    `).get(receipt.id);
    assertReadbackFields(row, {
      id: receipt.id,
      task_id: receipt.record.task_id,
      owner_id: receipt.record.owner_id,
      shop_id: receipt.shopId,
    });
    if (receipt.disposition !== 'preserved') {
      assertReadbackFields(row, {
        attempt_id: receipt.record.attempt_id,
        receipt_hash: receipt.record.receipt_hash,
        website_readback_hash: receipt.record.website_readback_hash,
        created_at: receipt.record.created_at,
      });
      if (
        canonicalJson(parseEncryptedJson(decryptShopSecret, row.receipt_encrypted))
        !== canonicalJson(receipt.record.receipt)
      ) fail('DATA_BACKUP_IMPORT_READBACK_FAILED');
    }
  }
  for (const history of expected.completionHistory) {
    const row = db.prepare(`
      SELECT shop_id, source_task_id, source_receipt_id,
        source_account_ref_hash, order_number_hash, receipt_encrypted,
        receipt_hash, website_readback_hash, order_product_encrypted,
        order_product_hash, source_summary_encrypted, source_summary_hash,
        archive_origin, completed_at, archived_at, created_at, updated_at
      FROM purchase_completion_history
      WHERE shop_id = ? AND source_receipt_id = ?
    `).get(history.shopId, history.sourceReceiptId);
    assertReadbackFields(row, {
      shop_id: history.shopId,
      source_receipt_id: history.sourceReceiptId,
    });
    if (history.disposition !== 'preserved') {
      assertReadbackFields(row, {
        source_task_id: history.record.source_task_id,
        source_account_ref_hash: history.record.source_account_ref_hash,
        order_number_hash: history.record.order_number_hash,
        receipt_hash: history.record.receipt_hash,
        website_readback_hash: history.record.website_readback_hash,
        order_product_hash: history.record.order_product_hash,
        source_summary_hash: history.record.source_summary_hash,
        archive_origin: history.record.archive_origin,
        completed_at: history.record.completed_at,
        archived_at: history.record.archived_at,
        created_at: history.record.created_at,
        updated_at: history.record.updated_at,
      });
      for (const [encryptedField, sourceField] of [
        ['receipt_encrypted', 'receipt'],
        ['order_product_encrypted', 'order_product'],
        ['source_summary_encrypted', 'source_summary'],
      ]) {
        if (
          canonicalJson(parseEncryptedJson(decryptShopSecret, row[encryptedField]))
          !== canonicalJson(history.record[sourceField])
        ) fail('DATA_BACKUP_IMPORT_READBACK_FAILED');
      }
    }
  }
  if (db.prepare('PRAGMA foreign_key_check').all().length) fail('DATA_BACKUP_IMPORT_FOREIGN_KEY_FAILED');
}

export function assertGenericPlanApplied(plan, applied) {
  const publicApplied = publicGenericPlan(applied);
  if (canonicalJson(publicGenericPlan(plan)) !== canonicalJson(publicApplied)) {
    fail('DATA_BACKUP_IMPORT_PLAN_DRIFT');
  }
}
