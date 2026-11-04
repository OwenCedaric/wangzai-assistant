/**
 * Static evidence only: every historical browser-storage runtime has been
 * removed. This module contains no browser API calls, listeners or user data.
 */
export const RETIRED_BROWSER_STORAGE_AUDIT = Object.freeze({
  profileResource: 'browser:external-chrome-extension-profile-unattributed',
  storageResource: 'browser:external-chrome-extension-storage-unattributed',
  contentSnapshotResource: 'memory:external-chrome-content-snapshots',
  contentPollerResource: 'runtime:external-chrome-content-pollers',
  popupSnapshotResource: 'memory:external-chrome-popup-snapshots',
  mirrorResource: 'memory:renderer-browser-local-storage-mirror-retired',
  telemetryResource: 'runtime:renderer-legacy-browser-read-telemetry-retired',
  readListenerResource: 'runtime:renderer-legacy-browser-read-listeners-retired',
  auditKeysResource: 'memory:static:frontend-src-services-browser-legacy-read-store:legacy-browser-audit-keys-retired',
  state: 'removed-no-runtime-state',
});
