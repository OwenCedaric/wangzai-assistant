import { calculatePurchaseBrowserWindowBounds } from './purchaseBrowserWindowGeometry.js';

function usableWindow(value) {
  return Boolean(value && !value.isDestroyed?.());
}

function sameBounds(left, right) {
  return Boolean(left && right && ['x', 'y', 'width', 'height', 'visible'].every((field) => left[field] === right[field]));
}

/**
 * Presentation adapter for the native CEF window.
 *
 * This deliberately does not create a BrowserWindow or paint an Electron
 * shell.  The Electron main window is only the owner/IPC endpoint; CEF
 * owns the visible browser chrome and page in one native HWND. Embedded
 * rectangles are Electron client-area coordinates for a real WS_CHILD; only
 * standalone login/settings windows use desktop screen coordinates.
 */
export function createPurchaseBrowserCefWindowController({
  screen,
  getParentWindow = () => null,
  onBoundsChanged = () => undefined,
  appendLog = () => undefined,
} = {}) {
  let browserVisible = false;
  let disposed = false;
  let lastBounds = null;
  let boundsVersion = 0;
  let embeddedViewport = null;
  let observedParent = null;
  const parentEvents = ['resize', 'maximize', 'unmaximize', 'restore', 'minimize', 'show', 'hide'];

  function parentWindow() {
    const parent = getParentWindow();
    return usableWindow(parent) ? parent : null;
  }

  function detachParentEvents() {
    if (!observedParent) return;
    for (const eventName of parentEvents) observedParent.removeListener?.(eventName, notifyBoundsFromParent);
    observedParent = null;
  }

  function notifyBoundsFromParent() {
    lastBounds = null;
    void notifyBounds().catch(() => undefined);
  }

  function attachParentEvents(parent) {
    if (observedParent === parent) return;
    detachParentEvents();
    observedParent = parent;
    for (const eventName of parentEvents) parent.on?.(eventName, notifyBoundsFromParent);
  }

  function nativeBounds({ visible = browserVisible } = {}) {
    const parent = parentWindow();
    if (!parent) return { x: 0, y: 0, width: 1, height: 1, visible: false, boundsVersion };
    const parentBounds = parent.getBounds?.() || { x: 0, y: 0, width: 1280, height: 800 };
    const embedded = embeddedViewport?.visible !== false ? embeddedViewport : null;
    const embeddedDip = embedded
      ? {
          x: embedded.x,
          y: embedded.y,
          width: embedded.width,
          height: embedded.height,
        }
      : null;
    const display = screen?.getDisplayMatching?.(parentBounds) || {};
    const dip = embeddedDip || calculatePurchaseBrowserWindowBounds({
      workArea: display.workArea,
      parentBounds,
    });
    // Electron DOM/client coordinates are DIP. The sidecar is per-monitor DPI
    // aware and Win32 SetWindowPos expects physical pixels for both top-level
    // screen rectangles and child-client rectangles.
    const scale = Math.max(1, Number(display.scaleFactor) || 1);
    // Desired browser visibility is independent from Electron presentation.
    // An embedded WS_CHILD is suppressed by Windows together with its parent,
    // while a standalone CEF Form owns its own taskbar/window lifecycle. Do not
    // convert either case to visible=false merely because Electron is hidden or
    // minimized; that used to hide a freshly opened standalone login window.
    const next = {
      x: Math.floor(dip.x * scale),
      y: Math.floor(dip.y * scale),
      width: Math.max(embedded ? 320 : 640, Math.floor(dip.width * scale)),
      height: Math.max(embedded ? 240 : 480, Math.floor(dip.height * scale)),
      visible: visible === true && browserVisible,
      boundsVersion,
    };
    return next;
  }

  function notifyBounds() {
    if (disposed) return Promise.resolve(null);
    const next = nativeBounds();
    if (sameBounds(lastBounds, next)) return Promise.resolve(next);
    lastBounds = next;
    return Promise.resolve(onBoundsChanged({ ...next })).catch((error) => {
      const code = String(error?.code || error?.message || 'unknown');
      appendLog(
        'desktop-main',
        '[purchase-browser-native] bounds sync failed code='
          + code + '\n',
      );
      // Closing, hiding and force-resetting the browser intentionally cancel
      // older queued bounds work.  That cancellation is a lifecycle result,
      // not a renderer failure, and must never escape as an unhandled promise.
      if (
        disposed
        || code === 'PURCHASE_BROWSER_COMMAND_CANCELLED'
        || code === 'PURCHASE_BROWSER_COMMAND_SUPERSEDED'
      ) return next;
      throw error;
    });
  }

  async function ensure() {
    const parent = parentWindow();
    if (!parent) {
      const error = new Error('PURCHASE_BROWSER_HOST_WINDOW_REQUIRED');
      error.code = 'PURCHASE_BROWSER_HOST_WINDOW_REQUIRED';
      throw error;
    }
    attachParentEvents(parent);
    return parent;
  }

  async function showLoading() {
    await ensure();
    browserVisible = false;
    boundsVersion += 1;
    await notifyBounds();
    return parentWindow();
  }

  async function showReady(presentation = {}) {
    await ensure();
    const embeddedRequired = presentation?.embedded === true || presentation?.displayMode === 'embedded';
    browserVisible = embeddedRequired ? embeddedViewport?.visible === true : true;
    boundsVersion += 1;
    await notifyBounds();
    return parentWindow();
  }

  async function restore() {
    await ensure();
    browserVisible = true;
    boundsVersion += 1;
    await notifyBounds();
    return parentWindow();
  }

  function hide() {
    browserVisible = false;
    boundsVersion += 1;
    void notifyBounds().catch(() => undefined);
    return true;
  }

  function getWindow() {
    return parentWindow();
  }

  async function setEmbeddedViewport(input = {}, { notify = true } = {}) {
    await ensure();
    const values = ['x', 'y', 'width', 'height'].map((field) => Number(input?.[field]));
    if (values.some((value) => !Number.isFinite(value))) {
      const error = new Error('PURCHASE_BROWSER_BOUNDS_INVALID');
      error.code = 'PURCHASE_BROWSER_BOUNDS_INVALID';
      throw error;
    }
    embeddedViewport = {
      x: Math.max(0, Math.floor(values[0])),
      y: Math.max(0, Math.floor(values[1])),
      width: Math.max(320, Math.floor(values[2])),
      height: Math.max(240, Math.floor(values[3])),
      visible: input?.visible !== false,
    };
    lastBounds = null;
    boundsVersion += 1;
    if (!notify) {
      const next = nativeBounds();
      lastBounds = next;
      return next;
    }
    return notifyBounds();
  }

  async function clearEmbeddedViewport({ notify = true } = {}) {
    await ensure();
    embeddedViewport = null;
    browserVisible = false;
    lastBounds = null;
    boundsVersion += 1;
    if (!notify) {
      const next = nativeBounds();
      lastBounds = next;
      return next;
    }
    return notifyBounds();
  }

  function viewportBounds({ visible = browserVisible } = {}) {
    return nativeBounds({ visible });
  }

  function standaloneBoundsForSize({ width = 520, height = 800, visible = true } = {}) {
    const parent = parentWindow();
    const parentBounds = parent?.getBounds?.() || { x: 0, y: 0, width: 1280, height: 800 };
    const display = screen?.getDisplayMatching?.(parentBounds) || {};
    const area = display.workArea || { x: 0, y: 0, width: 1280, height: 800 };
    const widthDip = Math.min(Math.max(440, Math.floor(Number(width) || 520)), Math.max(440, area.width - 40));
    const heightDip = Math.min(Math.max(620, Math.floor(Number(height) || 800)), Math.max(620, area.height - 40));
    const scale = Math.max(1, Number(display.scaleFactor) || 1);
    return {
      x: Math.floor((area.x + area.width - widthDip - 32) * scale),
      y: Math.floor((area.y + Math.max(24, (area.height - heightDip) / 2)) * scale),
      width: Math.floor(widthDip * scale),
      height: Math.floor(heightDip * scale),
      visible: visible === true,
      compact: true,
      boundsVersion: ++boundsVersion,
    };
  }

  function setBrowserState(state = {}) {
    const stateTabs = Array.isArray(state?.tabs) ? state.tabs : [];
    const activeState = stateTabs.find((tab) => tab.tabId === state?.activeTabId) || stateTabs[0] || null;
    const stateRepresentsEmbeddedWindow = activeState?.embedding?.requested === true;
    if (
      state?.visible === true
      && stateRepresentsEmbeddedWindow
      && embeddedViewport?.visible !== true
    ) {
      // A renderer rectangle that completed after embed-hide may report a
      // visible native snapshot. Desired ownership is authoritative: once the
      // React card cleared its viewport, that late result cannot re-arm CEF.
      return;
    }
    const observedBoundsVersion = Number(state?.boundsVersion);
    if (Number.isFinite(observedBoundsVersion) && observedBoundsVersion > 0) {
      // Host and CEF controller counters are monotonic but not the same clock.
      // Absorb only forward progress; desired embeddedViewport ownership above
      // is the actual stale-result fence.
      boundsVersion = Math.max(boundsVersion, Math.floor(observedBoundsVersion));
    }
    // Native X/Alt+F4 hides the CEF form without going through Electron.
    // Mirror the controller's readback so the next open is never mistaken
    // for an already-visible window and can run the normal restore path.
    if (typeof state?.visible === 'boolean' && browserVisible !== state.visible) {
      // A real child HWND is automatically suppressed with its Electron
      // parent. While the React card still owns a visible viewport, a false
      // native snapshot is only observed visibility (minimized, hidden or
      // temporarily occluded), not a request to close the card. The explicit
      // clearEmbeddedViewport path is the sole owner of that desired state.
      if (state.visible === false && embeddedViewport?.visible === true) return;
      browserVisible = state.visible;
      lastBounds = null;
    }
  }

  function dispose() {
    disposed = true;
    browserVisible = false;
    embeddedViewport = null;
    lastBounds = null;
    detachParentEvents();
  }

  return Object.freeze({
    dispose,
    clearEmbeddedViewport,
    ensure,
    getWindow,
    hide,
    restore,
    setBrowserState,
    setEmbeddedViewport,
    showError: showLoading,
    showLoading,
    showReady,
    standaloneBoundsForSize,
    viewportBounds,
  });
}

