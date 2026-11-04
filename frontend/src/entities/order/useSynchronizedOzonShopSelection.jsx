import React from 'react';
import {
  getOzonShopSelectionId,
  getOzonSnapshotSourceKey,
  resolveOzonConfiguredShop,
} from './orderShopScope.jsx';

export function resolveActiveOzonShopSelection(shops = [], activeShopId = '', allValue = 'all') {
  const availableShops = Array.isArray(shops) ? shops.filter(Boolean) : [];
  const active = String(activeShopId || '').trim();
  if (!active) return allValue;
  const matchedShop = resolveOzonConfiguredShop(availableShops, active);
  return matchedShop ? getOzonShopSelectionId(matchedShop) || allValue : allValue;
}

/**
 * Keeps a page-local shop filter aligned with the application-wide shop.
 *
 * The derived value is returned immediately when the global scope changes, so
 * a render cannot launch a request for the previous shop while the effect is
 * still waiting to commit. Manual page selections remain valid until the
 * global shop or the generation-aware configured-shop scope changes.
 */
export function useSynchronizedOzonShopSelection({
  shops = [],
  activeShopId = '',
  allValue = 'all',
  onScopeChange,
} = {}) {
  const availableShops = React.useMemo(
    () => (Array.isArray(shops) ? shops.filter(Boolean) : []),
    [shops],
  );
  const desiredSelection = React.useMemo(
    () => resolveActiveOzonShopSelection(availableShops, activeShopId, allValue),
    [activeShopId, allValue, availableShops],
  );
  const sourceKey = React.useMemo(
    () => getOzonSnapshotSourceKey(availableShops),
    [availableShops],
  );
  const globalScopeKey = `${String(activeShopId || '').trim()}\u0001${sourceKey}`;
  const [selection, setSelection] = React.useState(() => desiredSelection);
  const previousGlobalScopeRef = React.useRef(globalScopeKey);
  const onScopeChangeRef = React.useRef(onScopeChange);

  React.useEffect(() => {
    onScopeChangeRef.current = onScopeChange;
  }, [onScopeChange]);

  const scopeChanged = previousGlobalScopeRef.current !== globalScopeKey;
  const effectiveSelection = scopeChanged ? desiredSelection : selection;

  React.useEffect(() => {
    const previousScopeKey = previousGlobalScopeRef.current;
    if (previousScopeKey === globalScopeKey) return;
    previousGlobalScopeRef.current = globalScopeKey;
    setSelection(desiredSelection);
    onScopeChangeRef.current?.({
      previousScopeKey,
      scopeKey: globalScopeKey,
      selection: desiredSelection,
    });
  }, [desiredSelection, globalScopeKey]);

  return [effectiveSelection, setSelection];
}
