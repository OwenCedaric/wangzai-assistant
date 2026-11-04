const SAFE_REPAIR_ACTIONS = new Set([
  'assign-after-confirmation',
  'purge-runtime-after-confirmation',
]);

function nonNegativeInteger(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function inspectSafely(service, method = 'inspect') {
  try {
    const result = service?.[method]?.();
    return result && typeof result === 'object' ? result : null;
  } catch {
    return null;
  }
}

function safeRepairRows(scopePreview) {
  if (!Array.isArray(scopePreview?.tables)) return 0;
  return scopePreview.tables.reduce((total, table) => (
    SAFE_REPAIR_ACTIONS.has(table?.action)
      ? total + nonNegativeInteger(table?.emptyRows)
      : total
  ), 0);
}

/**
 * Value-free summary for the renderer status observer. The detailed maintenance
 * previews stay behind their existing routes; this service intentionally emits
 * no table names, row identities, fingerprints or repair instructions.
 */
export function createMaintenanceStatusService({
  storageAuditService,
  shopScopeRepairPreviewService,
  technicalRetentionPreviewService,
  databaseCompactionService,
  now = () => new Date(),
} = {}) {
  if (!storageAuditService) throw new Error('createMaintenanceStatusService requires storageAuditService.');
  if (!shopScopeRepairPreviewService) throw new Error('createMaintenanceStatusService requires shopScopeRepairPreviewService.');
  if (!technicalRetentionPreviewService) throw new Error('createMaintenanceStatusService requires technicalRetentionPreviewService.');
  if (!databaseCompactionService) throw new Error('createMaintenanceStatusService requires databaseCompactionService.');

  function inspect() {
    const storageAudit = inspectSafely(storageAuditService);
    const scopePreview = inspectSafely(shopScopeRepairPreviewService);
    const manualPreview = inspectSafely(shopScopeRepairPreviewService, 'inspectManualResolution');
    const technicalPreview = inspectSafely(technicalRetentionPreviewService);
    const compactionPreview = inspectSafely(databaseCompactionService);
    const checks = [
      storageAudit,
      scopePreview,
      manualPreview,
      technicalPreview,
      compactionPreview,
    ];
    const ok = checks.every((result) => result?.ok === true);
    const unclassifiedTables = nonNegativeInteger(
      storageAudit?.classificationSummary?.unclassifiedTables,
    );
    const emptyShopRows = nonNegativeInteger(scopePreview?.totalEmptyRows);
    const manualAssignmentRows = nonNegativeInteger(manualPreview?.totalCandidates);
    const repairRows = safeRepairRows(scopePreview);
    const technicalCleanupRows = nonNegativeInteger(technicalPreview?.maximumCandidateRows);
    const reclaimableBytes = nonNegativeInteger(compactionPreview?.sqlite?.reclaimableBytes);
    const needsAttention = !ok
      || unclassifiedTables > 0
      || emptyShopRows > 0
      || technicalCleanupRows > 0
      || reclaimableBytes > 0;

    return {
      ok,
      mode: 'read-only-maintenance-status',
      generatedAt: new Date(now()).toISOString(),
      unclassifiedTables,
      emptyShopRows,
      manualAssignmentRows,
      safeRepairRows: repairRows,
      technicalCleanupRows,
      reclaimableBytes,
      needsAttention,
      userActionRequired: manualAssignmentRows > 0,
    };
  }

  return { inspect };
}
