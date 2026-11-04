import fs from 'node:fs';
import path from 'node:path';

export const BUILT_IN_CEF_ADDON = Object.freeze({
  version: '1.1.0',
  sha256: '091aabc7e0b671eb395748527cccb6456652af130406651fcf24a289226b0800',
  geckoId: 'purchase-browser@wangzai.local',
  // Keep local-api's established 32-character audit identifier stable.
  extensionId: 'ajkbnfmdnjfbiamkokbpijmlohjancdl',
});

export const BUILT_IN_CROSS_BORDER_ADDON = Object.freeze({
  version: '1.0.0',
  sha256: '03068bc18f3b8e3c8af08e48b45dccd0e6bd57b870696ed1ab24333c1141ab5e',
  geckoId: 'cross-border-bus@wangzai.local',
  extensionId: 'cross-border-bus@wangzai.local',
});

function ownerPath(root, ownerRef) {
  if (!/^[a-f0-9]{40}$/u.test(String(ownerRef || ''))) {
    const error = new Error('PURCHASE_BROWSER_OWNER_REF_INVALID');
    error.code = error.message;
    throw error;
  }
  return path.join(root, String(ownerRef) + '.json');
}

export function createPurchaseBrowserBuiltinManager({ cacheRoot } = {}) {
  const root = path.resolve(String(cacheRoot || ''));
  const statesRoot = path.join(root, 'owner-states');
  function readState(ownerRef) {
    const filePath = ownerPath(statesRoot, ownerRef);
    if (!fs.existsSync(filePath)) return { version: 1, activeSha: '', previousSha: '', addons: [] };
    try {
      const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return {
        version: 1,
        activeSha: '',
        previousSha: '',
        addons: Array.isArray(value?.addons) ? value.addons : [],
      };
    } catch {
      return { version: 1, activeSha: '', previousSha: '', addons: [] };
    }
  }
  function purgeOwner(ownerRef) {
    const filePath = ownerPath(statesRoot, ownerRef);
    fs.rmSync(filePath, { force: true });
    return !fs.existsSync(filePath);
  }
  return Object.freeze({ purgeOwner, readState });
}
