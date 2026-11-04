import { createHash } from 'node:crypto';
import {
  ACCOUNT_OWNERSHIP_CATALOG,
  ACCOUNT_OWNERSHIP_CATALOG_VERSION,
  ACCOUNT_OWNER_TYPES,
  validateAccountOwnershipCatalog,
} from './accountOwnershipCatalog.js';
import { ACCOUNT_REMOVAL_ERROR_CODES, failAccountRemovalContract } from './accountRemovalErrors.js';

export const ACCOUNT_REMOVAL_CONTRACT_VERSION = 'account-removal-contract-v4';
export const ACCOUNT_REMOVAL_SNAPSHOT_VERSION = 'account-removal-snapshot-v2';
export const ACCOUNT_REMOVAL_REQUESTED_RESOURCE_IDS_SEMANTICS = 'assertion-allowlist';
export const ACCOUNT_REMOVAL_OBSERVATION_STATES = Object.freeze(['unobserved', 'observed', 'absent']);
export const ACCOUNT_REMOVAL_SAFETY_BARRIER_VERSION = 'account-removal-safety-barriers-v1';

const REMOVABLE_OWNER_TYPES = new Set(
  ACCOUNT_OWNER_TYPES.filter((ownerType) => !['system', 'unknown'].includes(ownerType)),
);
const OWNER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const RESOURCE_ID_PATTERN = /^[A-Za-z][A-Za-z0-9:_-]{0,255}$/u;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_OBSERVATION_TEXT_LENGTH = 512;
const OBSERVATION_STATE_SET = new Set(ACCOUNT_REMOVAL_OBSERVATION_STATES);

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  Object.values(value).forEach((child) => deepFreeze(child, seen));
  return Object.freeze(value);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function stableJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  throw new TypeError('ACCOUNT_REMOVAL_CONTRACT_NON_CANONICAL_VALUE');
}

function hash(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function sameCanonicalValue(left, right) {
  return stableJson(left) === stableJson(right);
}

function sameOwner(left = {}, right = {}) {
  return left.ownerType === right.ownerType && left.ownerId === right.ownerId;
}

function failIfNotPlainInput(value, code = ACCOUNT_REMOVAL_ERROR_CODES.PREVIEW_INVALID) {
  if (!isPlainObject(value)) failAccountRemovalContract(code);
  return value;
}

function isAccountRemovalContractError(error) {
  return error?.name === 'AccountRemovalContractError' && typeof error.code === 'string';
}

function withContractBoundary(code, action) {
  try {
    return action();
  } catch (error) {
    if (isAccountRemovalContractError(error)) throw error;
    failAccountRemovalContract(code);
  }
}

function readContractProperty(value, key, code) {
  return withContractBoundary(code, () => value[key]);
}

function hasContractProperty(value, key, code) {
  return withContractBoundary(code, () => Object.prototype.hasOwnProperty.call(value, key));
}

const PREVIEW_FINGERPRINT_FIELDS = Object.freeze([
  'version',
  'mode',
  'completed',
  'owner',
  'requestedOwnerType',
  'requestedOwnerId',
  'requestedResourceIdsSemantics',
  'requestedResourceIds',
  'catalogVersion',
  'catalogFingerprint',
  'resourceObservations',
  'snapshotFingerprint',
  'plannedResources',
  'preserveResources',
  'quiesceResources',
  'fenceResources',
  'drainResources',
]);
const PREVIEW_DTO_FIELDS = Object.freeze([...PREVIEW_FINGERPRINT_FIELDS, 'previewFingerprint']);

function withPreviewContractBoundary(action) {
  try {
    return action();
  } catch (error) {
    if (isAccountRemovalContractError(error)) throw error;
    failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.PREVIEW_INVALID);
  }
}

function isCanonicalJsonContractValue(value, seen = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  if (!Array.isArray(value) && !isPlainObject(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index) || !isCanonicalJsonContractValue(value[index], seen)) return false;
    }
    return Object.getOwnPropertySymbols(value).length === 0;
  }
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set || !isCanonicalJsonContractValue(descriptor.value, seen)) return false;
  }
  return true;
}

function hasExactPreviewFields(preview, requiredFields, allowedFields = requiredFields) {
  const allowed = new Set(allowedFields);
  return Object.keys(preview).every((key) => allowed.has(key))
    && requiredFields.every((field) => Object.prototype.hasOwnProperty.call(preview, field) && preview[field] !== undefined);
}

function validatePreviewFingerprintShape(preview, { requirePreviewFingerprint = false } = {}) {
  return withPreviewContractBoundary(() => {
    failIfNotPlainInput(preview);
    const fields = requirePreviewFingerprint ? PREVIEW_DTO_FIELDS : PREVIEW_FINGERPRINT_FIELDS;
    if (!hasExactPreviewFields(preview, fields, PREVIEW_DTO_FIELDS)) {
      failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.PREVIEW_INVALID);
    }
    if (
      typeof preview.version !== 'string'
      || typeof preview.mode !== 'string'
      || typeof preview.completed !== 'boolean'
      || !isPlainObject(preview.owner)
      || typeof preview.requestedOwnerType !== 'string'
      || typeof preview.requestedOwnerId !== 'string'
      || typeof preview.requestedResourceIdsSemantics !== 'string'
      || !Array.isArray(preview.requestedResourceIds)
      || typeof preview.catalogVersion !== 'string'
      || typeof preview.catalogFingerprint !== 'string'
      || !Array.isArray(preview.resourceObservations)
      || typeof preview.snapshotFingerprint !== 'string'
      || !Array.isArray(preview.plannedResources)
      || !Array.isArray(preview.preserveResources)
      || !Array.isArray(preview.quiesceResources)
      || !Array.isArray(preview.fenceResources)
      || !Array.isArray(preview.drainResources)
      || (requirePreviewFingerprint && typeof preview.previewFingerprint !== 'string')
      || !isCanonicalJsonContractValue(preview)
    ) {
      failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.PREVIEW_INVALID);
    }
    return preview;
  });
}

function normalizeOwnerType(value) {
  if (typeof value !== 'string') failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.OWNER_TYPE_INVALID);
  // Owner scope is an authorization boundary.  Do not turn a distinct raw
  // client value (for example, " shop") into an accepted owner by trimming.
  if (value !== value.trim()) failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.OWNER_TYPE_INVALID);
  const ownerType = value;
  if (!REMOVABLE_OWNER_TYPES.has(ownerType)) {
    if (ownerType === 'system') failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.SYSTEM_OWNER_PROTECTED);
    failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.OWNER_TYPE_INVALID);
  }
  return ownerType;
}

function normalizeOwnerId(value) {
  if (value === undefined || value === '') {
    failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.OWNER_ID_REQUIRED);
  }
  if (typeof value !== 'string') failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.OWNER_ID_INVALID);
  // Preserve the exact scope assertion: whitespace, wildcard, control, NUL,
  // and overlong identifiers are never silently normalized into another ID.
  if (value !== value.trim() || value.length > 128 || /[\u0000-\u001F\u007F*?%\[\]]/u.test(value)) {
    failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.OWNER_ID_INVALID);
  }
  const ownerId = value;
  if (!OWNER_ID_PATTERN.test(ownerId)) failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.OWNER_ID_INVALID);
  return ownerId;
}

function normalizeDigest(value, { requiredCode, mismatchCode }) {
  if (value === undefined || value === null || value === '') {
    failAccountRemovalContract(requiredCode);
  }
  if (typeof value !== 'string' || !FINGERPRINT_PATTERN.test(value)) {
    failAccountRemovalContract(mismatchCode);
  }
  return value;
}

function normalizeResourceId(value, code = ACCOUNT_REMOVAL_ERROR_CODES.REQUESTED_RESOURCES_INVALID) {
  if (typeof value !== 'string') failAccountRemovalContract(code);
  const id = value.trim();
  if (!RESOURCE_ID_PATTERN.test(id)) failAccountRemovalContract(code);
  return id;
}

function normalizeObservationText(value) {
  if (typeof value !== 'string') failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.RESOURCE_OBSERVATIONS_INVALID);
  const text = value.trim();
  if (!text || text.length > MAX_OBSERVATION_TEXT_LENGTH || /[\u0000-\u001F\u007F]/u.test(text)) {
    failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.RESOURCE_OBSERVATIONS_INVALID);
  }
  return text;
}

function assertCurrentContractVersion(value) {
  if (value !== ACCOUNT_REMOVAL_CONTRACT_VERSION) {
    failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.CONTRACT_VERSION_MISMATCH);
  }
}

function assertCurrentCatalogVersion(value) {
  if (value !== ACCOUNT_OWNERSHIP_CATALOG_VERSION) {
    failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.CATALOG_VERSION_MISMATCH);
  }
}

function validateCatalog(catalog) {
  try {
    validateAccountOwnershipCatalog(catalog);
  } catch (error) {
    failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.CATALOG_INVALID, error?.message);
  }
  return catalog;
}

function normalizeOwnerScopeAssertion(input, owner, { required }) {
  const hasOwnerType = hasContractProperty(input, 'requestedOwnerType', ACCOUNT_REMOVAL_ERROR_CODES.OWNER_SCOPE_ASSERTION_REQUIRED);
  const hasOwnerId = hasContractProperty(input, 'requestedOwnerId', ACCOUNT_REMOVAL_ERROR_CODES.OWNER_SCOPE_ASSERTION_REQUIRED);
  if (!hasOwnerType && !hasOwnerId) {
    if (required) failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.OWNER_SCOPE_ASSERTION_REQUIRED);
    return owner;
  }
  if (!hasOwnerType || !hasOwnerId) {
    failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.OWNER_SCOPE_ASSERTION_REQUIRED);
  }
  const assertedOwner = validateAccountRemovalOwner({
    ownerType: readContractProperty(input, 'requestedOwnerType', ACCOUNT_REMOVAL_ERROR_CODES.OWNER_TYPE_INVALID),
    ownerId: readContractProperty(input, 'requestedOwnerId', ACCOUNT_REMOVAL_ERROR_CODES.OWNER_ID_INVALID),
  });
  if (!sameOwner(assertedOwner, owner)) {
    failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.CROSS_OWNER_SCOPE);
  }
  return assertedOwner;
}

function resourceContract(entry) {
  return {
    id: entry.id,
    storageKind: entry.storageKind,
    resource: entry.resource,
    scopeType: entry.scopeType,
    ownerType: entry.ownerType,
    ownerField: entry.ownerField,
    deletePrimitive: entry.deletePrimitive,
    verifyQuery: cloneJson(entry.verifyQuery),
    preserveRule: entry.preserveRule,
    backupRule: entry.backupRule,
    risk: entry.risk,
    removable: entry.removable === true,
    availability: entry.availability,
    executionGroup: entry.executionGroup || null,
    sourceRegistryDomain: entry.sourceRegistryDomain || null,
    sourceProtocolKey: entry.sourceProtocolKey || null,
    directory: entry.directory || null,
    fileName: entry.fileName || null,
    relativePath: entry.relativePath || null,
    sourceEvidence: entry.sourceEvidence ? cloneJson(entry.sourceEvidence) : null,
    coverageAudit: entry.coverageAudit === true,
  };
}

const SHARED_SAFETY_BARRIERS = Object.freeze([
  {
    resourceId: 'runtime:desktop-recovery-auto-backup-scheduler',
    ownerTypes: ['ozon_shop', 'cross_border_bus', 'promotion_account', 'purchase_account', 'model_api_account', 'integration_profile'],
    fenceAction: 'fence-profile-backup-publication',
    drainAction: 'await-active-backup-publication',
  },
  {
    resourceId: 'runtime:renderer-marketing-view-state-write-queue',
    ownerTypes: ['ozon_shop'],
    fenceAction: 'fence-owner-write-publication',
    drainAction: 'await-shared-write-pipeline',
  },
  {
    resourceId: 'runtime:renderer-product-material-profile-write-queue',
    ownerTypes: ['ozon_shop'],
    fenceAction: 'fence-owner-write-publication',
    drainAction: 'await-shared-write-pipeline',
  },
  {
    resourceId: 'runtime:renderer-product-source-link-migration',
    ownerTypes: ['ozon_shop'],
    fenceAction: 'fence-owner-migration-publication',
    drainAction: 'await-shared-migration',
  },
  {
    resourceId: 'runtime:renderer-sales-source-link-migration',
    ownerTypes: ['ozon_shop'],
    fenceAction: 'fence-owner-migration-publication',
    drainAction: 'await-shared-migration',
  },
  {
    resourceId: 'runtime:renderer-purchase-source-link-migration',
    ownerTypes: ['ozon_shop'],
    fenceAction: 'fence-owner-migration-publication',
    drainAction: 'await-shared-migration',
  },
  {
    resourceId: 'runtime:renderer-ozon-shop-settings-write-queue',
    ownerTypes: ['ozon_shop'],
    fenceAction: 'fence-owner-settings-publication',
    drainAction: 'await-shared-write-pipeline',
  },
  {
    resourceId: 'runtime:renderer-purchase-plugin-context-write-queue',
    ownerTypes: ['ozon_shop', 'purchase_account'],
    fenceAction: 'fence-owner-context-publication',
    drainAction: 'await-shared-write-pipeline',
  },
  {
    resourceId: 'runtime:local-api-performance-request-queue',
    ownerTypes: ['promotion_account'],
    fenceAction: 'fence-account-request-admission',
    drainAction: 'await-account-performance-queue',
  },
]);

function safetyBarrierContract(entry, owner, action, requiredReadback) {
  return {
    resourceId: entry.id,
    ownerApplicability: {
      ownerType: owner.ownerType,
      ownerIdBinding: 'exact-request-owner',
    },
    action,
    requiredReadback,
  };
}

function buildCanonicalSafetyBarriers(owner, allResources, plannedResources) {
  const allById = new Map(allResources.map((entry) => [entry.id, entry]));
  const quiesceResources = plannedResources
    .filter((entry) => entry.storageKind === 'runtime')
    .map((entry) => safetyBarrierContract(
      entry,
      owner,
      entry.deletePrimitive,
      cloneJson(entry.verifyQuery),
    ))
    .sort((left, right) => left.resourceId.localeCompare(right.resourceId));
  const applicable = SHARED_SAFETY_BARRIERS
    .filter((definition) => definition.ownerTypes.includes(owner.ownerType))
    .map((definition) => ({ definition, entry: allById.get(definition.resourceId) }))
    .filter(({ entry }) => Boolean(entry));
  const fenceResources = applicable
    .map(({ definition, entry }) => safetyBarrierContract(
      entry,
      owner,
      definition.fenceAction,
      { type: 'barrier-state', expected: 'owner-write-fenced' },
    ))
    .sort((left, right) => left.resourceId.localeCompare(right.resourceId));
  const drainResources = applicable
    .map(({ definition, entry }) => safetyBarrierContract(
      entry,
      owner,
      definition.drainAction,
      { type: 'barrier-state', expected: 'settled-and-owner-write-fenced' },
    ))
    .sort((left, right) => left.resourceId.localeCompare(right.resourceId));
  return { quiesceResources, fenceResources, drainResources };
}

function buildCanonicalPlan(owner, catalog) {
  const allResources = catalog.map(resourceContract).sort((left, right) => left.id.localeCompare(right.id));
  const plannedResources = allResources.filter(
    (entry) => entry.ownerType === owner.ownerType && entry.removable === true && entry.availability === 'current',
  );
  const plannedIds = new Set(plannedResources.map((entry) => entry.id));
  const preserveResources = allResources.filter((entry) => !plannedIds.has(entry.id));
  return {
    allResources,
    plannedResources,
    preserveResources,
    plannedResourceIds: [...plannedIds].sort(),
    ...buildCanonicalSafetyBarriers(owner, allResources, plannedResources),
  };
}

function canonicalizeRequestedResourceIds(value, plan, { required }) {
  if (value === undefined) {
    if (required) failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.REQUESTED_RESOURCES_INVALID);
    return [];
  }
  if (!Array.isArray(value)) failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.REQUESTED_RESOURCES_INVALID);
  const allById = new Map(plan.allResources.map((entry) => [entry.id, entry]));
  const plannedIds = new Set(plan.plannedResourceIds);
  const ids = [...new Set(value.map((item) => normalizeResourceId(item)))].sort();
  for (const id of ids) {
    const entry = allById.get(id);
    if (!entry) failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.RESOURCE_UNREGISTERED);
    if (!plannedIds.has(id)) failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.CROSS_OWNER_SCOPE);
  }
  if (ids.length && !sameCanonicalValue(ids, plan.plannedResourceIds)) {
    failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.REQUESTED_RESOURCES_ASSERTION_MISMATCH);
  }
  return ids;
}

/**
 * Canonical resource observations are injected by a future read-only planner.
 * `unobserved` is an explicit Phase B placeholder state, never a fabricated
 * zero/count result. Every currently planned resource must have exactly one
 * observation so a later planner can replace only this injection point.
 */
export function canonicalizeResourceObservations(
  value,
  plannedResourceIds = [],
  { allowDefault = false, required = false } = {},
) {
  return withContractBoundary(ACCOUNT_REMOVAL_ERROR_CODES.RESOURCE_OBSERVATIONS_INVALID, () => {
  const plannedIds = [...new Set((Array.isArray(plannedResourceIds) ? plannedResourceIds : []).map((id) => normalizeResourceId(id)))].sort();
  if (value === undefined) {
    if (allowDefault) {
      return plannedIds.map((resourceId) => ({ resourceId, state: 'unobserved' }));
    }
    if (required) failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.RESOURCE_OBSERVATIONS_REQUIRED);
    failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.RESOURCE_OBSERVATIONS_INVALID);
  }
  if (!Array.isArray(value)) failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.RESOURCE_OBSERVATIONS_INVALID);
  const expectedIds = new Set(plannedIds);
  const seenIds = new Set();
  const observations = value.map((raw) => {
    if (!isPlainObject(raw)) failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.RESOURCE_OBSERVATIONS_INVALID);
    const resourceId = normalizeResourceId(raw.resourceId, ACCOUNT_REMOVAL_ERROR_CODES.RESOURCE_OBSERVATIONS_INVALID);
    if (!expectedIds.has(resourceId) || seenIds.has(resourceId)) {
      failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.RESOURCE_OBSERVATIONS_INVALID);
    }
    seenIds.add(resourceId);
    if (typeof raw.state !== 'string' || !OBSERVATION_STATE_SET.has(raw.state)) {
      failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.RESOURCE_OBSERVATIONS_INVALID);
    }
    const allowedKeys = new Set(['resourceId', 'state', 'count', 'revision', 'hash']);
    if (Object.keys(raw).some((key) => !allowedKeys.has(key))) {
      failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.RESOURCE_OBSERVATIONS_INVALID);
    }
    if (raw.state === 'unobserved' || raw.state === 'absent') {
      if (Object.prototype.hasOwnProperty.call(raw, 'count') || Object.prototype.hasOwnProperty.call(raw, 'revision') || Object.prototype.hasOwnProperty.call(raw, 'hash')) {
        failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.RESOURCE_OBSERVATIONS_INVALID);
      }
      return { resourceId, state: raw.state };
    }
    const observation = { resourceId, state: 'observed' };
    let observedFieldCount = 0;
    if (Object.prototype.hasOwnProperty.call(raw, 'count')) {
      if (!Number.isSafeInteger(raw.count) || raw.count < 0) {
        failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.RESOURCE_OBSERVATIONS_INVALID);
      }
      observation.count = raw.count;
      observedFieldCount += 1;
    }
    if (Object.prototype.hasOwnProperty.call(raw, 'revision')) {
      observation.revision = normalizeObservationText(raw.revision);
      observedFieldCount += 1;
    }
    if (Object.prototype.hasOwnProperty.call(raw, 'hash')) {
      if (typeof raw.hash !== 'string' || !FINGERPRINT_PATTERN.test(raw.hash)) {
        failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.RESOURCE_OBSERVATIONS_INVALID);
      }
      observation.hash = raw.hash;
      observedFieldCount += 1;
    }
    if (!observedFieldCount) failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.RESOURCE_OBSERVATIONS_INVALID);
    return observation;
  }).sort((left, right) => left.resourceId.localeCompare(right.resourceId));
  if (observations.length !== plannedIds.length || observations.some((entry, index) => entry.resourceId !== plannedIds[index])) {
    failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.RESOURCE_OBSERVATIONS_INVALID);
  }
  return observations;
  });
}

function canonicalizeSnapshotResourceIds(value) {
  if (!Array.isArray(value)) failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.RESOURCE_OBSERVATIONS_INVALID);
  return [...new Set(value.map((resourceId) => normalizeResourceId(resourceId, ACCOUNT_REMOVAL_ERROR_CODES.RESOURCE_OBSERVATIONS_INVALID)))].sort();
}

export function createAccountRemovalSnapshotFingerprint({
  contractVersion = ACCOUNT_REMOVAL_CONTRACT_VERSION,
  owner,
  catalogFingerprint,
  plannedResourceIds,
  resourceObservations,
} = {}) {
  assertCurrentContractVersion(contractVersion);
  const canonicalOwner = validateAccountRemovalOwner(owner);
  const canonicalCatalogFingerprint = normalizeDigest(catalogFingerprint, {
    requiredCode: ACCOUNT_REMOVAL_ERROR_CODES.SNAPSHOT_FINGERPRINT_REQUIRED,
    mismatchCode: ACCOUNT_REMOVAL_ERROR_CODES.SNAPSHOT_FINGERPRINT_MISMATCH,
  });
  const canonicalPlannedResourceIds = canonicalizeSnapshotResourceIds(plannedResourceIds);
  const canonicalObservations = canonicalizeResourceObservations(
    resourceObservations,
    canonicalPlannedResourceIds,
    { required: true },
  );
  return hash({
    snapshotVersion: ACCOUNT_REMOVAL_SNAPSHOT_VERSION,
    contractVersion: ACCOUNT_REMOVAL_CONTRACT_VERSION,
    owner: canonicalOwner,
    catalogFingerprint: canonicalCatalogFingerprint,
    plannedResourceIds: canonicalPlannedResourceIds,
    resourceObservations: canonicalObservations,
  });
}

function catalogFingerprintShape(catalog = []) {
  return [...catalog]
    .map((entry) => ({
      id: entry.id,
      storageKind: entry.storageKind,
      resource: entry.resource,
      scopeType: entry.scopeType,
      ownerType: entry.ownerType,
      ownerField: entry.ownerField,
      deletePrimitive: entry.deletePrimitive,
      verifyQuery: entry.verifyQuery,
      preserveRule: entry.preserveRule,
      backupRule: entry.backupRule,
      risk: entry.risk,
      removable: entry.removable,
      availability: entry.availability,
      executionGroup: entry.executionGroup || null,
      sourceRegistryDomain: entry.sourceRegistryDomain || null,
      sourceProtocolKey: entry.sourceProtocolKey || null,
      directory: entry.directory || null,
      fileName: entry.fileName || null,
      relativePath: entry.relativePath || null,
      sourceEvidence: entry.sourceEvidence || null,
      coverageAudit: entry.coverageAudit === true,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function createAccountOwnershipCatalogFingerprint(catalog = ACCOUNT_OWNERSHIP_CATALOG) {
  validateCatalog(catalog);
  return hash({ catalogVersion: ACCOUNT_OWNERSHIP_CATALOG_VERSION, entries: catalogFingerprintShape(catalog) });
}

export function validateAccountRemovalOwner(owner = {}) {
  if (!isPlainObject(owner)) failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.OWNER_TYPE_INVALID);
  const ownerType = readContractProperty(owner, 'ownerType', ACCOUNT_REMOVAL_ERROR_CODES.OWNER_TYPE_INVALID);
  const ownerId = readContractProperty(owner, 'ownerId', ACCOUNT_REMOVAL_ERROR_CODES.OWNER_ID_INVALID);
  return deepFreeze({
    ownerType: normalizeOwnerType(ownerType),
    ownerId: normalizeOwnerId(ownerId),
  });
}

function buildCanonicalPreview({
  owner: rawOwner,
  scopeInput,
  requestedResourceIds,
  resourceObservations,
  allowDefaultObservations,
  requiredRequestedResources,
}, catalog) {
  const owner = validateAccountRemovalOwner(rawOwner);
  const scope = normalizeOwnerScopeAssertion(scopeInput, owner, { required: false });
  const catalogFingerprint = createAccountOwnershipCatalogFingerprint(catalog);
  const plan = buildCanonicalPlan(owner, catalog);
  const canonicalRequestedResourceIds = canonicalizeRequestedResourceIds(requestedResourceIds, plan, {
    required: requiredRequestedResources,
  });
  const canonicalObservations = canonicalizeResourceObservations(
    resourceObservations,
    plan.plannedResourceIds,
    { allowDefault: allowDefaultObservations, required: !allowDefaultObservations },
  );
  const snapshotFingerprint = createAccountRemovalSnapshotFingerprint({
    owner,
    catalogFingerprint,
    plannedResourceIds: plan.plannedResourceIds,
    resourceObservations: canonicalObservations,
  });
  const preview = {
    version: ACCOUNT_REMOVAL_CONTRACT_VERSION,
    mode: 'preview-only',
    completed: false,
    owner,
    requestedOwnerType: scope.ownerType,
    requestedOwnerId: scope.ownerId,
    requestedResourceIdsSemantics: ACCOUNT_REMOVAL_REQUESTED_RESOURCE_IDS_SEMANTICS,
    requestedResourceIds: canonicalRequestedResourceIds,
    catalogVersion: ACCOUNT_OWNERSHIP_CATALOG_VERSION,
    catalogFingerprint,
    resourceObservations: canonicalObservations,
    snapshotFingerprint,
    plannedResources: plan.plannedResources,
    preserveResources: plan.preserveResources,
    quiesceResources: plan.quiesceResources,
    fenceResources: plan.fenceResources,
    drainResources: plan.drainResources,
  };
  preview.previewFingerprint = createAccountRemovalPreviewFingerprint(preview);
  return deepFreeze(preview);
}

/** Returns the complete, ordered shape that is hashed for a canonical preview. */
export function createCanonicalAccountRemovalPreviewFingerprintShape(preview = {}) {
  return withPreviewContractBoundary(() => {
    validatePreviewFingerprintShape(preview);
    return cloneJson({
      contractVersion: preview.version,
      mode: preview.mode,
      completed: preview.completed,
      owner: preview.owner,
      requestedOwnerType: preview.requestedOwnerType,
      requestedOwnerId: preview.requestedOwnerId,
      requestedResourceIdsSemantics: preview.requestedResourceIdsSemantics,
      requestedResourceIds: preview.requestedResourceIds,
      catalogVersion: preview.catalogVersion,
      catalogFingerprint: preview.catalogFingerprint,
      resourceObservations: preview.resourceObservations,
      snapshotFingerprint: preview.snapshotFingerprint,
      plannedResources: preview.plannedResources,
      preserveResources: preview.preserveResources,
      quiesceResources: preview.quiesceResources,
      fenceResources: preview.fenceResources,
      drainResources: preview.drainResources,
    });
  });
}

export function createAccountRemovalPreviewFingerprint(preview = {}) {
  return hash(createCanonicalAccountRemovalPreviewFingerprintShape(preview));
}

/**
 * Rebuilds a preview solely from current catalog contracts plus its normalized
 * owner/assertion/observation inputs. It never reads SQLite or starts work.
 */
export function createAccountRemovalPreviewDto(input = {}, {
  catalog = ACCOUNT_OWNERSHIP_CATALOG,
  resourceObservations,
} = {}) {
  failIfNotPlainInput(input);
  validateCatalog(catalog);
  return buildCanonicalPreview({
    owner: readContractProperty(input, 'owner', ACCOUNT_REMOVAL_ERROR_CODES.PREVIEW_INVALID),
    scopeInput: input,
    requestedResourceIds: readContractProperty(input, 'requestedResourceIds', ACCOUNT_REMOVAL_ERROR_CODES.REQUESTED_RESOURCES_INVALID),
    resourceObservations,
    allowDefaultObservations: true,
    requiredRequestedResources: false,
  }, catalog);
}

/**
 * Validates every client-echoed preview field against a freshly rebuilt
 * canonical contract. This does not treat Object.freeze or a supplied digest
 * as proof; arrays and nested verify contracts are compared structurally.
 */
export function validateCanonicalAccountRemovalPreviewDto(preview = {}, {
  catalog = ACCOUNT_OWNERSHIP_CATALOG,
} = {}) {
  validatePreviewFingerprintShape(preview, { requirePreviewFingerprint: true });
  validateCatalog(catalog);
  assertCurrentContractVersion(preview.version);
  assertCurrentCatalogVersion(preview.catalogVersion);
  if (preview.mode !== 'preview-only' || preview.completed !== false) {
    failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.PREVIEW_CONTRACT_MISMATCH);
  }
  if (preview.requestedResourceIdsSemantics !== ACCOUNT_REMOVAL_REQUESTED_RESOURCE_IDS_SEMANTICS) {
    failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.PREVIEW_CONTRACT_MISMATCH);
  }
  const canonical = buildCanonicalPreview({
    owner: preview.owner,
    scopeInput: preview,
    requestedResourceIds: preview.requestedResourceIds,
    resourceObservations: preview.resourceObservations,
    allowDefaultObservations: false,
    requiredRequestedResources: true,
  }, catalog);
  const previewCatalogFingerprint = normalizeDigest(preview.catalogFingerprint, {
    requiredCode: ACCOUNT_REMOVAL_ERROR_CODES.CATALOG_FINGERPRINT_MISMATCH,
    mismatchCode: ACCOUNT_REMOVAL_ERROR_CODES.CATALOG_FINGERPRINT_MISMATCH,
  });
  if (previewCatalogFingerprint !== canonical.catalogFingerprint) {
    failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.CATALOG_FINGERPRINT_MISMATCH);
  }
  const previewSnapshotFingerprint = normalizeDigest(preview.snapshotFingerprint, {
    requiredCode: ACCOUNT_REMOVAL_ERROR_CODES.SNAPSHOT_FINGERPRINT_REQUIRED,
    mismatchCode: ACCOUNT_REMOVAL_ERROR_CODES.SNAPSHOT_FINGERPRINT_MISMATCH,
  });
  if (previewSnapshotFingerprint !== canonical.snapshotFingerprint) {
    failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.SNAPSHOT_FINGERPRINT_MISMATCH);
  }
  if (
    !sameCanonicalValue(preview.owner, canonical.owner)
    || preview.requestedOwnerType !== canonical.requestedOwnerType
    || preview.requestedOwnerId !== canonical.requestedOwnerId
    || !sameCanonicalValue(preview.requestedResourceIds, canonical.requestedResourceIds)
    || !sameCanonicalValue(preview.resourceObservations, canonical.resourceObservations)
    || !sameCanonicalValue(preview.plannedResources, canonical.plannedResources)
    || !sameCanonicalValue(preview.preserveResources, canonical.preserveResources)
    || !sameCanonicalValue(preview.quiesceResources, canonical.quiesceResources)
    || !sameCanonicalValue(preview.fenceResources, canonical.fenceResources)
    || !sameCanonicalValue(preview.drainResources, canonical.drainResources)
  ) {
    failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.PREVIEW_CONTRACT_MISMATCH);
  }
  const previewFingerprint = normalizeDigest(preview.previewFingerprint, {
    requiredCode: ACCOUNT_REMOVAL_ERROR_CODES.PREVIEW_FINGERPRINT_REQUIRED,
    mismatchCode: ACCOUNT_REMOVAL_ERROR_CODES.PREVIEW_FINGERPRINT_MISMATCH,
  });
  if (previewFingerprint !== canonical.previewFingerprint) {
    failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.PREVIEW_FINGERPRINT_MISMATCH);
  }
  return canonical;
}

function validateIdempotencyKey(value) {
  if (value === undefined || value === null || value === '') {
    failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED);
  }
  if (typeof value !== 'string') failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.IDEMPOTENCY_KEY_INVALID);
  if (value !== value.trim()) failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.IDEMPOTENCY_KEY_INVALID);
  const key = value;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{15,160}$/u.test(key)) {
    failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.IDEMPOTENCY_KEY_INVALID);
  }
  return key;
}

export function createAccountRemovalRequestDigest({
  contractVersion = ACCOUNT_REMOVAL_CONTRACT_VERSION,
  owner,
  previewFingerprint,
  catalogFingerprint,
  snapshotFingerprint,
} = {}) {
  assertCurrentContractVersion(contractVersion);
  return hash({
    contractVersion: ACCOUNT_REMOVAL_CONTRACT_VERSION,
    owner: validateAccountRemovalOwner(owner),
    previewFingerprint: normalizeDigest(previewFingerprint, {
      requiredCode: ACCOUNT_REMOVAL_ERROR_CODES.PREVIEW_FINGERPRINT_REQUIRED,
      mismatchCode: ACCOUNT_REMOVAL_ERROR_CODES.PREVIEW_FINGERPRINT_MISMATCH,
    }),
    catalogFingerprint: normalizeDigest(catalogFingerprint, {
      requiredCode: ACCOUNT_REMOVAL_ERROR_CODES.CATALOG_FINGERPRINT_MISMATCH,
      mismatchCode: ACCOUNT_REMOVAL_ERROR_CODES.CATALOG_FINGERPRINT_MISMATCH,
    }),
    snapshotFingerprint: normalizeDigest(snapshotFingerprint, {
      requiredCode: ACCOUNT_REMOVAL_ERROR_CODES.SNAPSHOT_FINGERPRINT_REQUIRED,
      mismatchCode: ACCOUNT_REMOVAL_ERROR_CODES.SNAPSHOT_FINGERPRINT_MISMATCH,
    }),
  });
}

function createIdempotencyScope(idempotencyKey, requestDigest) {
  return hash({ idempotencyKey, requestDigest });
}

function canonicalizeIdempotencyContract(value) {
  return withContractBoundary(ACCOUNT_REMOVAL_ERROR_CODES.PREVIEW_CONTRACT_MISMATCH, () => {
  failIfNotPlainInput(value, ACCOUNT_REMOVAL_ERROR_CODES.IDEMPOTENCY_KEY_INVALID);
  if (
    Object.prototype.hasOwnProperty.call(value, 'contractVersion')
    && Object.prototype.hasOwnProperty.call(value, 'version')
    && value.contractVersion !== value.version
  ) {
    failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.CONTRACT_VERSION_MISMATCH);
  }
  const contractVersion = value.contractVersion ?? value.version;
  assertCurrentContractVersion(contractVersion);
  const idempotencyKey = validateIdempotencyKey(value.idempotencyKey);
  const owner = validateAccountRemovalOwner(value.owner);
  const requestDigest = createAccountRemovalRequestDigest({
    contractVersion,
    owner,
    previewFingerprint: value.previewFingerprint,
    catalogFingerprint: value.catalogFingerprint,
    snapshotFingerprint: value.snapshotFingerprint,
  });
  if (value.requestDigest !== requestDigest) {
    failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.PREVIEW_CONTRACT_MISMATCH);
  }
  const idempotencyScope = createIdempotencyScope(idempotencyKey, requestDigest);
  if (value.idempotencyScope !== idempotencyScope) {
    failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.PREVIEW_CONTRACT_MISMATCH);
  }
  return { idempotencyKey, requestDigest, idempotencyScope };
  });
}

/** Pure reuse gate: callers supply a previously observed contract; no key is stored in Phase B. */
export function validateAccountRemovalIdempotencyReuse(previousConfirm = {}, nextConfirm = {}) {
  const previous = canonicalizeIdempotencyContract(previousConfirm);
  const next = canonicalizeIdempotencyContract(nextConfirm);
  if (previous.idempotencyKey === next.idempotencyKey && previous.requestDigest !== next.requestDigest) {
    failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.IDEMPOTENCY_KEY_CONFLICT);
  }
  return deepFreeze({
    idempotencyKey: next.idempotencyKey,
    requestDigest: next.requestDigest,
    idempotencyScope: next.idempotencyScope,
    reused: previous.idempotencyKey === next.idempotencyKey && previous.requestDigest === next.requestDigest,
  });
}

function validateConfirmVersions(input) {
  const contractVersion = readContractProperty(input, 'contractVersion', ACCOUNT_REMOVAL_ERROR_CODES.CONTRACT_VERSION_MISMATCH);
  assertCurrentContractVersion(contractVersion);
  if (
    hasContractProperty(input, 'version', ACCOUNT_REMOVAL_ERROR_CODES.CONTRACT_VERSION_MISMATCH)
    && readContractProperty(input, 'version', ACCOUNT_REMOVAL_ERROR_CODES.CONTRACT_VERSION_MISMATCH) !== contractVersion
  ) {
    failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.CONTRACT_VERSION_MISMATCH);
  }
  assertCurrentCatalogVersion(readContractProperty(input, 'catalogVersion', ACCOUNT_REMOVAL_ERROR_CODES.CATALOG_VERSION_MISMATCH));
  if (readContractProperty(input, 'requestedResourceIdsSemantics', ACCOUNT_REMOVAL_ERROR_CODES.PREVIEW_CONTRACT_MISMATCH) !== ACCOUNT_REMOVAL_REQUESTED_RESOURCE_IDS_SEMANTICS) {
    failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.PREVIEW_CONTRACT_MISMATCH);
  }
}

/**
 * Validates a confirm contract using a fresh catalog plan and a separately
 * injected current observation snapshot. No route, repository, or executor is
 * invoked here.
 */
export function createAccountRemovalConfirmDto(
  input = {},
  preview = {},
  {
    catalog = ACCOUNT_OWNERSHIP_CATALOG,
    currentResourceObservations,
  } = {},
) {
  failIfNotPlainInput(input);
  validateCatalog(catalog);
  const canonicalPreview = validateCanonicalAccountRemovalPreviewDto(preview, { catalog });
  validateConfirmVersions(input);
  const owner = validateAccountRemovalOwner(readContractProperty(input, 'owner', ACCOUNT_REMOVAL_ERROR_CODES.OWNER_TYPE_INVALID));
  const assertedOwner = normalizeOwnerScopeAssertion(input, owner, { required: true });
  if (!sameOwner(owner, canonicalPreview.owner) || !sameOwner(assertedOwner, canonicalPreview.owner)) {
    failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.CROSS_OWNER_SCOPE);
  }
  const plan = buildCanonicalPlan(owner, catalog);
  const requestedResourceIds = canonicalizeRequestedResourceIds(
    readContractProperty(input, 'requestedResourceIds', ACCOUNT_REMOVAL_ERROR_CODES.REQUESTED_RESOURCES_INVALID),
    plan,
    { required: true },
  );
  if (!sameCanonicalValue(requestedResourceIds, canonicalPreview.requestedResourceIds)) {
    failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.PREVIEW_CONTRACT_MISMATCH);
  }
  const currentObservations = canonicalizeResourceObservations(
    currentResourceObservations,
    plan.plannedResourceIds,
    { required: true },
  );
  const echoedObservations = canonicalizeResourceObservations(
    readContractProperty(input, 'resourceObservations', ACCOUNT_REMOVAL_ERROR_CODES.RESOURCE_OBSERVATIONS_INVALID),
    plan.plannedResourceIds,
    { required: true },
  );
  if (!sameCanonicalValue(echoedObservations, currentObservations)) {
    failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.SNAPSHOT_FINGERPRINT_MISMATCH);
  }
  const currentSnapshotFingerprint = createAccountRemovalSnapshotFingerprint({
    owner,
    catalogFingerprint: canonicalPreview.catalogFingerprint,
    plannedResourceIds: plan.plannedResourceIds,
    resourceObservations: currentObservations,
  });
  const echoedSnapshotFingerprint = normalizeDigest(readContractProperty(input, 'snapshotFingerprint', ACCOUNT_REMOVAL_ERROR_CODES.SNAPSHOT_FINGERPRINT_MISMATCH), {
    requiredCode: ACCOUNT_REMOVAL_ERROR_CODES.SNAPSHOT_FINGERPRINT_REQUIRED,
    mismatchCode: ACCOUNT_REMOVAL_ERROR_CODES.SNAPSHOT_FINGERPRINT_MISMATCH,
  });
  if (
    echoedSnapshotFingerprint !== currentSnapshotFingerprint
    || currentSnapshotFingerprint !== canonicalPreview.snapshotFingerprint
    || !sameCanonicalValue(currentObservations, canonicalPreview.resourceObservations)
  ) {
    failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.SNAPSHOT_FINGERPRINT_MISMATCH);
  }
  const previewFingerprint = normalizeDigest(readContractProperty(input, 'previewFingerprint', ACCOUNT_REMOVAL_ERROR_CODES.PREVIEW_FINGERPRINT_MISMATCH), {
    requiredCode: ACCOUNT_REMOVAL_ERROR_CODES.PREVIEW_FINGERPRINT_REQUIRED,
    mismatchCode: ACCOUNT_REMOVAL_ERROR_CODES.PREVIEW_FINGERPRINT_MISMATCH,
  });
  if (previewFingerprint !== canonicalPreview.previewFingerprint) {
    failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.PREVIEW_FINGERPRINT_MISMATCH);
  }
  const catalogFingerprint = normalizeDigest(readContractProperty(input, 'catalogFingerprint', ACCOUNT_REMOVAL_ERROR_CODES.CATALOG_FINGERPRINT_MISMATCH), {
    requiredCode: ACCOUNT_REMOVAL_ERROR_CODES.CATALOG_FINGERPRINT_MISMATCH,
    mismatchCode: ACCOUNT_REMOVAL_ERROR_CODES.CATALOG_FINGERPRINT_MISMATCH,
  });
  if (catalogFingerprint !== canonicalPreview.catalogFingerprint) {
    failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.CATALOG_FINGERPRINT_MISMATCH);
  }
  const idempotencyKey = validateIdempotencyKey(readContractProperty(input, 'idempotencyKey', ACCOUNT_REMOVAL_ERROR_CODES.IDEMPOTENCY_KEY_INVALID));
  const requestDigest = createAccountRemovalRequestDigest({
    owner,
    previewFingerprint,
    catalogFingerprint,
    snapshotFingerprint: currentSnapshotFingerprint,
  });
  const confirm = deepFreeze({
    version: ACCOUNT_REMOVAL_CONTRACT_VERSION,
    contractVersion: ACCOUNT_REMOVAL_CONTRACT_VERSION,
    mode: 'confirm-contract-only',
    completed: false,
    owner,
    requestedOwnerType: assertedOwner.ownerType,
    requestedOwnerId: assertedOwner.ownerId,
    requestedResourceIdsSemantics: ACCOUNT_REMOVAL_REQUESTED_RESOURCE_IDS_SEMANTICS,
    requestedResourceIds,
    catalogVersion: ACCOUNT_OWNERSHIP_CATALOG_VERSION,
    catalogFingerprint,
    resourceObservations: currentObservations,
    snapshotFingerprint: currentSnapshotFingerprint,
    previewFingerprint,
    idempotencyKey,
    requestDigest,
    idempotencyScope: createIdempotencyScope(idempotencyKey, requestDigest),
  });
  const idempotencyReference = readContractProperty(input, 'idempotencyReference', ACCOUNT_REMOVAL_ERROR_CODES.PREVIEW_CONTRACT_MISMATCH);
  if (idempotencyReference !== undefined) {
    validateAccountRemovalIdempotencyReuse(idempotencyReference, confirm);
  }
  return confirm;
}

/** The only Phase B result is explicitly non-executing; completion is impossible here. */
export function createAccountRemovalResultDto(
  confirm = {},
  preview = {},
  options = {},
) {
  if (!isPlainObject(confirm) || confirm.mode !== 'confirm-contract-only') {
    failAccountRemovalContract(ACCOUNT_REMOVAL_ERROR_CODES.RESULT_EXECUTION_FORBIDDEN);
  }
  const boundConfirm = createAccountRemovalConfirmDto(confirm, preview, options);
  return deepFreeze({
    version: ACCOUNT_REMOVAL_CONTRACT_VERSION,
    mode: 'result-contract-only',
    completed: false,
    status: 'not-executed',
    owner: boundConfirm.owner,
    requestedOwnerType: boundConfirm.requestedOwnerType,
    requestedOwnerId: boundConfirm.requestedOwnerId,
    requestedResourceIdsSemantics: boundConfirm.requestedResourceIdsSemantics,
    requestedResourceIds: boundConfirm.requestedResourceIds,
    catalogVersion: boundConfirm.catalogVersion,
    catalogFingerprint: boundConfirm.catalogFingerprint,
    resourceObservations: boundConfirm.resourceObservations,
    snapshotFingerprint: boundConfirm.snapshotFingerprint,
    previewFingerprint: boundConfirm.previewFingerprint,
    idempotencyKey: boundConfirm.idempotencyKey,
    requestDigest: boundConfirm.requestDigest,
    idempotencyScope: boundConfirm.idempotencyScope,
  });
}
