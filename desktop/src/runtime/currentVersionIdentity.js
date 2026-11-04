import fs from 'node:fs';
import path from 'node:path';

const IDENTITY_FILE_NAME = 'current-version.json';

function requiredText(value, field) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`CURRENT_VERSION_IDENTITY_INVALID:${field}`);
  return normalized;
}

function requiredPort(value, field) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`CURRENT_VERSION_IDENTITY_INVALID:${field}`);
  }
  return port;
}

export function loadCurrentVersionIdentity({ desktopRoot }) {
  const identityPath = path.join(desktopRoot, IDENTITY_FILE_NAME);
  let input;
  try {
    input = JSON.parse(fs.readFileSync(identityPath, 'utf8'));
  } catch (error) {
    throw new Error(`CURRENT_VERSION_IDENTITY_UNREADABLE:${identityPath}`, { cause: error });
  }
  if (Number(input?.schemaVersion) !== 1) {
    throw new Error('CURRENT_VERSION_IDENTITY_INVALID:schemaVersion');
  }
  const ports = Object.freeze({
    purchaseBridge: requiredPort(input?.ports?.purchaseBridge, 'ports.purchaseBridge'),
    localApi: requiredPort(input?.ports?.localApi, 'ports.localApi'),
    cacheAgent: requiredPort(input?.ports?.cacheAgent, 'ports.cacheAgent'),
    ozonPushGateway: requiredPort(input?.ports?.ozonPushGateway, 'ports.ozonPushGateway'),
  });
  if (new Set(Object.values(ports)).size !== Object.keys(ports).length) {
    throw new Error('CURRENT_VERSION_IDENTITY_INVALID:ports.duplicate');
  }
  return Object.freeze({
    schemaVersion: 1,
    editionId: requiredText(input?.editionId, 'editionId'),
    displayVersion: requiredText(input?.displayVersion, 'displayVersion'),
    windowTitle: requiredText(input?.windowTitle, 'windowTitle'),
    workspaceFolderName: requiredText(input?.workspaceFolderName, 'workspaceFolderName'),
    sourceDataDirectory: requiredText(input?.sourceDataDirectory, 'sourceDataDirectory'),
    packageOutputDirectory: requiredText(input?.packageOutputDirectory, 'packageOutputDirectory'),
    ports,
    identityPath,
  });
}

export function assertCurrentSourceWorkspace({ identity, workspaceRoot, isPackaged }) {
  if (isPackaged) return;
  const actualFolderName = path.basename(path.resolve(workspaceRoot));
  if (actualFolderName !== identity.workspaceFolderName) {
    throw new Error(
      `CURRENT_VERSION_WORKSPACE_MISMATCH:${actualFolderName}:${identity.workspaceFolderName}`,
    );
  }
}
