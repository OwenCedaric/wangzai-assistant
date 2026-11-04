import { DEFAULT_SHOP_BOOTSTRAP_DOMAINS } from '../../db/repositories/shopLifecycleRepository.js';
import { ShopIdentityError } from '../../db/repositories/shopIdentityRepository.js';

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function bootstrapReason(result, fallback = 'manual_full') {
  if (result.created) return 'initial_bind';
  if (result.rebound || result.incarnationChanged) return 'rebind';
  if (result.bindingActivated) return 'initial_bind';
  if (result.credentialsUpdated) return 'credential_rotation';
  return fallback;
}

export function createShopIdentityLifecycleService(options = {}) {
  const shopRepository = options.shopRepository;
  const lifecycleRepository = options.lifecycleRepository;
  const shopDatabaseManager = options.shopDatabaseManager || null;
  const shopDatabaseLifecycle = options.shopDatabaseLifecycle || null;
  const onShopDatabaseError = typeof options.onShopDatabaseError === 'function'
    ? options.onShopDatabaseError
    : () => undefined;
  const onNewShopDatabaseProvisioned = typeof options.onNewShopDatabaseProvisioned === 'function'
    ? options.onNewShopDatabaseProvisioned
    : () => undefined;
  if (!shopRepository) throw new Error('SHOP_REPOSITORY_REQUIRED');
  if (!lifecycleRepository) throw new Error('SHOP_LIFECYCLE_REPOSITORY_REQUIRED');
  if (shopRepository.profileId !== lifecycleRepository.profileId) {
    throw new ShopIdentityError('SHOP_PROFILE_CONTEXT_MISMATCH');
  }
  const requiredDomains = Array.isArray(options.requiredDomains) && options.requiredDomains.length
    ? options.requiredDomains.slice()
    : DEFAULT_SHOP_BOOTSTRAP_DOMAINS.slice();

  function provisionShopDatabase(scopeToken, shop = null, provisionOptions = {}) {
    if (!shopDatabaseManager?.ensure || !scopeToken) return;
    try {
      shopDatabaseManager.ensure(scopeToken, shop ? {
        displayName: normalizeText(shop.name),
        alias: normalizeText(shop.alias),
      } : null);
      shopDatabaseLifecycle?.reconcileScope?.(scopeToken, { repair: true });
      if (provisionOptions.initializeNewShop === true) {
        onNewShopDatabaseProvisioned({ scopeToken, shop });
      }
    } catch (error) {
      // The independent database is an additive, verified cache. Provisioning
      // failure stays observable without changing the existing shop
      // save/bootstrap business result.
      onShopDatabaseError(error, { action: 'provision', scopeToken });
    }
  }

  function closeShopDatabase(scopeToken) {
    if (!shopDatabaseManager?.close || !scopeToken) return;
    try {
      shopDatabaseManager.close(scopeToken);
    } catch (error) {
      onShopDatabaseError(error, { action: 'close', scopeToken });
    }
  }

  function currentScopeToken(shopId) {
    try {
      return shopRepository.identityRepository.createScopeToken(
        normalizeText(shopId),
        shopRepository.profileId,
      );
    } catch {
      return null;
    }
  }

  function getBindingReadiness(shopId) {
    const identity = shopRepository.identityRepository.getIdentity(
      shopId,
      shopRepository.profileId,
    );
    if (!identity) throw new ShopIdentityError('SHOP_SCOPE_NOT_FOUND');
    const scopeToken = shopRepository.identityRepository.createScopeToken(shopId, shopRepository.profileId);
    const currentRun = lifecycleRepository.listBootstrapRuns(shopId).find((run) => (
      run.shopIncarnation === scopeToken.shopIncarnation
      && run.credentialRevision === scopeToken.credentialRevision
    )) || null;
    const bindingReady = Boolean(
      identity.status === 'active'
      && !identity.disabledAt
      && currentRun
      && ['completed', 'completed_with_source_gaps'].includes(currentRun.status),
    );
    return Object.freeze({
      bindingReady,
      bindingStatus: identity.status === 'active' && !identity.disabledAt
        ? currentRun?.status || 'not_started'
        : identity.status,
      scopeToken,
      bootstrapRun: currentRun,
    });
  }

  function attachBootstrap(bindingResult, requestedReason) {
    if (bindingResult?.shop?.status === 'active') {
      provisionShopDatabase(bindingResult.scopeToken, bindingResult.shop, {
        initializeNewShop: bindingResult.created === true,
      });
    }
    if (!bindingResult.syncBootstrapRequired) {
      const readiness = getBindingReadiness(bindingResult.shop.id);
      return Object.freeze({ ...bindingResult, ...readiness });
    }
    const bootstrapRun = lifecycleRepository.createBootstrapRun({
      ...bindingResult.scopeToken,
      reason: requestedReason || bootstrapReason(bindingResult),
      requiredDomains,
    });
    return Object.freeze({
      ...bindingResult,
      bindingReady: false,
      bindingStatus: bootstrapRun.status,
      bootstrapRun,
    });
  }

  function getLifecycleStatus(shopId) {
    const readiness = getBindingReadiness(shopId);
    return Object.freeze({
      ...readiness,
      domainStates: Object.freeze(lifecycleRepository.listCurrentDomainStates(shopId)),
      bootstrapRuns: Object.freeze(lifecycleRepository.listBootstrapRuns(shopId)),
    });
  }

  // Existing active bindings also receive their readable cache identity on
  // startup. This never changes the canonical shop row or bootstrap state.
  for (const shop of shopRepository.listShops()) {
    if (shop.status !== 'active') continue;
    const scopeToken = currentScopeToken(shop.id);
    if (scopeToken) provisionShopDatabase(scopeToken, shop);
  }

  return Object.freeze({
    profileId: shopRepository.profileId,
    requiredDomains: Object.freeze(requiredDomains),

    getBindingReadiness,
    getLifecycleStatus,

    getBootstrapRun(runId) {
      return lifecycleRepository.getBootstrapRun(runId);
    },

    getBootstrapRunStatus(shopId, runId) {
      const run = lifecycleRepository.getBootstrapRun(runId);
      if (!run) throw new ShopIdentityError('SHOP_BOOTSTRAP_RUN_NOT_FOUND');
      if (run.shopId !== normalizeText(shopId)) {
        throw new ShopIdentityError('SHOP_BOOTSTRAP_RUN_SCOPE_MISMATCH');
      }
      return Object.freeze({
        run,
        domainStates: Object.freeze(lifecycleRepository.listBootstrapDomainStates(runId)),
        ...getBindingReadiness(run.shopId),
      });
    },

    saveBinding(input = {}, saveOptions = {}) {
      const deletedRebind = saveOptions.deletedRebind === true;
      if (deletedRebind) {
        const shopId = normalizeText(input.id);
        const clientId = normalizeText(input.clientId ?? input.client_id);
        const apiKey = normalizeText(input.apiKey ?? input.apiKeyEncrypted ?? input.api_key_encrypted);
        if (!shopId) throw new ShopIdentityError('SHOP_ID_REQUIRED');
        if (shopRepository.getPublicShopById(shopId)) {
          throw new ShopIdentityError('SHOP_DELETED_REBIND_SCOPE_CONFLICT');
        }
        if (!clientId || !apiKey) throw new ShopIdentityError('SHOP_REBIND_CREDENTIALS_REQUIRED');
      }
      const previousScopeToken = currentScopeToken(input.id);
      const saved = shopRepository.saveShop(deletedRebind
        ? { ...input, status: 'active' }
        : input);
      if (
        previousScopeToken
        && (saved.rebound || saved?.shop?.status !== 'active')
      ) closeShopDatabase(previousScopeToken);
      if (!deletedRebind) return attachBootstrap(saved);
      return attachBootstrap(Object.freeze({
        ...saved,
        rebound: true,
        incarnationChanged: true,
        deletedRebind: true,
      }), 'rebind');
    },

    rebind(input = {}) {
      const previousScopeToken = currentScopeToken(input.id);
      const rebound = shopRepository.rebindShop(input);
      if (previousScopeToken) closeShopDatabase(previousScopeToken);
      return attachBootstrap(rebound, 'rebind');
    },

    requestBootstrap(shopId, input = {}) {
      const scopeToken = shopRepository.identityRepository.createScopeToken(
        shopId,
        shopRepository.profileId,
      );
      shopRepository.identityRepository.assertCurrentScopeToken(scopeToken);
      provisionShopDatabase(scopeToken, shopRepository.getPublicShopById(shopId));
      const bootstrapRun = lifecycleRepository.createBootstrapRun({
        ...scopeToken,
        reason: normalizeText(input.reason) || 'manual_full',
        // A public/manual bootstrap is always the same full binding contract.
        // Callers cannot narrow it to one convenient domain and accidentally
        // turn a partially restored account into a ready binding.
        requiredDomains,
      });
      return Object.freeze({
        bindingReady: false,
        bindingStatus: bootstrapRun.status,
        scopeToken,
        bootstrapRun,
      });
    },

    disableBinding(shopId, input = {}) {
      const existing = shopRepository.getPublicShopById(shopId);
      if (!existing) throw new ShopIdentityError('SHOP_SCOPE_NOT_FOUND');
      const scopeToken = currentScopeToken(shopId);
      const saved = shopRepository.saveShop({
        id: existing.id,
        name: normalizeText(input.name) || existing.name,
        alias: Object.prototype.hasOwnProperty.call(input, 'alias') ? input.alias : existing.alias,
        status: 'disabled',
      });
      closeShopDatabase(scopeToken);
      return saved;
    },

    revokeCredentials(shopId) {
      const existing = shopRepository.getPublicShopById(shopId);
      if (!existing) throw new ShopIdentityError('SHOP_SCOPE_NOT_FOUND');
      const scopeToken = currentScopeToken(shopId);
      const saved = shopRepository.saveShop({
        id: existing.id,
        name: existing.name,
        alias: existing.alias,
        clientId: '',
        apiKey: '',
        status: 'disabled',
      });
      closeShopDatabase(scopeToken);
      return saved;
    },

    createTaskScopeToken(shopId) {
      return shopRepository.identityRepository.createScopeToken(shopId, shopRepository.profileId);
    },

    assertTaskMayActivate(scopeToken, assertionOptions) {
      return shopRepository.identityRepository.assertCurrentScopeToken(scopeToken, assertionOptions);
    },

    activateBootstrap(runId, scopeToken) {
      return lifecycleRepository.transitionBootstrapRun({
        runId,
        scopeToken,
        expectedStatus: 'queued',
        nextStatus: 'running',
      });
    },

    beginBootstrapVerification(runId, scopeToken) {
      return lifecycleRepository.transitionBootstrapRun({
        runId,
        scopeToken,
        expectedStatus: 'running',
        nextStatus: 'verifying',
      });
    },

    recordBootstrapDomain(input = {}) {
      return lifecycleRepository.recordDomainState(input);
    },

    completeBootstrap(input = {}) {
      return lifecycleRepository.completeBootstrapRun(input);
    },
  });
}
