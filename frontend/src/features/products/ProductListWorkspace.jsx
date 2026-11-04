import { useProductListPageModel } from './model/useProductListPageModel.jsx';
import { ProductListPageView } from './view/ProductListPageView.jsx';
import { createProductWorkspaceActivityRuntime } from './model/productWorkspaceActivityRuntime.js';
import {
  measureRouteRenderCommit,
  measureRouteRenderPhase,
} from '../../app/performance/routeModuleLoadTelemetry.js';
import React from 'react';

function productViewModelPropsEqual(previous, next) {
  const previousModel = previous.model;
  const nextModel = next.model;
  if (previousModel === nextModel) return true;
  const previousKeys = Object.keys(previousModel || {});
  const nextKeys = Object.keys(nextModel || {});
  const changedKeys = previousKeys.filter(
    (key) => !Object.hasOwn(nextModel, key) || !Object.is(previousModel[key], nextModel[key]),
  );
  return previousKeys.length === nextKeys.length && changedKeys.length === 0;
}

const StableProductListPageView = React.memo(ProductListPageView, productViewModelPropsEqual);

const ProductListWorkspaceContent = React.memo(function ProductListWorkspaceContent({ activityRuntime, ...props }) {
  const firstRenderTimingRef = React.useRef(null);
  const firstCommitStartedAtRef = React.useRef(null);
  const renderStartedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const model = useProductListPageModel({
    ...props,
    activityRuntime,
  });
  const modelPreparedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
  firstRenderTimingRef.current ??= { renderStartedAt, modelPreparedAt };
  React.useInsertionEffect(() => {
    firstCommitStartedAtRef.current ??= typeof performance !== 'undefined' ? performance.now() : Date.now();
  }, []);
  React.useLayoutEffect(() => {
    const timing = firstRenderTimingRef.current;
    const commitStartedAt = firstCommitStartedAtRef.current ?? timing.modelPreparedAt;
    measureRouteRenderPhase('products', 'model', timing.renderStartedAt, { endedAt: timing.modelPreparedAt });
    measureRouteRenderPhase('products', 'reconcile', timing.modelPreparedAt, { endedAt: commitStartedAt });
    measureRouteRenderPhase('products', 'commit', commitStartedAt);
    measureRouteRenderPhase('products', 'view', timing.modelPreparedAt);
    measureRouteRenderCommit('products', timing.renderStartedAt);
  }, []);
  return <StableProductListPageView model={model} routeModelPreparedAt={modelPreparedAt} />;
});

function ProductWorkspaceActivityBridge({ activityRuntime, isActive }) {
  React.useLayoutEffect(() => {
    activityRuntime.setActive(isActive);
    return () => activityRuntime.setActive(false);
  }, [activityRuntime, isActive]);
  return null;
}

function ProductListPage({ isActive = true, isVisible = isActive, ...props }) {
  const activityRuntimeRef = React.useRef(null);
  activityRuntimeRef.current ??= createProductWorkspaceActivityRuntime(isActive);
  const activityRuntime = activityRuntimeRef.current;
  return (
    <>
      <ProductWorkspaceActivityBridge activityRuntime={activityRuntime} isActive={isActive} />
      <ProductListWorkspaceContent {...props} isVisible={isVisible} activityRuntime={activityRuntime} />
    </>
  );
}

export default ProductListPage;
