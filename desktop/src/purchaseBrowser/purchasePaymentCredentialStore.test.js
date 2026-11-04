import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createPurchasePaymentCredentialStore } from './purchasePaymentCredentialStore.js';

function createProtector() {
  return {
  	protect(value) { return Buffer.from(`cipher:${value}`, 'utf8'); },
		unprotect(value) { return Buffer.from(value).toString('utf8').replace(/^cipher:/u, ''); },
  };
}

test('payment credential store persists encrypted records without exposing password in status', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wangzai-payment-credential-'));
  const filePath = path.join(directory, 'payment-credentials.enc.json');
  const first = createPurchasePaymentCredentialStore({ filePath, protector: createProtector() });
  first.save({
    accountRef: 'pdd:account-1',
    platform: 'pinduoduo',
    loginAccount: 'buyer@example.test',
    loginPassword: '',
    paymentPassword: '123456',
  });
  const status = first.status('pdd:account-1');
  assert.equal(status.configured, true);
  assert.equal('paymentPassword' in status, false);
  assert.doesNotMatch(fs.readFileSync(filePath, 'utf8'), /123456/u);

  const second = createPurchasePaymentCredentialStore({ filePath, protector: createProtector() });
  assert.deepEqual(second.get('pdd:account-1'), {
    accountRef: 'pdd:account-1',
    platform: 'pinduoduo',
    loginAccount: 'buyer@example.test',
    loginPassword: '',
    paymentPassword: '123456',
    updatedAt: second.get('pdd:account-1').updatedAt,
  });
  second.clear('pdd:account-1');
  assert.equal(second.status('pdd:account-1').configured, false);
  for (const candidate of [filePath, `${filePath}.bak`]) {
    const envelope = JSON.parse(fs.readFileSync(candidate, 'utf8'));
    const plaintext = createProtector().unprotect(Buffer.from(envelope.ciphertext, 'base64'));
    assert.doesNotMatch(plaintext, /123456|buyer@example\.test/u);
  }
  fs.rmSync(directory, { recursive: true, force: true });
});

test('shared Alipay login credential is encrypted, status-safe, and independent from payment passwords', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wangzai-alipay-login-'));
  const filePath = path.join(directory, 'credentials.enc.json');
  const first = createPurchasePaymentCredentialStore({ filePath, protector: createProtector() });
  const saved = first.saveAlipayLogin({ loginAccount: '13800000000', loginPassword: 'login-secret' });
  assert.equal(saved.loginAccount, '13800000000');
  const status = first.alipayLoginStatus();
  assert.equal(status.configured, true);
  assert.equal('loginPassword' in status, false);
  assert.doesNotMatch(fs.readFileSync(filePath, 'utf8'), /login-secret|13800000000/u);

  const second = createPurchasePaymentCredentialStore({ filePath, protector: createProtector() });
  assert.equal(second.getAlipayLogin().loginPassword, 'login-secret');
  assert.equal(second.getAlipayLogin().paymentPassword, '');
  second.clearAlipayLogin();
  assert.equal(second.alipayLoginStatus().configured, false);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('payment credential store rejects empty credentials', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wangzai-payment-credential-'));
  const store = createPurchasePaymentCredentialStore({
    filePath: path.join(directory, 'credentials.enc.json'),
    protector: createProtector(),
  });
  assert.throws(() => store.save({ accountRef: 'pdd:account-1', paymentPassword: '' }), {
    code: 'PURCHASE_PAYMENT_PASSWORD_REQUIRED',
  });
  fs.rmSync(directory, { recursive: true, force: true });
});
