import { createAccountRemovalProtectionService } from "../backup/accountRemovalProtectionService.js";
import { createRecoveryRemoteClient } from "../backup/recoveryRemoteClient.js";
import { createAppStatusPayload } from "../routes/appStatus.js";
import { createJsonResponse } from "../utils/http.js";
import { createBadJsonPayload, historicalProductImportErrorPayload, historicalProductImportErrorStatus, recoveryCommandErrorCode, recoveryCommandErrorStatus } from "./createAppRouteHelpers.js";

export function createAppMaintenanceRoute({
  accountRemovalOperationRepository,
  assertAccountOwnerWritable,
  automaticMaintenanceScheduler,
  config,
  continuousSyncService,
  dataBackupImportService,
  dataBackupService,
  dataConsistencyAuditService,
  databaseCompactionService,
  domainServices,
  getDatabaseStatus,
  getRecoveryStagingService,
  historicalOrderImportService,
  historicalProductImportService,
  listAppliedMigrations,
  maintenanceStatusService,
  migrationsApplied,
  providedAccountRemovalProtectionService,
  readOwnerWritableJsonRequestBody,
  recoveryBackupOrchestrator,
  recoveryBackupPlanner,
  recoveryFetchImpl,
  recoveryKeysetStore,
  recoveryReconcileState,
  shopScopeRepairPreviewService,
  startedAt,
  storageAuditService,
  technicalArchiveService,
  technicalRetentionPreviewService,
  technicalRetentionRunner,
}) {
  let accountRemovalProtectionService = providedAccountRemovalProtectionService;
  return function handleAppMaintenanceRoute({ corsHeaders, query, req, requestUrl, res }) {
    if (req.method === "GET" && requestUrl.pathname === "/api/app/status") {
      createJsonResponse(
        res,
        200,
        createAppStatusPayload({
          config,
          getDatabaseStatus,
          listAppliedMigrations,
          startedAt,
          migrationsApplied,
        }),
        corsHeaders,
      );
      return true;
    }

    if (
      req.method === "GET" &&
      requestUrl.pathname === "/api/app/maintenance-status"
    ) {
      createJsonResponse(
        res,
        200,
        maintenanceStatusService.inspect(),
        corsHeaders,
      );
      return true;
    }

    if (
      req.method === "GET" &&
      requestUrl.pathname === "/api/app/storage-audit"
    ) {
      createJsonResponse(res, 200, storageAuditService.inspect(), corsHeaders);
      return true;
    }

    if (
      req.method === "GET" &&
      requestUrl.pathname === "/api/app/data-consistency-audit"
    ) {
      createJsonResponse(
        res,
        200,
        dataConsistencyAuditService.inspect(),
        corsHeaders,
      );
      return true;
    }

    if (
      req.method === "GET" &&
      requestUrl.pathname === "/api/app/database-compaction-preview"
    ) {
      createJsonResponse(
        res,
        200,
        databaseCompactionService.inspect(),
        corsHeaders,
      );
      return true;
    }

    if (
      req.method === "POST" &&
      requestUrl.pathname === "/api/app/database-compaction/confirm"
    ) {
      readOwnerWritableJsonRequestBody(req, { maxBytes: 64 * 1024 })
        .then((body) => {
          const result = databaseCompactionService.applyConfirmed({
            confirmation: body?.confirmation,
            previewFingerprint:
              body?.previewFingerprint || body?.preview_fingerprint,
            backupAcknowledged:
              body?.backupAcknowledged === true ||
              body?.backup_acknowledged === true,
          });
          const status = result.ok
            ? 200
            : result.code === "DATABASE_COMPACTION_PREVIEW_STALE"
              ? 409
              : 400;
          createJsonResponse(res, status, result, corsHeaders);
        })
        .catch((error) =>
          createJsonResponse(
            res,
            400,
            createBadJsonPayload(error),
            corsHeaders,
          ),
        );
      return true;
    }

    if (
      req.method === "GET" &&
      requestUrl.pathname === "/api/app/shop-scope-preview"
    ) {
      createJsonResponse(
        res,
        200,
        shopScopeRepairPreviewService.inspect(),
        corsHeaders,
      );
      return true;
    }

    if (
      req.method === "POST" &&
      requestUrl.pathname === "/api/app/shop-scope-repair/confirm"
    ) {
      readOwnerWritableJsonRequestBody(req, { maxBytes: 64 * 1024 })
        .then((body) => {
          const result = shopScopeRepairPreviewService.applyConfirmed({
            confirmation: body?.confirmation,
            previewFingerprint:
              body?.previewFingerprint || body?.preview_fingerprint,
          });
          const status = result.ok
            ? 200
            : result.code === "SHOP_SCOPE_REPAIR_PREVIEW_STALE" ||
                result.code === "SHOP_SCOPE_REPAIR_SCHEMA_DRIFT"
              ? 409
              : 400;
          createJsonResponse(res, status, result, corsHeaders);
        })
        .catch((error) =>
          createJsonResponse(
            res,
            400,
            createBadJsonPayload(error),
            corsHeaders,
          ),
        );
      return true;
    }

    if (
      req.method === "GET" &&
      requestUrl.pathname === "/api/app/shop-scope-manual-preview"
    ) {
      createJsonResponse(
        res,
        200,
        shopScopeRepairPreviewService.inspectManualResolution(),
        corsHeaders,
      );
      return true;
    }

    if (
      req.method === "POST" &&
      requestUrl.pathname === "/api/app/shop-scope-manual-resolution/confirm"
    ) {
      readOwnerWritableJsonRequestBody(req, { maxBytes: 128 * 1024 })
        .then((body) => {
          const result = shopScopeRepairPreviewService.applyManualResolution({
            confirmation: body?.confirmation,
            previewFingerprint:
              body?.previewFingerprint || body?.preview_fingerprint,
            assignments: body?.assignments,
          });
          const status = result.ok
            ? 200
            : result.code === "SHOP_SCOPE_MANUAL_RESOLUTION_PREVIEW_STALE" ||
                result.code === "SHOP_SCOPE_MANUAL_RESOLUTION_SCHEMA_DRIFT"
              ? 409
              : 400;
          createJsonResponse(res, status, result, corsHeaders);
        })
        .catch((error) =>
          createJsonResponse(
            res,
            400,
            createBadJsonPayload(error),
            corsHeaders,
          ),
        );
      return true;
    }

    if (
      req.method === "GET" &&
      requestUrl.pathname === "/api/app/technical-retention-preview"
    ) {
      createJsonResponse(
        res,
        200,
        technicalRetentionPreviewService.inspect(),
        corsHeaders,
      );
      return true;
    }

    if (
      req.method === "GET" &&
      requestUrl.pathname === "/api/app/technical-retention/status"
    ) {
      createJsonResponse(
        res,
        200,
        technicalRetentionRunner.getStatus(),
        corsHeaders,
      );
      return true;
    }

    if (
      req.method === "GET" &&
      requestUrl.pathname === "/api/app/automatic-maintenance/status"
    ) {
      createJsonResponse(
        res,
        200,
        automaticMaintenanceScheduler.getStatus(),
        corsHeaders,
      );
      return true;
    }

    if (
      req.method === "GET" &&
      requestUrl.pathname === "/api/app/technical-archives"
    ) {
      createJsonResponse(
        res,
        200,
        technicalArchiveService.inspect(),
        corsHeaders,
      );
      return true;
    }

    if (
      req.method === "POST" &&
      requestUrl.pathname === "/api/app/technical-retention/confirm"
    ) {
      readOwnerWritableJsonRequestBody(req, { maxBytes: 64 * 1024 })
        .then((body) => {
          const result = technicalRetentionRunner.start({
            confirmation: body?.confirmation,
            previewFingerprint:
              body?.previewFingerprint || body?.preview_fingerprint,
            backupAcknowledged:
              body?.backupAcknowledged === true ||
              body?.backup_acknowledged === true,
          });
          const status = result.ok
            ? 200
            : result.code === "TECHNICAL_RETENTION_PREVIEW_STALE" ||
                result.code === "TECHNICAL_RETENTION_SCHEMA_DRIFT"
              ? 409
              : 400;
          createJsonResponse(res, status, result, corsHeaders);
        })
        .catch((error) =>
          createJsonResponse(
            res,
            400,
            createBadJsonPayload(error),
            corsHeaders,
          ),
        );
      return true;
    }

    if (
      req.method === "GET" &&
      requestUrl.pathname === "/api/app/continuous-sync-status"
    ) {
      createJsonResponse(
        res,
        200,
        {
          ...continuousSyncService.getStatus(),
          hotCache: domainServices.getHotCacheStatus?.() || {},
          shopCache: domainServices.getShopCacheCompatibilityStatus?.() || null,
        },
        corsHeaders,
      );
      return true;
    }
    if (
      req.method === "GET" &&
      requestUrl.pathname === "/api/app/recovery-backup-preview"
    ) {
      const shopId = String(query.shopId || query.shop_id || "").trim();
      const payload = shopId
        ? recoveryBackupPlanner.previewShop(shopId)
        : recoveryBackupPlanner.previewAll();
      createJsonResponse(res, 200, payload, corsHeaders);
      return true;
    }
    if (
      req.method === "GET" &&
      requestUrl.pathname === "/api/app/data-backup-preview"
    ) {
      try {
        const shopId = String(query.shopId || query.shop_id || "").trim();
        const ownerType = String(
          query.ownerType || query.owner_type || "",
        ).trim();
        const ownerId = String(query.ownerId || query.owner_id || "").trim();
        const payload =
          ownerType && ownerId
            ? dataBackupService.previewOwner({ ownerType, ownerId })
            : shopId
              ? dataBackupService.previewShop(shopId)
              : dataBackupService.previewAll();
        createJsonResponse(res, 200, payload, corsHeaders);
      } catch (error) {
        createJsonResponse(
          res,
          String(error?.code || error?.message || "").includes("NOT_FOUND")
            ? 404
            : 400,
          {
            ok: false,
            error: {
              code: String(
                error?.code || error?.message || "DATA_BACKUP_PREVIEW_FAILED",
              ),
              message: error instanceof Error ? error.message : String(error),
            },
          },
          corsHeaders,
        );
      }
      return true;
    }
    if (
      req.method === "GET" &&
      requestUrl.pathname === "/api/app/data-backup-history"
    ) {
      try {
        const ownerType = String(
          query.ownerType || query.owner_type || "",
        ).trim();
        const ownerId = String(query.ownerId || query.owner_id || "").trim();
        const payload =
          ownerType && ownerId
            ? dataBackupService.listOwnerHistory(
                { ownerType, ownerId },
                { limit: query.limit },
              )
            : dataBackupService.listHistory(query.shopId || query.shop_id, {
                limit: query.limit,
              });
        createJsonResponse(res, 200, payload, corsHeaders);
      } catch (error) {
        createJsonResponse(
          res,
          String(error?.code || error?.message || "").includes("NOT_FOUND")
            ? 404
            : 400,
          {
            ok: false,
            error: {
              code: String(
                error?.code || error?.message || "DATA_BACKUP_HISTORY_FAILED",
              ),
              message: error instanceof Error ? error.message : String(error),
            },
          },
          corsHeaders,
        );
      }
      return true;
    }
    if (
      req.method === "POST" &&
      requestUrl.pathname === "/api/app/data-backup-import"
    ) {
      // The request carries only a trusted staging-file reference plus hashes;
      // package size is bounded by local disk, not by this control-message limit.
      readOwnerWritableJsonRequestBody(req, { maxBytes: 128 * 1024 })
        .then((body) => {
          const command = String(body?.command || "").trim();
          if (command === "preflight") {
            const result = dataBackupImportService.preflight(body);
            const targetOwner = result?.targetOwner || result?.target_owner;
            if (targetOwner?.ownerType || targetOwner?.owner_type) {
              assertAccountOwnerWritable(
                targetOwner.ownerType || targetOwner.owner_type,
                targetOwner.ownerId || targetOwner.owner_id,
              );
            } else {
              assertAccountOwnerWritable(
                "ozon_shop",
                result?.targetShop?.shopId || result?.target?.shopId,
              );
            }
            createJsonResponse(res, 200, result, corsHeaders);
            return;
          }
          if (command === "confirm") {
            const targetOwner = body?.targetOwner || body?.target_owner;
            if (targetOwner?.ownerType || targetOwner?.owner_type) {
              assertAccountOwnerWritable(
                targetOwner.ownerType || targetOwner.owner_type,
                targetOwner.ownerId || targetOwner.owner_id,
              );
            } else {
              assertAccountOwnerWritable(
                "ozon_shop",
                body?.targetShopId || body?.target_shop_id,
              );
            }
            createJsonResponse(
              res,
              200,
              dataBackupImportService.confirm(body),
              corsHeaders,
            );
            return;
          }
          throw new Error("DATA_BACKUP_IMPORT_COMMAND_INVALID");
        })
        .catch((error) => {
          const code = recoveryCommandErrorCode(error);
          createJsonResponse(
            res,
            recoveryCommandErrorStatus(code),
            {
              ok: false,
              error: {
                code,
                message: error instanceof Error ? error.message : String(error),
                ...(Number.isInteger(error?.remoteStatus) ? { remoteStatus: error.remoteStatus } : {}),
                ...(typeof error?.safeAuthRetry === 'boolean' ? { safeAuthRetry: error.safeAuthRetry } : {}),
              },
            },
            corsHeaders,
          );
        });
      return true;
    }
    if (
      req.method === "GET" &&
      requestUrl.pathname === "/api/app/data-backup-import-history"
    ) {
      try {
        const ownerType = String(
          query.ownerType || query.owner_type || "",
        ).trim();
        const ownerId = String(query.ownerId || query.owner_id || "").trim();
        createJsonResponse(
          res,
          200,
          ownerType && ownerId
            ? dataBackupImportService.ownerHistory({
                owner: { ownerType, ownerId },
                limit: query.limit,
              })
            : dataBackupImportService.history({
                shopId: query.shopId || query.shop_id,
                limit: query.limit,
              }),
          corsHeaders,
        );
      } catch (error) {
        const code = recoveryCommandErrorCode(error);
        createJsonResponse(
          res,
          recoveryCommandErrorStatus(code),
          {
            ok: false,
            error: {
                code,
                message: error instanceof Error ? error.message : String(error),
                ...(Number.isInteger(error?.remoteStatus) ? { remoteStatus: error.remoteStatus } : {}),
                ...(typeof error?.safeAuthRetry === 'boolean' ? { safeAuthRetry: error.safeAuthRetry } : {}),
              },
          },
          corsHeaders,
        );
      }
      return true;
    }
    if (
      req.method === "POST" &&
      requestUrl.pathname === "/api/app/historical-order-import/preflight"
    ) {
      readOwnerWritableJsonRequestBody(req, { maxBytes: 8 * 1024 * 1024 })
        .then(async (body) =>
          createJsonResponse(
            res,
            200,
            await historicalOrderImportService.preflightWithOzon(body),
            corsHeaders,
          ),
        )
        .catch((error) =>
          createJsonResponse(
            res,
            historicalProductImportErrorStatus(error),
            historicalProductImportErrorPayload(error),
            corsHeaders,
          ),
        );
      return true;
    }
    if (
      req.method === "POST" &&
      requestUrl.pathname === "/api/app/historical-order-import/confirm"
    ) {
      readOwnerWritableJsonRequestBody(req, { maxBytes: 8 * 1024 * 1024 })
        .then((body) =>
          createJsonResponse(
            res,
            200,
            historicalOrderImportService.confirm(body),
            corsHeaders,
          ),
        )
        .catch((error) =>
          createJsonResponse(
            res,
            historicalProductImportErrorStatus(error),
            historicalProductImportErrorPayload(error),
            corsHeaders,
          ),
        );
      return true;
    }
    if (
      req.method === "GET" &&
      requestUrl.pathname === "/api/app/historical-order-import/history"
    ) {
      try {
        createJsonResponse(
          res,
          200,
          historicalOrderImportService.history({
            shopId: query.shopId || query.shop_id,
            limit: query.limit,
          }),
          corsHeaders,
        );
      } catch (error) {
        createJsonResponse(
          res,
          historicalProductImportErrorStatus(error),
          historicalProductImportErrorPayload(error),
          corsHeaders,
        );
      }
      return true;
    }
    if (
      req.method === "POST" &&
      requestUrl.pathname === "/api/app/historical-product-import/preflight"
    ) {
      readOwnerWritableJsonRequestBody(req, { maxBytes: 8 * 1024 * 1024 })
        .then((body) =>
          createJsonResponse(
            res,
            200,
            historicalProductImportService.preflight(body),
            corsHeaders,
          ),
        )
        .catch((error) =>
          createJsonResponse(
            res,
            historicalProductImportErrorStatus(error),
            historicalProductImportErrorPayload(error),
            corsHeaders,
          ),
        );
      return true;
    }
    if (
      req.method === "POST" &&
      requestUrl.pathname === "/api/app/historical-product-import/confirm"
    ) {
      readOwnerWritableJsonRequestBody(req, { maxBytes: 8 * 1024 * 1024 })
        .then((body) =>
          createJsonResponse(
            res,
            200,
            historicalProductImportService.confirm(body),
            corsHeaders,
          ),
        )
        .catch((error) =>
          createJsonResponse(
            res,
            historicalProductImportErrorStatus(error),
            historicalProductImportErrorPayload(error),
            corsHeaders,
          ),
        );
      return true;
    }
    if (
      req.method === "GET" &&
      requestUrl.pathname === "/api/app/historical-product-import/history"
    ) {
      try {
        createJsonResponse(
          res,
          200,
          historicalProductImportService.history({
            shopId: query.shopId || query.shop_id,
            limit: query.limit,
          }),
          corsHeaders,
        );
      } catch (error) {
        createJsonResponse(
          res,
          historicalProductImportErrorStatus(error),
          historicalProductImportErrorPayload(error),
          corsHeaders,
        );
      }
      return true;
    }
    if (
      req.method === "POST" &&
      requestUrl.pathname === "/api/app/recovery/command"
    ) {
      readOwnerWritableJsonRequestBody(req, { maxBytes: 128 * 1024 })
        .then(async (body) => {
          const command = String(body?.command || "").trim();
          if (command === "status") {
            createJsonResponse(
              res,
              200,
              {
                ok: true,
                ...recoveryKeysetStore.getStatus(),
                reconcile: recoveryReconcileState.getStatus(),
              },
              corsHeaders,
            );
            return;
          }
          if (command === "purge-account-owner-protection") {
            const operationId = String(
              body.operationId || body.operation_id || "",
            ).trim();
            const operation =
              accountRemovalOperationRepository.getOperation(operationId);
            const operationPayload = operation?.payload;
            const protectionResourceIds =
              operation?.clientResourceIds.filter(
                (resourceId) =>
                  resourceId.startsWith(
                    "filesystem:recovery-protection-owner-",
                  ) ||
                  resourceId.startsWith("filesystem:diagnostic-logs-owner-"),
              ) || [];
            if (
              !operation ||
              operation.completedAt ||
              !operationPayload?.confirm?.owner ||
              !protectionResourceIds.some((resourceId) =>
                resourceId.startsWith("filesystem:recovery-protection-owner-"),
              )
            ) {
              throw new Error("ACCOUNT_REMOVAL_PROTECTION_OPERATION_INVALID");
            }
            accountRemovalProtectionService ||=
              createAccountRemovalProtectionService({
                activeDatabasePath: config?.database?.path,
                logDirectory: config?.runtime?.logDirectory,
              });
            const result = accountRemovalProtectionService.purgeOwner({
              owner: operationPayload.confirm.owner,
            });
            if (
              result?.verified !== true ||
              result?.diagnosticLogs?.verified !== true
            ) {
              throw new Error("ACCOUNT_REMOVAL_PROTECTION_READBACK_FAILED");
            }
            for (const resourceId of protectionResourceIds) {
              accountRemovalOperationRepository.recordTrustedClientResourceReceipt(
                operationId,
                resourceId,
              );
            }
            createJsonResponse(res, 200, result, corsHeaders);
            return;
          }
          if (command === "prepare-user-data-export") {
            const result = dataBackupService.prepareExport({
              owner: body.owner,
              shopId: body.shopId || body.shop_id,
              expectedDataFingerprint:
                body.expectedDataFingerprint || body.expected_data_fingerprint,
              commitCapability: body.commitCapability || body.commit_capability,
              stagingFileName: body.stagingFileName || body.staging_file_name,
              selectedDomains: body.selectedDomains || body.selected_domains,
            });
            createJsonResponse(res, 200, result, corsHeaders);
            return;
          }
          if (command === "commit-user-data-export") {
            const result = dataBackupService.commitExport({
              backupId: body.backupId || body.backup_id,
              packageSha256: body.packageSha256 || body.package_sha256,
              packageBytes: body.packageBytes || body.package_bytes,
              commitCapability: body.commitCapability || body.commit_capability,
            });
            createJsonResponse(res, 200, result, corsHeaders);
            return;
          }
          if (command === "fail-user-data-export") {
            const result = dataBackupService.failExport({
              backupId: body.backupId || body.backup_id,
              failureCode: body.failureCode || body.failure_code,
              commitCapability: body.commitCapability || body.commit_capability,
            });
            createJsonResponse(res, 200, result, corsHeaders);
            return;
          }
          const remote =
            body?.remote && typeof body.remote === "object" ? body.remote : {};
          const remoteClient = createRecoveryRemoteClient({
            baseUrl: remote.baseUrl,
            accessToken: remote.accessToken,
            fetchImpl: recoveryFetchImpl,
          });
          if (command === "backup-shop") {
            const result = await recoveryBackupOrchestrator.uploadShop({
              shopId: body.shopId || body.shop_id,
              passphrase: body.passphrase,
              remoteClient,
            });
            createJsonResponse(res, 200, result, corsHeaders);
            return;
          }
          if (command === "backup-all-shops") {
            const result = await recoveryBackupOrchestrator.uploadAllShops({
              passphrase: body.passphrase,
              remoteClient,
            });
            createJsonResponse(res, 200, result, corsHeaders);
            return;
          }
          if (command === "purge-account-owner") {
            const operationId = String(
              body.operationId || body.operation_id || "",
            ).trim();
            const operation =
              accountRemovalOperationRepository.getOperation(operationId);
            const operationPayload = operation?.payload;
            const remoteResourceIds =
              operation?.clientResourceIds.filter((resourceId) =>
                resourceId.startsWith("backup:remote-recovery-owner-"),
              ) || [];
            if (
              !operation ||
              operation.completedAt ||
              !operationPayload?.confirm?.owner ||
              !operationPayload.ownerIncarnation ||
              remoteResourceIds.length !== 1
            ) {
              throw new Error("RECOVERY_OWNER_PURGE_OPERATION_INVALID");
            }
            const result = await recoveryBackupOrchestrator.purgeAccountOwner({
              owner: operationPayload.confirm.owner,
              ownerIncarnation: operationPayload.ownerIncarnation,
              remoteClient,
            });
            if (result?.verified !== true) {
              throw new Error("RECOVERY_OWNER_PURGE_READBACK_FAILED");
            }
            accountRemovalOperationRepository.recordTrustedClientResourceReceipt(
              operationId,
              remoteResourceIds[0],
            );
            createJsonResponse(res, 200, result, corsHeaders);
            return;
          }
          if (command === "stage-restore") {
            const result =
              await getRecoveryStagingService().stageRemoteGenerations({
                remoteClient,
                generationIds: Array.isArray(body.generationIds)
                  ? body.generationIds
                  : Array.isArray(body.generation_ids)
                    ? body.generation_ids
                    : [body.generationId || body.generation_id],
                passphrase: body.passphrase,
              });
            createJsonResponse(res, 200, result, corsHeaders);
            return;
          }
          if (command === "list-generations") {
            const generations = await remoteClient.listGenerations();
            createJsonResponse(
              res,
              200,
              { ok: true, generations },
              corsHeaders,
            );
            return;
          }
          createJsonResponse(
            res,
            400,
            {
              ok: false,
              error: {
                code: "RECOVERY_COMMAND_INVALID",
                message: "恢复命令不受支持。",
              },
            },
            corsHeaders,
          );
        })
        .catch((error) => {
          const code = recoveryCommandErrorCode(error);
          createJsonResponse(
            res,
            recoveryCommandErrorStatus(code),
            {
              ok: false,
              error: {
                code,
                message: error instanceof Error ? error.message : String(error),
                ...(Number.isInteger(error?.remoteStatus) ? { remoteStatus: error.remoteStatus } : {}),
                ...(typeof error?.safeAuthRetry === 'boolean' ? { safeAuthRetry: error.safeAuthRetry } : {}),
              },
            },
            corsHeaders,
          );
        });
      return true;
    }
    return false;
  };
}
