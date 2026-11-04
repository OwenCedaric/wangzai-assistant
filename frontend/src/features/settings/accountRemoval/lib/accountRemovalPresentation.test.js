import { describe, expect, it } from 'vitest';
import {
  canUseAccountRemovalRecentBackup,
  getAccountRemovalErrorMessage,
  getAccountRemovalPhaseLabel,
  getAccountRemovalResourceLabel,
  getAccountRemovalStorageKindLabel,
  isAccountRemovalBackupAuthorizationCurrent,
} from './accountRemovalPresentation.js';

describe('accountRemovalPresentation', () => {
  it('turns runtime bridge and physical-erasure codes into explicit terminal messages', () => {
    expect(getAccountRemovalErrorMessage(new Error('ACCOUNT_REMOVAL_REMOTE_RECOVERY_PURGE_FAILED')))
      .toContain('流程已停止');
    expect(getAccountRemovalErrorMessage(new Error('ACCOUNT_REMOVAL_PROTECTION_PURGE_FAILED')))
      .toContain('诊断日志');
    expect(getAccountRemovalErrorMessage({ code: 'ACCOUNT_REMOVAL_PHYSICAL_ERASURE_INCOMPLETE' }))
      .toContain('尚未完成');
    expect(getAccountRemovalErrorMessage({ code: 'ACCOUNT_REMOVAL_DATABASE_BUSY' }))
      .toContain('当前阶段尚未完成');
    expect(getAccountRemovalErrorMessage({ code: 'ACCOUNT_REMOVAL_SQLITE_EXECUTION_FAILED' }))
      .toContain('部分此前阶段可能已经完成');
  });

  it('keeps a legacy preview without backupReview renderable', () => {
    expect(canUseAccountRemovalRecentBackup(null)).toBe(false);
    expect(isAccountRemovalBackupAuthorizationCurrent(null, { previewFingerprint: 'legacy' }, null)).toBe(true);
  });

  it('turns resource ids, storage kinds, and operation phases into plain Chinese', () => {
    expect(getAccountRemovalResourceLabel({ id: 'registry:purchase-accounts', storageKind: 'sqlite' }))
      .toBe('采购账号');
    expect(getAccountRemovalResourceLabel({ id: 'browser:purchase-cookies', storageKind: 'browser-storage' }))
      .toBe('拍单网站登录状态');
    expect(getAccountRemovalResourceLabel({
      id: 'logical:purchase-browser-receipts-shop-links',
      storageKind: 'logical',
    })).toBe('采购执行回执与店铺关系');
    expect(getAccountRemovalResourceLabel({ id: 'runtime:unregistered-job', storageKind: 'runtime' }))
      .toBe('系统后台任务');
    expect(getAccountRemovalStorageKindLabel('secret-vault')).toBe('本机加密凭证库');
    expect(getAccountRemovalStorageKindLabel('browser-download')).toBe('网站下载记录');
    expect(getAccountRemovalPhaseLabel('external-delete-pending')).toBe('正在清理账号外部数据');
  });

  it('does not expose unknown English errors in the delete window', () => {
    expect(getAccountRemovalErrorMessage(new Error('database is busy')))
      .toBe('账号删除尚未确认完成，请查看原任务状态后继续。');
  });
  it('keeps remote authorization and endpoint failures actionable without claiming deletion rolled back', () => {
    expect(getAccountRemovalErrorMessage({ code: 'RECOVERY_REMOTE_LOGIN_REQUIRED' })).toContain('重新登录');
    expect(getAccountRemovalErrorMessage({ code: 'RECOVERY_REMOTE_ACCESS_DENIED' })).toContain('检查权限');
    expect(getAccountRemovalErrorMessage({ code: 'RECOVERY_REMOTE_ENDPOINT_UNAVAILABLE' })).toContain('接口暂不可用');
    for (const code of ['ACCOUNT_REMOVAL_DATABASE_BUSY', 'ACCOUNT_REMOVAL_SQLITE_EXECUTION_FAILED', 'RECOVERY_REMOTE_UNAVAILABLE']) {
      expect(getAccountRemovalErrorMessage({ code })).not.toMatch(/保持原状|全部修改.*回滚/u);
    }
  });

  it('explains that a missing desktop authorization policy has not started deletion', () => {
    expect(getAccountRemovalErrorMessage({ code: 'LOCAL_API_AUTH_POLICY_MISSING' }))
      .toBe('本地删除接口授权策略不完整，本次删除尚未开始。可以关闭窗口，更新后重新尝试。');
  });
});
