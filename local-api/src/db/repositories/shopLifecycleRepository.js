import { randomUUID } from 'node:crypto';
import { createStableHash } from '../../utils/stableHash.js';
import {
  createShopIdentityRepository,
  normalizeProfileId,
  ShopIdentityError,
} from './shopIdentityRepository.js';

export const DEFAULT_SHOP_BOOTSTRAP_DOMAINS = Object.freeze([
  'products',
  'orders',
  'finance',
  'returns',
  'marketing',
  'logistics',
  'catalog_mappings',
]);

const BOOTSTRAP_REASONS = new Set([
  'initial_bind',
  'rebind',
  'credential_rotation',
  'manual_full',
  'restore_reconcile',
]);
const DOMAIN_STATUSES = new Set([
  'pending',
  'syncing',
  'completed',
  'completed_with_source_gaps',
  'partial',
  'failed',
  'interrupted',
  'invalid',
]);
const BOOTSTRAP_TRANSITIONS = Object.freeze({
  queued: new Set(['running', 'cancelled', 'invalid', 'interrupted']),
  running: new Set(['verifying', 'partial', 'failed', 'interrupted', 'invalid']),
  verifying: new Set(['completed', 'completed_with_source_gaps', 'partial', 'failed', 'interrupted', 'invalid']),
  interrupted: new Set(['queued', 'cancelled', 'invalid']),
  partial: new Set(['queued', 'cancelled', 'invalid']),
  failed: new Set(['queued', 'cancelled', 'invalid']),
  completed: new Set(),
  completed_with_source_gaps: new Set(),
  cancelled: new Set(),
  invalid: new Set(),
});
const TERMINAL_BOOTSTRAP_STATUSES = new Set([
  'completed',
  'completed_with_source_gaps',
  'cancelled',
  'invalid',
]);
const FORBIDDEN_TOMBSTONE_METADATA_KEY = /(?:api.?key|password|cookie|secret|credential|access.?token|refresh.?token)/iu;

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function fail(code) {
  throw new ShopIdentityError(code);
}

function normalizeJsonArray(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeDomains(input) {
  const source = Array.isArray(input) && input.length ? input : DEFAULT_SHOP_BOOTSTRAP_DOMAINS;
  const domains = [...new Set(source.map(normalizeText).filter(Boolean))].sort();
  if (!domains.length || domains.some((domain) => !/^[a-z][a-z0-9._-]{0,63}$/u.test(domain))) {
    fail('SHOP_BOOTSTRAP_DOMAINS_INVALID');
  }
  return domains;
}

function isHash(value) {
  return /^[a-f0-9]{64}$/u.test(normalizeText(value));
}

function assertNoSecretMetadata(value, seen = new Set()) {
  if (value === null || value === undefined) return;
  if (typeof value !== 'object') return;
  if (seen.has(value)) fail('SHOP_TOMBSTONE_METADATA_INVALID');
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item) => assertNoSecretMetadata(item, seen));
  } else {
    Object.entries(value).forEach(([key, item]) => {
      if (FORBIDDEN_TOMBSTONE_METADATA_KEY.test(key)) fail('SHOP_TOMBSTONE_METADATA_SECRET_FORBIDDEN');
      assertNoSecretMetadata(item, seen);
    });
  }
  seen.delete(value);
}

function parseMetadata(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('SHOP_TOMBSTONE_METADATA_INVALID');
  }
  assertNoSecretMetadata(value);
  return value;
}

function toBootstrapRun(row, extra = {}) {
  if (!row) return null;
  return Object.freeze({
    runId: row.run_id,
    profileId: row.profile_id,
    shopId: row.shop_id,
    shopIncarnation: row.shop_incarnation,
    credentialRevision: Number(row.credential_revision),
    reason: row.reason,
    status: row.status,
    requiredDomains: Object.freeze(normalizeJsonArray(row.required_domains_json)),
    completedDomains: Object.freeze(normalizeJsonArray(row.completed_domains_json)),
    sourceGaps: Object.freeze(normalizeJsonArray(row.source_gaps_json)),
    proofHash: row.proof_hash || null,
    lastErrorCode: row.last_error_code || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at || null,
    completedAt: row.completed_at || null,
    ...extra,
  });
}

function toDomainState(row) {
  if (!row) return null;
  return Object.freeze({
    profileId: row.profile_id,
    shopId: row.shop_id,
    shopIncarnation: row.shop_incarnation,
    credentialRevision: Number(row.credential_revision),
    domain: row.domain,
    status: row.status,
    bootstrapRunId: row.bootstrap_run_id || null,
    activeSnapshotId: row.active_snapshot_id || null,
    committedCursor: row.committed_cursor || null,
    proofHash: row.proof_hash || null,
    lastErrorCode: row.last_error_code || null,
    lastAttemptAt: row.last_attempt_at || null,
    lastSuccessAt: row.last_success_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function toTombstone(row) {
  if (!row) return null;
  return Object.freeze({
    tombstoneId: row.tombstone_id,
    profileId: row.profile_id,
    formerShopId: row.former_shop_id,
    externalIdentityHash: row.external_identity_hash || null,
    formerShopIncarnation: row.former_shop_incarnation,
    finalCredentialRevision: Number(row.final_credential_revision),
    deletionOperationId: row.deletion_operation_id,
    deletionReason: row.deletion_reason,
    metadata: JSON.parse(row.metadata_json),
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
  });
}

export function createShopLifecycleRepository(db, options = {}) {
  const profileId = normalizeProfileId(options.profileId);
  const clock = typeof options.now === 'function' ? options.now : () => new Date();
  const runIdFactory = typeof options.createRunId === 'function'
    ? options.createRunId
    : () => `bootstrap_${randomUUID()}`;
  const tombstoneIdFactory = typeof options.createTombstoneId === 'function'
    ? options.createTombstoneId
    : () => `shop_tombstone_${randomUUID()}`;
  const identityRepository = options.identityRepository
    || createShopIdentityRepository(db, { profileId });

  function timestampNow() {
    const value = clock();
    return (value instanceof Date ? value : new Date(value)).toISOString();
  }

  function getBootstrapRunRow(runId) {
    const id = normalizeText(runId);
    return id
      ? db.prepare('SELECT * FROM shop_bootstrap_runs WHERE run_id = ?').get(id) || null
      : null;
  }

  function requireBootstrapRun(runId) {
    const row = getBootstrapRunRow(runId);
    if (!row) fail('SHOP_BOOTSTRAP_RUN_NOT_FOUND');
    if (row.profile_id !== profileId) fail('SHOP_SCOPE_FORBIDDEN');
    return row;
  }

  function assertRunScope(row, token, assertionOptions = {}) {
    const normalizedToken = {
      profileId: normalizeProfileId(token?.profileId ?? profileId),
      shopId: normalizeText(token?.shopId),
      shopIncarnation: normalizeText(token?.shopIncarnation),
      credentialRevision: Number(token?.credentialRevision),
    };
    if (
      row.profile_id !== normalizedToken.profileId
      || row.shop_id !== normalizedToken.shopId
      || row.shop_incarnation !== normalizedToken.shopIncarnation
      || Number(row.credential_revision) !== normalizedToken.credentialRevision
    ) {
      fail('SHOP_BOOTSTRAP_SCOPE_TOKEN_MISMATCH');
    }
    return identityRepository.assertCurrentScopeToken(normalizedToken, assertionOptions);
  }

  function getDomainRows(row) {
    return db.prepare(`
      SELECT * FROM shop_domain_sync_state
      WHERE profile_id = ? AND shop_id = ? AND shop_incarnation = ?
      ORDER BY domain ASC
    `).all(row.profile_id, row.shop_id, row.shop_incarnation);
  }

  function inImmediateTransaction(callback) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const value = callback();
      db.exec('COMMIT');
      return value;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* transaction may already be closed */ }
      throw error;
    }
  }

  return Object.freeze({
    profileId,
    identityRepository,

    getBootstrapRun(runId) {
      const row = getBootstrapRunRow(runId);
      if (!row || row.profile_id !== profileId) return null;
      return toBootstrapRun(row);
    },

    listBootstrapRuns(shopId) {
      const id = normalizeText(shopId);
      if (!id) fail('SHOP_ID_REQUIRED');
      return db.prepare(`
        SELECT * FROM shop_bootstrap_runs
        WHERE profile_id = ? AND shop_id = ?
        ORDER BY created_at DESC, run_id DESC
      `).all(profileId, id).map(toBootstrapRun);
    },

    listBootstrapDomainStates(runId) {
      const row = requireBootstrapRun(runId);
      return db.prepare(`
        SELECT * FROM shop_domain_sync_state
        WHERE profile_id = ? AND shop_id = ? AND shop_incarnation = ?
          AND bootstrap_run_id = ?
        ORDER BY domain ASC
      `).all(
        row.profile_id,
        row.shop_id,
        row.shop_incarnation,
        row.run_id,
      ).map(toDomainState);
    },

    /**
     * Recover the durable lifecycle state after a local-api process restart.
     *
     * External scheduler/catalog job handles are intentionally process-local,
     * so a formerly running run is interrupted and re-enqueued from its
     * durable domain state. A verifying run is left in place: the coordinator
     * may finish it from already persisted domain proofs without reading Ozon
     * again. Runs whose incarnation/revision no longer match the active shop
     * are invalidated and can never become the current binding proof.
     */
    recoverBootstrapRuns() {
      return inImmediateTransaction(() => {
        const timestamp = timestampNow();
        const rows = db.prepare(`
          SELECT bootstrap.*,
                 shops.id AS current_shop_id,
                 shops.shop_incarnation AS current_shop_incarnation,
                 shops.credential_revision AS current_credential_revision,
                 shops.status AS current_shop_status,
                 shops.disabled_at AS current_shop_disabled_at
          FROM shop_bootstrap_runs AS bootstrap
          LEFT JOIN shops
            ON shops.profile_id = bootstrap.profile_id
           AND shops.id = bootstrap.shop_id
          WHERE bootstrap.profile_id = ?
            AND bootstrap.status IN ('queued', 'running', 'verifying', 'interrupted')
          ORDER BY bootstrap.created_at ASC, bootstrap.run_id ASC
        `).all(profileId);

        return rows.map((row) => {
          const scopeIsCurrent = Boolean(
            row.current_shop_id
            && row.current_shop_status === 'active'
            && !row.current_shop_disabled_at
            && row.current_shop_incarnation === row.shop_incarnation
            && Number(row.current_credential_revision) === Number(row.credential_revision),
          );
          if (!scopeIsCurrent) {
            db.prepare(`
              UPDATE shop_bootstrap_runs
              SET status = 'invalid', last_error_code = 'SHOP_SCOPE_TOKEN_STALE',
                  updated_at = ?, completed_at = ?
              WHERE run_id = ?
                AND status IN ('queued', 'running', 'verifying', 'interrupted')
            `).run(timestamp, timestamp, row.run_id);
            db.prepare(`
              UPDATE shop_domain_sync_state
              SET status = 'invalid', last_error_code = 'SHOP_SCOPE_TOKEN_STALE',
                  updated_at = ?
              WHERE bootstrap_run_id = ?
            `).run(timestamp, row.run_id);
            return Object.freeze({
              recoveryAction: 'invalidated',
              run: toBootstrapRun(getBootstrapRunRow(row.run_id)),
            });
          }

          if (row.status === 'running') {
            db.prepare(`
              UPDATE shop_bootstrap_runs
              SET status = 'interrupted', last_error_code = 'SHOP_BOOTSTRAP_PROCESS_RESTARTED',
                  updated_at = ?, completed_at = NULL
              WHERE run_id = ? AND status = 'running'
            `).run(timestamp, row.run_id);
            db.prepare(`
              UPDATE shop_domain_sync_state
              SET status = 'interrupted', last_error_code = 'SHOP_BOOTSTRAP_PROCESS_RESTARTED',
                  updated_at = ?
              WHERE bootstrap_run_id = ? AND status = 'syncing'
            `).run(timestamp, row.run_id);
            return Object.freeze({
              recoveryAction: 'requeue',
              run: toBootstrapRun(getBootstrapRunRow(row.run_id)),
            });
          }

          return Object.freeze({
            recoveryAction: row.status === 'verifying' ? 'verify' : 'requeue',
            run: toBootstrapRun(row),
          });
        });
      });
    },

    createBootstrapRun(input = {}) {
      const token = {
        profileId: normalizeProfileId(input.profileId ?? profileId),
        shopId: normalizeText(input.shopId),
        shopIncarnation: normalizeText(input.shopIncarnation),
        credentialRevision: Number(input.credentialRevision),
      };
      identityRepository.assertCurrentScopeToken(token);
      const reason = normalizeText(input.reason) || 'manual_full';
      if (!BOOTSTRAP_REASONS.has(reason)) fail('SHOP_BOOTSTRAP_REASON_INVALID');
      const domains = normalizeDomains(input.requiredDomains);
      const existing = db.prepare(`
        SELECT * FROM shop_bootstrap_runs
        WHERE profile_id = ? AND shop_id = ?
          AND status IN ('queued', 'running', 'verifying')
        ORDER BY created_at DESC LIMIT 1
      `).get(profileId, token.shopId);
      if (existing) {
        if (
          existing.shop_incarnation === token.shopIncarnation
          && Number(existing.credential_revision) === token.credentialRevision
        ) {
          if (JSON.stringify(normalizeJsonArray(existing.required_domains_json).slice().sort()) !== JSON.stringify(domains)) {
            fail('SHOP_BOOTSTRAP_SINGLEFLIGHT_SCOPE_CONFLICT');
          }
          return toBootstrapRun(existing, { deduplicated: true });
        }
      }
      const runId = normalizeText(input.runId) || runIdFactory();
      const timestamp = timestampNow();
      db.exec('BEGIN IMMEDIATE');
      try {
        identityRepository.assertCurrentScopeToken(token);
        if (existing) {
          db.prepare(`
            UPDATE shop_bootstrap_runs
            SET status = 'invalid', last_error_code = 'SHOP_SCOPE_TOKEN_STALE', updated_at = ?, completed_at = ?
            WHERE run_id = ? AND status IN ('queued', 'running', 'verifying')
          `).run(timestamp, timestamp, existing.run_id);
        }
        db.prepare(`
          INSERT INTO shop_bootstrap_runs (
            run_id, profile_id, shop_id, shop_incarnation, credential_revision,
            reason, status, required_domains_json, completed_domains_json,
            source_gaps_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, '[]', '[]', ?, ?)
        `).run(
          runId,
          profileId,
          token.shopId,
          token.shopIncarnation,
          token.credentialRevision,
          reason,
          JSON.stringify(domains),
          timestamp,
          timestamp,
        );
        const insertDomain = db.prepare(`
          INSERT INTO shop_domain_sync_state (
            profile_id, shop_id, shop_incarnation, credential_revision,
            domain, status, bootstrap_run_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
          ON CONFLICT(profile_id, shop_id, shop_incarnation, domain) DO UPDATE SET
            credential_revision = excluded.credential_revision,
            status = 'pending', bootstrap_run_id = excluded.bootstrap_run_id,
            active_snapshot_id = NULL, committed_cursor = NULL, proof_hash = NULL,
            last_error_code = NULL, last_attempt_at = NULL, last_success_at = NULL,
            updated_at = excluded.updated_at
        `);
        domains.forEach((domain) => insertDomain.run(
          profileId,
          token.shopId,
          token.shopIncarnation,
          token.credentialRevision,
          domain,
          runId,
          timestamp,
          timestamp,
        ));
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return toBootstrapRun(requireBootstrapRun(runId), { deduplicated: false });
    },

    transitionBootstrapRun(input = {}) {
      return inImmediateTransaction(() => {
      const row = requireBootstrapRun(input.runId);
      const expectedStatus = normalizeText(input.expectedStatus);
      const nextStatus = normalizeText(input.nextStatus);
      assertRunScope(row, input.scopeToken);
      if (row.status !== expectedStatus) fail('SHOP_BOOTSTRAP_STATUS_CONFLICT');
      if (!BOOTSTRAP_TRANSITIONS[row.status]?.has(nextStatus)) fail('SHOP_BOOTSTRAP_TRANSITION_INVALID');
      const timestamp = timestampNow();
      const startedAt = nextStatus === 'running' ? row.started_at || timestamp : row.started_at;
      const completedAt = TERMINAL_BOOTSTRAP_STATUSES.has(nextStatus) ? timestamp : null;
      const result = db.prepare(`
        UPDATE shop_bootstrap_runs
        SET status = ?, started_at = ?, completed_at = ?, updated_at = ?, last_error_code = ?
        WHERE run_id = ? AND status = ?
      `).run(
        nextStatus,
        startedAt,
        completedAt,
        timestamp,
        normalizeText(input.lastErrorCode) || null,
        row.run_id,
        expectedStatus,
      );
      if (Number(result.changes) !== 1) fail('SHOP_BOOTSTRAP_STATUS_CONFLICT');
      return toBootstrapRun(requireBootstrapRun(row.run_id));
      });
    },

    recordDomainState(input = {}) {
      return inImmediateTransaction(() => {
      const row = requireBootstrapRun(input.runId);
      assertRunScope(row, input.scopeToken);
      if (!['running', 'verifying'].includes(row.status)) fail('SHOP_BOOTSTRAP_DOMAIN_WRITE_FORBIDDEN');
      const domain = normalizeText(input.domain);
      if (!normalizeJsonArray(row.required_domains_json).includes(domain)) fail('SHOP_BOOTSTRAP_DOMAIN_NOT_REQUIRED');
      const status = normalizeText(input.status);
      if (!DOMAIN_STATUSES.has(status)) fail('SHOP_DOMAIN_SYNC_STATUS_INVALID');
      const proofHash = normalizeText(input.proofHash) || null;
      if (['completed', 'completed_with_source_gaps'].includes(status) && !isHash(proofHash)) {
        fail('SHOP_DOMAIN_SYNC_PROOF_REQUIRED');
      }
      const timestamp = timestampNow();
      const domainUpdate = db.prepare(`
        UPDATE shop_domain_sync_state
        SET credential_revision = ?, status = ?, bootstrap_run_id = ?,
            active_snapshot_id = ?, committed_cursor = ?, proof_hash = ?,
            last_error_code = ?, last_attempt_at = ?,
            last_success_at = CASE WHEN ? IN ('completed', 'completed_with_source_gaps') THEN ? ELSE last_success_at END,
            updated_at = ?
        WHERE profile_id = ? AND shop_id = ? AND shop_incarnation = ? AND domain = ?
      `).run(
        row.credential_revision,
        status,
        row.run_id,
        normalizeText(input.activeSnapshotId) || null,
        normalizeText(input.committedCursor) || null,
        proofHash,
        normalizeText(input.lastErrorCode) || null,
        timestamp,
        status,
        timestamp,
        timestamp,
        row.profile_id,
        row.shop_id,
        row.shop_incarnation,
        domain,
      );
      if (Number(domainUpdate.changes) !== 1) fail('SHOP_DOMAIN_SYNC_STATE_NOT_FOUND');
      const states = getDomainRows(row).map(toDomainState);
      const completedDomains = states
        .filter((state) => ['completed', 'completed_with_source_gaps'].includes(state.status))
        .map((state) => state.domain);
      db.prepare(`UPDATE shop_bootstrap_runs SET completed_domains_json = ?, updated_at = ? WHERE run_id = ?`)
        .run(JSON.stringify(completedDomains), timestamp, row.run_id);
      return states.find((state) => state.domain === domain) || null;
      });
    },

    completeBootstrapRun(input = {}) {
      return inImmediateTransaction(() => {
      const row = requireBootstrapRun(input.runId);
      assertRunScope(row, input.scopeToken);
      if (row.status !== 'verifying') fail('SHOP_BOOTSTRAP_STATUS_CONFLICT');
      const proofHash = normalizeText(input.proofHash);
      if (!isHash(proofHash)) fail('SHOP_BOOTSTRAP_PROOF_REQUIRED');
      const requiredDomains = normalizeJsonArray(row.required_domains_json);
      const states = getDomainRows(row).map(toDomainState);
      const stateByDomain = new Map(states.map((state) => [state.domain, state]));
      if (requiredDomains.some((domain) => !['completed', 'completed_with_source_gaps'].includes(stateByDomain.get(domain)?.status))) {
        fail('SHOP_BOOTSTRAP_COVERAGE_INCOMPLETE');
      }
      const completedWithSourceGaps = requiredDomains.some(
        (domain) => stateByDomain.get(domain)?.status === 'completed_with_source_gaps',
      );
      const sourceGaps = Array.isArray(input.sourceGaps) ? input.sourceGaps : [];
      if (completedWithSourceGaps && !sourceGaps.length) fail('SHOP_BOOTSTRAP_SOURCE_GAPS_REQUIRED');
      if (!completedWithSourceGaps && sourceGaps.length) fail('SHOP_BOOTSTRAP_SOURCE_GAPS_UNEXPECTED');
      const status = completedWithSourceGaps ? 'completed_with_source_gaps' : 'completed';
      const timestamp = timestampNow();
      const completedDomains = requiredDomains.slice().sort();
      db.prepare(`
        UPDATE shop_bootstrap_runs
        SET status = ?, completed_domains_json = ?, source_gaps_json = ?,
            proof_hash = ?, last_error_code = NULL, updated_at = ?, completed_at = ?
        WHERE run_id = ? AND status = 'verifying'
      `).run(
        status,
        JSON.stringify(completedDomains),
        JSON.stringify(sourceGaps),
        proofHash,
        timestamp,
        timestamp,
        row.run_id,
      );
      return toBootstrapRun(requireBootstrapRun(row.run_id));
      });
    },

    listCurrentDomainStates(shopId) {
      const identity = identityRepository.getIdentity(shopId, profileId);
      if (!identity) return [];
      return db.prepare(`
        SELECT * FROM shop_domain_sync_state
        WHERE profile_id = ? AND shop_id = ? AND shop_incarnation = ?
        ORDER BY domain ASC
      `).all(profileId, identity.shopId, identity.shopIncarnation).map(toDomainState);
    },

    createIdentityTombstone(input = {}) {
      const deletionOperationId = normalizeText(input.deletionOperationId);
      const formerShopId = normalizeText(input.formerShopId ?? input.shopId);
      const formerShopIncarnation = normalizeText(input.formerShopIncarnation ?? input.shopIncarnation);
      const finalCredentialRevision = Number(input.finalCredentialRevision ?? input.credentialRevision);
      if (
        !deletionOperationId
        || !formerShopId
        || !formerShopIncarnation
        || !Number.isSafeInteger(finalCredentialRevision)
        || finalCredentialRevision < 1
      ) fail('SHOP_TOMBSTONE_INPUT_INVALID');
      const existing = db.prepare('SELECT * FROM shop_identity_tombstones WHERE deletion_operation_id = ?')
        .get(deletionOperationId);
      if (existing) {
        if (
          existing.profile_id !== profileId
          || existing.former_shop_id !== formerShopId
          || existing.former_shop_incarnation !== formerShopIncarnation
          || Number(existing.final_credential_revision) !== finalCredentialRevision
        ) fail('SHOP_TOMBSTONE_IDEMPOTENCY_CONFLICT');
        return toTombstone(existing);
      }
      const metadata = parseMetadata(input.metadata);
      const timestamp = timestampNow();
      const deletedAt = normalizeText(input.deletedAt) || timestamp;
      const tombstoneId = normalizeText(input.tombstoneId) || tombstoneIdFactory();
      db.prepare(`
        INSERT INTO shop_identity_tombstones (
          tombstone_id, profile_id, former_shop_id, external_identity_hash,
          former_shop_incarnation, final_credential_revision,
          deletion_operation_id, deletion_reason, metadata_json,
          deleted_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        tombstoneId,
        profileId,
        formerShopId,
        normalizeText(input.externalIdentityHash) || null,
        formerShopIncarnation,
        finalCredentialRevision,
        deletionOperationId,
        normalizeText(input.deletionReason) || 'permanent_delete',
        JSON.stringify(metadata),
        deletedAt,
        timestamp,
      );
      return toTombstone(db.prepare('SELECT * FROM shop_identity_tombstones WHERE tombstone_id = ?').get(tombstoneId));
    },

    createCurrentIdentityTombstone(input = {}) {
      const identity = identityRepository.getIdentity(input.shopId, profileId);
      if (!identity) fail('SHOP_SCOPE_NOT_FOUND');
      return this.createIdentityTombstone({
        ...input,
        formerShopId: identity.shopId,
        formerShopIncarnation: identity.shopIncarnation,
        finalCredentialRevision: identity.credentialRevision,
        externalIdentityHash: identity.externalIdentityHash,
      });
    },

    findLatestTombstoneByExternalIdentity(externalIdentityHash) {
      const hash = normalizeText(externalIdentityHash);
      if (!hash) return null;
      return toTombstone(db.prepare(`
        SELECT * FROM shop_identity_tombstones
        WHERE profile_id = ? AND external_identity_hash = ?
        ORDER BY deleted_at DESC, created_at DESC LIMIT 1
      `).get(profileId, hash));
    },

    createBootstrapProof(input = {}) {
      return createStableHash({
        profileId,
        shopId: normalizeText(input.shopId),
        shopIncarnation: normalizeText(input.shopIncarnation),
        credentialRevision: Number(input.credentialRevision),
        domains: normalizeDomains(input.domains),
        domainProofHashes: input.domainProofHashes || {},
      });
    },
  });
}
