function describeShopScope(shops = []) {
  const identityFields = [
    'id',
    'clientId',
    'client_id',
    'shopId',
    'shop_id',
    'alias',
    'shopAlias',
    'sellerName',
    'name',
  ];
  const values = (Array.isArray(shops) ? shops : [])
    .map((shop) => identityFields
      .map((field) => String(shop?.[field] ?? '').trim())
      .filter(Boolean)
      .join('\u001f'))
    .filter(Boolean)
    .sort();
  const uniqueIdentityCount = new Set(
    values.flatMap((value) => value.split(String.fromCharCode(31))).filter(Boolean)
  ).size;
  return Object.freeze({
    signature: values.join('\u001e'),
    richness: uniqueIdentityCount,
  });
}

/**
 * Startup effects may run before the canonical shop hydration finishes. Keep a
 * single writer, but queue one retry when a later caller supplies a richer
 * identity scope; otherwise an early empty scope can permanently retain a
 * browser key that is perfectly resolvable a moment later.
 */
export function createLegacyScopedMigrationCoordinator() {
  let activeRun = null;
  let activeScope = null;

  function start(scope, previousRun, worker) {
    const run = Promise.resolve(previousRun)
      .catch(() => undefined)
      .then(worker);
    activeRun = run;
    activeScope = scope;
    const clear = () => {
      if (activeRun !== run) return;
      activeRun = null;
      activeScope = null;
    };
    run.then(clear, clear);
    return run;
  }

  return Object.freeze({
    drain() {
      return activeRun || Promise.resolve();
    },
    getStatus() {
      return Object.freeze({ active: Boolean(activeRun), scope: activeScope ? { ...activeScope } : null });
    },
    run(shops, worker) {
      const scope = describeShopScope(shops);
      if (!activeRun) return start(scope, null, worker);
      if (
        scope.signature === activeScope?.signature ||
        scope.richness < Number(activeScope?.richness || 0)
      ) return activeRun;
      return start(scope, activeRun, worker);
    },
  });
}
