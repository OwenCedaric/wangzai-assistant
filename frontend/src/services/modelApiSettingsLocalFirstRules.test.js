import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const appEntrySource = readFileSync(join(process.cwd(), 'src', 'App.jsx'), 'utf8');
const pluginSource = readFileSync(join(process.cwd(), 'localDataPlugin.js'), 'utf8');
const catalogSource = readFileSync(join(process.cwd(), 'src', 'services', 'localDataDomainCatalog.js'), 'utf8');
const settingsSource = readFileSync(
  join(process.cwd(), 'src', 'features', 'settings', 'lib', 'modelApiSettings.jsx'),
  'utf8'
);
const panelSource = readFileSync(
  join(process.cwd(), 'src', 'features', 'settings', 'ModelApiSettingsPanel.jsx'),
  'utf8'
);
const clientSource = readFileSync(join(process.cwd(), 'src', 'api', 'localApiClient.js'), 'utf8');
const desktopRoot = join(process.cwd(), '..', 'desktop');
const localApiRoot = join(process.cwd(), '..', 'local-api');
const protocolSource = readFileSync(join(desktopRoot, 'src', 'protocol', 'appProtocol.js'), 'utf8');
const proxySource = readFileSync(join(desktopRoot, 'src', 'runtime', 'localApiProxy.js'), 'utf8');
const localApiSource = readFileSync(join(localApiRoot, 'src', 'app', 'createApp.js'), 'utf8');
const repositorySource = readFileSync(
  join(localApiRoot, 'src', 'db', 'repositories', 'modelApiAccountRepository.js'),
  'utf8'
);
const legacyMigrationPath = join(process.cwd(), 'src', 'services', 'legacyModelApiMigration.js');

describe('model API settings SQLite-only rules', () => {
  it('removes browser/file readers, migration code, and the obsolete local-data route', () => {
    expect(settingsSource).not.toContain('wangzai-image2-model-api-settings');
    expect(settingsSource).not.toContain('readLegacyJsonValue');
    expect(settingsSource).not.toContain('readLocalDataFile');
    expect(settingsSource).not.toContain('loadLegacyModelApiStateSources');
    expect(settingsSource).not.toContain('loadModelApiStateFromFile');
    expect(settingsSource).not.toContain('LOCAL_MODEL_API_SETTINGS_FILE_KEY');
    expect(pluginSource).not.toContain("'model-api-settings'");
    expect(protocolSource).not.toContain("'model-api-settings'");
    expect(catalogSource).not.toContain('settings/model-api-settings.json');
    expect(existsSync(legacyMigrationPath)).toBe(false);
  });

  it('keeps renderer interaction on the encrypted canonical account path only', () => {
    expect(panelSource).toContain('listModelApiAccounts');
    expect(panelSource).toContain('saveModelApiAccount');
    expect(panelSource).toContain('useAccountRemovalFlow');
    expect(panelSource).toContain('AccountRemovalPreviewDialog');
    expect(panelSource).toContain("ownerType: 'model_api_account'");
    expect(panelSource).not.toContain('deleteModelApiAccount');
    expect(panelSource).toContain('toModelApiStateFromAccounts(accounts)');
    expect(panelSource).not.toContain('migrateLegacyModelApiSettings');
    expect(panelSource).not.toContain('localStorage');
    expect(panelSource).toContain('toCredentialMaskValue');
    expect(appEntrySource).not.toContain('migrateLegacyModelApiSettings');
  });

  it('removes the model-account-only bulk import and cursor migration surface', () => {
    expect(clientSource).not.toContain('importLegacyModelApiAccounts');
    expect(clientSource).not.toContain('/api/model-api/accounts/legacy-import');
    expect(clientSource).not.toContain('listModelApiAccountsPage');
    expect(proxySource).not.toContain('/api/model-api/accounts/legacy-import');
    expect(localApiSource).not.toContain('/api/model-api/accounts/legacy-import');
    expect(localApiSource).not.toContain('modelApiAccountRepository.listAccountsPage');
    expect(repositorySource).not.toContain('importLegacyAccounts');
    expect(repositorySource).not.toContain('listAccountsPage');
  });
});
