export function createProductWorkspaceActivityRuntime(initialActive = false) {
  let active = Boolean(initialActive);
  const subscribers = new Set();
  return Object.freeze({
    getSnapshot() {
      return active;
    },
    setActive(value) {
      const next = Boolean(value);
      if (next === active) return;
      active = next;
      subscribers.forEach((subscriber) => subscriber(active));
    },
    subscribe(subscriber) {
      if (typeof subscriber !== 'function') throw new Error('PRODUCT_WORKSPACE_ACTIVITY_LISTENER_REQUIRED');
      subscribers.add(subscriber);
      subscriber(active);
      return () => subscribers.delete(subscriber);
    },
  });
}
