import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

const OWNER_REF_PATTERN = /^[a-f0-9]{40}$/u;
const GIB = 1024 * 1024 * 1024;
const LEGACY_CACHE_DIRECTORIES = Object.freeze([
  'Cache', 'Code Cache', 'GPUCache', 'GrShaderCache', 'ShaderCache',
  'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'Service Worker/CacheStorage',
]);
const AUTOMATIC_CACHE_DIRECTORIES = Object.freeze(
  LEGACY_CACHE_DIRECTORIES.filter((name) => name !== 'Service Worker/CacheStorage'),
);
const workersByRoot = new Map();
const errorCode = (error) => String(error?.code || 'PURCHASE_BROWSER_CACHE_PRUNE_FAILED');
const pathKey = (value) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const inside = (root, value) => {
  const relative = path.relative(root, value);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
};

function fail(code) { throw Object.assign(new Error(code), { code }); }
function rootPath(value) {
  if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) fail('PURCHASE_BROWSER_CEF_ROOT_CACHE_REQUIRED');
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) fail('PURCHASE_BROWSER_CEF_ROOT_CACHE_INVALID');
  return resolved;
}
function nonnegative(value, fallback, name) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) fail(`PURCHASE_BROWSER_CACHE_${name}_INVALID`);
  return value;
}

function statOrMissing(value) {
  try { return fs.lstatSync(value); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

// Validate every existing ancestor, including the selected root itself. A
// string prefix alone does not protect Service Worker/CacheStorage when its
// parent is a junction. These checks never read file contents.
function plainDirectory(value) {
  const resolved = path.resolve(value);
  const volume = path.parse(resolved).root;
  let current = volume;
  for (const part of path.relative(volume, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()
      || pathKey(fs.realpathSync(current)) !== pathKey(current)) fail('PURCHASE_BROWSER_CACHE_LINKED_PATH_REJECTED');
  }
  return fs.lstatSync(resolved);
}

function directorySnapshot(directory, { rejectLinks = false } = {}) {
  const rootStat = fs.lstatSync(directory);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail('PURCHASE_BROWSER_CACHE_LINKED_PATH_REJECTED');
  const stack = [directory];
  let bytes = 0;
  let latestModifiedMs = rootStat.mtimeMs;
  while (stack.length) {
    const current = stack.pop();
    for (const name of fs.readdirSync(current)) {
      const entry = path.join(current, name);
      const stat = fs.lstatSync(entry);
      latestModifiedMs = Math.max(latestModifiedMs, stat.mtimeMs);
      if (stat.isSymbolicLink()) {
        if (rejectLinks) fail('PURCHASE_BROWSER_CACHE_LINKED_PATH_REJECTED');
        continue;
      }
      if (stat.isDirectory()) stack.push(entry);
      else if (stat.isFile()) bytes += stat.size;
      else if (rejectLinks) fail('PURCHASE_BROWSER_CACHE_SPECIAL_FILE_REJECTED');
    }
  }
  return { bytes, latestModifiedMs, device: rootStat.dev, inode: rootStat.ino };
}

/**
 * Caller must exclusively own an idle CEF root until this call/worker exits.
 * Legacy hardLimitBytes/targetBytes keep their whole-root budget contract.
 * automatic:true (or explicit cache* budgets) measures allowlisted caches only.
 * Automatic mode deliberately excludes Service Worker offline CacheStorage.
 * activeProfileRefs names physical CachePath directories (storageRef), not a
 * collector/interactive tab's possibly different logical ownerRef.
 */
export function pruneCefTransientCache(options = {}) {
  const root = rootPath(options.rootCachePath);
  const automatic = options.automatic === true;
  const cacheBudget = automatic || options.cacheHardLimitBytes !== undefined || options.cacheTargetBytes !== undefined;
  const hardLimit = nonnegative(cacheBudget ? options.cacheHardLimitBytes : options.hardLimitBytes, 2 * GIB, 'HARD_LIMIT');
  const target = nonnegative(cacheBudget ? options.cacheTargetBytes : options.targetBytes, Math.min(1280 * 1024 * 1024, hardLimit), 'TARGET');
  if (target > hardLimit) fail('PURCHASE_BROWSER_CACHE_TARGET_EXCEEDS_LIMIT');
  const maxAgeMs = options.maxAgeMs === undefined ? null : nonnegative(options.maxAgeMs, null, 'MAX_AGE');
  const nowMs = nonnegative(options.nowMs, Date.now(), 'NOW');
  const activeRefs = options.activeProfileRefs ?? [];
  if (!Array.isArray(activeRefs) || activeRefs.some((ref) => ref !== '_global' && !OWNER_REF_PATTERN.test(ref))) fail('PURCHASE_BROWSER_CACHE_ACTIVE_PROFILE_INVALID');
  const active = new Set(activeRefs);
  if (active.size) active.add('_global');
  const mode = cacheBudget ? 'allowlisted-transient-cache' : 'legacy-whole-cef-root';
  if (!statOrMissing(root)) return { ok: true, mode, beforeBytes: 0, afterBytes: 0, cacheBeforeBytes: 0, cacheAfterBytes: 0, removed: 0, targetReached: true, triggered: false, errors: [], skippedActiveProfiles: 0 };
  plainDirectory(root);
  const directories = automatic ? AUTOMATIC_CACHE_DIRECTORIES : LEGACY_CACHE_DIRECTORIES;
  const candidates = [];
  const errors = [];
  let skippedActiveProfiles = 0;
  for (const profileRef of fs.readdirSync(root)) {
    if (profileRef !== '_global' && !OWNER_REF_PATTERN.test(profileRef)) continue;
    if (active.has(profileRef)) { skippedActiveProfiles++; continue; }
    const profile = path.join(root, profileRef);
    try { plainDirectory(profile); }
    catch (error) { errors.push({ profileRef, code: errorCode(error) }); continue; }
    for (const resource of directories) {
      const candidate = path.resolve(profile, ...resource.split('/'));
      if (!inside(root, candidate) || !inside(profile, candidate)) fail('PURCHASE_BROWSER_CACHE_PATH_ESCAPE');
      try {
        if (!statOrMissing(candidate)) continue;
        plainDirectory(candidate);
        candidates.push({ path: candidate, profileRef, resource, ...directorySnapshot(candidate, { rejectLinks: true }) });
      } catch (error) { errors.push({ profileRef, resource, code: errorCode(error) }); }
    }
  }
  candidates.sort((left, right) => left.latestModifiedMs - right.latestModifiedMs || left.path.localeCompare(right.path));
  const cacheBeforeBytes = candidates.reduce((sum, candidate) => sum + candidate.bytes, 0);
  const beforeBytes = cacheBudget ? cacheBeforeBytes : directorySnapshot(root).bytes;
  let afterBytes = beforeBytes;
  let cacheAfterBytes = cacheBeforeBytes;
  let removed = 0;
  let expiredRemoved = 0;
  const capacityTriggered = beforeBytes > hardLimit;
  const expired = (candidate) => maxAgeMs !== null && candidate.latestModifiedMs <= nowMs - maxAgeMs;
  const ageTriggered = candidates.some(expired);
  for (const candidate of candidates) {
    const forAge = expired(candidate);
    if (!forAge && (!capacityTriggered || afterBytes <= target)) continue;
    try {
      // Recheck all parent paths and object identity immediately before rm.
      plainDirectory(root);
      plainDirectory(candidate.path);
      const current = directorySnapshot(candidate.path, { rejectLinks: true });
      if (current.device !== candidate.device || current.inode !== candidate.inode) fail('PURCHASE_BROWSER_CACHE_RESOURCE_CHANGED');
      if (forAge && (!capacityTriggered || afterBytes <= target) && !expired(current)) continue;
      fs.rmSync(candidate.path, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
      if (statOrMissing(candidate.path)) fail('PURCHASE_BROWSER_CACHE_DELETE_UNVERIFIED');
      removed++;
      if (forAge) expiredRemoved++;
      afterBytes = Math.max(0, afterBytes - candidate.bytes);
      cacheAfterBytes = Math.max(0, cacheAfterBytes - candidate.bytes);
    } catch (error) { errors.push({ profileRef: candidate.profileRef, resource: candidate.resource, code: errorCode(error) }); }
  }
  // Report observed remaining bytes, never just arithmetic estimates of what
  // rm was supposed to reclaim. Do not read any browser storage contents.
  cacheAfterBytes = 0;
  for (const candidate of candidates) {
    try {
      if (!statOrMissing(candidate.path)) continue;
      plainDirectory(candidate.path);
      cacheAfterBytes += directorySnapshot(candidate.path, { rejectLinks: true }).bytes;
    } catch (error) { errors.push({ profileRef: candidate.profileRef, resource: candidate.resource, code: errorCode(error) }); }
  }
  if (cacheBudget) afterBytes = cacheAfterBytes;
  else {
    try { plainDirectory(root); afterBytes = directorySnapshot(root).bytes; }
    catch (error) { errors.push({ code: errorCode(error) }); }
  }
  const targetReached = afterBytes <= target;
  const ok = errors.length === 0 && (!capacityTriggered || targetReached);
  return {
    ok, mode, beforeBytes, afterBytes, cacheBeforeBytes, cacheAfterBytes,
    protectedBytes: cacheBudget ? null : Math.max(0, beforeBytes - cacheBeforeBytes),
    removed, expiredRemoved, targetReached, triggered: capacityTriggered || ageTriggered,
    capacityTriggered, ageTriggered, skippedActiveProfiles, errors,
    partial: !ok && removed > 0,
    ...(!ok && !errors.length ? { code: 'PURCHASE_BROWSER_CACHE_BUDGET_NOT_REACHABLE' } : {}),
  };
}

// A posted result is not a worker-exit receipt. In particular, terminate()
// requests cancellation but filesystem work may still be unwinding. The idle
// admission fence must not be released before actual exit/terminate completion.
export function pruneCefTransientCacheInWorker(options = {}, dependencies = {}) {
  const root = rootPath(options.rootCachePath);
  const signal = dependencies.signal;
  if (signal && (typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) fail('PURCHASE_BROWSER_CACHE_ABORT_SIGNAL_INVALID');
  const abortedWithoutWorker = () => ({ ok: false, cancelled: true, removed: null,
    mutationOutcome: 'unknown', exitVerified: true, started: false, code: 'PURCHASE_BROWSER_CACHE_PRUNE_CANCELLED' });
  const active = workersByRoot.get(pathKey(root));
  if (active) {
    const abort = () => active.cancel();
    if (signal?.aborted) abort();
    else if (signal) {
      signal.addEventListener('abort', abort, { once: true });
      void active.promise.finally(() => signal.removeEventListener('abort', abort));
    }
    return active.promise;
  }
  if (signal?.aborted) return Promise.resolve(abortedWithoutWorker());
  const createWorker = dependencies.createWorker || ((url, config) => new Worker(url, config));
  const schedule = dependencies.schedule || setTimeout;
  const cancel = dependencies.cancel || clearTimeout;
  const timeoutMs = nonnegative(options.workerTimeoutMs, 90_000, 'WORKER_TIMEOUT');
  let worker;
  try { worker = createWorker(new URL('./cefCachePruneWorker.js', import.meta.url), { workerData: { ...options, rootCachePath: root } }); }
  catch (error) { return Promise.resolve({ ok: false, removed: 0, code: errorCode(error), exitVerified: true, started: false }); }
  let cancelWork;
  const completion = new Promise((resolve) => {
    let reported = null;
    let failure = null;
    let timedOut = false;
    let cancelled = false;
    let terminating = false;
    let settled = false;
    let timer;
    const finishAfterExit = (exitCode) => {
      if (settled) return;
      settled = true;
      cancel(timer);
      signal?.removeEventListener('abort', abort);
      if (cancelled) {
        resolve({ ok: false, cancelled: true, removed: null, timedOut,
          mutationOutcome: 'unknown', exitVerified: true, exitCode, code: 'PURCHASE_BROWSER_CACHE_PRUNE_CANCELLED' });
        return;
      }
      if (!timedOut && !failure && exitCode === 0 && reported) resolve({ ...reported, exitVerified: true });
      else resolve({ ok: false, removed: reported?.removed ?? null, timedOut, exitVerified: true,
        code: timedOut ? 'PURCHASE_BROWSER_CACHE_PRUNE_TIMEOUT' : errorCode(failure || { code: 'PURCHASE_BROWSER_CACHE_WORKER_EXIT_FAILED' }),
        mutationOutcome: reported ? 'reported-before-exit' : 'unknown', exitCode });
    };
    const stopWorker = (reason) => {
      if (settled) return;
      if (reason === 'cancel') cancelled = true;
      if (reason === 'timeout') timedOut = true;
      if (terminating) return;
      terminating = true;
      try { Promise.resolve(worker.terminate()).then(finishAfterExit, (error) => { failure = error; }); }
      catch (error) { failure = error; }
    };
    const abort = () => stopWorker('cancel');
    cancelWork = abort;
    worker.once('message', (result) => { reported = result; });
    worker.once('error', (error) => { failure = error; });
    worker.once('exit', finishAfterExit);
    timer = schedule(() => stopWorker('timeout'), timeoutMs);
    timer?.unref?.();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
  const tracked = completion.finally(() => {
    if (workersByRoot.get(pathKey(root))?.promise === tracked) workersByRoot.delete(pathKey(root));
  });
  workersByRoot.set(pathKey(root), { promise: tracked, cancel: cancelWork });
  return tracked;
}
