import React from 'react';

export const WORKSPACE_DESIGN_WIDTH = 1600;
export const WORKSPACE_SIDEBAR_WIDTH = 216;
export const WORKSPACE_SIDEBAR_COLLAPSED_WIDTH = 68;
export const WORKSPACE_MIN_SCALE = 0.5;

function roundLayoutValue(value, precision = 4) {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

export function calculateWorkspaceScale({ viewportWidth, viewportHeight, sidebarOpen } = {}) {
  const safeViewportWidth = Math.max(Number(viewportWidth) || WORKSPACE_DESIGN_WIDTH, 1);
  const safeViewportHeight = Math.max(Number(viewportHeight) || 1, 1);
  const sidebarWidth = sidebarOpen ? WORKSPACE_SIDEBAR_WIDTH : WORKSPACE_SIDEBAR_COLLAPSED_WIDTH;
  const availableWidth = Math.max(safeViewportWidth - sidebarWidth, 1);
  const scale = Math.min(1, Math.max(WORKSPACE_MIN_SCALE, availableWidth / WORKSPACE_DESIGN_WIDTH));
  // Below the readability floor the surface reflows narrower instead of
  // overflowing: the shell clips horizontally, so overflow would hide content.
  const designWidth = scale < 1
    ? Math.min(WORKSPACE_DESIGN_WIDTH, availableWidth / scale)
    : availableWidth;
  const visualWidth = designWidth * scale;

  return {
    availableWidth: roundLayoutValue(availableWidth, 2),
    designHeight: roundLayoutValue(safeViewportHeight / scale, 2),
    designWidth: roundLayoutValue(designWidth, 2),
    overflowWidth: roundLayoutValue(Math.max(visualWidth - availableWidth, 0), 2),
    scale: roundLayoutValue(scale),
    visualWidth: roundLayoutValue(visualWidth, 2),
  };
}

function readViewportSize() {
  if (typeof window === 'undefined') return { width: WORKSPACE_DESIGN_WIDTH, height: 900 };
  // innerWidth includes the page's vertical scrollbar; sizing the workspace to it
  // pushes the right-most content under the scrollbar where the shell clips it.
  // styles.css reserves the root scrollbar gutter, so clientWidth stays stable
  // whether or not the page currently scrolls.
  const root = document.documentElement;
  return {
    width: root?.clientWidth || window.innerWidth,
    height: root?.clientHeight || window.innerHeight,
  };
}

export function useWorkspaceScale(sidebarOpen) {
  const [viewportSize, setViewportSize] = React.useState(readViewportSize);

  React.useEffect(() => {
    let frameId = null;
    const scheduleFrame = globalThis.requestAnimationFrame || ((callback) => globalThis.setTimeout(callback, 16));
    const cancelFrame = globalThis.cancelAnimationFrame || globalThis.clearTimeout;
    const updateViewportSize = () => {
      if (frameId !== null) cancelFrame(frameId);
      frameId = scheduleFrame(() => {
        frameId = null;
        setViewportSize(readViewportSize());
      });
    };

    window.addEventListener('resize', updateViewportSize, { passive: true });
    updateViewportSize();
    return () => {
      window.removeEventListener('resize', updateViewportSize);
      if (frameId !== null) cancelFrame(frameId);
    };
  }, []);

  return React.useMemo(
    () => calculateWorkspaceScale({
      viewportWidth: viewportSize.width,
      viewportHeight: viewportSize.height,
      sidebarOpen,
    }),
    [sidebarOpen, viewportSize]
  );
}
