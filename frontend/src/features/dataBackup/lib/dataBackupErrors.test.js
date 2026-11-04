import { describe, expect, it } from 'vitest';
import { getDataBackupErrorMessage, presentDataBackupError } from './dataBackupErrors.js';

describe('dataBackupErrors', () => {
  it('maps known internal codes to Chinese and hides unknown codes', () => {
    expect(getDataBackupErrorMessage('HISTORICAL_IMPORT_PREVIEW_STALE')).toMatch(/重新预检/u);
    expect(getDataBackupErrorMessage('DATA_BACKUP_IMPORT_SESSION_EXPIRED')).toMatch(/已过期/u);
    expect(getDataBackupErrorMessage('DATA_BACKUP_IMPORT_TARGET_MISMATCH')).toMatch(/店铺身份/u);
    expect(getDataBackupErrorMessage('DATA_BACKUP_IMPORT_PREFLIGHT_STALE')).toMatch(/重新选择/u);
    expect(getDataBackupErrorMessage('DATA_BACKUP_PACKAGE_JSON_INVALID')).toMatch(/已损坏/u);
    expect(getDataBackupErrorMessage('DATA_BACKUP_DISK_FULL')).toMatch(/空间不足/u);
    expect(getDataBackupErrorMessage('RECOVERY_ENVELOPE_DECRYPT_FAILED')).toMatch(/口令不正确/u);
    expect(getDataBackupErrorMessage('HISTORICAL_ORDER_IMPORT_PRODUCT_SELECTION_REQUIRED')).toMatch(/选择具体商品/u);
    expect(getDataBackupErrorMessage('HISTORICAL_DIMENSION_SYNC_PREVIEW_REQUIRED')).toMatch(/先预览/u);
    expect(getDataBackupErrorMessage('HISTORICAL_DIMENSION_SYNC_CARD_FIELD_MISSING')).toMatch(/商品资料不完整/u);
    expect(getDataBackupErrorMessage('HISTORICAL_DIMENSION_SYNC_IMPORT_SELECTION_MISMATCH')).toMatch(/已停止回传/u);
    expect(getDataBackupErrorMessage('PRIVATE_INTERNAL_ERROR')).toBe('操作失败，请重试。');
  });

  it('preserves an intentional Chinese local validation message but never exposes an English code', () => {
    expect(presentDataBackupError(new Error('请先选择文件。'))).toBe('请先选择文件。');
    expect(presentDataBackupError(Object.assign(new Error('PRIVATE_INTERNAL_ERROR'), {
      code: 'PRIVATE_INTERNAL_ERROR',
    }))).toBe('操作失败，请重试。');
  });
});
