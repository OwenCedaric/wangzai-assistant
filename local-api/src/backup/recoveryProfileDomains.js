import { DATA_BACKUP_OZON_LOGICAL_SLICE_DOMAINS } from "./recoveryExporter.js";

export const RECOVERY_PROFILE_CORE_DOMAINS = Object.freeze([
  'shops',
  'shop-credentials',
  'cross-border-accounts',
  'performance-accounts',
  'purchase-accounts',
  'model-api-accounts',
  'integration-profiles',
  'integration-credentials',
  'follow-seller-login-preferences',
  'profile-settings',
  'profile-assets',
  'purchase-browser-tasks',
  'purchase-browser-receipts',
  'purchase-completion-history',
]);

export const RECOVERY_PROFILE_CORE_VERSION = 11;

export const RECOVERY_OWNER_DOMAIN_TYPES = Object.freeze({
  shops: 'ozon_shop',
  'cross-border-accounts': 'cross_border_bus',
  'performance-accounts': 'promotion_account',
  'purchase-accounts': 'purchase_account',
  'model-api-accounts': 'model_api_account',
  'integration-profiles': 'integration_profile',
});

export const RECOVERY_OWNER_IDENTITY_DOMAINS = Object.freeze({
  ozon_shop: Object.freeze(['shops', 'shop-credentials']),
  cross_border_bus: Object.freeze(['cross-border-accounts']),
  promotion_account: Object.freeze(['performance-accounts']),
  purchase_account: Object.freeze(['purchase-accounts']),
  model_api_account: Object.freeze(['model-api-accounts']),
  integration_profile: Object.freeze(['integration-profiles']),
});

export const RECOVERY_OWNER_PROFILE_DOMAINS = Object.freeze({
  ozon_shop: Object.freeze([
    'shops',
    'shop-credentials',
    'purchase-completion-history',
    ...new Set(Object.values(DATA_BACKUP_OZON_LOGICAL_SLICE_DOMAINS)),
  ]),
  cross_border_bus: Object.freeze(['cross-border-accounts', 'profile-settings']),
  promotion_account: Object.freeze(['performance-accounts']),
  purchase_account: Object.freeze([
    'purchase-accounts',
    'purchase-browser-tasks',
    'purchase-browser-receipts',
  ]),
  model_api_account: Object.freeze(['model-api-accounts']),
  integration_profile: Object.freeze([
    'integration-profiles',
    'integration-credentials',
    'follow-seller-login-preferences',
  ]),
});

export function expectedProfileDomainCount(version) {
  if (version === 1) return 2;
  if (version === 2) return 4;
  if (version === 3) return 5;
  if (version === 4) return 6;
  if (version === 5) return 7;
  if (version === 6) return 8;
  if (version === 7) return 9;
  if (version === 8) return 11;
  if (version === 9) return 12;
  if (version === 10) return 13;
  if (version === RECOVERY_PROFILE_CORE_VERSION) return RECOVERY_PROFILE_CORE_DOMAINS.length;
  return 0;
}

export function assertRecoveryProfileCoreCandidateShape(candidate) {
  const domains = Array.isArray(candidate?.domains) ? candidate.domains.map((item) => item?.domain) : [];
  const known = new Set(RECOVERY_PROFILE_CORE_DOMAINS);
  const present = new Set(domains);
  if (
    domains.length !== present.size
    || domains.some((domain) => !known.has(domain))
    || !present.has('shops')
    || !present.has('shop-credentials')
  ) {
    throw new Error('RESTORE_PROFILE_CANDIDATE_INVALID');
  }
  const version = Number(candidate?.version);
  // Legacy v1 candidates have two original chunks; v2 has four account chunks; v3 has five;
  // v4 has six, v5 has seven, v6 has eight, v7 has nine, v8 has eleven, v9 has twelve
  // and v10 has thirteen. Current v11 candidates contain
  // every registered profile-core domain. A partial current candidate must not silently drop
  // accounts, user configuration, purchase tasks or execution receipts.
  if (domains.length !== expectedProfileDomainCount(version)) {
    throw new Error('RESTORE_PROFILE_CANDIDATE_INVALID');
  }
}
