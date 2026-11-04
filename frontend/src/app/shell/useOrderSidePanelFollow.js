import React from 'react';

const ORDER_SIDE_PANEL_SELECTOR = '[data-order-follow-panel="true"]';
const ORDER_LAYOUT_SELECTOR = '.sales-orders-layout, .purchase-orders-layout, .profit-orders-layout';
const FOLLOW_RUNTIME_CLASS = 'order-side-panel-follow-runtime';
const FOLLOW_OFFSET_DATA_KEY = 'orderFollowOffset';

function toPositiveNumber(value, fallback = 1) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

export function calculateOrderSidePanelFollowOffset({
  panelTop = 0,
  stickyTop = 0,
  scale = 1,
  currentOffset = 0,
} = {}) {
  const safeScale = toPositiveNumber(scale, 1);
  const currentPhysicalOffset = Math.max(0, Number(currentOffset) || 0) * safeScale;
  const naturalTop = Number(panelTop) - currentPhysicalOffset;
  const requestedPhysicalOffset = Math.max(0, Number(stickyTop) - naturalTop);
  return requestedPhysicalOffset / safeScale;
}

function resetOrderSidePanel(panel) {
  panel.style.removeProperty('transform');
  panel.style.removeProperty('will-change');
  panel.classList.remove(FOLLOW_RUNTIME_CLASS);
  delete panel.dataset[FOLLOW_OFFSET_DATA_KEY];
}

function getWorkspaceScale(panel) {
  const surface = panel.closest('.workspace-scale-surface');
  return toPositiveNumber(surface?.dataset.workspaceScale, 1);
}

function getStickyViewportTop(panel) {
  const surface = panel.closest('.workspace-scale-surface');
  const topbar = surface?.querySelector('.topbar') ?? document.querySelector('.topbar');
  const topbarBottom = topbar?.getBoundingClientRect?.().bottom;
  return Math.max(12, Number.isFinite(topbarBottom) ? topbarBottom + 12 : 12);
}

function measureOrderSidePanel(panel) {
  if (!(panel instanceof HTMLElement) || panel.getClientRects().length === 0) {
    return { panel, reset: panel instanceof HTMLElement };
  }
  const layout = panel.closest(ORDER_LAYOUT_SELECTOR);
  if (!(layout instanceof HTMLElement)) {
    return { panel, reset: true };
  }

  const scale = getWorkspaceScale(panel);
  const currentOffset = Math.max(0, Number(panel.dataset[FOLLOW_OFFSET_DATA_KEY]) || 0);
  const panelRect = panel.getBoundingClientRect();
  const nextOffset = calculateOrderSidePanelFollowOffset({
    panelTop: panelRect.top,
    stickyTop: getStickyViewportTop(panel),
    scale,
    currentOffset,
  });
  const normalizedOffset = Math.abs(nextOffset) < 0.05 ? 0 : Number(nextOffset.toFixed(3));
  return { panel, reset: false, normalizedOffset };
}

function applyOrderSidePanelMeasurement({ panel, reset, normalizedOffset } = {}) {
  if (!(panel instanceof HTMLElement)) return;
  if (reset) {
    resetOrderSidePanel(panel);
    return;
  }
  panel.classList.add(FOLLOW_RUNTIME_CLASS);
  panel.style.setProperty('will-change', 'transform');
  const previousOffset = Number(panel.dataset[FOLLOW_OFFSET_DATA_KEY]);
  if (Number.isFinite(previousOffset) && Math.abs(previousOffset - normalizedOffset) < 0.001) return;
  panel.dataset[FOLLOW_OFFSET_DATA_KEY] = String(normalizedOffset);
  panel.style.setProperty('transform', `translate3d(0, ${normalizedOffset}px, 0)`);
}

export function createOrderSidePanelFrameScheduler(update, options = {}) {
  const requestFrame = options.requestFrame || globalThis.requestAnimationFrame;
  const cancelFrame = options.cancelFrame || globalThis.cancelAnimationFrame;
  let frameId = null;
  let disposed = false;
  const run = () => {
    frameId = null;
    if (!disposed) update();
  };
  return {
    schedule() {
      if (disposed || frameId !== null) return;
      frameId = requestFrame(run);
    },
    cancel() {
      disposed = true;
      if (frameId !== null) cancelFrame(frameId);
      frameId = null;
    },
  };
}

export function useOrderSidePanelFollow(refreshKey = '', options = {}) {
  const enabled = options.enabled !== false;
  React.useEffect(() => {
    const initialPanels = () => [...document.querySelectorAll(ORDER_SIDE_PANEL_SELECTOR)];
    if (!enabled) {
      initialPanels().forEach(resetOrderSidePanel);
      return undefined;
    }
    const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => scheduleUpdate()) : null;
    const observedElements = new Set();

    const getPanels = () => [...document.querySelectorAll(ORDER_SIDE_PANEL_SELECTOR)];
    const observePanels = () => {
      if (!resizeObserver) return;
      const activeElements = new Set();
      getPanels().forEach((panel) => {
        activeElements.add(panel);
        const layout = panel.closest(ORDER_LAYOUT_SELECTOR);
        if (layout) activeElements.add(layout);
      });
      activeElements.forEach((element) => {
        if (observedElements.has(element)) return;
        observedElements.add(element);
        resizeObserver.observe(element);
      });
      observedElements.forEach((element) => {
        if (activeElements.has(element) && element.isConnected) return;
        resizeObserver.unobserve(element);
        observedElements.delete(element);
      });
    };
    const update = () => {
      const measurements = getPanels().map(measureOrderSidePanel);
      measurements.forEach(applyOrderSidePanelMeasurement);
    };
    const scheduler = createOrderSidePanelFrameScheduler(update);
    function scheduleUpdate() {
      scheduler.schedule();
    }

    const mutationObserver = new MutationObserver(() => {
      observePanels();
      scheduleUpdate();
    });
    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['hidden'],
    });
    observePanels();
    scheduleUpdate();
    window.addEventListener('scroll', scheduleUpdate, { capture: true, passive: true });
    window.addEventListener('resize', scheduleUpdate, { passive: true });

    return () => {
      mutationObserver.disconnect();
      resizeObserver?.disconnect();
      scheduler.cancel();
      window.removeEventListener('scroll', scheduleUpdate, true);
      window.removeEventListener('resize', scheduleUpdate);
      getPanels().forEach(resetOrderSidePanel);
    };
  }, [enabled, refreshKey]);
}
