function noop() {}

function isUsableWindow(window) {
  return Boolean(window && !window.isDestroyed?.());
}

function rendererRecoveryError(code) {
  return Object.assign(new Error(code), { code });
}

/**
 * Pure lifecycle coordinator. Electron objects are injected by main.js so the
 * hide/restore and power-transition semantics can be tested without booting a
 * renderer or opening a second profile owner.
 */
export function createRuntimeLifecycleController({
  closeToTrayEnabled = true,
  isQuitting = () => false,
  getWindow = () => null,
  createWindow = async () => null,
  onSuspend = async () => undefined,
  onResume = async () => undefined,
  onWindowHidden = noop,
  onWindowRestored = noop,
  onRendererRecoveryFailed = noop,
  maxRendererRecoveryAttempts = 2,
  rendererRecoveryWindowMs = 60_000,
  rendererRecoveryTimeoutMs = 15_000,
  now = () => Date.now(),
  logger = noop,
} = {}) {
  const boundWindows = new WeakSet();
  const rendererStates = new WeakMap();
  const pendingRendererRecoveries = new Set();
  let tray = null;
  let suspended = false;
  let suspendPromise = Promise.resolve();
  let resumePromise = null;
  let restorePromise = null;
  let disposed = false;

  function canHideToTray() {
    return closeToTrayEnabled && !disposed && !isQuitting() && Boolean(tray);
  }

  function bindWindow(window) {
    if (!isUsableWindow(window) || boundWindows.has(window)) return window;
    boundWindows.add(window);
    const rendererState = { gone: false, attempts: [] };
    rendererStates.set(window, rendererState);
    window.on?.('close', (event) => {
      if (!canHideToTray()) return;
      event?.preventDefault?.();
      window.hide?.();
      onWindowHidden();
    });
    window.webContents?.on?.('render-process-gone', (_event, details = {}) => {
      rendererState.gone = true;
      logger('renderer-gone', {
        reason: details.reason || 'unknown',
        exitCode: details.exitCode ?? null,
      });
      // Keep the owned services and in-flight business operations untouched.
      // Recovery is a bounded UI reload only, on the next user activation.
    });
    window.webContents?.on?.('did-finish-load', () => { rendererState.gone = false; });
    return window;
  }

  async function recoverRenderer(window) {
    const state = rendererStates.get(window);
    if (!state?.gone) return;
    const attemptedAt = now();
    state.attempts = state.attempts.filter((time) => attemptedAt - time < rendererRecoveryWindowMs);
    if (state.attempts.length >= maxRendererRecoveryAttempts) {
      throw rendererRecoveryError('DESKTOP_RENDERER_RECOVERY_LIMIT');
    }
    const contents = window.webContents;
    if (typeof contents?.reload !== 'function' || contents.isDestroyed?.()) {
      throw rendererRecoveryError('DESKTOP_RENDERER_RECOVERY_UNAVAILABLE');
    }
    state.attempts.push(attemptedAt);
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        contents.removeListener?.('did-finish-load', onLoaded);
        contents.removeListener?.('did-fail-load', onLoadFailed);
        contents.removeListener?.('render-process-gone', onGone);
        window.removeListener?.('closed', cancel);
        pendingRendererRecoveries.delete(cancel);
        if (error) {
          state.gone = true;
          reject(error);
        } else {
          state.gone = false;
          resolve();
        }
      };
      const onLoaded = () => finish();
      const onLoadFailed = (_event, code, _description, _url, isMainFrame) => {
        if (isMainFrame === false || code === -3) return;
        finish(rendererRecoveryError('DESKTOP_RENDERER_RECOVERY_LOAD_FAILED'));
      };
      const onGone = () => finish(rendererRecoveryError('DESKTOP_RENDERER_RECOVERY_CRASHED'));
      const cancel = () => finish(rendererRecoveryError('DESKTOP_RENDERER_RECOVERY_CANCELLED'));
      const timeout = setTimeout(
        () => finish(rendererRecoveryError('DESKTOP_RENDERER_RECOVERY_TIMEOUT')),
        rendererRecoveryTimeoutMs,
      );
      contents.once('did-finish-load', onLoaded);
      contents.on('did-fail-load', onLoadFailed);
      contents.once('render-process-gone', onGone);
      window.once?.('closed', cancel);
      pendingRendererRecoveries.add(cancel);
      try {
        // Never restart services, reconstruct a purchase task, or repeat an
        // order/payment command as part of renderer crash recovery.
        contents.reload();
      } catch {
        finish(rendererRecoveryError('DESKTOP_RENDERER_RECOVERY_LOAD_FAILED'));
      }
    });
    logger('renderer-recovered', { attempt: state.attempts.length });
  }

  async function restoreWindowOnce() {
    if (disposed || isQuitting()) return null;
    let window = getWindow();
    if (!isUsableWindow(window)) window = await createWindow();
    if (!isUsableWindow(window)) return null;
    bindWindow(window);
    try {
      await recoverRenderer(window);
    } catch (error) {
      if (!disposed && !isQuitting() && error?.code !== 'DESKTOP_RENDERER_RECOVERY_CANCELLED') {
        await Promise.resolve().then(() => onRendererRecoveryFailed(error, window)).catch(() => undefined);
      }
      throw error;
    }
    if (disposed || isQuitting() || !isUsableWindow(window)) return null;
    if (window.isMinimized?.()) window.restore?.();
    window.show?.();
    window.focus?.();
    await onWindowRestored(window);
    return window;
  }

  function restoreWindow() {
    if (restorePromise) return restorePromise;
    restorePromise = restoreWindowOnce().finally(() => { restorePromise = null; });
    return restorePromise;
  }

  function attachTray(nextTray) {
    tray = nextTray || null;
    if (!tray) return null;
    const restoreFromTray = () => {
      void restoreWindow().catch((error) => {
        logger('tray-restore-failed', { message: error?.message || String(error) });
      });
    };
    tray.on?.('click', restoreFromTray);
    tray.on?.('double-click', restoreFromTray);
    return tray;
  }

  function handleSuspend() {
    if (disposed || isQuitting()) return Promise.resolve({ skipped: true });
    if (suspended) return suspendPromise;
    suspended = true;
    suspendPromise = Promise.resolve()
      .then(() => onSuspend())
      .then(
        (result) => ({ ok: true, result }),
        (error) => {
          logger('suspend-failed', { message: error?.message || String(error) });
          return { ok: false, error };
        },
      );
    return suspendPromise;
  }

  function handleResume() {
    if (disposed || isQuitting()) return Promise.resolve({ skipped: true });
    if (resumePromise) return resumePromise;
    resumePromise = Promise.resolve()
      .then(() => suspendPromise)
      .then(() => onResume())
      .then(
        (result) => ({ ok: true, result }),
        (error) => {
          logger('resume-failed', { message: error?.message || String(error) });
          return { ok: false, error };
        },
      )
      .finally(() => {
        suspended = false;
        resumePromise = null;
      });
    return resumePromise;
  }

  function shouldKeepAliveWithoutWindows() {
    // Never strand an invisible process when native Tray creation failed.
    // Without a tray there is no user-owned path to restore a destroyed window.
    return closeToTrayEnabled && Boolean(tray) && !disposed && !isQuitting();
  }

  function dispose() {
    disposed = true;
    tray = null;
    for (const cancel of [...pendingRendererRecoveries]) cancel();
  }

  return Object.freeze({
    attachTray,
    bindWindow,
    restoreWindow,
    handleSuspend,
    handleResume,
    shouldKeepAliveWithoutWindows,
    canHideToTray,
    getStatus() {
      return Object.freeze({
        closeToTrayEnabled,
        trayAttached: Boolean(tray),
        suspended,
        resuming: Boolean(resumePromise),
        disposed,
      });
    },
    dispose,
  });
}
