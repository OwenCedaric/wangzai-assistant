import { openDatabase } from "../../db/database.js";
import { createProductRepository } from "../../db/repositories/productRepository.js";
import { createProductSyncRunRepository } from "../../db/repositories/productSyncRunRepository.js";
import { createSyncJobService } from "../../sync/syncJobService.js";
import { createSyncSnapshotService } from "../../sync/syncSnapshotService.js";
import { createSyncStateService } from "../../sync/syncStateService.js";
import { activateStagedProductSync } from "./productSyncService.js";

export function runProductAtomicActivation(input = {}) {
  const database = input.database || {};
  if (!String(database.path || "").trim()) {
    throw new Error("PRODUCT_SYNC_ACTIVATION_DATABASE_PATH_REQUIRED");
  }
  const db = openDatabase({ database });
  try {
    return activateStagedProductSync(
      {
        db,
        repository: createProductRepository(db),
        jobService: createSyncJobService(db),
        snapshotService: createSyncSnapshotService(db),
        stateService: createSyncStateService(db),
        atomicRunRepository: createProductSyncRunRepository(db),
      },
      input.activation,
    );
  } finally {
    db.close();
  }
}

function sendAndClose(message, exitCode = 0) {
  if (typeof process.send !== "function") return;
  process.send(message, (error) => {
    if (error) {
      process.stderr.write(`PRODUCT_SYNC_ACTIVATION_IPC_SEND_FAILED:${error.message}\n`);
      process.exitCode = 1;
      process.disconnect?.();
      setImmediate(() => process.exit(1));
      return;
    }
    process.disconnect?.();
    process.exitCode = exitCode;
    // Do not let the short empty-page activation process fall out of the event
    // loop in the same turn as IPC delivery. Exit only after Node confirms the
    // result frame was flushed to the parent.
    setImmediate(() => process.exit(exitCode));
  });
}

if (typeof process.send === "function") {
  process.once("message", (input) => {
    process.send?.({
      type: "started",
      runId: input?.activation?.atomicRunId || null,
      pid: process.pid,
    });
    try {
      const result = runProductAtomicActivation(input);
      sendAndClose({ type: "result", ok: true, result });
    } catch (error) {
      sendAndClose(
        {
          type: "result",
          ok: false,
          error: {
            code: error?.code || "PRODUCT_SYNC_ACTIVATION_PROCESS_FAILED",
            message: error instanceof Error ? error.message : String(error),
            stack: error?.stack || "",
          },
        },
        1,
      );
    }
  });
}
