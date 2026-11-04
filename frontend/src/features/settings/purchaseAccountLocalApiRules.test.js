import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const settingsSource = readFileSync(
  join(process.cwd(), 'src', 'features', 'settings', 'StructuredSettingsLayout.jsx'),
  'utf8'
);
const settingsRecordsSource = readFileSync(
  join(process.cwd(), 'src', 'features', 'settings', 'lib', 'structuredSettingsRecords.js'),
  'utf8'
);
const localApiClientSource = readFileSync(join(process.cwd(), 'src', 'api', 'localApiClient.js'), 'utf8');
const appSource = readFileSync(join(process.cwd(), 'src', 'App.jsx'), 'utf8');
const localApiServerSource = readFileSync(join(process.cwd(), '..', 'local-api', 'src', 'app', 'createApp.js'), 'utf8');
const repositorySource = readFileSync(
  join(process.cwd(), '..', 'local-api', 'src', 'db', 'repositories', 'purchaseAccountRepository.js'),
  'utf8'
);
const purchaseMigrationPath = join(process.cwd(), 'src', 'services', 'legacyPurchaseAccountMigration.js');

describe('purchase account SQLite-only rules', () => {
  it('uses local-api as the only new persistence path for purchase-account records', () => {
    expect(settingsSource).not.toContain('function saveStructuredRecords()');
    expect(settingsSource).not.toContain('saveStructuredRecords(config');
    expect(settingsSource).not.toContain('localStorage');
    expect(settingsSource).toContain('listPurchaseAccounts({ timeoutMs: 10000 })');
    expect(settingsSource).toContain('await savePurchaseAccount(');
    expect(settingsSource).toContain("accountRemoval.openAccountRemoval({ ownerType: 'purchase_account'");
    expect(settingsSource).not.toContain('await deletePurchaseAccount(selectedRecord.id');
  });

  it('has no browser migration or browser-preservation fallback after the key is retired', () => {
    const purchaseEffectStart = settingsSource.indexOf("if (config.id === 'purchaseAccount')");
    const purchaseEffectEnd = settingsSource.indexOf('return () =>', purchaseEffectStart);
    const purchaseEffectSource = settingsSource.slice(purchaseEffectStart, purchaseEffectEnd);

    expect(settingsSource).not.toContain('migrateLegacyPurchaseAccountRecords');
    expect(appSource).not.toContain('migrateLegacyPurchaseAccountRecords');
    expect(purchaseEffectSource).not.toContain('已保留浏览器数据');
    expect(existsSync(purchaseMigrationPath)).toBe(false);
  });

  it('never rebuilds a browser-facing record with a stored password plaintext', () => {
    const recordStart = settingsRecordsSource.indexOf('function toPurchaseStructuredRecord(');
    const recordEnd = settingsRecordsSource.indexOf('function buildPurchaseStructuredRecords(', recordStart);
    const recordSource = settingsRecordsSource.slice(recordStart, recordEnd);
    const payloadStart = settingsRecordsSource.indexOf('function toPurchaseAccountSavePayload(');
    const payloadEnd = settingsRecordsSource.indexOf('function toPurchaseStructuredRecord(', payloadStart);
    const payloadSource = settingsRecordsSource.slice(payloadStart, payloadEnd);

    expect(recordSource).toContain("loginPassword: ''");
    expect(recordSource).toContain('hasLoginPassword');
    expect(payloadSource).toContain('if (loginPassword) payload.loginPassword = loginPassword;');
  });

  it('keeps only normal canonical transport methods and removes migration-only API branches', () => {
    const purchaseListStart = localApiClientSource.indexOf('export function listPurchaseAccounts(');
    const purchaseListEnd = localApiClientSource.indexOf('export function savePurchaseAccount(', purchaseListStart);
    const purchaseListSource = localApiClientSource.slice(purchaseListStart, purchaseListEnd);

    expect(localApiClientSource).toContain("requestLocalApi('/api/purchase/accounts', {");
    expect(localApiClientSource).toContain('function deletePurchaseAccount(accountId');
    expect(localApiClientSource).toContain('encodeURIComponent(accountId)');
    expect(localApiClientSource).not.toContain('importLegacyPurchaseAccounts');
    expect(purchaseListSource).not.toContain("cursorMode === 'legacy-migration'");
    expect(localApiServerSource).not.toContain('/api/purchase/accounts/legacy-import');
    expect(localApiServerSource).not.toContain('purchaseAccountRepository.listAccountsPage');
    expect(repositorySource).not.toContain('function importLegacyAccounts(');
    expect(repositorySource).not.toContain('function listAccountsPage(');
  });
});
