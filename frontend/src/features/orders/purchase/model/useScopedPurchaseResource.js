import React from 'react';

// Keep same-scope supplemental data while the tab is hidden. On re-entry we
// still read again; changed owners are never allowed to see the old resource.
export function useScopedPurchaseResource({ scopeKey, enabled, read, emptyValue, refreshKey = 0 }) {
  const [state, setState] = React.useState(() => ({ scopeKey: '', value: emptyValue }));
  React.useEffect(() => {
    if (!scopeKey) {
      setState(current => current.scopeKey ? { scopeKey: '', value: emptyValue } : current);
      return undefined;
    }
    if (!enabled) return undefined;
    let disposed = false;
    const adopt = value => {
      if (disposed) return;
      setState(current => current.scopeKey === scopeKey && current.value === value ? current : { scopeKey, value });
    };
    Promise.resolve().then(read).then(adopt).catch(() => adopt(emptyValue));
    return () => { disposed = true; };
  }, [emptyValue, enabled, read, refreshKey, scopeKey]);
  return state.scopeKey === scopeKey ? state.value : emptyValue;
}
