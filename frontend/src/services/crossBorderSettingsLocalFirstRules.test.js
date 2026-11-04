import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSplitAppSource } from '../test/appSource';

const appSource = readSplitAppSource();
const pluginSource = readFileSync(join(process.cwd(), 'localDataPlugin.js'), 'utf8');
const catalogSource = readFileSync(join(process.cwd(), 'src', 'services', 'localDataDomainCatalog.js'), 'utf8');
const stylesSource = readFileSync(join(process.cwd(), 'src', 'styles.css'), 'utf8');
const runtimeConfigSource = readFileSync(
  join(process.cwd(), 'src', 'shared', 'config', 'appConfigRuntime.jsx'),
  'utf8',
);
const crossBorderReadClientSource = readFileSync(
  join(process.cwd(), 'src', 'services', 'crossBorderReadClient.js'),
  'utf8',
);
const crossBorderWriteClientSource = readFileSync(
  join(process.cwd(), 'src', 'services', 'crossBorderWriteClient.js'),
  'utf8',
);

describe('cross-border settings local-first rules', () => {
  it('keeps enterprise API and tokens out of the current desktop settings and forbids local read/write fallback', () => {
    const crossBorderConfigStart = runtimeConfigSource.indexOf('crossBorderBus: {');
    const purchaseConfigStart = runtimeConfigSource.indexOf('purchaseAccount: {', crossBorderConfigStart);
    const crossBorderConfigSource = runtimeConfigSource.slice(crossBorderConfigStart, purchaseConfigStart);

    expect(crossBorderConfigSource).not.toContain("title: '企业接口'");
    expect(crossBorderConfigSource).not.toContain("id: 'companySecret'");
    expect(crossBorderConfigSource).not.toContain('保存API接口');
    expect(crossBorderConfigSource).toContain('企业 API 由管理端统一保管');
    expect(crossBorderReadClientSource).toContain('readCrossBorderWithServer({');
    expect(crossBorderReadClientSource).not.toContain('requestCrossBorderRead(');
    expect(crossBorderReadClientSource).not.toContain('runtime?.thinClient');
    expect(crossBorderWriteClientSource).toContain('previewCrossBorderWriteWithServer({');
    expect(crossBorderWriteClientSource).toContain('confirmCrossBorderWriteWithServer({');
    expect(crossBorderWriteClientSource).not.toContain('previewCrossBorderWrite(');
    expect(crossBorderWriteClientSource).not.toContain('confirmCrossBorderWrite(');
    expect(crossBorderWriteClientSource).not.toContain('runtime?.thinClient');
  });

  it('loads cached cross-border settings first and refreshes warehouse options in background when authorized', () => {
    expect(appSource).not.toContain('crossBorderServiceRefreshKey');

    const layoutStart = appSource.indexOf('function StructuredSettingsLayout');
    const authorizeStart = appSource.indexOf('const authorizeCrossBorderAccount = async', layoutStart);
    const entrySource = appSource.slice(layoutStart, authorizeStart);

    expect(entrySource).toContain('hydrateCrossBorderSettingsFromLocalApi(config.records[0]?.values ?? {})');
    expect(entrySource).toContain('const isCurrentCrossBorderHydration = () => (');
    expect(entrySource).toContain('if (!isCurrentCrossBorderHydration()) return;');
    expect(entrySource).toContain('if (hasServerCrossBorderAuthorization(selectedSettings))');
    expect(entrySource).toContain("setCrossBorderStatus('正在后台读取最新合作仓库...')");
    expect(entrySource).toContain('crossBorderWarehouseRefreshRef');
    expect(entrySource).toContain('.current?.(selectedSettings, {');
    expect(entrySource).toContain('isCurrent: isCurrentCrossBorderRequest,');
    expect(entrySource).not.toContain('fetchCrossBorderServices(crossBorderSettings)');
  });

  it('replaces a stale connection error after the live warehouse and service reads succeed', () => {
    const layoutStart = appSource.indexOf('function StructuredSettingsLayout');
    const servicesStart = appSource.indexOf('const fetchCrossBorderServices = async', layoutStart);
    const warehousesStart = appSource.indexOf('const fetchCrossBorderWarehouses = async', servicesStart);
    const saveAccountStart = appSource.indexOf('const authorizeCrossBorderAccount = async', warehousesStart);
    const servicesSource = appSource.slice(servicesStart, warehousesStart);
    const warehousesSource = appSource.slice(warehousesStart, saveAccountStart);

    expect(warehousesSource).toContain('setCrossBorderStatus(warehouseMessage);');
    expect(warehousesSource).toContain('connectionMessage: warehouseMessage');
    expect(servicesSource).toContain('setCrossBorderStatus(successMessage);');
    expect(servicesSource).toContain("connectionStatus: '真实接口已连接'");
    expect(servicesSource).toContain('connectionMessage: successMessage');
  });

  it('refreshes the full cross-border warehouse list after management authorization succeeds', () => {
    const authorizeStart = appSource.indexOf('const authorizeCrossBorderAccount = async');
    const authorizeEnd = appSource.indexOf('const saveCrossBorderForecastSettings', authorizeStart);
    const authorizeSource = appSource.slice(authorizeStart, authorizeEnd);

    expect(authorizeSource).toContain('authorizeCrossBorderAccountThroughServer({');
    expect(authorizeSource).toContain('authorizationRef: payload.authorization_ref');
    expect(authorizeSource).toContain('return fetchCrossBorderWarehouses(authorizedSettings, options);');
    expect(appSource).not.toContain("} else if (action === '保存API接口') {");
  });

  it('keeps cross-border settings SQLite-only after the browser/file reader retires', () => {
    const saveStart = appSource.indexOf('function saveCrossBorderSettings(settings)');
    const saveEnd = appSource.indexOf('async function hydrateCrossBorderSettingsFromLocalApi', saveStart);
    const saveSource = appSource.slice(saveStart, saveEnd);

    expect(appSource).toContain("const PROFILE_CROSS_BORDER_PREFERENCES_NAMESPACE = 'cross-border-preferences';");
    expect(appSource).not.toContain('readSavedCrossBorderSettingsFromBrowser');
    expect(appSource).not.toContain('CROSS_BORDER_STORAGE_KEY');
    expect(appSource).not.toContain('LOCAL_CROSS_BORDER_SETTINGS_FILE_KEY');
    expect(appSource).not.toContain('scrubLegacyCrossBorderSettingsSources');
    expect(pluginSource).not.toContain("'cross-border-bus-settings'");
    expect(pluginSource).not.toContain("fileName: 'cross-border-bus-settings.json'");
    expect(catalogSource).not.toContain("'商品资料/cross-border-bus-settings.json'");
    expect(saveSource).toContain('crossBorderSettingsMemory = nextSettings');
    expect(saveSource).toContain('toCrossBorderSafeLocalSettings(optimisticSettings)');
    expect(saveSource).toContain('saveProfileSetting(PROFILE_CROSS_BORDER_PREFERENCES_NAMESPACE');
    expect(saveSource).toContain('getProfileSetting(PROFILE_CROSS_BORDER_PREFERENCES_NAMESPACE');
    expect(saveSource).not.toContain('writeLocalDataFile');
    expect(saveSource).not.toContain('window.localStorage');
  });

  it('loads public cross-border account flags from local-api without reading secrets into App state', () => {
    const importStart = appSource.indexOf("from './services/crossBorderAccountClient'");
    const importSource = appSource.slice(Math.max(0, importStart - 240), importStart + 80);
    const accountReaderStart = appSource.indexOf('async function readCrossBorderSettingsByAccountId');
    const hydrateStart = appSource.indexOf('async function readCrossBorderSettingsFromLocalApi');
    const hydrateEnd = appSource.indexOf('async function hydrateCrossBorderSettingsFromLocalApi', hydrateStart);
    const hydrateSource = appSource.slice(accountReaderStart, hydrateEnd);

    expect(importSource).toContain('readCrossBorderAccounts');
    expect(importSource).toContain('selectCrossBorderAccount');
    expect(importSource).toContain('toCrossBorderPublicSettings');
    expect(accountReaderStart).toBeGreaterThanOrEqual(0);
    expect(hydrateSource).toContain('readCrossBorderAccounts({ timeoutMs: 2500 })');
    expect(hydrateSource).toContain('!crossBorderReadExcludes(task, account?.id)');
    expect(hydrateSource).toContain('selectCrossBorderAccount(rows, preferredId)');
    expect(hydrateSource).toContain('assertCrossBorderReadCurrent(task, preferredId)');
    expect(hydrateSource).toContain('toCrossBorderPublicSettings(account)');
    expect(hydrateSource).not.toContain('accessToken');
    expect(hydrateSource).not.toContain('companySecret');
    expect(hydrateSource).not.toContain('appUid');
  });

  it('removes the local token helper and routes setting reads through the management authorization', () => {
    const readStart = appSource.indexOf('const requestCrossBorderSettingsRead = async');
    const readEnd = appSource.indexOf('const fetchCrossBorderServices = async', readStart);
    const readSource = appSource.slice(readStart, readEnd);

    expect(appSource).not.toContain('const fetchCrossBorderToken = async');
    expect(readSource).toContain('readCrossBorderAccountThroughServer(settings, endpointKey, body)');
    expect(readSource).not.toContain('requestCrossBorderReadOnly');
    expect(readSource).not.toContain('/erpapi/token/index');
    expect(readSource).not.toContain('/erpapi/token/refresh');
  });

  it('authorizes with the management core instead of local enterprise credentials', () => {
    const authorizeStart = appSource.indexOf('const authorizeCrossBorderAccount = async');
    const authorizeEnd = appSource.indexOf('const saveCrossBorderForecastSettings', authorizeStart);
    const authorizeSource = appSource.slice(authorizeStart, authorizeEnd);

    expect(authorizeSource).toContain('authorizeCrossBorderAccountThroughServer({');
    expect(authorizeSource).toContain('userName: \'\'');
    expect(authorizeSource).toContain('password: \'\'');
    expect(authorizeSource).toContain('hasCompanySecret: false');
    expect(authorizeSource).toContain('hasAccessToken: false');
    expect(authorizeSource).not.toContain('authorizeCrossBorderAccountConnection');
    expect(authorizeSource).not.toContain('savedAccount?.hasCompanySecret');
  });

  it('sends username/password only to management and saves no login or enterprise credential locally', () => {
    const saveAccountStart = appSource.indexOf('const authorizeCrossBorderAccount = async');
    const saveApiStart = appSource.indexOf('const saveCrossBorderForecastSettings', saveAccountStart);
    const localApiAccountStart = appSource.indexOf('export async function saveCrossBorderAccountToLocalApi(settings = {}, options = {})');
    const localApiAccountEnd = appSource.indexOf('export function', localApiAccountStart + 1);
    const saveAccountSource = appSource.slice(saveAccountStart, saveApiStart);
    const localApiAccountSource = appSource.slice(localApiAccountStart, localApiAccountEnd);

    expect(saveAccountSource).toContain('authorizeCrossBorderAccountThroughServer({');
    expect(saveAccountSource).toContain('userName: \'\'');
    expect(saveAccountSource).toContain('password: \'\'');
    expect(saveAccountSource).toContain('toCrossBorderPublicSettings(payload.account)');
    expect(saveAccountSource).toContain('persistCrossBorderSettings({');
    expect(localApiAccountSource).toContain('saveCrossBorderServerAccountSettings(payload)');
    expect(localApiAccountSource).not.toContain('payload.userName');
    expect(localApiAccountSource).not.toContain('payload.password');
    expect(localApiAccountSource).not.toContain('payload.companySecret');
    expect(localApiAccountSource).not.toContain('payload.accessToken');
    expect(localApiAccountSource).not.toContain('payload.appUid');
    expect(localApiAccountSource).toContain('if (options.accountRemovalRebind === true) payload.accountRemovalRebind = true;');
  });

  it('requires an explicit successful local-api rebind before releasing the deleted account write fence', () => {
    const helperStart = appSource.indexOf('const saveCrossBorderAccountWithExplicitRebind = async (settings)');
    const helperEnd = appSource.indexOf('const setCrossBorderMessage =', helperStart);
    const helperSource = appSource.slice(helperStart, helperEnd);

    expect(helperStart).toBeGreaterThanOrEqual(0);
    expect(helperSource).toContain('{ accountRemovalRebind: Boolean(ownerId) }');
    expect(helperSource.indexOf('await saveCrossBorderAccountToLocalApi('))
      .toBeLessThan(helperSource.indexOf('releaseCrossBorderSettingsWriteFence(ownerId)'));
  });

  it('opens permanent removal only for a cross-border account confirmed by local-api', () => {
    const deleteStart = appSource.indexOf('const handleCrossBorderDeleteAccount = async () =>');
    const deleteEnd = appSource.indexOf('const handleCrossBorderSectionAction = async', deleteStart);
    const deleteSource = appSource.slice(deleteStart, deleteEnd);

    expect(deleteStart).toBeGreaterThanOrEqual(0);
    expect(deleteSource).toContain('await readCrossBorderAccounts({ timeoutMs: 10000 })');
    expect(deleteSource).toContain("String(account?.id || '').trim() === String(accountId || '').trim()");
    expect(deleteSource).toContain('if (!persistedAccount && crossBorderSettings.accountSaved !== true)');
    expect(deleteSource).toContain('账号核对失败，未执行删除');
    expect(deleteSource).toContain('applyDeletedSettings(false);');
    expect(deleteSource).toContain("accountRemoval.openAccountRemoval({ ownerType: 'cross_border_bus', ownerId: accountId }");
    expect(deleteSource).toContain('onCompleted: () => applyDeletedSettings(true)');
    expect(deleteSource).toContain('onMissing: () => applyDeletedSettings(true)');
  });

  it('drops stale cross-border settings option reads before updating state or loading status', () => {
    const layoutStart = appSource.indexOf('function StructuredSettingsLayout');
    const servicesStart = appSource.indexOf('const fetchCrossBorderServices = async', layoutStart);
    const warehousesStart = appSource.indexOf('const fetchCrossBorderWarehouses = async', servicesStart);
    const saveAccountStart = appSource.indexOf('const authorizeCrossBorderAccount = async', warehousesStart);
    const actionStart = appSource.indexOf('const handleCrossBorderSectionAction = async', saveAccountStart);
    const updateStart = appSource.indexOf('const updateCrossBorderField = (fieldId, value) =>', actionStart);
    const servicesSource = appSource.slice(servicesStart, warehousesStart);
    const warehousesSource = appSource.slice(warehousesStart, saveAccountStart);
    const actionSource = appSource.slice(actionStart, updateStart);
    const updateSource = appSource.slice(updateStart, appSource.indexOf('const renderCrossBorderField', updateStart));

    expect(appSource).toContain('const crossBorderRequestRef = React.useRef(0);');
    expect(servicesSource).toContain('const isCurrent = options.isCurrent || (() => true);');
    expect(servicesSource).toContain('if (!isCurrent()) return settings;');
    expect(warehousesSource).toContain('const isCurrent = options.isCurrent || (() => true);');
    expect(warehousesSource).toContain('if (!isCurrent()) return settings;');
    expect(actionSource).toContain('const requestId = crossBorderRequestRef.current + 1;');
    expect(actionSource).toContain('crossBorderRequestRef.current = requestId;');
    expect(actionSource).toContain('const isCurrentCrossBorderRequest = () =>');
    expect(actionSource).toContain('crossBorderRequestRef.current === requestId && isCrossBorder;');
    expect(actionSource).toContain('if (!isCurrentCrossBorderRequest()) return;');
    expect(actionSource).toContain('authorizeCrossBorderAccount(crossBorderSettings, {');
    expect(actionSource).toContain('isCurrent: isCurrentCrossBorderRequest,');
    expect(actionSource).toContain('if (isCurrentCrossBorderRequest()) {');

    expect(updateSource).toContain('crossBorderRequestRef.current += 1;');
  });

  it('keeps cross-border action buttons in one aligned column and isolates the clicked loading state', () => {
    expect(appSource).toContain("isCrossBorder ? ' cross-border-settings-layout' : ''");
    expect(appSource).toContain('disabled={isCurrentCrossBorderAuthorization}');
    expect(appSource).toContain('disabled={isCurrentCrossBorderAction}');
    expect(appSource).not.toContain('disabled={isCrossBorder && crossBorderLoading}');
    expect(stylesSource).toContain('.cross-border-settings-layout .structured-form-row');
    expect(stylesSource).toContain('grid-template-columns: minmax(0, 1fr) 160px;');
    expect(stylesSource).toContain('.cross-border-settings-layout .structured-form-actions .MuiButton-root');
    expect(stylesSource).toContain('width: 160px;');
    expect(stylesSource).toContain('height: 40px;');
  });
});
