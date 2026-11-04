export function scheduleProductRenderTask(callback) {
  if (typeof globalThis.scheduler?.postTask === 'function') {
    const controller = new AbortController();
    void globalThis.scheduler
      .postTask(callback, { priority: 'user-blocking', signal: controller.signal })
      .catch(() => undefined);
    return () => controller.abort();
  }

  const handle = setTimeout(callback, 0);
  return () => clearTimeout(handle);
}
