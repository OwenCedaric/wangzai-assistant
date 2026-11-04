import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canUseOzonShop } from '../entities/order/orderShopScope.jsx';
import { readSplitAppSource } from '../test/appSource';

const appSource = readSplitAppSource();
const mainSource = readFileSync(join(process.cwd(), 'src', 'main.jsx'), 'utf8');
const pluginSource = readFileSync(join(process.cwd(), 'localDataPlugin.js'), 'utf8');
const shopSettingsSource = readFileSync(join(process.cwd(), 'src', 'services', 'ozonShopSettingsStore.js'), 'utf8');
const productBaseStateSource = readFileSync(
  join(process.cwd(), 'src', 'features', 'products', 'model', 'useProductBaseState.jsx'),
  'utf8'
);

describe('ozon shop settings local-first rules', () => {
  it('registers Ozon shop settings file only as a legacy migration source', () => {
    expect(appSource).toContain("const LOCAL_OZON_SHOP_SETTINGS_FILE_KEY = 'ozon-shop-settings';");
    expect(pluginSource).toContain("'ozon-shop-settings'");
    expect(pluginSource).toContain("fileName: 'ozon-shop-settings.json'");
  });

  it('does not keep any Ozon shop preference as browser input', () => {
    expect(shopSettingsSource).not.toContain('OZON_ACTIVE_SHOP_STORAGE_KEY');
    expect(shopSettingsSource).not.toContain('readSavedActiveOzonShopIdFromBrowser');
    expect(shopSettingsSource).not.toContain('OZON_DEFAULT_WAREHOUSE_STORAGE_KEY');
    expect(shopSettingsSource).not.toContain('readSavedOzonDefaultWarehouseIdsFromBrowser');
    expect(shopSettingsSource).not.toContain('OZON_SHOP_STORAGE_KEY');
    expect(shopSettingsSource).not.toContain('readSavedOzonShopsFromBrowser');
  });

  it('persists Ozon accounts and preferences through local-api instead of browser or plaintext files', () => {
    const saveStart = appSource.indexOf('function stageOzonShopSettingsWrite(shops, activeShopId');
    const saveEnd = appSource.indexOf('async function hydrateOzonShopSettingsFromLocalFile()', saveStart);
    const saveSource = appSource.slice(saveStart, saveEnd);
    expect(appSource).toContain("const PROFILE_OZON_SHOP_PREFERENCES_NAMESPACE = 'ozon-shop-preferences';");
    expect(saveSource).toContain('persistOzonShopsToLocalApi(optimisticStore.shops, {');
    expect(saveSource).toContain('saveProfileSetting(PROFILE_OZON_SHOP_PREFERENCES_NAMESPACE, preferences');
    expect(saveSource).toContain('getProfileSetting(PROFILE_OZON_SHOP_PREFERENCES_NAMESPACE');
    expect(saveSource).not.toContain('writeLocalDataFile(LOCAL_OZON_SHOP_SETTINGS_FILE_KEY, nextStore)');
    expect(saveSource).not.toContain('window.localStorage.setItem(OZON_SHOP_STORAGE_KEY');
    expect(appSource).not.toContain('window.localStorage.setItem(OZON_SHOP_STORAGE_KEY');
    expect(mainSource).not.toContain('BROWSER_LOCAL_STORAGE_MIRROR_KEYS');
  });

  it('treats local-api encrypted Ozon shop credentials as readable without exposing apiKey', () => {
    expect(canUseOzonShop({
      id: 'ozon-shop-1',
      clientId: '',
      apiKey: '',
      hasClientId: true,
      hasApiKey: true,
      licenseAuthorizationStatus: 'active',
      licenseAuthorized: true,
    })).toBe(
      true
    );
    expect(canUseOzonShop({
      id: 'ozon-shop-1',
      clientId: '',
      apiKey: '',
      hasClientId: true,
      hasApiKey: false,
      licenseAuthorizationStatus: 'active',
      licenseAuthorized: true,
    })).toBe(
      false
    );
    expect(shopSettingsSource).toContain('getLocalShops({ timeoutMs: 10000 })');
    expect(shopSettingsSource).toContain('mergeLocalApiOzonShopSettings');
    expect(shopSettingsSource).toContain('saveLocalShop(payload, { timeoutMs: 30000 })');
    expect(shopSettingsSource).toContain('toOzonShopPreferences');
    expect(shopSettingsSource).toContain('if (clientId) payload.clientId = clientId;');
    expect(shopSettingsSource).toContain('if (apiKey) payload.apiKey = apiKey;');
    expect(shopSettingsSource).toContain('clientId: normalizeText(localShop.clientId || localShop.client_id)');
    expect(productBaseStateSource).toContain('const canReadOzon = canUseOzonShop(activeShop);');
  });

  it('blocks configured credentials while exact shop-card authorization is missing or still checking', () => {
    const configured = {
      id: 'ozon-shop-1',
      clientId: '4616153',
      hasApiKey: true,
    };
    expect(canUseOzonShop({
      ...configured,
      licenseAuthorizationStatus: 'checking',
      licenseAuthorized: false,
    })).toBe(false);
    expect(canUseOzonShop({
      ...configured,
      licenseAuthorizationStatus: 'missing',
      licenseAuthorized: false,
    })).toBe(false);
  });

  it('keeps default warehouse settings in profile preferences only', () => {
    const saveStart = appSource.indexOf('function saveOzonDefaultWarehouseIds(defaults)');
    const saveEnd = appSource.indexOf('let crossBorderSettingsMemory = null;', saveStart);
    const saveSource = appSource.slice(saveStart, saveEnd);

    expect(saveSource).toContain('saveOzonShopSettings(currentStore.shops, currentStore.activeShopId');
    expect(saveSource).not.toContain('window.localStorage.setItem(OZON_DEFAULT_WAREHOUSE_STORAGE_KEY');
    expect(shopSettingsSource).not.toContain('OZON_DEFAULT_WAREHOUSE_STORAGE_KEY');
  });

  it('persists and verifies the current credentials before starting a connection test', () => {
    const persistIndex = appSource.indexOf('await persistOzonShopSettings(shopsForTest, activeShop.id)');
    const testIndex = appSource.indexOf('await testLocalShopConnection(activeShop.id', persistIndex);
    expect(persistIndex).toBeGreaterThan(-1);
    expect(testIndex).toBeGreaterThan(persistIndex);
    expect(appSource.slice(persistIndex, testIndex)).toContain('savedBeforeTest = true');
    expect(appSource).toContain("error?.code === 'OZON_AUTHENTICATION_FAILED'");
    expect(appSource).toContain("? '鉴权失败'");
  });
});
