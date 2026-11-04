import { createDeploymentReadinessPayload } from "../security/deploymentReadiness.js";
import {
  createPublicRequestContext,
  createRequestContext,
} from "../security/requestContext.js";

export function createHealthPayload({ config, databaseStatus, migrationsApplied = [] }) {
  return {
    ok: true,
    service: 'wangzai-local-api',
    version: '0.1.0',
    status: 'healthy',
    timestamp: new Date().toISOString(),
    runtime: {
      appId: config.runtime?.appId || '',
      profileId: config.runtime?.profileId || '',
      dataRootFingerprint: config.runtime?.dataRootFingerprint || '',
      protocolVersion: config.runtime?.protocolVersion || '',
    },
    server: {
      host: config.server.host,
      port: config.server.port,
    },
    sqlite: {
      ok: databaseStatus.ok,
      journalMode: databaseStatus.journalMode,
      userVersion: databaseStatus.userVersion,
      tables: databaseStatus.tables,
      migrationsApplied,
    },
    requestContext: createPublicRequestContext(createRequestContext()),
    deployment: createDeploymentReadinessPayload(config),
  };
}
