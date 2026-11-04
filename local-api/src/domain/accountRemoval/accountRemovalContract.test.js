import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ACCOUNT_OWNERSHIP_CATALOG } from './accountOwnershipCatalog.js';
import {
  ACCOUNT_REMOVAL_CONTRACT_VERSION,
  ACCOUNT_REMOVAL_REQUESTED_RESOURCE_IDS_SEMANTICS,
  createAccountOwnershipCatalogFingerprint,
  createAccountRemovalConfirmDto,
  createAccountRemovalPreviewDto,
  createAccountRemovalPreviewFingerprint,
  createAccountRemovalResultDto,
  createAccountRemovalSnapshotFingerprint,
  createCanonicalAccountRemovalPreviewFingerprintShape,
  validateAccountRemovalIdempotencyReuse,
  validateCanonicalAccountRemovalPreviewDto,
} from './accountRemovalContract.js';
import { ACCOUNT_REMOVAL_ERROR_CODES, AccountRemovalContractError } from './accountRemovalErrors.js';

const accountRemovalDirectory = dirname(fileURLToPath(import.meta.url));
const localApiRoot = resolve(accountRemovalDirectory, '../../..');
const workspaceRoot = resolve(localApiRoot, '..');

function clone(value) {
  return structuredClone(value);
}

function expectContractError(expectedCode, action) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof AccountRemovalContractError);
    assert.equal(error.code, expectedCode);
    return true;
  });
}

function createShopPreview(ownerId = 'shop-a', options = {}) {
  const { catalog, resourceObservations, ...input } = options;
  const contractOptions = {};
  if (catalog !== undefined) contractOptions.catalog = catalog;
  if (resourceObservations !== undefined) contractOptions.resourceObservations = resourceObservations;
  return createAccountRemovalPreviewDto({
    owner: { ownerType: 'ozon_shop', ownerId },
    ...input,
  }, contractOptions);
}

function createFixtureObservations(preview, { countOffset = 0, revision = 'fixture-a' } = {}) {
  return preview.plannedResources.map((resource, index) => ({
    resourceId: resource.id,
    state: 'observed',
    count: index + countOffset,
    revision: `${revision}-${index}`,
  }));
}

function createObservedShopPreview(ownerId = 'shop-a', options = {}) {
  const provisional = createShopPreview(ownerId, options);
  return createShopPreview(ownerId, {
    ...options,
    resourceObservations: createFixtureObservations(provisional, options.observationFixture),
  });
}

function confirmInput(preview, overrides = {}) {
  return {
    contractVersion: preview.version,
    catalogVersion: preview.catalogVersion,
    owner: clone(preview.owner),
    requestedOwnerType: preview.requestedOwnerType,
    requestedOwnerId: preview.requestedOwnerId,
    requestedResourceIdsSemantics: preview.requestedResourceIdsSemantics,
    requestedResourceIds: clone(preview.requestedResourceIds),
    resourceObservations: clone(preview.resourceObservations),
    snapshotFingerprint: preview.snapshotFingerprint,
    previewFingerprint: preview.previewFingerprint,
    catalogFingerprint: preview.catalogFingerprint,
    idempotencyKey: 'phase-b-account-removal-contract-0001',
    ...overrides,
  };
}

function confirmOptions(preview, overrides = {}) {
  return {
    currentResourceObservations: clone(preview.resourceObservations),
    ...overrides,
  };
}

function createConfirm(preview, overrides = {}, options = {}) {
  return createAccountRemovalConfirmDto(
    confirmInput(preview, overrides),
    preview,
    confirmOptions(preview, options),
  );
}

test('catalog and preview fingerprints are canonical, order-stable, and sensitive to catalog or owner changes', () => {
  const canonicalCatalogFingerprint = createAccountOwnershipCatalogFingerprint(ACCOUNT_OWNERSHIP_CATALOG);
  assert.equal(canonicalCatalogFingerprint, createAccountOwnershipCatalogFingerprint([...ACCOUNT_OWNERSHIP_CATALOG].reverse()));

  const changedCatalog = clone(ACCOUNT_OWNERSHIP_CATALOG);
  const shops = changedCatalog.find((entry) => entry.id === 'registry:shops');
  shops.risk = `${shops.risk} changed`;
  assert.notEqual(canonicalCatalogFingerprint, createAccountOwnershipCatalogFingerprint(changedCatalog));

  const sourceChangedCatalog = clone(ACCOUNT_OWNERSHIP_CATALOG);
  const sourceBackedResource = sourceChangedCatalog.find((entry) => entry.id === 'memory:renderer-marketing-activity-runtime-cache');
  sourceBackedResource.sourceEvidence = { ...sourceBackedResource.sourceEvidence, ownerBasis: `${sourceBackedResource.sourceEvidence.ownerBasis} changed` };
  assert.notEqual(canonicalCatalogFingerprint, createAccountOwnershipCatalogFingerprint(sourceChangedCatalog));

  const pathChangedCatalog = clone(ACCOUNT_OWNERSHIP_CATALOG);
  const recordMapResource = pathChangedCatalog.find((entry) => entry.id === 'logical:local-data-product-material-profiles-shop-records');
  assert.equal(recordMapResource.verifyQuery.type, 'json-record-map-owner-absence');
  recordMapResource.directory = '商品资料-v2';
  recordMapResource.relativePath = '商品资料-v2/product-material-profiles.json';
  recordMapResource.resource = 'desktop local-data/商品资料-v2/product-material-profiles.json';
  recordMapResource.verifyQuery.directory = recordMapResource.directory;
  recordMapResource.verifyQuery.relativePath = recordMapResource.relativePath;
  assert.notEqual(canonicalCatalogFingerprint, createAccountOwnershipCatalogFingerprint(pathChangedCatalog));

  const previewA = createShopPreview('shop-a');
  const previewB = createShopPreview('shop-b');
  const promotionPreview = createAccountRemovalPreviewDto({
    owner: { ownerType: 'promotion_account', ownerId: 'performance-a' },
  });
  assert.notEqual(previewA.previewFingerprint, previewB.previewFingerprint);
  assert.notEqual(previewA.previewFingerprint, promotionPreview.previewFingerprint);
  assert.equal(previewA.version, ACCOUNT_REMOVAL_CONTRACT_VERSION);
  assert.equal(previewA.catalogFingerprint, canonicalCatalogFingerprint);
  assert.equal(previewA.requestedResourceIdsSemantics, ACCOUNT_REMOVAL_REQUESTED_RESOURCE_IDS_SEMANTICS);

  const fingerprintShape = createCanonicalAccountRemovalPreviewFingerprintShape(previewA);
  assert.deepEqual(fingerprintShape.owner, previewA.owner);
  assert.deepEqual(fingerprintShape.plannedResources, previewA.plannedResources);
  assert.deepEqual(fingerprintShape.preserveResources, previewA.preserveResources);
  assert.equal(createAccountRemovalPreviewFingerprint(previewA), previewA.previewFingerprint);
  assert.deepEqual(validateCanonicalAccountRemovalPreviewDto(previewA), previewA);
});

test('preview plans only strict current removable resources and returns a full preserve contract', () => {
  const preview = createShopPreview('shop-a');

  assert.equal(preview.mode, 'preview-only');
  assert.equal(preview.completed, false);
  assert.ok(preview.plannedResources.length > 0);
  assert.ok(preview.plannedResources.every((entry) => entry.ownerType === 'ozon_shop'));
  assert.ok(preview.plannedResources.every((entry) => entry.removable === true));
  assert.ok(preview.plannedResources.every((entry) => entry.availability === 'current'));
  assert.ok(preview.plannedResources.every((entry) => typeof entry.preserveRule === 'string' && entry.preserveRule.length > 0));
  assert.ok(preview.preserveResources.some((entry) => entry.id === 'registry:cross-border-accounts'));
  assert.ok(preview.preserveResources.some((entry) => entry.id === 'registry:profile-settings'));
  assert.ok(preview.preserveResources.some((entry) => entry.id === 'backup:remote-recovery-generation-shared-profile'));

  const catalogWithFutureShopResource = clone(ACCOUNT_OWNERSHIP_CATALOG);
  const futureShops = catalogWithFutureShopResource.find((entry) => entry.id === 'registry:shops');
  futureShops.removable = false;
  futureShops.availability = 'future-contract';
  const futurePreview = createShopPreview('shop-a', { catalog: catalogWithFutureShopResource });
  assert.equal(futurePreview.plannedResources.some((entry) => entry.id === 'registry:shops'), false);
  assert.ok(futurePreview.preserveResources.some((entry) => entry.id === 'registry:shops'));

  const malformedCatalog = clone(ACCOUNT_OWNERSHIP_CATALOG);
  malformedCatalog.find((entry) => entry.id === 'registry:shops').removable = 'false';
  expectContractError(ACCOUNT_REMOVAL_ERROR_CODES.CATALOG_INVALID, () => createShopPreview('shop-a', { catalog: malformedCatalog }));

  const originalAcceptancePoc = clone(ACCOUNT_OWNERSHIP_CATALOG);
  Object.assign(originalAcceptancePoc.find((entry) => entry.id === 'registry:shops'), {
    scopeType: 'system',
    deletePrimitive: 'prohibited:no-op',
    verifyQuery: {
      type: 'sqlite-count',
      table: 'shops',
      ownerField: 'id',
      ownerPredicate: 'id = :ownerId',
      expected: 'banana',
    },
  });
  expectContractError(
    ACCOUNT_REMOVAL_ERROR_CODES.CATALOG_INVALID,
    () => createShopPreview('shop-a', { catalog: originalAcceptancePoc }),
  );

  const plannerPocs = [
    {
      name: 'wildcard or SQL-like owner selector cannot enter planning',
      mutate(entry) { entry.ownerField = 'shop_id LIKE *'; },
    },
    {
      name: 'SQLite resource cannot swap to a browser verifier',
      mutate(entry) { entry.verifyQuery = { type: 'browser-artifact-absence', artifact: 'cookies', expected: 'absent' }; },
    },
    {
      name: 'SQLite selector, verifier owner field, and predicate must remain exactly bound',
      mutate(entry) {
        entry.verifyQuery = {
          ...entry.verifyQuery,
          ownerField: 'client_id',
          ownerPredicate: 'client_id = :ownerId',
        };
      },
    },
  ];
  for (const { name, mutate } of plannerPocs) {
    const catalog = clone(ACCOUNT_OWNERSHIP_CATALOG);
    mutate(catalog.find((entry) => entry.id === 'registry:shops'));
    expectContractError(ACCOUNT_REMOVAL_ERROR_CODES.CATALOG_INVALID, () => createShopPreview('shop-a', { catalog }), name);
  }
});

test('requested resource ids are a sorted, deduplicated full-plan assertion allowlist rather than a selectable delete subset', () => {
  const preview = createShopPreview('shop-a');
  const fullPlanIds = preview.plannedResources.map((entry) => entry.id).sort();
  const assertedPreview = createShopPreview('shop-a', {
    requestedResourceIds: [...fullPlanIds].reverse().concat(fullPlanIds[0]),
  });
  assert.deepEqual(assertedPreview.requestedResourceIds, fullPlanIds);

  expectContractError(ACCOUNT_REMOVAL_ERROR_CODES.REQUESTED_RESOURCES_ASSERTION_MISMATCH, () => createShopPreview('shop-a', {
    requestedResourceIds: fullPlanIds.slice(0, -1),
  }));
  expectContractError(ACCOUNT_REMOVAL_ERROR_CODES.CROSS_OWNER_SCOPE, () => createShopPreview('shop-a', {
    requestedResourceIds: ['registry:cross-border-accounts'],
  }));
  expectContractError(ACCOUNT_REMOVAL_ERROR_CODES.RESOURCE_UNREGISTERED, () => createShopPreview('shop-a', {
    requestedResourceIds: ['not-a-catalog-resource'],
  }));
});

test('owner type and owner id reject object coercion, wildcard/control input, and contradictory confirm scope assertions', () => {
  const invalidOwnerIds = [
    {},
    [],
    null,
    new String('shop-a'),
    ' shop-a',
    'shop-a ',
    'shop\u0000a',
    'shop\na',
    'shop*a',
    'shop?a',
    'shop%a',
    'shop[a]',
    'a'.repeat(129),
  ];
  for (const ownerId of invalidOwnerIds) {
    expectContractError(ACCOUNT_REMOVAL_ERROR_CODES.OWNER_ID_INVALID, () => createAccountRemovalPreviewDto({
      owner: { ownerType: 'ozon_shop', ownerId },
    }));
  }
  assert.equal(createShopPreview('shop_a').owner.ownerId, 'shop_a');
  expectContractError(ACCOUNT_REMOVAL_ERROR_CODES.OWNER_ID_REQUIRED, () => createAccountRemovalPreviewDto({
    owner: { ownerType: 'ozon_shop', ownerId: '' },
  }));
  expectContractError(ACCOUNT_REMOVAL_ERROR_CODES.OWNER_TYPE_INVALID, () => createAccountRemovalPreviewDto({
    owner: { ownerType: {}, ownerId: 'shop-a' },
  }));
  expectContractError(ACCOUNT_REMOVAL_ERROR_CODES.OWNER_TYPE_INVALID, () => createAccountRemovalPreviewDto({
    owner: { ownerType: ' ozon_shop', ownerId: 'shop-a' },
  }));
  expectContractError(ACCOUNT_REMOVAL_ERROR_CODES.SYSTEM_OWNER_PROTECTED, () => createAccountRemovalPreviewDto({
    owner: { ownerType: 'system', ownerId: 'global' },
  }));
  expectContractError(ACCOUNT_REMOVAL_ERROR_CODES.OWNER_TYPE_INVALID, () => createAccountRemovalPreviewDto({
    owner: { ownerType: 'unknown', ownerId: 'unknown-owner' },
  }));

  const preview = createShopPreview('shop-a');
  const confirmWithoutScopeAssertion = confirmInput(preview);
  delete confirmWithoutScopeAssertion.requestedOwnerType;
  delete confirmWithoutScopeAssertion.requestedOwnerId;
  expectContractError(ACCOUNT_REMOVAL_ERROR_CODES.OWNER_SCOPE_ASSERTION_REQUIRED, () => createAccountRemovalConfirmDto(
    confirmWithoutScopeAssertion,
    preview,
    confirmOptions(preview),
  ));
  expectContractError(ACCOUNT_REMOVAL_ERROR_CODES.OWNER_ID_INVALID, () => createAccountRemovalConfirmDto(
    confirmInput(preview, { requestedOwnerId: {} }),
    preview,
    confirmOptions(preview),
  ));
  expectContractError(ACCOUNT_REMOVAL_ERROR_CODES.CROSS_OWNER_SCOPE, () => createAccountRemovalConfirmDto(
    confirmInput(preview, {
      owner: { ownerType: 'ozon_shop', ownerId: 'shop-b' },
      requestedOwnerType: 'ozon_shop',
      requestedOwnerId: 'shop-b',
    }),
    preview,
    confirmOptions(preview),
  ));
});

test('confirm re-canonicalizes every preview field and rejects all known preview tampering PoCs', () => {
  const preview = createObservedShopPreview('shop-a');
  const promotionResource = ACCOUNT_OWNERSHIP_CATALOG.find((entry) => entry.id === 'registry:performance-accounts');
  assert.ok(promotionResource);

  function expectPreviewTamper(name, mutate, expectedCode) {
    const tamperedPreview = clone(preview);
    mutate(tamperedPreview);
    expectContractError(expectedCode, () => createAccountRemovalConfirmDto(
      confirmInput(tamperedPreview),
      tamperedPreview,
      confirmOptions(preview),
    ));
    assert.ok(name);
  }

  expectPreviewTamper('planned resource replacement cannot promote a different account type', (value) => {
    value.plannedResources[0] = clone(promotionResource);
  }, ACCOUNT_REMOVAL_ERROR_CODES.PREVIEW_CONTRACT_MISMATCH);
  expectPreviewTamper('preserve resource removal is rejected', (value) => {
    value.preserveResources = [];
  }, ACCOUNT_REMOVAL_ERROR_CODES.PREVIEW_CONTRACT_MISMATCH);
  expectPreviewTamper('owner mutation is not accepted', (value) => {
    value.owner.ownerId = 'shop-b';
  }, ACCOUNT_REMOVAL_ERROR_CODES.CROSS_OWNER_SCOPE);
  expectPreviewTamper('contract version mutation is not accepted', (value) => {
    value.version = 'account-removal-contract-v0';
  }, ACCOUNT_REMOVAL_ERROR_CODES.CONTRACT_VERSION_MISMATCH);
  expectPreviewTamper('catalog version mutation is not accepted', (value) => {
    value.catalogVersion = 'account-ownership-catalog-v0';
  }, ACCOUNT_REMOVAL_ERROR_CODES.CATALOG_VERSION_MISMATCH);
  expectPreviewTamper('requested resource subset cannot replace the assertion', (value) => {
    value.requestedResourceIds = [value.plannedResources[0].id];
  }, ACCOUNT_REMOVAL_ERROR_CODES.REQUESTED_RESOURCES_ASSERTION_MISMATCH);
  expectPreviewTamper('catalog fingerprint mutation is not accepted', (value) => {
    value.catalogFingerprint = '0'.repeat(64);
  }, ACCOUNT_REMOVAL_ERROR_CODES.CATALOG_FINGERPRINT_MISMATCH);
  expectPreviewTamper('snapshot fingerprint mutation is not accepted', (value) => {
    value.snapshotFingerprint = '0'.repeat(64);
  }, ACCOUNT_REMOVAL_ERROR_CODES.SNAPSHOT_FINGERPRINT_MISMATCH);
  expectPreviewTamper('preview fingerprint mutation is not accepted', (value) => {
    value.previewFingerprint = '0'.repeat(64);
  }, ACCOUNT_REMOVAL_ERROR_CODES.PREVIEW_FINGERPRINT_MISMATCH);
  expectPreviewTamper('resource observation mutation is not accepted', (value) => {
    value.resourceObservations[0].count += 1;
  }, ACCOUNT_REMOVAL_ERROR_CODES.SNAPSHOT_FINGERPRINT_MISMATCH);

  expectContractError(ACCOUNT_REMOVAL_ERROR_CODES.CONTRACT_VERSION_MISMATCH, () => createConfirm(preview, {
    contractVersion: 'account-removal-contract-v0',
  }));
  expectContractError(ACCOUNT_REMOVAL_ERROR_CODES.CONTRACT_VERSION_MISMATCH, () => createConfirm(preview, {
    version: 'account-removal-contract-v0',
  }));
  expectContractError(ACCOUNT_REMOVAL_ERROR_CODES.CATALOG_VERSION_MISMATCH, () => createConfirm(preview, {
    catalogVersion: 'account-ownership-catalog-v0',
  }));
  expectContractError(ACCOUNT_REMOVAL_ERROR_CODES.PREVIEW_CONTRACT_MISMATCH, () => createConfirm(preview, {
    requestedResourceIds: preview.plannedResources.map((resource) => resource.id),
  }));
  const changedEchoedObservations = clone(preview.resourceObservations);
  changedEchoedObservations[0].count += 1;
  expectContractError(ACCOUNT_REMOVAL_ERROR_CODES.SNAPSHOT_FINGERPRINT_MISMATCH, () => createConfirm(preview, {
    resourceObservations: changedEchoedObservations,
  }));
});

test('preview DTO shape validation turns missing, undefined, mistyped, and non-canonical fingerprint inputs into stable contract errors', () => {
  const preview = createObservedShopPreview('shop-a');
  const cases = [
    { field: 'plannedResources', wrongType: {} },
    { field: 'preserveResources', wrongType: {} },
    { field: 'resourceObservations', wrongType: {} },
    { field: 'requestedResourceIds', wrongType: {} },
    { field: 'version', wrongType: {} },
    { field: 'catalogVersion', wrongType: {} },
    { field: 'catalogFingerprint', wrongType: {} },
    { field: 'snapshotFingerprint', wrongType: {} },
    { field: 'previewFingerprint', wrongType: {} },
  ];

  function expectPreviewInvalid(action, label) {
    try {
      action();
      assert.fail(`${label} unexpectedly accepted`);
    } catch (error) {
      assert.ok(error instanceof AccountRemovalContractError, `${label} must not leak a native exception`);
      assert.equal(error.code, ACCOUNT_REMOVAL_ERROR_CODES.PREVIEW_INVALID, label);
    }
  }

  for (const { field, wrongType } of cases) {
    const variants = [
      {
        name: 'deleted',
        mutate(value) {
          delete value[field];
        },
      },
      {
        name: 'undefined',
        mutate(value) {
          value[field] = undefined;
        },
      },
      {
        name: 'wrong type',
        mutate(value) {
          value[field] = wrongType;
        },
      },
    ];
    for (const variant of variants) {
      const malformed = clone(preview);
      variant.mutate(malformed);
      const label = `${field} ${variant.name}`;
      expectPreviewInvalid(() => validateCanonicalAccountRemovalPreviewDto(malformed), `${label} validate`);
      expectPreviewInvalid(
        () => createAccountRemovalConfirmDto(confirmInput(malformed), malformed, confirmOptions(preview)),
        `${label} confirm`,
      );
      if (field !== 'previewFingerprint') {
        expectPreviewInvalid(() => createCanonicalAccountRemovalPreviewFingerprintShape(malformed), `${label} shape`);
        expectPreviewInvalid(() => createAccountRemovalPreviewFingerprint(malformed), `${label} fingerprint`);
      }
    }
  }

  const nonCanonical = clone(preview);
  nonCanonical.plannedResources[0].verifyQuery = { type: 'sqlite-count', table: undefined };
  expectPreviewInvalid(() => validateCanonicalAccountRemovalPreviewDto(nonCanonical), 'nested undefined validate');
  expectPreviewInvalid(() => createAccountRemovalPreviewFingerprint(nonCanonical), 'nested undefined fingerprint');
});

test('preview and result DTOs are recursively immutable and cloned nested tampering is revalidated', () => {
  const preview = createShopPreview('shop-a');
  assert.ok(Object.isFrozen(preview));
  assert.ok(Object.isFrozen(preview.plannedResources));
  assert.ok(Object.isFrozen(preview.plannedResources[0]));
  assert.ok(Object.isFrozen(preview.plannedResources[0].verifyQuery));
  assert.ok(Object.isFrozen(preview.resourceObservations));
  assert.throws(() => {
    preview.plannedResources[0].verifyQuery.type = 'tampered';
  }, TypeError);

  const clonedPreview = clone(preview);
  clonedPreview.plannedResources[0].verifyQuery.type = 'tampered';
  expectContractError(ACCOUNT_REMOVAL_ERROR_CODES.PREVIEW_CONTRACT_MISMATCH, () => createAccountRemovalConfirmDto(
    confirmInput(clonedPreview),
    clonedPreview,
    confirmOptions(preview),
  ));

  const confirm = createConfirm(preview);
  const result = createAccountRemovalResultDto(confirm, preview, confirmOptions(preview));
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.owner));
  assert.ok(Object.isFrozen(result.resourceObservations));
  assert.equal(result.mode, 'result-contract-only');
  assert.equal(result.completed, false);
  assert.equal(result.status, 'not-executed');
  expectContractError(ACCOUNT_REMOVAL_ERROR_CODES.RESULT_EXECUTION_FORBIDDEN, () => createAccountRemovalResultDto(
    { ...confirm, mode: 'executed' },
    preview,
    confirmOptions(preview),
  ));
});

test('snapshot contract represents explicit observations without fake zeroes and rejects changed current data', () => {
  const unobservedPreview = createShopPreview('shop-a');
  assert.ok(unobservedPreview.resourceObservations.every((item) => item.state === 'unobserved'));
  assert.ok(unobservedPreview.resourceObservations.every((item) => !Object.hasOwn(item, 'count')));

  const preview = createObservedShopPreview('shop-a');
  const confirm = createConfirm(preview);
  assert.deepEqual(confirm.resourceObservations, preview.resourceObservations);
  assert.equal(confirm.snapshotFingerprint, preview.snapshotFingerprint);

  expectContractError(ACCOUNT_REMOVAL_ERROR_CODES.RESOURCE_OBSERVATIONS_REQUIRED, () => createAccountRemovalConfirmDto(
    confirmInput(preview),
    preview,
  ));

  const changedCurrentObservations = clone(preview.resourceObservations);
  changedCurrentObservations[0].count += 1;
  const changedSnapshotFingerprint = createAccountRemovalSnapshotFingerprint({
    owner: preview.owner,
    catalogFingerprint: preview.catalogFingerprint,
    plannedResourceIds: preview.plannedResources.map((resource) => resource.id),
    resourceObservations: changedCurrentObservations,
  });
  expectContractError(ACCOUNT_REMOVAL_ERROR_CODES.SNAPSHOT_FINGERPRINT_MISMATCH, () => createAccountRemovalConfirmDto(
    confirmInput(preview, {
      resourceObservations: changedCurrentObservations,
      snapshotFingerprint: changedSnapshotFingerprint,
    }),
    preview,
    { currentResourceObservations: changedCurrentObservations },
  ));
  expectContractError(ACCOUNT_REMOVAL_ERROR_CODES.SNAPSHOT_FINGERPRINT_MISMATCH, () => createConfirm(preview, {
    snapshotFingerprint: '0'.repeat(64),
  }));
});

test('idempotency contracts are deterministic and detect same-key owner, preview, or snapshot conflicts without storage', () => {
  const previewA = createShopPreview('shop-a');
  const repeatedConfirms = Array.from({ length: 10 }, () => createConfirm(previewA));
  for (const confirm of repeatedConfirms) {
    assert.deepEqual(confirm, repeatedConfirms[0]);
  }
  assert.deepEqual(validateAccountRemovalIdempotencyReuse(repeatedConfirms[0], repeatedConfirms[1]), {
    idempotencyKey: repeatedConfirms[0].idempotencyKey,
    requestDigest: repeatedConfirms[0].requestDigest,
    idempotencyScope: repeatedConfirms[0].idempotencyScope,
    reused: true,
  });

  const key = repeatedConfirms[0].idempotencyKey;
  const previewOtherOwner = createShopPreview('shop-b');
  const otherOwnerConfirm = createConfirm(previewOtherOwner, { idempotencyKey: key });
  expectContractError(ACCOUNT_REMOVAL_ERROR_CODES.IDEMPOTENCY_KEY_CONFLICT, () => validateAccountRemovalIdempotencyReuse(
    repeatedConfirms[0],
    otherOwnerConfirm,
  ));
  expectContractError(ACCOUNT_REMOVAL_ERROR_CODES.IDEMPOTENCY_KEY_CONFLICT, () => createConfirm(previewOtherOwner, {
    idempotencyKey: key,
    idempotencyReference: repeatedConfirms[0],
  }));

  const fullAssertionPreview = createShopPreview('shop-a', {
    requestedResourceIds: [...previewA.plannedResources.map((entry) => entry.id)].reverse(),
  });
  const differentPreviewConfirm = createConfirm(fullAssertionPreview, { idempotencyKey: key });
  expectContractError(ACCOUNT_REMOVAL_ERROR_CODES.IDEMPOTENCY_KEY_CONFLICT, () => validateAccountRemovalIdempotencyReuse(
    repeatedConfirms[0],
    differentPreviewConfirm,
  ));

  const observedPreview = createObservedShopPreview('shop-a', {
    observationFixture: { countOffset: 7, revision: 'fixture-snapshot-a' },
  });
  const differentSnapshotConfirm = createConfirm(observedPreview, { idempotencyKey: key });
  expectContractError(ACCOUNT_REMOVAL_ERROR_CODES.IDEMPOTENCY_KEY_CONFLICT, () => validateAccountRemovalIdempotencyReuse(
    repeatedConfirms[0],
    differentSnapshotConfirm,
  ));
});

test('account removal has one static local executor and one preview-confirm-readback entry path', () => {
  const productionDomainFiles = readdirSync(accountRemovalDirectory)
    .filter((name) => name.endsWith('.js') && !name.endsWith('.test.js'))
    .map((name) => resolve(accountRemovalDirectory, name));
  const sources = productionDomainFiles.map((filePath) => ({
    filePath,
    source: readFileSync(filePath, 'utf8'),
  }));

  const sqlDeleteFiles = sources
    .filter(({ source }) => /\bDELETE\s+FROM\b/iu.test(source))
    .map(({ filePath }) => filePath);
  assert.deepEqual(sqlDeleteFiles, [resolve(accountRemovalDirectory, 'accountRemovalSqliteExecutor.js')]);
  for (const { filePath, source } of sources) {
    assert.doesNotMatch(source, /\bfrom\s*['"](?:axios|node:)?https?['"]/iu, `${filePath} must not import an HTTP client`);
    assert.doesNotMatch(source, /\b(?:fetch|axios|httpClient)\s*\(/iu, `${filePath} must not make an external request`);
    assert.doesNotMatch(source, /\b(?:ipcMain|ipcRenderer|contextBridge)\b/u, `${filePath} must not bypass the local-api boundary through IPC`);
  }

  const sqliteCatalog = readFileSync(resolve(accountRemovalDirectory, 'accountRemovalSqliteCatalog.js'), 'utf8');
  const sqliteExecutor = readFileSync(resolve(accountRemovalDirectory, 'accountRemovalSqliteExecutor.js'), 'utf8');
  assert.match(sqliteCatalog, /ACCOUNT_REMOVAL_SQLITE_RESOURCES/u);
  assert.doesNotMatch(sqliteCatalog, /(?:prepare|exec)\s*\([^)]*sqlite_master/isu);
  assert.doesNotMatch(sqliteExecutor, /(?:prepare|exec)\s*\([^)]*sqlite_master/isu);
  assert.match(sqliteExecutor, /getAccountRemovalSqliteResources\(owner\.ownerType\)/u);
  assert.match(sqliteExecutor, /PRAGMA\s+secure_delete\s*=\s*ON/iu);
  assert.match(sqliteExecutor, /PRAGMA\s+wal_checkpoint\(TRUNCATE\)/iu);

  const route = readFileSync(resolve(localApiRoot, 'src/app/accountRemovalRoute.js'), 'utf8');
  for (const endpoint of [
    '/api/account-removal/preview',
    '/api/account-removal/confirm',
    '/api/account-removal/client-verify',
    '/api/account-removal/recover',
    '/api/account-removal/recover-direct',
    '/api/account-removal/pending',
  ]) {
    assert.match(route, new RegExp(endpoint.replaceAll('/', '\\/'), 'u'));
  }
  assert.match(route, /LEGACY_DELETE_ROUTES/u);
  assert.match(route, /LEGACY_ROUTE_PREVIEW_REQUIRED/u);
  assert.match(route, /createJsonResponse\(res,\s*409/iu);

  const rendererClient = readFileSync(resolve(
    workspaceRoot,
    'frontend/src/features/settings/accountRemoval/services/accountRemovalClient.js',
  ), 'utf8');
  assert.doesNotMatch(rendererClient, /method:\s*['"]DELETE['"]/u);
  const rendererPaths = [...rendererClient.matchAll(/['"](\/api\/[^'"]+)['"]/gu)].map((match) => match[1]);
  assert.ok(rendererPaths.length >= 5);
  assert.ok(rendererPaths.every((path) => path.startsWith('/api/account-removal/')));

  for (const relativePath of [
    'frontend/src/App.jsx',
    'frontend/src/features/settings/StructuredSettingsLayout.jsx',
    'frontend/src/features/settings/ModelApiSettingsPanel.jsx',
  ]) {
    const source = readFileSync(resolve(workspaceRoot, relativePath), 'utf8');
    assert.match(source, /useAccountRemovalFlow/u, `${relativePath} must use the unified flow`);
    assert.match(source, /AccountRemovalPreviewDialog/u, `${relativePath} must render the preview dialog`);
  }

  const legacyClient = readFileSync(resolve(workspaceRoot, 'frontend/src/api/localApiClient.js'), 'utf8');
  for (const helper of [
    'deleteCrossBorderAccount',
    'deleteLocalShop',
    'deletePurchaseAccount',
    'deleteModelApiAccount',
    'deletePerformanceAccount',
    'deleteIntegrationProfile',
  ]) {
    const start = legacyClient.indexOf(`export function ${helper}(`);
    const end = start < 0 ? -1 : legacyClient.indexOf('\n}\n', start);
    const body = start < 0 || end < 0 ? '' : legacyClient.slice(start, end + 2);
    assert.match(body, /ACCOUNT_REMOVAL_UNIFIED_FLOW_REQUIRED/u, `${helper} must fail closed`);
    assert.doesNotMatch(body, /requestLocalApi\s*\(/u, `${helper} must not issue a legacy DELETE`);
  }

  for (const relativePath of [
    'src/db/repositories/shopRepository.js',
    'src/db/repositories/crossBorderAccountRepository.js',
    'src/db/repositories/purchaseAccountRepository.js',
    'src/db/repositories/performanceAccountRepository.js',
    'src/db/repositories/modelApiAccountRepository.js',
    'src/db/repositories/integrationProfileRepository.js',
  ]) {
    const source = readFileSync(resolve(localApiRoot, relativePath), 'utf8');
    assert.match(source, /ACCOUNT_REMOVAL_LEGACY_PRIMITIVE_DISABLED/u, `${relativePath} must disable direct account deletion`);
  }
});
