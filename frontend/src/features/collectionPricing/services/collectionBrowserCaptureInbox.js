let pendingCapture = null;
const listeners = new Set();

function validCapture(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

export function publishCollectionBrowserCapture(capture) {
  if (!validCapture(capture)) return false;
  pendingCapture = capture;
  listeners.forEach((listener) => listener(capture));
  if (listeners.size) pendingCapture = null;
  return true;
}

export function subscribeCollectionBrowserCapture(listener) {
  if (typeof listener !== 'function') return () => undefined;
  listeners.add(listener);
  if (pendingCapture) {
    const capture = pendingCapture;
    pendingCapture = null;
    listener(capture);
  }
  return () => listeners.delete(listener);
}

export function resetCollectionBrowserCaptureInboxForTests() {
  pendingCapture = null;
  listeners.clear();
}
