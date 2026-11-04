import {
  getCrossBorderAccounts,
  listIntegrationProfiles,
  listPerformanceAccounts,
  listPurchaseAccounts,
} from '../../../api/localApiClient.js';

const SMART_TOOL_INTEGRATION_TYPES = new Set(['seerfar-open-api', 'linkfox-agent']);

function isProfileCredentialReady(profile = {}) {
  return profile.hasApiKey === true || profile.lastTestStatus === 'connected' || profile.lastTestStatus === 'limited';
}

export function getReadySmartToolIntegrationTypes(profiles = []) {
  return [
    ...new Set(
      (Array.isArray(profiles) ? profiles : [])
        .filter(isProfileCredentialReady)
        .map((profile) => String(profile?.integrationType || '').trim())
        .filter((integrationType) => SMART_TOOL_INTEGRATION_TYPES.has(integrationType))
    ),
  ];
}

export function getReadyPerformanceAccountCount(accounts = []) {
  return (Array.isArray(accounts) ? accounts : []).filter((account) => {
    const hasClientId = account?.hasClientId === true || Boolean(String(account?.clientId || '').trim());
    const hasClientSecret =
      account?.hasClientSecret === true || Boolean(String(account?.clientSecretHint || '').trim());
    return hasClientId && hasClientSecret;
  }).length;
}

export function getEnabledIntegrationAccountCount(accounts = []) {
  return (Array.isArray(accounts) ? accounts : []).filter(
    (account) => account?.enabled !== false && account?.disabled !== true && account?.status !== 'disabled'
  ).length;
}

export async function loadSmartToolIntegrationState(options = {}) {
  const requestOptions = { timeoutMs: options.timeoutMs || 10000 };
  const [integrationResult, performanceResult, crossBorderResult, purchaseResult] = await Promise.all([
    listIntegrationProfiles(requestOptions).catch(() => ({ profiles: [] })),
    listPerformanceAccounts(requestOptions).catch(() => ({ accounts: [] })),
    getCrossBorderAccounts(requestOptions).catch(() => ({ rows: [] })),
    listPurchaseAccounts(requestOptions).catch(() => ({ accounts: [] })),
  ]);
  const integrationTypes = getReadySmartToolIntegrationTypes(integrationResult?.profiles);
  const performanceAccountCount = getReadyPerformanceAccountCount(
    performanceResult?.accounts || performanceResult?.rows
  );
  const crossBorderAccountCount = getEnabledIntegrationAccountCount(
    crossBorderResult?.accounts || crossBorderResult?.rows
  );
  const purchaseAccountCount = getEnabledIntegrationAccountCount(purchaseResult?.accounts || purchaseResult?.rows);
  return {
    integrationTypes,
    hasThirdPartyToolAccount: integrationTypes.length > 0,
    hasPerformanceAccount: performanceAccountCount > 0,
    performanceAccountCount,
    hasCrossBorderAccount: crossBorderAccountCount > 0,
    crossBorderAccountCount,
    hasPurchaseAccount: purchaseAccountCount > 0,
    purchaseAccountCount,
  };
}
