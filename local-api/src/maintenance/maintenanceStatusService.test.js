import assert from 'node:assert/strict';
import test from 'node:test';
import { createMaintenanceStatusService } from './maintenanceStatusService.js';

function createServices() {
  const scopeService = {
    inspect: () => ({
      ok: true,
      totalEmptyRows: 20,
      previewFingerprint: 'scope-secret-fingerprint',
      tables: [
        { table: 'private_assignments', action: 'assign-after-confirmation', emptyRows: 2 },
        { table: 'private_runtime', action: 'purge-runtime-after-confirmation', emptyRows: 3 },
        { table: 'private_remote_cache', action: 'rehydrate-from-source-after-confirmation', emptyRows: 4 },
        { table: 'private_manual', action: 'isolate-for-manual-resolution', emptyRows: 5 },
        { table: 'private_schema', action: 'schema-repair-required', emptyRows: 6 },
      ],
    }),
    inspectManualResolution: () => ({
      ok: true,
      totalCandidates: 5,
      previewFingerprint: 'manual-secret-fingerprint',
      candidates: [{ id: 'private-candidate-id', identity: 'private-row-value' }],
    }),
  };
  return {
    storageAuditService: {
      inspect: () => ({
        ok: true,
        classificationSummary: { unclassifiedTables: 1 },
        tables: [{ name: 'private_storage_table' }],
      }),
    },
    shopScopeRepairPreviewService: scopeService,
    technicalRetentionPreviewService: {
      inspect: () => ({
        ok: true,
        maximumCandidateRows: 7,
        previewFingerprint: 'retention-secret-fingerprint',
        tables: [{ table: 'private_trace_table' }],
      }),
    },
    databaseCompactionService: {
      inspect: () => ({
        ok: true,
        sqlite: { reclaimableBytes: 8192 },
        previewFingerprint: 'compaction-secret-fingerprint',
      }),
    },
  };
}

test('maintenance status emits only value-free user summary fields', () => {
  const service = createMaintenanceStatusService({
    ...createServices(),
    now: () => new Date('2026-07-17T02:03:04.000Z'),
  });

  const status = service.inspect();

  assert.deepEqual(status, {
    ok: true,
    mode: 'read-only-maintenance-status',
    generatedAt: '2026-07-17T02:03:04.000Z',
    unclassifiedTables: 1,
    emptyShopRows: 20,
    manualAssignmentRows: 5,
    safeRepairRows: 5,
    technicalCleanupRows: 7,
    reclaimableBytes: 8192,
    needsAttention: true,
    userActionRequired: true,
  });
  const serialized = JSON.stringify(status);
  for (const privateValue of [
    'private_storage_table',
    'private_assignments',
    'private_trace_table',
    'private-candidate-id',
    'private-row-value',
    'fingerprint',
  ]) {
    assert.equal(serialized.includes(privateValue), false);
  }
});

test('maintenance status stays available when one detailed check fails', () => {
  const services = createServices();
  services.technicalRetentionPreviewService.inspect = () => {
    throw new Error('private technical failure');
  };
  const status = createMaintenanceStatusService({
    ...services,
    now: () => new Date('2026-07-17T02:03:04.000Z'),
  }).inspect();

  assert.equal(status.ok, false);
  assert.equal(status.needsAttention, true);
  assert.equal(status.technicalCleanupRows, 0);
  assert.equal(JSON.stringify(status).includes('private technical failure'), false);
});
