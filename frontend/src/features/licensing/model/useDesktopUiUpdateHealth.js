import React from 'react';

export function useDesktopUiUpdateHealth(ready = true) {
  React.useEffect(() => {
    const updates = globalThis.wangzaiDesktop?.uiUpdates;
    if (!updates) return undefined;
    const fail = () => { void updates.failed().catch(() => undefined); };
    globalThis.addEventListener('error', fail);
    globalThis.addEventListener('unhandledrejection', fail);
    let cancelled = false, second = null;
    const first = ready ? requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        if (!cancelled) void updates.ready().catch(() => undefined);
      });
    }) : null;
    return () => {
      cancelled = true;
      if (first !== null) cancelAnimationFrame(first);
      if (second !== null) cancelAnimationFrame(second);
      globalThis.removeEventListener('error', fail);
      globalThis.removeEventListener('unhandledrejection', fail);
    };
  }, [ready]);
}
