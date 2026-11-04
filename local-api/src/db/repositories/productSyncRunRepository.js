import { randomUUID } from 'node:crypto';
import { createStableHash, stableStringify } from '../../utils/stableHash.js';

const ACTIVE_RUN_STATUSES = new Set(['queued', 'fetching', 'proving', 'activating']);
const TERMINAL_RUN_STATUSES = new Set([
  'completed',
  'completed_with_source_gaps',
  'partial',
  'failed',
  'interrupted',
  'invalid',
  'canceled',
]);
const RUN_MODES = new Set(['bootstrap', 'full', 'reconcile', 'incremental', 'fast', 'details', 'readback']);
const UNIFIED_FULL_RUN_MODES = new Set(['bootstrap', 'full', 'reconcile']);
const PRODUCT_FULL_SYNC_VISIBILITIES = Object.freeze([
  'ALL',
  'IN_SALE',
  'TO_SUPPLY',
  'STATE_FAILED',
  'VALIDATION_STATE_FAIL',
  'REMOVED_FROM_SALE',
  'ARCHIVED',
]);
const FACET_COVERAGE_KEYS = Object.freeze([
  'returned',
  'returnedEmpty',
  'notApplicable',
  'unavailable',
  'notReturned',
  'failed',
]);
const MAX_STAGE_BYTES = 32 * 1024 * 1024;
const COMPACTED_STAGE_JSON = '[]';
const FAILED_STAGE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function normalizeText(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function nowIso() {
  return new Date().toISOString();
}

function toNonNegativeInteger(value, field) {
  const number = Number(value ?? 0);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`PRODUCT_SYNC_${field}_INVALID`);
  }
  return number;
}

function normalizeIdList(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).map(normalizeText).filter(Boolean))].sort();
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function tableColumns(db, tableName) {
  return new Set(db.prepare(`PRAGMA table_info(${tableName})`).all().map((row) => row.name));
}

function assertRunMode(value) {
  const mode = normalizeText(value).toLowerCase();
  if (!RUN_MODES.has(mode)) throw new Error('PRODUCT_SYNC_MODE_INVALID');
  return mode;
}

function assertRunStatus(value) {
  const status = normalizeText(value).toLowerCase();
  if (!ACTIVE_RUN_STATUSES.has(status) && !TERMINAL_RUN_STATUSES.has(status)) {
    throw new Error('PRODUCT_SYNC_STATUS_INVALID');
  }
  return status;
}

function normalizeCoverageFacet(input = {}, facet = 'unknown') {
  const expected = toNonNegativeInteger(input.expected, 'COVERAGE_EXPECTED');
  const normalized = { expected };
  let actual = 0;
  for (const key of FACET_COVERAGE_KEYS) {
    normalized[key] = toNonNegativeInteger(input[key], `COVERAGE_${key.toUpperCase()}`);
    actual += normalized[key];
  }
  if (actual !== expected) {
    const error = new Error(`PRODUCT_SYNC_COVERAGE_EQUATION_INVALID:${facet}`);
    error.code = 'PRODUCT_SYNC_COVERAGE_EQUATION_INVALID';
    throw error;
  }
  return normalized;
}

export function normalizeProductSyncCoverageProof(input = {}) {
  const rawFacets = input?.facets && typeof input.facets === 'object' ? input.facets : {};
  const facetEntries = Object.entries(rawFacets).sort(([left], [right]) => left.localeCompare(right));
  if (!facetEntries.length) throw new Error('PRODUCT_SYNC_COVERAGE_FACETS_REQUIRED');
  const facets = {};
  let expected = 0;
  let returned = 0;
  let sourceGaps = 0;
  let failed = 0;
  for (const [facet, value] of facetEntries) {
    const key = normalizeText(facet).toLowerCase();
    if (!key) throw new Error('PRODUCT_SYNC_COVERAGE_FACET_INVALID');
    const normalized = normalizeCoverageFacet(value, key);
    facets[key] = normalized;
    expected += normalized.expected;
    returned += normalized.returned + normalized.returnedEmpty + normalized.notApplicable + normalized.unavailable;
    sourceGaps += normalized.notReturned;
    failed += normalized.failed;
  }
  return Object.freeze({
    schemaVersion: 1,
    facets: Object.freeze(facets),
    expected,
    accounted: returned + sourceGaps + failed,
    sourceGaps,
    failed,
  });
}

function toPublicRun(row) {
  if (!row) return null;
  return {
    runId: row.id,
    shopId: row.shop_id,
    shopIncarnation: row.shop_incarnation,
    credentialRevision: Number(row.credential_revision),
    mode: row.mode,
    visibility: row.visibility,
    requestFingerprint: row.request_fingerprint,
    status: row.status,
    contractHash: row.contract_hash,
    mapperVersion: row.mapper_version,
    baseSnapshotId: row.base_snapshot_id || null,
    activatedSnapshotId: row.activated_snapshot_id || null,
    startCursor: row.start_cursor || null,
    committedCursor: row.committed_cursor || null,
    expectedCount: Number(row.expected_count || 0),
    actualCount: Number(row.actual_count || 0),
    stagedBatchCount: Number(row.staged_batch_count || 0),
    sourceGapCount: Number(row.source_gap_count || 0),
    proof: parseJson(row.proof_json, null),
    proofHash: row.proof_hash || null,
    leaseOwner: row.lease_owner || null,
    leaseExpiresAt: row.lease_expires_at || null,
    heartbeatAt: row.heartbeat_at || null,
    errorCode: row.error_code || null,
    errorMessage: row.error_message || null,
    createdAt: row.created_at,
    startedAt: row.started_at || null,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at || null,
  };
}

function toPublicBatch(row) {
  return {
    runId: row.run_id,
    shopId: row.shop_id,
    batchKey: row.batch_key,
    stageKind: row.stage_kind,
    endpointKey: row.endpoint_key,
    facet: row.facet,
    visibility: row.visibility || null,
    batchIndex: Number(row.batch_index),
    requestCursor: row.request_cursor || null,
    nextCursor: row.next_cursor || null,
    expectedProductIds: parseJson(row.expected_product_ids_json, []),
    expectedOfferIds: parseJson(row.expected_offer_ids_json, []),
    actualProductIds: parseJson(row.actual_product_ids_json, []),
    actualOfferIds: parseJson(row.actual_offer_ids_json, []),
    rows: parseJson(row.normalized_rows_json, []),
    rowCount: Number(row.row_count),
    payloadHash: row.payload_hash,
    responseHash: row.response_hash,
    contractVersion: row.contract_version,
    mapperVersion: row.mapper_version,
    status: row.status,
    sourceReason: row.source_reason || null,
    observedAt: row.observed_at,
  };
}

export function createProductSyncRunRepository(db, { clock = nowIso } = {}) {
  if (!db) throw new Error('createProductSyncRunRepository requires db.');
  const shopColumns = tableColumns(db, 'shops');
  const incarnationColumn = shopColumns.has('shop_incarnation') ? 'shop_incarnation' : null;
  const revisionColumn = shopColumns.has('credential_revision') ? 'credential_revision' : null;

  function readShopFence(shopId) {
    const id = normalizeText(shopId);
    if (!id) throw new Error('PRODUCT_SYNC_SHOP_ID_REQUIRED');
    const row = db.prepare('SELECT * FROM shops WHERE id = ?').get(id);
    if (!row) throw new Error('PRODUCT_SYNC_SHOP_NOT_FOUND');
    const shopIncarnation = normalizeText(incarnationColumn ? row[incarnationColumn] : '') || `${row.id}:${row.created_at}`;
    const credentialRevision = Number(revisionColumn ? row[revisionColumn] : 1);
    if (!shopIncarnation || !Number.isSafeInteger(credentialRevision) || credentialRevision < 1) {
      throw new Error('PRODUCT_SYNC_SHOP_FENCE_INVALID');
    }
    return { shopId: row.id, shopIncarnation, credentialRevision };
  }

  function getRun(runId) {
    return toPublicRun(db.prepare('SELECT * FROM product_sync_runs WHERE id = ?').get(normalizeText(runId)));
  }

  function assertCurrentFence(row) {
    if (!row) throw new Error('PRODUCT_SYNC_RUN_NOT_FOUND');
    const current = readShopFence(row.shop_id);
    if (current.shopIncarnation !== row.shop_incarnation) {
      throw new Error('PRODUCT_SYNC_SHOP_INCARNATION_STALE');
    }
    if (current.credentialRevision !== Number(row.credential_revision)) {
      throw new Error('PRODUCT_SYNC_CREDENTIAL_REVISION_STALE');
    }
    return current;
  }

  function createRun(input = {}) {
    const fence = readShopFence(input.shopId ?? input.shop_id);
    if (input.shopIncarnation && normalizeText(input.shopIncarnation) !== fence.shopIncarnation) {
      throw new Error('PRODUCT_SYNC_SHOP_INCARNATION_STALE');
    }
    if (input.credentialRevision && Number(input.credentialRevision) !== fence.credentialRevision) {
      throw new Error('PRODUCT_SYNC_CREDENTIAL_REVISION_STALE');
    }
    const mode = assertRunMode(input.mode || 'incremental');
    const visibility = normalizeText(input.visibility || 'ALL').toUpperCase();
    if (UNIFIED_FULL_RUN_MODES.has(mode) && visibility !== 'FULL') {
      throw new Error('PRODUCT_SYNC_FULL_RUN_SCOPE_REQUIRED');
    }
    if (!UNIFIED_FULL_RUN_MODES.has(mode) && visibility === 'FULL') {
      throw new Error('PRODUCT_SYNC_FULL_SCOPE_MODE_INVALID');
    }
    const requestFingerprint = normalizeText(input.requestFingerprint ?? input.request_fingerprint);
    const contractHash = normalizeText(input.contractHash ?? input.contract_hash);
    const mapperVersion = normalizeText(input.mapperVersion ?? input.mapper_version);
    if (!requestFingerprint) throw new Error('PRODUCT_SYNC_REQUEST_FINGERPRINT_REQUIRED');
    if (!contractHash) throw new Error('PRODUCT_SYNC_CONTRACT_HASH_REQUIRED');
    if (!mapperVersion) throw new Error('PRODUCT_SYNC_MAPPER_VERSION_REQUIRED');
    const reusable = db.prepare(`
      SELECT * FROM product_sync_runs
       WHERE shop_id = ? AND request_fingerprint = ?
         AND status IN ('queued', 'fetching', 'proving', 'activating', 'interrupted')
       ORDER BY created_at DESC LIMIT 1
    `).get(fence.shopId, requestFingerprint);
    if (reusable) return { run: toPublicRun(reusable), reused: true };
    const timestamp = clock();
    const id = normalizeText(input.runId ?? input.id) || `product_sync_${randomUUID()}`;
    db.prepare(`
      INSERT INTO product_sync_runs (
        id, shop_id, shop_incarnation, credential_revision, mode, visibility,
        request_fingerprint, status, contract_hash, mapper_version,
        base_snapshot_id, start_cursor, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      fence.shopId,
      fence.shopIncarnation,
      fence.credentialRevision,
      mode,
      visibility,
      requestFingerprint,
      contractHash,
      mapperVersion,
      normalizeText(input.baseSnapshotId) || null,
      normalizeText(input.startCursor) || null,
      timestamp,
      timestamp,
    );
    return { run: getRun(id), reused: false };
  }

  function transition(runId, fromStatuses, status, patch = {}) {
    const nextStatus = assertRunStatus(status);
    const allowed = new Set(Array.isArray(fromStatuses) ? fromStatuses : [fromStatuses]);
    const row = db.prepare('SELECT * FROM product_sync_runs WHERE id = ?').get(normalizeText(runId));
    if (!row) throw new Error('PRODUCT_SYNC_RUN_NOT_FOUND');
    assertCurrentFence(row);
    if (!allowed.has(row.status)) throw new Error('PRODUCT_SYNC_RUN_STATE_CONFLICT');
    const timestamp = clock();
    db.prepare(`
      UPDATE product_sync_runs
         SET status = ?, lease_owner = COALESCE(?, lease_owner),
             lease_expires_at = COALESCE(?, lease_expires_at), heartbeat_at = COALESCE(?, heartbeat_at),
             started_at = COALESCE(started_at, ?), updated_at = ?,
             error_code = ?, error_message = ?,
             finished_at = CASE WHEN ? IN ('completed','completed_with_source_gaps','partial','failed','interrupted','invalid','canceled') THEN ? ELSE NULL END
       WHERE id = ?
    `).run(
      nextStatus,
      normalizeText(patch.leaseOwner) || null,
      normalizeText(patch.leaseExpiresAt) || null,
      normalizeText(patch.heartbeatAt) || null,
      timestamp,
      timestamp,
      normalizeText(patch.errorCode) || null,
      normalizeText(patch.errorMessage) || null,
      nextStatus,
      timestamp,
      row.id,
    );
    return getRun(row.id);
  }

  function startFetching(runId, { leaseOwner, leaseExpiresAt } = {}) {
    const owner = normalizeText(leaseOwner);
    const expiresAt = normalizeText(leaseExpiresAt);
    if (!owner || !expiresAt) throw new Error('PRODUCT_SYNC_LEASE_REQUIRED');
    return transition(runId, ['queued', 'interrupted'], 'fetching', {
      leaseOwner: owner,
      leaseExpiresAt: expiresAt,
      heartbeatAt: clock(),
    });
  }

  function heartbeat(runId, { leaseOwner, leaseExpiresAt } = {}) {
    const row = db.prepare('SELECT * FROM product_sync_runs WHERE id = ?').get(normalizeText(runId));
    if (!row) throw new Error('PRODUCT_SYNC_RUN_NOT_FOUND');
    assertCurrentFence(row);
    if (!ACTIVE_RUN_STATUSES.has(row.status)) throw new Error('PRODUCT_SYNC_RUN_STATE_CONFLICT');
    if (normalizeText(row.lease_owner) !== normalizeText(leaseOwner)) throw new Error('PRODUCT_SYNC_LEASE_OWNER_MISMATCH');
    const timestamp = clock();
    db.prepare(`UPDATE product_sync_runs SET lease_expires_at = ?, heartbeat_at = ?, updated_at = ? WHERE id = ?`)
      .run(normalizeText(leaseExpiresAt), timestamp, timestamp, row.id);
    return getRun(row.id);
  }

  function stageBatch(input = {}) {
    const runId = normalizeText(input.runId ?? input.run_id);
    const row = db.prepare('SELECT * FROM product_sync_runs WHERE id = ?').get(runId);
    if (!row) throw new Error('PRODUCT_SYNC_RUN_NOT_FOUND');
    assertCurrentFence(row);
    if (row.status !== 'fetching') throw new Error('PRODUCT_SYNC_RUN_STATE_CONFLICT');
    const rows = Array.isArray(input.rows) ? input.rows : null;
    if (!rows) throw new Error('PRODUCT_SYNC_STAGE_ROWS_REQUIRED');
    const normalizedRowsJson = stableStringify(rows);
    if (Buffer.byteLength(normalizedRowsJson, 'utf8') > MAX_STAGE_BYTES) {
      throw new Error('PRODUCT_SYNC_STAGE_PAYLOAD_TOO_LARGE');
    }
    const stageKind = normalizeText(input.stageKind ?? input.stage_kind).toLowerCase();
    if (!['list', 'facet'].includes(stageKind)) throw new Error('PRODUCT_SYNC_STAGE_KIND_INVALID');
    const endpointKey = normalizeText(input.endpointKey ?? input.endpoint_key);
    const facet = normalizeText(input.facet).toLowerCase();
    const batchIndex = toNonNegativeInteger(input.batchIndex ?? input.batch_index, 'BATCH_INDEX');
    const contractVersion = normalizeText(input.contractVersion ?? input.contract_version);
    const mapperVersion = normalizeText(input.mapperVersion ?? input.mapper_version);
    const responseHash = normalizeText(input.responseHash ?? input.response_hash);
    if (!endpointKey || !facet || !contractVersion || !mapperVersion || !responseHash) {
      throw new Error('PRODUCT_SYNC_STAGE_PROVENANCE_REQUIRED');
    }
    const expectedProductIds = normalizeIdList(input.expectedProductIds);
    const expectedOfferIds = normalizeIdList(input.expectedOfferIds);
    const actualProductIds = normalizeIdList(input.actualProductIds);
    const actualOfferIds = normalizeIdList(input.actualOfferIds);
    const status = normalizeText(input.status || (rows.length ? 'returned' : 'returned_empty')).toLowerCase();
    if (!['returned', 'returned_empty', 'failed', 'contract_invalid'].includes(status)) {
      throw new Error('PRODUCT_SYNC_STAGE_STATUS_INVALID');
    }
    const batchKey = normalizeText(input.batchKey ?? input.batch_key) || createStableHash({
      stageKind,
      endpointKey,
      facet,
      visibility: normalizeText(input.visibility),
      batchIndex,
      requestCursor: normalizeText(input.requestCursor),
      expectedProductIds,
      expectedOfferIds,
    });
    const timestamp = normalizeText(input.observedAt) || clock();
    const payloadHash = createStableHash(rows);
    db.prepare(`
      INSERT INTO product_sync_stage_batches (
        run_id, shop_id, batch_key, stage_kind, endpoint_key, facet, visibility,
        batch_index, request_cursor, next_cursor,
        expected_product_ids_json, expected_offer_ids_json,
        actual_product_ids_json, actual_offer_ids_json,
        normalized_rows_json, row_count, payload_hash, response_hash,
        contract_version, mapper_version, status, source_reason, observed_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, batch_key) DO UPDATE SET
        normalized_rows_json = excluded.normalized_rows_json,
        row_count = excluded.row_count,
        payload_hash = excluded.payload_hash,
        response_hash = excluded.response_hash,
        actual_product_ids_json = excluded.actual_product_ids_json,
        actual_offer_ids_json = excluded.actual_offer_ids_json,
        status = excluded.status,
        source_reason = excluded.source_reason,
        observed_at = excluded.observed_at
    `).run(
      row.id,
      row.shop_id,
      batchKey,
      stageKind,
      endpointKey,
      facet,
      normalizeText(input.visibility) || null,
      batchIndex,
      normalizeText(input.requestCursor) || null,
      normalizeText(input.nextCursor) || null,
      stableStringify(expectedProductIds),
      stableStringify(expectedOfferIds),
      stableStringify(actualProductIds),
      stableStringify(actualOfferIds),
      normalizedRowsJson,
      rows.length,
      payloadHash,
      responseHash,
      contractVersion,
      mapperVersion,
      status,
      normalizeText(input.sourceReason) || null,
      timestamp,
      timestamp,
    );
    db.prepare(`
      UPDATE product_sync_runs
         SET staged_batch_count = (SELECT COUNT(*) FROM product_sync_stage_batches WHERE run_id = ?),
             actual_count = (SELECT COALESCE(SUM(row_count), 0) FROM product_sync_stage_batches WHERE run_id = ?),
             updated_at = ?
       WHERE id = ?
    `).run(row.id, row.id, clock(), row.id);
    return toPublicBatch(db.prepare('SELECT * FROM product_sync_stage_batches WHERE run_id = ? AND batch_key = ?').get(row.id, batchKey));
  }

  function recordPageProof(input = {}) {
    const runId = normalizeText(input.runId ?? input.run_id);
    const run = db.prepare('SELECT * FROM product_sync_runs WHERE id = ?').get(runId);
    if (!run) throw new Error('PRODUCT_SYNC_RUN_NOT_FOUND');
    assertCurrentFence(run);
    if (run.status !== 'fetching') throw new Error('PRODUCT_SYNC_RUN_STATE_CONFLICT');
    const pageIndex = toNonNegativeInteger(input.pageIndex ?? input.page_index, 'PAGE_INDEX');
    if (pageIndex < 1) throw new Error('PRODUCT_SYNC_PAGE_INDEX_INVALID');
    const rowCount = toNonNegativeInteger(input.rowCount ?? input.row_count, 'PAGE_ROW_COUNT');
    const pageLimit = toNonNegativeInteger(input.pageLimit ?? input.page_limit, 'PAGE_LIMIT');
    if (pageLimit < 1) throw new Error('PRODUCT_SYNC_PAGE_LIMIT_INVALID');
    const responseHash = normalizeText(input.responseHash);
    const contractVersion = normalizeText(input.contractVersion);
    const mapperVersion = normalizeText(input.mapperVersion);
    if (!responseHash || !contractVersion || !mapperVersion) throw new Error('PRODUCT_SYNC_PAGE_PROOF_PROVENANCE_REQUIRED');
    const timestamp = normalizeText(input.observedAt) || clock();
    db.prepare(`
      INSERT INTO product_sync_page_proofs (
        run_id, shop_id, visibility, page_index, request_cursor, next_cursor,
        row_count, page_limit, is_short_page, is_terminal, response_hash,
        contract_version, mapper_version, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, visibility, page_index) DO UPDATE SET
        request_cursor = excluded.request_cursor, next_cursor = excluded.next_cursor,
        row_count = excluded.row_count, page_limit = excluded.page_limit,
        is_short_page = excluded.is_short_page, is_terminal = excluded.is_terminal,
        response_hash = excluded.response_hash, contract_version = excluded.contract_version,
        mapper_version = excluded.mapper_version, observed_at = excluded.observed_at
    `).run(
      run.id,
      run.shop_id,
      normalizeText(input.visibility || run.visibility).toUpperCase(),
      pageIndex,
      normalizeText(input.requestCursor) || null,
      normalizeText(input.nextCursor) || null,
      rowCount,
      pageLimit,
      input.isShortPage ? 1 : 0,
      input.isTerminal ? 1 : 0,
      responseHash,
      contractVersion,
      mapperVersion,
      timestamp,
    );
    return { ok: true, runId: run.id, pageIndex };
  }

  function listStagedBatches(runId) {
    return db.prepare(`
      SELECT * FROM product_sync_stage_batches
       WHERE run_id = ?
       ORDER BY CASE stage_kind WHEN 'list' THEN 0 ELSE 1 END, batch_index, batch_key
    `).all(normalizeText(runId)).map(toPublicBatch);
  }

  function validatePageProofs(row, proofInput = {}) {
    const requestedVisibilities = normalizeIdList(
      proofInput.requiredVisibilities ?? proofInput.required_visibilities ?? [row.visibility],
    ).map((value) => value.toUpperCase());
    const requiredVisibilities = UNIFIED_FULL_RUN_MODES.has(row.mode)
      ? [...PRODUCT_FULL_SYNC_VISIBILITIES]
      : requestedVisibilities;
    if (
      UNIFIED_FULL_RUN_MODES.has(row.mode) &&
      (
        requestedVisibilities.length !== PRODUCT_FULL_SYNC_VISIBILITIES.length ||
        PRODUCT_FULL_SYNC_VISIBILITIES.some(
          (visibility) => !requestedVisibilities.includes(visibility),
        )
      )
    ) {
      throw new Error('PRODUCT_SYNC_FULL_VISIBILITY_PROOF_INCOMPLETE');
    }
    if (!requiredVisibilities.length) throw new Error('PRODUCT_SYNC_REQUIRED_VISIBILITIES_REQUIRED');
    const pages = db.prepare(`
      SELECT * FROM product_sync_page_proofs
       WHERE run_id = ?
       ORDER BY visibility, page_index
    `).all(row.id);
    if (!pages.length) throw new Error('PRODUCT_SYNC_PAGE_PROOF_REQUIRED');
    const pagesByVisibility = new Map();
    for (const page of pages) {
      const visibility = normalizeText(page.visibility).toUpperCase();
      if (!pagesByVisibility.has(visibility)) pagesByVisibility.set(visibility, []);
      pagesByVisibility.get(visibility).push(page);
    }
    const unexpected = [...pagesByVisibility.keys()].filter(
      (visibility) => !requiredVisibilities.includes(visibility),
    );
    if (unexpected.length) throw new Error(`PRODUCT_SYNC_UNEXPECTED_VISIBILITY_PROOF:${unexpected.join(',')}`);

    const listStages = db.prepare(`
      SELECT * FROM product_sync_stage_batches
       WHERE run_id = ? AND stage_kind = 'list'
       ORDER BY visibility, batch_index, batch_key
    `).all(row.id);
    const listStagesByPage = new Map();
    for (const stage of listStages) {
      const key = `${normalizeText(stage.visibility).toUpperCase()}:${Number(stage.batch_index)}`;
      if (!listStagesByPage.has(key)) listStagesByPage.set(key, []);
      listStagesByPage.get(key).push(stage);
    }
    if (listStages.length !== pages.length) {
      throw new Error('PRODUCT_SYNC_LIST_STAGE_PAGE_COUNT_MISMATCH');
    }

    const committedCursors = {};
    const orderedPages = [];
    const identityKeys = new Set();
    for (const visibility of requiredVisibilities) {
      const visibilityPages = pagesByVisibility.get(visibility) || [];
      if (!visibilityPages.length) {
        throw new Error(`PRODUCT_SYNC_VISIBILITY_PAGE_PROOF_REQUIRED:${visibility}`);
      }
      const seenCursors = new Set();
      let priorNext = requiredVisibilities.length === 1 ? normalizeText(row.start_cursor) : '';
      for (let index = 0; index < visibilityPages.length; index += 1) {
        const page = visibilityPages[index];
        if (Number(page.page_index) !== index + 1) throw new Error('PRODUCT_SYNC_PAGE_SEQUENCE_INVALID');
        if (normalizeText(page.request_cursor) !== priorNext) throw new Error('PRODUCT_SYNC_CURSOR_CHAIN_INVALID');
        const next = normalizeText(page.next_cursor);
        const isShortPage = Number(page.row_count) < Number(page.page_limit);
        if (Number(page.is_short_page) !== Number(isShortPage)) {
          throw new Error('PRODUCT_SYNC_SHORT_PAGE_PROOF_INVALID');
        }
        const isTerminal = Number(page.is_terminal) === 1;
        if (isTerminal && next && !isShortPage) {
          throw new Error('PRODUCT_SYNC_TERMINAL_PAGE_PROOF_INVALID');
        }
        if (!isTerminal && (!next || isShortPage)) {
          throw new Error('PRODUCT_SYNC_NON_TERMINAL_PAGE_PROOF_INVALID');
        }
        if (next && seenCursors.has(next)) throw new Error('PRODUCT_SYNC_CURSOR_LOOP');
        if (next) seenCursors.add(next);
        priorNext = next;
        if (index < visibilityPages.length - 1 && Number(page.is_terminal) === 1) {
          throw new Error('PRODUCT_SYNC_EARLY_TERMINAL_PAGE');
        }

        const stageKey = `${visibility}:${Number(page.page_index)}`;
        const matchingStages = listStagesByPage.get(stageKey) || [];
        if (matchingStages.length !== 1) {
          throw new Error('PRODUCT_SYNC_LIST_STAGE_PAGE_MATCH_INVALID');
        }
        const stage = matchingStages[0];
        if (
          normalizeText(stage.request_cursor) !== normalizeText(page.request_cursor) ||
          normalizeText(stage.next_cursor) !== normalizeText(page.next_cursor) ||
          Number(stage.row_count) !== Number(page.row_count) ||
          stage.response_hash !== page.response_hash ||
          stage.contract_version !== page.contract_version ||
          stage.mapper_version !== page.mapper_version
        ) {
          throw new Error('PRODUCT_SYNC_LIST_STAGE_PAGE_PROOF_MISMATCH');
        }
        const stageRows = parseJson(stage.normalized_rows_json, null);
        if (!Array.isArray(stageRows) || stageRows.length !== Number(stage.row_count)) {
          throw new Error('PRODUCT_SYNC_LIST_STAGE_ROWS_INVALID');
        }
        const actualProductIds = normalizeIdList(parseJson(stage.actual_product_ids_json, []));
        const actualOfferIds = normalizeIdList(parseJson(stage.actual_offer_ids_json, []));
        const mappedProductIds = normalizeIdList(
          stageRows.map((item) => item?.product_id ?? item?.productId ?? item?.id),
        );
        const mappedOfferIds = normalizeIdList(
          stageRows.map((item) => item?.offer_id ?? item?.offerId),
        );
        if (
          stableStringify(actualProductIds) !== stableStringify(mappedProductIds) ||
          stableStringify(actualOfferIds) !== stableStringify(mappedOfferIds)
        ) {
          throw new Error('PRODUCT_SYNC_LIST_IDENTITY_PROOF_MISMATCH');
        }
        for (const item of stageRows) {
          const productId = normalizeText(item?.product_id ?? item?.productId ?? item?.id);
          if (productId) identityKeys.add(`product:${productId}`);
          else throw new Error('PRODUCT_SYNC_LIST_PRODUCT_ID_REQUIRED');
        }
      }
      const last = visibilityPages.at(-1);
      if (Number(last.is_terminal) !== 1) {
        throw new Error(`PRODUCT_SYNC_INCOMPLETE_PAGINATION:${visibility}`);
      }
      committedCursors[visibility] = normalizeText(last.next_cursor) || null;
      orderedPages.push(...visibilityPages);
    }
    return {
      pages: orderedPages,
      requiredVisibilities,
      committedCursors,
      committedCursor:
        requiredVisibilities.length === 1
          ? committedCursors[requiredVisibilities[0]]
          : stableStringify(committedCursors),
      identityKeys: [...identityKeys].sort(),
    };
  }

  function markProving(runId, proofInput = {}) {
    const row = db.prepare('SELECT * FROM product_sync_runs WHERE id = ?').get(normalizeText(runId));
    if (!row) throw new Error('PRODUCT_SYNC_RUN_NOT_FOUND');
    assertCurrentFence(row);
    if (row.status !== 'fetching') throw new Error('PRODUCT_SYNC_RUN_STATE_CONFLICT');
    const pageProof = validatePageProofs(row, proofInput);
    const invalidBatch = db.prepare(`
      SELECT status FROM product_sync_stage_batches
       WHERE run_id = ? AND status IN ('failed', 'contract_invalid') LIMIT 1
    `).get(row.id);
    if (invalidBatch) throw new Error(invalidBatch.status === 'failed' ? 'PRODUCT_SYNC_FETCH_FAILED' : 'PRODUCT_SYNC_CONTRACT_INVALID');
    const coverage = normalizeProductSyncCoverageProof(proofInput.coverage || proofInput);
    if (coverage.failed > 0) throw new Error('PRODUCT_SYNC_COVERAGE_FAILED');
    const identityCoverage = coverage.facets.identity;
    if (
      !identityCoverage ||
      identityCoverage.expected !== pageProof.identityKeys.length ||
      identityCoverage.returned !== pageProof.identityKeys.length ||
      FACET_COVERAGE_KEYS
        .filter((key) => key !== 'returned')
        .some((key) => identityCoverage[key] !== 0)
    ) {
      throw new Error('PRODUCT_SYNC_IDENTITY_COVERAGE_PROOF_INVALID');
    }
    const proof = {
      schemaVersion: pageProof.requiredVisibilities.length > 1 ? 2 : 1,
      contractHash: row.contract_hash,
      mapperVersion: row.mapper_version,
      pageCount: pageProof.pages.length,
      pageHashes: pageProof.pages.map((page) => page.response_hash),
      requiredVisibilities: pageProof.requiredVisibilities,
      committedCursors: pageProof.committedCursors,
      stagedBatchCount: Number(db.prepare('SELECT COUNT(*) AS count FROM product_sync_stage_batches WHERE run_id = ?').get(row.id).count),
      coverage,
      provenAt: clock(),
    };
    const proofHash = createStableHash(proof);
    const timestamp = clock();
    db.prepare(`
      UPDATE product_sync_runs
         SET status = 'proving', expected_count = ?, source_gap_count = ?,
             proof_json = ?, proof_hash = ?, committed_cursor = ?, updated_at = ?
       WHERE id = ?
    `).run(
      coverage.expected,
      coverage.sourceGaps,
      stableStringify(proof),
      proofHash,
      pageProof.committedCursor,
      timestamp,
      row.id,
    );
    return getRun(row.id);
  }

  function activateRun(runId, { snapshotId, apply, beforeOutbox, beforeCommit } = {}) {
    const id = normalizeText(runId);
    const activeSnapshotId = normalizeText(snapshotId);
    if (!activeSnapshotId) throw new Error('PRODUCT_SYNC_SNAPSHOT_ID_REQUIRED');
    if (typeof apply !== 'function') throw new Error('PRODUCT_SYNC_APPLY_REQUIRED');
    let result;
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = db.prepare('SELECT * FROM product_sync_runs WHERE id = ?').get(id);
      if (!row) throw new Error('PRODUCT_SYNC_RUN_NOT_FOUND');
      assertCurrentFence(row);
      if (row.status !== 'proving') throw new Error('PRODUCT_SYNC_RUN_STATE_CONFLICT');
      const proof = parseJson(row.proof_json, null);
      if (!proof || createStableHash(proof) !== row.proof_hash) throw new Error('PRODUCT_SYNC_PROOF_HASH_INVALID');
      if (proof.contractHash !== row.contract_hash || proof.mapperVersion !== row.mapper_version) {
        throw new Error('PRODUCT_SYNC_PROOF_CONTRACT_INVALID');
      }
      db.prepare(`UPDATE product_sync_runs SET status = 'activating', updated_at = ? WHERE id = ?`).run(clock(), row.id);
      const batches = listStagedBatches(row.id);
      result = apply({ run: toPublicRun({ ...row, status: 'activating' }), batches, proof });
      if (result && typeof result.then === 'function') throw new Error('PRODUCT_SYNC_APPLY_MUST_BE_SYNCHRONOUS');
      beforeOutbox?.({ run: toPublicRun(row), batches, proof, result });
      const hasSourceGaps = Number(row.source_gap_count) > 0;
      const eventType = hasSourceGaps ? 'ProductSnapshotActivatedWithSourceGaps' : 'ProductSnapshotActivated';
      const payload = {
        schemaVersion: 1,
        shopId: row.shop_id,
        runId: row.id,
        snapshotId: activeSnapshotId,
        visibility: row.visibility,
        proofHash: row.proof_hash,
        sourceGapCount: Number(row.source_gap_count),
        committedCursor: row.committed_cursor || null,
      };
      const eventId = `product_outbox_${randomUUID()}`;
      const timestamp = clock();
      db.prepare(`
        INSERT INTO product_sync_outbox (
          event_id, shop_id, run_id, snapshot_id, event_type, payload_json,
          payload_hash, status, attempts, available_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
      `).run(
        eventId,
        row.shop_id,
        row.id,
        activeSnapshotId,
        eventType,
        stableStringify(payload),
        createStableHash(payload),
        timestamp,
        timestamp,
      );
      const finalStatus = hasSourceGaps ? 'completed_with_source_gaps' : 'completed';
      db.prepare(`
        UPDATE product_sync_runs
           SET status = ?, activated_snapshot_id = ?, lease_owner = NULL,
               lease_expires_at = NULL, heartbeat_at = ?, updated_at = ?, finished_at = ?
         WHERE id = ?
      `).run(finalStatus, activeSnapshotId, timestamp, timestamp, timestamp, row.id);
      compactRunStagePayload(row.id);
      beforeCommit?.({ runId: row.id, eventId, result });
      db.exec('COMMIT');
      return { run: getRun(row.id), eventId, result };
    } catch (error) {
      db.exec('ROLLBACK');
      const row = db.prepare('SELECT status FROM product_sync_runs WHERE id = ?').get(id);
      if (row && !TERMINAL_RUN_STATUSES.has(row.status)) {
        db.prepare(`
          UPDATE product_sync_runs
             SET status = 'invalid', error_code = ?, error_message = ?,
                 lease_owner = NULL, lease_expires_at = NULL,
                 updated_at = ?, finished_at = ?
           WHERE id = ?
        `).run(
          normalizeText(error?.code) || normalizeText(error?.message).split(':')[0] || 'PRODUCT_SYNC_ACTIVATION_FAILED',
          normalizeText(error?.message) || 'Product sync activation failed.',
          clock(),
          clock(),
          id,
        );
      }
      throw error;
    }
  }

  function compactRunStagePayload(runId) {
    const id = normalizeText(runId);
    if (!id) throw new Error('PRODUCT_SYNC_RUN_NOT_FOUND');
    const result = db.prepare(`
      UPDATE product_sync_stage_batches
         SET expected_product_ids_json = ?,
             expected_offer_ids_json = ?,
             actual_product_ids_json = ?,
             actual_offer_ids_json = ?,
             normalized_rows_json = ?
       WHERE run_id = ?
         AND (
           expected_product_ids_json <> ? OR expected_offer_ids_json <> ?
           OR actual_product_ids_json <> ? OR actual_offer_ids_json <> ?
           OR normalized_rows_json <> ?
         )
    `).run(
      COMPACTED_STAGE_JSON,
      COMPACTED_STAGE_JSON,
      COMPACTED_STAGE_JSON,
      COMPACTED_STAGE_JSON,
      COMPACTED_STAGE_JSON,
      id,
      COMPACTED_STAGE_JSON,
      COMPACTED_STAGE_JSON,
      COMPACTED_STAGE_JSON,
      COMPACTED_STAGE_JSON,
      COMPACTED_STAGE_JSON,
    );
    return { runId: id, compactedBatches: Number(result.changes || 0) };
  }

  function compactExpiredTerminalStagePayloads({ at = clock(), shopId = '' } = {}) {
    const cutoffMs = Date.parse(at) - FAILED_STAGE_RETENTION_MS;
    if (!Number.isFinite(cutoffMs)) throw new Error('PRODUCT_SYNC_RETENTION_TIME_INVALID');
    const cutoff = new Date(cutoffMs).toISOString();
    const normalizedShopId = normalizeText(shopId);
    const terminalRows = db.prepare(`
      SELECT id FROM product_sync_runs
       WHERE (
         status IN ('completed', 'completed_with_source_gaps')
          OR (
            status IN ('partial', 'failed', 'invalid', 'canceled')
            AND COALESCE(finished_at, updated_at, created_at) < ?
          )
          OR (
            status = 'interrupted'
            AND EXISTS (
              SELECT 1 FROM product_sync_runs newer
               WHERE newer.shop_id = product_sync_runs.shop_id
                 AND newer.request_fingerprint = product_sync_runs.request_fingerprint
                 AND (
                   newer.created_at > product_sync_runs.created_at
                   OR (newer.created_at = product_sync_runs.created_at AND newer.id > product_sync_runs.id)
                 )
            )
          )
       )
       ${normalizedShopId ? 'AND shop_id = ?' : ''}
    `).all(...(normalizedShopId ? [cutoff, normalizedShopId] : [cutoff]));
    let compactedBatches = 0;
    for (const row of terminalRows) {
      compactedBatches += compactRunStagePayload(row.id).compactedBatches;
    }
    return { runCount: terminalRows.length, compactedBatches, cutoff, at };
  }

  function failRun(runId, { status = 'failed', errorCode, errorMessage } = {}) {
    const terminal = assertRunStatus(status);
    if (!['partial', 'failed', 'interrupted', 'invalid', 'canceled'].includes(terminal)) {
      throw new Error('PRODUCT_SYNC_FAILURE_STATUS_INVALID');
    }
    const row = db.prepare('SELECT * FROM product_sync_runs WHERE id = ?').get(normalizeText(runId));
    if (!row) throw new Error('PRODUCT_SYNC_RUN_NOT_FOUND');
    if (TERMINAL_RUN_STATUSES.has(row.status)) return getRun(row.id);
    const timestamp = clock();
    db.prepare(`
      UPDATE product_sync_runs
         SET status = ?, error_code = ?, error_message = ?, lease_owner = NULL,
             lease_expires_at = NULL, updated_at = ?, finished_at = ?
       WHERE id = ?
    `).run(
      terminal,
      normalizeText(errorCode) || null,
      normalizeText(errorMessage) || null,
      timestamp,
      timestamp,
      row.id,
    );
    return getRun(row.id);
  }

  function recoverExpiredRuns(at = clock()) {
    const result = db.prepare(`
      UPDATE product_sync_runs
         SET status = 'interrupted', error_code = 'PRODUCT_SYNC_LEASE_EXPIRED',
             error_message = 'Persistent product sync lease expired before activation.',
             lease_owner = NULL, lease_expires_at = NULL, updated_at = ?, finished_at = ?
       WHERE status IN ('fetching', 'proving', 'activating')
         AND lease_expires_at IS NOT NULL AND lease_expires_at < ?
    `).run(at, at, at);
    return { interrupted: Number(result.changes || 0), recoveredAt: at };
  }

  function listPendingOutbox(limit = 100) {
    const bounded = Math.min(Math.max(Number(limit) || 100, 1), 500);
    return db.prepare(`
      SELECT event_id, shop_id, run_id, snapshot_id, event_type, payload_json,
             payload_hash, status, attempts, available_at, created_at
        FROM product_sync_outbox
       WHERE status IN ('pending', 'failed') AND available_at <= ?
       ORDER BY available_at, created_at LIMIT ?
    `).all(clock(), bounded).map((row) => ({
      eventId: row.event_id,
      shopId: row.shop_id,
      runId: row.run_id,
      snapshotId: row.snapshot_id,
      eventType: row.event_type,
      payload: parseJson(row.payload_json, null),
      payloadHash: row.payload_hash,
      status: row.status,
      attempts: Number(row.attempts),
      availableAt: row.available_at,
      createdAt: row.created_at,
    }));
  }

  return Object.freeze({
    createRun,
    getRun,
    startFetching,
    heartbeat,
    stageBatch,
    recordPageProof,
    listStagedBatches,
    markProving,
    activateRun,
    compactRunStagePayload,
    compactExpiredTerminalStagePayloads,
    failRun,
    recoverExpiredRuns,
    listPendingOutbox,
    readShopFence,
  });
}
