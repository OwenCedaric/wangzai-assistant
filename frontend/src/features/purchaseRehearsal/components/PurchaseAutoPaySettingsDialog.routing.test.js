import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolvePlatformPaymentAccount } from './PurchaseAutoPaySettingsDialog.jsx';

describe('purchase auto-pay payment-window routing', () => {
  it('resolves an independent real default account for Taobao and 1688 instead of reusing another platform credential', () => {
    const accounts = [
      { id: 'pdd-1', platformName: '拼多多', name: '拼多多一号' },
      { id: 'tb-1', platformName: '淘宝', name: '淘宝一号' },
      { id: 'tmall-1', platformName: '天猫', name: '天猫一号' },
      { id: '1688-1', platformName: '1688', name: '1688一号' },
    ];
    expect(resolvePlatformPaymentAccount(accounts, '淘宝', [], 'pdd-1')?.id).toBe('tb-1');
    expect(resolvePlatformPaymentAccount(accounts, '1688', [], 'pdd-1')?.id).toBe('1688-1');
    expect(resolvePlatformPaymentAccount(accounts, '淘宝', ['tmall-1'], 'tb-1')?.id).toBe('tmall-1');
    expect(resolvePlatformPaymentAccount(accounts, '1688', ['pdd-1'], 'pdd-1')?.id).toBe('1688-1');
  });

  it('routes every marketplace wait-pay and login action through the dedicated Electron payment window', () => {
    const source = fs.readFileSync(path.join(
      process.cwd(),
      'src/features/purchaseRehearsal/components/PurchaseAutoPaySettingsDialog.jsx',
    ), 'utf8');
    const start = source.indexOf('const openSelectedWaitPay = async () =>');
    const end = source.indexOf('\n\n  return (', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = source.slice(start, end);
    expect(block).toContain("command: 'open-purchase-payment-login'");
    expect(block).toContain('${credential.platform}支付专用 Electron 待付款窗口已打开。');
    expect(block).not.toContain("command: 'open-external'");
    const platformStart = source.indexOf('const openPlatformWaitPay = async (platform) =>');
    const platformEnd = source.indexOf('\n\n  return (', platformStart);
    const platformBlock = source.slice(platformStart, platformEnd);
    expect(platformBlock).toContain("command: 'open-purchase-payment-login'");
    expect(platformBlock).not.toContain("command: 'open-external'");
  });

  it('uses exact per-account credential drafts and real login status instead of treating a saved password as logged in', () => {
    const source = fs.readFileSync(path.join(
      process.cwd(),
      'src/features/purchaseRehearsal/components/PurchaseAutoPaySettingsDialog.jsx',
    ), 'utf8');
    expect(source).toContain('credentialStatusByAccount');
    expect(source).toContain('loginStatusByAccount');
    expect(source).toContain('getPurchasePaymentLoginStatus');
    expect(source).toContain("status?.loggedIn ? '已登录'");
    expect(source).toContain('onClick={() => onRefresh(platform)}');
    expect(source).toContain('waitForPurchasePaymentLogin({ accountRef: account.id, platform })');
    expect(source).toContain("status?.checking ? '登录中'");
    expect(source).toContain('label="统一支付宝账号"');
    expect(source).toContain('label="支付密码（验证码可空）"');
    expect(source).toContain("purchaseAccountId: pddAccount.id");
    expect(source).toContain('waitForSharedAlipayLogin()');
    expect(source).not.toContain("status?.configured ? '已登录' : '未登录'");
  });

  it('renders one Taotian switch, removes the 1688 payment-mode dropdown, and aligns all rows on one grid', () => {
    const source = fs.readFileSync(path.join(
      process.cwd(),
      'src/features/purchaseRehearsal/components/PurchaseAutoPaySettingsDialog.jsx',
    ), 'utf8');
    expect(source).toContain('label="淘天"');
    expect(source).toContain('const updateTaotian = (event) =>');
    expect(source).not.toContain('secondaryChecked=');
    expect(source).not.toContain('1688 免密代扣');
    expect(source).not.toContain('<MenuItem value="password">1688 支付密码</MenuItem>');
    expect(source).not.toContain('paymentMode={settings.paymentMode1688}');
    expect(source).toContain("minmax(250px, 1.35fr) minmax(215px, 1.15fr) minmax(145px, 0.8fr)");
  });
});
