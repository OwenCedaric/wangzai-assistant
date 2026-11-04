import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const paidPromotionSource = [
  join(process.cwd(), 'src', 'features', 'paidPromotion', 'PaidPromotionPage.jsx'),
  join(process.cwd(), 'src', 'features', 'paidPromotion', 'lib', 'paidPromotionFormatters.js'),
  join(process.cwd(), 'src', 'features', 'paidPromotion', 'components', 'PaidPromotionTables.jsx'),
]
  .map((filePath) => readFileSync(filePath, 'utf8'))
  .join('\n');
const structuredSettingsSource = [
  join(process.cwd(), 'src', 'features', 'settings', 'StructuredSettingsLayout.jsx'),
  join(process.cwd(), 'src', 'features', 'settings', 'lib', 'platformIntegrationRecords.js'),
  join(process.cwd(), 'src', 'features', 'settings', 'lib', 'integrationProfileRecords.js'),
]
  .map((filePath) => readFileSync(filePath, 'utf8'))
  .join('\n');
const appSource = readFileSync(join(process.cwd(), 'src', 'App.jsx'), 'utf8');
const localApiClientSource = readFileSync(join(process.cwd(), 'src', 'api', 'localApiClient.js'), 'utf8');
const localApiServerSource = readFileSync(join(process.cwd(), '..', 'local-api', 'src', 'app', 'createApp.js'), 'utf8');
const integrationRepositorySource = readFileSync(
  join(process.cwd(), '..', 'local-api', 'src', 'db', 'repositories', 'integrationProfileRepository.js'),
  'utf8'
);
const performanceRepositorySource = readFileSync(
  join(process.cwd(), '..', 'local-api', 'src', 'db', 'repositories', 'performanceAccountRepository.js'),
  'utf8'
);
const performanceClientSource = readFileSync(
  join(process.cwd(), '..', 'local-api', 'src', 'integrations', 'performanceApiClient.js'),
  'utf8'
);
const legacyMigrationPath = join(process.cwd(), 'src', 'services', 'legacyPlatformApiMigration.js');

describe('paid promotion Performance API SQLite-only rules', () => {
  it('loads encrypted Performance accounts from local-api before showing API configured state', () => {
    expect(paidPromotionSource).toContain('listPerformanceAccounts({ timeoutMs: 10000 })');
    expect(paidPromotionSource).toContain(
      'toPerformanceAccounts(accountPayload?.accounts || accountPayload?.rows || [])'
    );
    expect(paidPromotionSource).toContain("推广接口：{selectedAccount?.configured ? '已配置' : '未配置'}");
  });

  it('has no browser migration fallback in the promotion page or application startup', () => {
    expect(paidPromotionSource).not.toContain('migrateLegacyPlatformApiRecords');
    expect(paidPromotionSource).not.toContain('localStorage');
    expect(appSource).not.toContain('migrateLegacyPlatformApiRecords');
    expect(existsSync(legacyMigrationPath)).toBe(false);
  });

  it('uses accountId for all Performance reads instead of sending client_secret from the promotion page', () => {
    const overviewStart = paidPromotionSource.indexOf('const payload = await readPerformanceOverview(');
    const overviewEnd = paidPromotionSource.indexOf('setOverview(payload);', overviewStart);
    const overviewSource = paidPromotionSource.slice(overviewStart, overviewEnd);

    expect(overviewSource).toContain('accountId: accountToUse.id');
    expect(overviewSource).not.toContain('clientSecret');
    expect(overviewSource).not.toContain('client_secret');
  });

  it('deduplicates same realtime overview reads so refresh does not create duplicate Performance requests', () => {
    expect(paidPromotionSource).toContain('const overviewReadsRef = React.useRef(new Map())');
    expect(paidPromotionSource).toContain('buildPerformanceOverviewReadKey({');
    expect(paidPromotionSource).toContain('const existingRead = overviewReadsRef.current.get(overviewReadKey);');
    expect(paidPromotionSource).toContain('overviewReadsRef.current.set(overviewReadKey, overviewReadPromise);');
    expect(paidPromotionSource).toContain("readDepth: 'dashboard'");
    expect(paidPromotionSource).toContain('Number(readOptions.timeoutMs) > 0 ? Number(readOptions.timeoutMs) : 240000');
  });

  it('switches Performance reads and writes with the canonical shop scope and drops stale responses', () => {
    expect(paidPromotionSource).toContain('import { useSynchronizedOzonShopSelection }');
    expect(paidPromotionSource).toContain(
      'const [selectedShopId, setSelectedShopId] = useSynchronizedOzonShopSelection({'
    );
    expect(paidPromotionSource).toContain('onScopeChange: resetPromotionShopScope');
    expect(paidPromotionSource).toContain('const overviewReadGenerationRef = React.useRef(0);');
    expect(paidPromotionSource).toContain(
      'overviewReadGenerationRef.current !== overviewReadGeneration ||\n            overviewScopeKeyRef.current !== overviewSnapshotKey'
    );
    expect(paidPromotionSource).toContain('() => shops.find((shop) => shop.id === selectedShopId) ?? {}');
    expect(paidPromotionSource).toContain("const shopId = activeShop.id || '';");
    expect(paidPromotionSource).toContain("shopId: activeShop.id || '',");
    expect(paidPromotionSource).not.toContain(
      "const [selectedShopId, setSelectedShopId] = React.useState(() => activeShopId || shops[0]?.id || '');"
    );
    expect(paidPromotionSource).not.toContain('activeShop.id || selectedShopId || activeShopId');
  });

  it('keeps tab switching local and loads only selected campaign details on demand', () => {
    const loadStart = paidPromotionSource.indexOf('const loadRealtimeOverview = React.useCallback(');
    const loadEnd = paidPromotionSource.indexOf('const handleRefreshOverview = React.useCallback', loadStart);
    const loadSource = paidPromotionSource.slice(loadStart, loadEnd);
    const tabStart = paidPromotionSource.indexOf('const handlePromotionTabChange = React.useCallback(');
    const tabEnd = paidPromotionSource.indexOf('const loadSelectedCampaignDetails = React.useCallback', tabStart);
    const tabSource = paidPromotionSource.slice(tabStart, tabEnd);

    expect(loadSource).toContain("const readDepth = normalizeText(readOptions.readDepth) || 'full';");
    expect(loadSource).not.toContain('activePromotionTab');
    expect(tabSource).toContain('setActivePromotionTab(nextTab);');
    expect(tabSource).not.toContain('loadRealtimeOverview');
    expect(paidPromotionSource).toContain("readDepth: 'detail'");
    expect(paidPromotionSource).toContain('campaignId: selectedCampaign.id');
    expect(paidPromotionSource).toContain("['products', 'objects', 'search'].includes(activePromotionTab)");
    expect(paidPromotionSource).not.toContain("readDepth: activePromotionTab === 'stats' ? 'full' : 'fast'");
  });

  it('keeps the last complete snapshot visible while a full refresh is running', () => {
    const loadStart = paidPromotionSource.indexOf('const loadRealtimeOverview = React.useCallback(');
    const loadEnd = paidPromotionSource.indexOf('const handleRefreshOverview = React.useCallback', loadStart);
    const loadSource = paidPromotionSource.slice(loadStart, loadEnd);

    expect(loadSource).not.toContain("setOverview(null);\n      setSelectedCampaignId('');");
    expect(loadSource).toContain('setOverview(nextOverview);');
    expect(loadSource).toContain(
      'writePerformanceOverviewHotSnapshot(overviewByScopeRef.current, overviewSnapshotKey, nextOverview);'
    );
    expect(loadSource).toContain('已保留当前已经返回的数据');
  });

  it('keeps the current workspace mounted while a new date range has no hot snapshot', () => {
    const loadStart = paidPromotionSource.indexOf('const loadRealtimeOverview = React.useCallback(');
    const loadEnd = paidPromotionSource.indexOf('const handleRefreshOverview = React.useCallback', loadStart);
    const loadSource = paidPromotionSource.slice(loadStart, loadEnd);

    expect(loadSource).toContain('overviewRef.current = hotSnapshot;');
    expect(loadSource).toContain('if (hotSnapshot) {');
    expect(loadSource).not.toContain('setOverview(hotSnapshot);\n        setSelectedCampaignId');
    expect(loadSource).not.toContain("setOverview(null);\n        setError('统计范围开始日期不能晚于结束日期。');");
  });

  it('renders a local verified snapshot before batched dashboard statistics without queueing hidden catalog reads', () => {
    const initialStart = paidPromotionSource.indexOf('const loadInitialPromotionOverview = React.useCallback(');
    const initialEnd = paidPromotionSource.indexOf('const handleRefreshOverview = React.useCallback', initialStart);
    const initialSource = paidPromotionSource.slice(initialStart, initialEnd);

    expect(initialSource).toContain("readDepth: 'snapshot'");
    expect(initialSource).toContain('snapshotOnly: true');
    expect(initialSource).not.toContain("readDepth: 'fast'");
    expect(initialSource).toContain("readDepth: 'dashboard'");
    expect(initialSource).toContain('silent: Boolean(instantSnapshot?.ok)');
    expect(initialSource).toContain('timeoutMs: 90000');
    expect(initialSource).not.toContain("readDepth: 'catalog'");
    expect(initialSource).toContain('if (overviewReadGenerationRef.current !== initialGeneration) return;');
    expect(paidPromotionSource).toContain(
      '基础计划返回后立即显示；消耗与统计批量补齐，商品和投放对象在打开具体计划时读取。'
    );
  });

  it('converts all Performance API ruble displays to CNY in the promotion UI', () => {
    expect(paidPromotionSource).toContain('getRubCnyDailyRate');
    expect(paidPromotionSource).toContain('normalizeRubCnyRatePayload');
    expect(paidPromotionSource).toContain('function formatCnyAmount(value)');
    expect(paidPromotionSource).toContain('function formatMoney(value, rubToCnyRate)');
    expect(paidPromotionSource).toContain('return formatCnyAmount(number * rate);');
    expect(paidPromotionSource).not.toContain('₽');
  });

  it('executes promotion writes once and requires exact Ozon readback for all ten visible operations', () => {
    expect(paidPromotionSource).toContain('confirmWrite: true');
    expect(paidPromotionSource).toContain('confirmationCode: PERFORMANCE_WRITE_CONFIRMATION_CODE');
    expect(paidPromotionSource).toContain("{writeLoading ? '写入并核对中' : '立即执行'}");
    expect(paidPromotionSource).not.toContain('writePreview');
    expect(paidPromotionSource).not.toContain('生成写入预览');
    expect(paidPromotionSource).not.toContain('二次确认并执行');
    expect(performanceClientSource).toContain('performPerformanceWriteReadback({');
    expect(performanceClientSource).toContain('verifyPerformanceProductRows({');
    expect(performanceClientSource).toContain('verifySearchPromoWrite({');
    for (const action of [
      'createCampaign',
      'editCampaign',
      'addProducts',
      'updateBudget',
      'setProductBids',
      'removeProducts',
      'setSearchPromoBids',
      'deleteSearchPromoBids',
      'toggleSearchPromoProduct',
      'toggleCampaign',
    ]) {
      expect(performanceClientSource).toContain(`action === "${action}"`);
    }
    expect(paidPromotionSource).toContain("operation.action === 'toggleCampaign'");
    expect(paidPromotionSource).toContain("action: 'toggleCampaign'");
    expect(paidPromotionSource).not.toContain("writeDialog.action === 'toggleCampaign'");
    expect(paidPromotionSource).toContain('payload?.readback?.actual?.campaignId');
  });

  it('separates ordinary CPC product candidates from the search-promo pool', () => {
    expect(paidPromotionSource).toContain('const useSearchPromoPool = GLOBAL_SEARCH_PROMO_ACTIONS.has(writeDialog.action);');
    expect(paidPromotionSource).toContain("'deleteSearchPromoBids'");
    expect(paidPromotionSource).toContain("'toggleSearchPromoProduct'");
    expect(paidPromotionSource).toContain("await getDomainCache(\n              'products'");
    expect(paidPromotionSource).toContain("source: 'ozon-seller-products'");
    expect(paidPromotionSource).toContain("visibility: 'IN_SALE'");
    expect(paidPromotionSource).toContain('!currentCampaignSkus.has(item.sku)');
    expect(performanceClientSource).toContain('endpoint: "/api/client/campaign/search_promo/v2/products"');
  });

  it('blocks invalid CPC weekly budgets locally and preserves the concrete Ozon write error', () => {
    expect(paidPromotionSource).toContain('PERFORMANCE_WEEKLY_BUDGET_PER_SKU_RUBLES = 2000');
    expect(paidPromotionSource).toContain('getWeeklyBudgetValidationMessage(');
    expect(paidPromotionSource).toContain('Ozon 拒绝本次推广操作：');
    expect(performanceClientSource).toContain('validatePerformanceWeeklyBudgetRubles(params, "budgetRubles")');
    expect(performanceClientSource).toContain('当前 ${productCount} 个商品至少需要 ${minimum} 卢布');
  });
});

describe('platform API settings credential persistence rules', () => {
  it('hydrates saved Ozon Performance credential flags from local-api without storing client_secret', () => {
    expect(structuredSettingsSource).toContain('listPerformanceAccounts');
    expect(structuredSettingsSource).toContain('mergePerformanceAccountsIntoStructuredRecords');
    expect(structuredSettingsSource).toContain('hasPerformanceClientSecret');
    expect(structuredSettingsSource).toContain("performanceClientSecret: ''");
    expect(structuredSettingsSource).not.toContain('migrateLegacyPlatformApiRecords');
    expect(structuredSettingsSource).not.toContain('readLegacyBrowserValue');
  });

  it('preserves encrypted Performance credentials when the secret field is blank', () => {
    expect(structuredSettingsSource).toContain('if (clientId) savePayload.clientId = clientId;');
    expect(structuredSettingsSource).toContain('if (clientSecret) savePayload.clientSecret = clientSecret;');
    expect(structuredSettingsSource).toContain('!clientSecret && !hasSavedClientSecret');
  });

  it('shows saved client_secret as a fixed mask instead of browser plaintext', () => {
    expect(structuredSettingsSource).toContain("hasClientSecret ? '••••••••••' : '未填写'");
    expect(structuredSettingsSource).toContain("'••••••••••'");
  });

  it('removes migration-only client, server and repository branches for both canonical tables', () => {
    expect(localApiClientSource).not.toContain('importLegacyIntegrationProfiles');
    expect(localApiClientSource).not.toContain('importLegacyPerformanceAccounts');
    expect(localApiServerSource).not.toContain('/api/integrations/profiles/legacy-import');
    expect(localApiServerSource).not.toContain('/api/performance/accounts/legacy-import');
    expect(localApiServerSource).not.toContain('integrationProfileRepository.listProfilesPage');
    expect(localApiServerSource).not.toContain('performanceAccountRepository.listAccountsPage');
    expect(integrationRepositorySource).not.toContain('function importLegacyProfiles(');
    expect(integrationRepositorySource).not.toContain('function listProfilesPage(');
    expect(performanceRepositorySource).not.toContain('function importLegacyAccounts(');
    expect(performanceRepositorySource).not.toContain('function listAccountsPage(');
  });
});
