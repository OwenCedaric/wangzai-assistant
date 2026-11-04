import Box from '@mui/material/Box';
import React from 'react';
import { isRendererTreeTelemetryEnabled, markRendererTreeRender } from './rendererTreeTelemetry.js';
import { workspacePerformanceRuntime } from './workspacePerformanceRuntime.js';

function PageLoadingFallback() {
  return (
    <Box className="page-loading-fallback" role="status" aria-label="页面加载中">
      <span className="page-loading-spinner" />
      <span>页面加载中</span>
    </Box>
  );
}

function WorkspacePageReady({ pageId, isActive, children }) {
  React.useEffect(() => {
    if (!isActive) return undefined;
    const complete = () => workspacePerformanceRuntime.markPageReady(pageId);
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      const frameId = window.requestAnimationFrame(complete);
      return () => window.cancelAnimationFrame(frameId);
    }
    const timer = globalThis.setTimeout(complete, 0);
    return () => globalThis.clearTimeout(timer);
  }, [isActive, pageId]);
  return children ?? null;
}

function workspacePageContentPropsEqual(previous, next) {
  if (previous.pageId !== next.pageId || previous.renderPage !== next.renderPage) return false;
  return previous.isActive === next.isActive && previous.isVisible === next.isVisible;
}

const WorkspacePageContent = React.memo(function WorkspacePageContent({ pageId, isActive, isVisible, renderPage }) {
  return renderPage(pageId, isActive, isVisible);
}, workspacePageContentPropsEqual);

function WorkspaceSlotCommitTelemetry({ metric, startedAt }) {
  React.useInsertionEffect(() => {
    markRendererTreeRender(metric, startedAt);
  }, [metric, startedAt]);
  return null;
}

function workspacePageSlotPropsEqual(previous, next) {
  const previousVisible = previous.isVisible ?? previous.isActive;
  const nextVisible = next.isVisible ?? next.isActive;
  if (
    previous.pageId !== next.pageId
    || previous.isActive !== next.isActive
    || previous.isPreparing !== next.isPreparing
    || previousVisible !== nextVisible
  ) return false;
  // App recreates the page factory when shell-level data changes. Hidden workspaces keep
  // their mounted state and do not need to coordinate that new factory until activated.
  return !next.isActive || previous.renderPage === next.renderPage;
}

/** Prevents global shell updates from rerendering inactive workspace pages. */
export const WorkspacePageSlot = React.memo(function WorkspacePageSlot({
  pageId,
  isActive,
  isVisible = isActive,
  isPreparing = false,
  renderPage,
}) {
  const treeTelemetryEnabled = isRendererTreeTelemetryEnabled();
  const treeTelemetryStartedAt = treeTelemetryEnabled && typeof performance !== 'undefined' ? performance.now() : 0;
  const contentIsActive = isActive || isPreparing;
  return (
    <Box
      className="page-panel"
      hidden={!isVisible}
      data-workspace-preparing={isPreparing ? 'true' : undefined}
    >
      <WorkspacePageReady pageId={pageId} isActive={isVisible} />
      <React.Suspense fallback={<PageLoadingFallback />}>
        <WorkspacePageContent
          pageId={pageId}
          isActive={contentIsActive}
          isVisible={isVisible}
          renderPage={renderPage}
        />
      </React.Suspense>
      {treeTelemetryEnabled ? (
        <WorkspaceSlotCommitTelemetry
          metric={`workspace-slot:${pageId}:${isVisible ? 'visible' : 'hidden'}`}
          startedAt={treeTelemetryStartedAt}
        />
      ) : null}
    </Box>
  );
}, workspacePageSlotPropsEqual);
