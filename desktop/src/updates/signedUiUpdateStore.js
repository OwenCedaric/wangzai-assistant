import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { uiUpdateHash, validateUiAssetPath, verifyUiBundle, verifyUiManifest } from './signedUiBundle.js';

const CONTRACT = 'wangzai-ui-update-store/v1';
const VERSION_ID = /^[1-9]\d*-[a-f0-9]{24}$/u;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const stat = file => { try { return fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };

function plainDirectory(directory) {
  for (let current = path.resolve(directory);;) {
    const value = stat(current);
    if (!value?.isDirectory() || value.isSymbolicLink()) fail('UI_UPDATE_LINKED_DIRECTORY');
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function readJson(file, maxBytes = 1024 * 1024) {
  const value = stat(file);
  if (!value?.isFile() || value.isSymbolicLink() || value.nlink !== 1 || value.size > maxBytes) fail('UI_UPDATE_FILE_UNSAFE');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function atomicJson(file, value) {
  plainDirectory(path.dirname(file));
  const existing = stat(file);
  if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)) fail('UI_UPDATE_FILE_UNSAFE');
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  // On failure leave only our new temporary evidence; never remove the old pointer.
  fs.renameSync(temporary, file);
}

export function createSignedUiUpdateStore({ directory, publicKey, appId, channel, shellApi = 1, now = Date.now } = {}) {
  const root = path.resolve(directory || '.');
  if (root === path.parse(root).root || !publicKey || !appId || !channel) fail('UI_UPDATE_STORE_CONFIG_INVALID');
  const marker = { contract: CONTRACT, appId, channel, shellApi, keyHash: uiUpdateHash(publicKey) };
  const markerPath = path.join(root, 'ownership.json'), statePath = path.join(root, 'state.json');
  const trust = requireFresh => ({ publicKey, appId, channel, shellApi, now: now(), requireFresh });
  function open() {
    if (!stat(root)) {
      plainDirectory(path.dirname(root));
      fs.mkdirSync(root);
      fs.writeFileSync(markerPath, JSON.stringify(marker), { flag: 'wx', mode: 0o600 });
    }
    plainDirectory(root);
    if (JSON.stringify(readJson(markerPath)) !== JSON.stringify(marker)) fail('UI_UPDATE_STORE_OWNER_MISMATCH');
  }
  function readState() {
    open();
    if (!stat(statePath)) return { active: null, previous: null, pending: null, trial: false, highestSequence: 0, failed: [] };
    const value = readJson(statePath, 16384);
    if (!value || Object.keys(value).sort().join('|') !== ['active','previous','pending','trial','highestSequence','failed'].sort().join('|')
      || !Number.isSafeInteger(value.highestSequence) || value.highestSequence < 0 || typeof value.trial !== 'boolean'
      || !Array.isArray(value.failed) || value.failed.length > 20
      || [value.active, value.previous, value.pending, ...value.failed].some(id => id !== null && (typeof id !== 'string' || !VERSION_ID.test(id)))) fail('UI_UPDATE_STATE_INVALID');
    return value;
  }
  function versionDirectory(id) {
    if (!VERSION_ID.test(id || '')) fail('UI_UPDATE_VERSION_INVALID');
    return path.join(root, id);
  }
  function verifyInstalled(id) {
    const location = versionDirectory(id);
    plainDirectory(location);
    const envelope = readJson(path.join(location, 'manifest.json'));
    const verified = verifyUiManifest(envelope, trust(false));
    if (verified.id !== id) fail('UI_UPDATE_VERSION_MISMATCH');
    const allowed = new Set(['manifest.json', ...verified.manifest.files.map(file => file.path)]);
    const stack = [location];
    while (stack.length) {
      const folder = stack.pop();
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        const target = path.join(folder, entry.name);
        if (entry.isSymbolicLink()) fail('UI_UPDATE_LINKED_DIRECTORY');
        if (entry.isDirectory()) { stack.push(target); continue; }
        if (!entry.isFile() || !allowed.has(path.relative(location, target).replaceAll('\\', '/'))) fail('UI_UPDATE_EXTRA_FILE');
      }
    }
    for (const file of verified.manifest.files) readAssetFromVerified(location, file);
    return { ...verified, directory: location };
  }
  function readAssetFromVerified(location, file) {
    const target = path.join(location, validateUiAssetPath(file.path));
    plainDirectory(path.dirname(target));
    const metadata = stat(target);
    if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size !== file.bytes) fail('UI_UPDATE_ASSET_UNSAFE');
    const bytes = fs.readFileSync(target);
    if (uiUpdateHash(bytes) !== file.sha256) fail('UI_UPDATE_ASSET_HASH_MISMATCH');
    return bytes;
  }
  function stage(bundle) {
    const verified = verifyUiBundle(bundle, trust(true));
    const state = readState();
    if (verified.manifest.sequence <= state.highestSequence) fail('UI_UPDATE_DOWNGRADE_OR_REPLAY');
    const staging = path.join(root, `staging-${randomUUID()}`), destination = versionDirectory(verified.id);
    // A previous pointer-write failure may leave a complete signed version.
    // Verify and reuse that owned version; never overwrite/adopt partial data.
    if (stat(destination)) {
      verifyInstalled(verified.id);
      atomicJson(statePath, { ...state, pending: verified.id, highestSequence: verified.manifest.sequence });
      return { staged: true, id: verified.id, sequence: verified.manifest.sequence, activated: false, resumed: true };
    }
    let used = 0;
    const scan = [root];
    while (scan.length) {
      for (const entry of fs.readdirSync(scan.pop(), { withFileTypes: true })) {
        const target = path.join(entry.parentPath || entry.path, entry.name);
        if (entry.isSymbolicLink()) fail('UI_UPDATE_LINKED_DIRECTORY');
        if (entry.isDirectory()) scan.push(target);
        else if (entry.isFile()) used += fs.statSync(target).size;
      }
    }
    if (used + verified.totalBytes > 400 * 1024 * 1024) fail('UI_UPDATE_STORAGE_BUDGET_EXCEEDED');
    fs.mkdirSync(staging);
    for (const [relative, bytes] of verified.assets) {
      const target = path.join(staging, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const fd = fs.openSync(target, 'wx', 0o600);
      try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    atomicJson(path.join(staging, 'manifest.json'), verified.envelope);
    fs.renameSync(staging, destination);
    verifyInstalled(verified.id);
    atomicJson(statePath, { ...state, pending: verified.id, highestSequence: verified.manifest.sequence });
    return { staged: true, id: verified.id, sequence: verified.manifest.sequence, activated: false };
  }
  function prepareBoot() {
    let state = readState();
    let rolledBack = false;
    let rejectedPending = null;
    if (state.trial) {
      state = { ...state, active: state.previous, previous: null, trial: false,
        failed: [...state.failed, state.active].filter(Boolean).slice(-20) };
      rolledBack = true;
      atomicJson(statePath, state);
    }
    if (state.active) {
      try { verifyInstalled(state.active); } catch {
        const invalid = state.active;
        let fallback = state.previous;
        try { if (fallback) verifyInstalled(fallback); } catch { fallback = null; }
        state = { ...state, active: fallback, previous: null, trial: false,
          failed: [...state.failed, invalid].slice(-20) };
        rolledBack = true;
        atomicJson(statePath, state);
      }
    }
    if (state.pending) {
      try {
        verifyUiManifest(readJson(path.join(versionDirectory(state.pending), 'manifest.json')), trust(true));
        verifyInstalled(state.pending);
        state = { ...state, previous: state.active, active: state.pending, pending: null, trial: true };
      } catch (error) {
        rejectedPending = error.code || 'UI_UPDATE_PENDING_INVALID';
        state = { ...state, failed: [...state.failed, state.pending].slice(-20), pending: null };
      }
      atomicJson(statePath, state);
    }
    return { id: state.active, trial: state.trial, rolledBack, rejectedPending,
      ...(state.active ? { directory: verifyInstalled(state.active).directory } : { directory: null }) };
  }
  function markHealthy(id) {
    const state = readState();
    if (!state.trial || state.active !== id) fail('UI_UPDATE_HEALTH_RECEIPT_MISMATCH');
    verifyInstalled(id);
    atomicJson(statePath, { ...state, trial: false });
    // Keep current, previous, pending, and failed candidates. Only obsolete,
    // completely verified program-only versions may be removed automatically.
    const protectedIds = new Set([state.active, state.previous, state.pending, ...state.failed]);
    const removed = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!VERSION_ID.test(entry.name) || protectedIds.has(entry.name)) continue;
      try {
        open();
        const candidate = verifyInstalled(entry.name).directory;
        if (path.dirname(candidate) !== root) fail('UI_UPDATE_PATH_ESCAPE');
        fs.rmSync(candidate, { recursive: true, force: false });
        removed.push(entry.name);
      } catch { /* uncertain/changed/failed artifacts remain, bounded by staging budget */ }
    }
    return { healthy: true, id, removedObsoleteVersions: removed };
  }
  function readAsset(id, relative) {
    const location = versionDirectory(id);
    const { manifest, id: verifiedId } = verifyUiManifest(readJson(path.join(location, 'manifest.json')), trust(false));
    if (id !== verifiedId) fail('UI_UPDATE_VERSION_MISMATCH');
    const file = manifest.files.find(item => item.path === relative);
    if (!file) fail('UI_UPDATE_ASSET_NOT_LISTED');
    return readAssetFromVerified(location, file);
  }
  return Object.freeze({ stage, prepareBoot, markHealthy, readAsset, status: readState });
}
