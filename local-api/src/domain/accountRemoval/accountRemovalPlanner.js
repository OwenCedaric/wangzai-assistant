import {
  ACCOUNT_OWNERSHIP_CATALOG,
} from './accountOwnershipCatalog.js';
import {
  createAccountRemovalPreviewDto,
  validateAccountRemovalOwner,
} from './accountRemovalContract.js';
import {
  observeAccountRemovalSqliteResource,
  observeCrossBorderPreferenceResource,
  observeOzonShopPreferenceResource,
  observePurchasePluginContextResource,
  observePurchasePluginAccountContextResource,
} from './accountRemovalEvidence.js';
import { ACCOUNT_REMOVAL_ERROR_CODES, failAccountRemovalContract } from './accountRemovalErrors.js';
import { isAccountRemovalClientResource } from './accountRemovalClientResources.js';
import {
  assertAccountRemovalSqliteCatalog,
  getAccountRemovalSqliteResourceById,
} from './accountRemovalSqliteCatalog.js';

const OWNER_LOOKUPS = Object.freeze({
  ozon_shop: Object.freeze({
    table: 'shops',
    label: 'name',
    secondary: 'alias',
    incarnation: 'shop_incarnation',
  }),
  cross_border_bus: Object.freeze({ table: 'cross_border_accounts', label: 'name', secondary: 'default_storehouse' }),
  promotion_account: Object.freeze({ table: 'performance_accounts', label: 'name', secondary: 'client_id' }),
  purchase_account: Object.freeze({ table: 'purchase_accounts', label: 'name', secondary: 'platform_name' }),
  model_api_account: Object.freeze({ table: 'model_api_accounts', label: 'api_alias', secondary: 'provider' }),
  integration_profile: Object.freeze({ table: 'integration_profiles', label: 'platform_name', secondary: 'integration_type' }),
});

function publicAccount(row, owner) {
  const lookup = OWNER_LOOKUPS[owner.ownerType];
  return {
    ownerType: owner.ownerType,
    ownerId: owner.ownerId,
    displayName: String(row?.[lookup.label] || owner.ownerId),
    secondaryLabel: String(row?.[lookup.secondary] || ''),
  };
}

export function createAccountRemovalPlanner({
  db,
  runtimeCoordinator,
  shopStorageLifecycle = null,
  catalog = ACCOUNT_OWNERSHIP_CATALOG,
} = {}) {
  if (!db) throw new Error('ACCOUNT_REMOVAL_DATABASE_REQUIRED');
  assertAccountRemovalSqliteCatalog(catalog);

  function findAccount(rawOwner) {
    const owner = validateAccountRemovalOwner(rawOwner);
    const lookup = OWNER_LOOKUPS[owner.ownerType];
    if (!lookup) failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.OWNER_TYPE_INVALID);
    const row = db.prepare(`SELECT id, "${lookup.label}", "${lookup.secondary}" FROM "${lookup.table}" WHERE id = ?`).get(owner.ownerId);
    return row ? publicAccount(row, owner) : null;
  }

  function requireAccount(rawOwner) {
    const owner = validateAccountRemovalOwner(rawOwner);
    const lookup = OWNER_LOOKUPS[owner.ownerType];
    if (!lookup) failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.OWNER_TYPE_INVALID);
    const lifecycleColumns = owner.ownerType === 'ozon_shop'
      ? ', profile_id, client_id, external_identity_hash, shop_incarnation, credential_revision'
      : '';
    const row = db.prepare(`
      SELECT id, "${lookup.label}", "${lookup.secondary}", created_at${lifecycleColumns}
      FROM "${lookup.table}" WHERE id = ?
    `).get(owner.ownerId);
    if (!row) failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.OWNER_NOT_FOUND);
    const ownerIncarnation = String(
      owner.ownerType === 'ozon_shop' ? row.shop_incarnation : row.created_at,
    ).trim();
    if (!ownerIncarnation) failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.OPERATION_STATE_INVALID);
    const identityLifecycle = owner.ownerType === 'ozon_shop'
      ? Object.freeze({
          profileId: String(row.profile_id || 'default').trim() || 'default',
          clientId: String(row.client_id || '').trim() || null,
          externalIdentityHash: String(row.external_identity_hash || '').trim() || null,
          shopIncarnation: ownerIncarnation,
          credentialRevision: Number(row.credential_revision),
        })
      : null;
    return { owner, account: publicAccount(row, owner), ownerIncarnation, identityLifecycle };
  }

  function observePlannedResources(owner, plannedResources, { scopeToken = null } = {}) {
    return plannedResources.map((entry) => {
      if (['filesystem:shop-database-scope', 'filesystem:shop-aggregate-index-scope'].includes(entry.id)) {
        const observation = shopStorageLifecycle?.observeResource?.({ owner, scopeToken, resourceId: entry.id });
        return { resourceId: entry.id, ...(observation || { state: 'absent' }) };
      }
      const descriptor = getAccountRemovalSqliteResourceById(owner.ownerType, entry.id);
      if (descriptor) {
        return { resourceId: entry.id, ...observeAccountRemovalSqliteResource(db, descriptor, owner.ownerId) };
      }
      if (entry.id === 'logical:profile-settings-ozon-shop-preferences' && owner.ownerType === 'ozon_shop') {
        return { resourceId: entry.id, ...observeOzonShopPreferenceResource(db, owner.ownerId) };
      }
      if (entry.id === 'logical:profile-settings-purchase-plugin-context' && owner.ownerType === 'ozon_shop') {
        return { resourceId: entry.id, ...observePurchasePluginContextResource(db, owner.ownerId) };
      }
      if (entry.id === 'logical:profile-settings-purchase-account-context' && owner.ownerType === 'purchase_account') {
        return { resourceId: entry.id, ...observePurchasePluginAccountContextResource(db, owner.ownerId) };
      }
      if (entry.id === 'logical:profile-settings-cross-border-preferences' && owner.ownerType === 'cross_border_bus') {
        return { resourceId: entry.id, ...observeCrossBorderPreferenceResource(db, owner.ownerId) };
      }
      if (isAccountRemovalClientResource(owner.ownerType, entry.id)) {
        return { resourceId: entry.id, state: 'unobserved' };
      }
      const runtimeObservation = runtimeCoordinator?.observeResource?.(owner, entry.id);
      if (runtimeObservation && runtimeObservation.state !== 'unobserved') return runtimeObservation;
      failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.CATALOG_INVALID);
    }).sort((left, right) => left.resourceId.localeCompare(right.resourceId));
  }

  function createPreview(input = {}) {
    const { owner, account, identityLifecycle } = requireAccount(input.owner);
    const provisional = createAccountRemovalPreviewDto({ owner }, { catalog });
    const requestedResourceIds = provisional.plannedResources.map((entry) => entry.id).sort();
    const scopeToken = identityLifecycle
      ? {
          profileId: identityLifecycle.profileId,
          shopId: owner.ownerId,
          shopIncarnation: identityLifecycle.shopIncarnation,
        }
      : null;
    const resourceObservations = observePlannedResources(owner, provisional.plannedResources, { scopeToken });
    const preview = createAccountRemovalPreviewDto({
      owner,
      requestedOwnerType: owner.ownerType,
      requestedOwnerId: owner.ownerId,
      requestedResourceIds,
    }, { catalog, resourceObservations });
    const ownerGeneration = identityLifecycle
      ? Object.freeze({
          ownerId: owner.ownerId,
          clientId: identityLifecycle.clientId,
          profileId: identityLifecycle.profileId,
          shopIncarnation: identityLifecycle.shopIncarnation,
          credentialRevision: identityLifecycle.credentialRevision,
        })
      : null;
    return { preview, account, ownerGeneration };
  }

  function observeCurrent(rawOwner, plannedResources, { scopeToken = null } = {}) {
    const owner = validateAccountRemovalOwner(rawOwner);
    return observePlannedResources(owner, plannedResources, { scopeToken });
  }

  return { createPreview, findAccount, observeCurrent, requireAccount };
}
