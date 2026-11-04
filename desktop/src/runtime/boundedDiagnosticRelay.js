import { Buffer } from 'node:buffer';

/** Bounded diagnostic-only queue. Never use this for business events/receipts.
 * Keep draining a native stderr pipe even when the rotating disk sink is slow,
 * without converting a log storm into an unbounded chain of pending writes. */
export function createBoundedDiagnosticRelay({
  write,
  maximumQueuedBytes = 64 * 1024,
  maximumQueuedEntries = 128,
  maximumEntryBytes = 2048,
} = {}) {
  if (typeof write !== 'function' || ![maximumQueuedBytes, maximumQueuedEntries, maximumEntryBytes]
    .every(value => Number.isSafeInteger(value) && value > 0)
    || maximumEntryBytes < 4 || maximumEntryBytes > maximumQueuedBytes) {
    throw new TypeError('DIAGNOSTIC_RELAY_POLICY_INVALID');
  }
  const queue = [];
  let queuedBytes = 0, running = null, accepting = true;
  let dropped = 0, pendingDropNotice = 0, truncated = 0, writeFailures = 0;
  const status = () => ({ queuedBytes, queuedEntries: queue.length, inFlight: Boolean(running),
    dropped, truncated, writeFailures, accepting });
  const persist = async line => {
    try { await write(line); } catch { writeFailures++; }
  };

  function drain() {
    if (running) return running;
    running = Promise.resolve().then(async () => {
      while (queue.length || pendingDropNotice) {
        if (pendingDropNotice) {
          const count = pendingDropNotice;
          pendingDropNotice = 0;
          await persist(`[cef-host-diagnostics] dropped=${count} reason=bounded-log-queue\n`);
        }
        const entry = queue.shift();
        if (entry) {
          queuedBytes -= entry.bytes;
          await persist(entry.text);
        }
      }
    }).finally(() => {
      running = null;
      if (queue.length || pendingDropNotice) void drain();
    });
    return running;
  }

  function append(value) {
    if (!accepting) return status();
    const source = String(value || '');
    if (!source) return status();
    // Slice before encoding so even an accidental huge diagnostic cannot
    // allocate an equally huge buffer inside this queue.
    const buffer = Buffer.from(source.slice(0, maximumEntryBytes), 'utf8');
    let end = Math.min(buffer.length, maximumEntryBytes);
    while (end < buffer.length && (buffer[end] & 0xc0) === 0x80) end--;
    const text = buffer.subarray(0, end).toString('utf8');
    if (source.length > maximumEntryBytes || end < buffer.length) truncated++;
    while (queue.length && (queue.length >= maximumQueuedEntries || queuedBytes + end > maximumQueuedBytes)) {
      queuedBytes -= queue.shift().bytes;
      dropped++; pendingDropNotice++;
    }
    queue.push({ text, bytes: end }); queuedBytes += end;
    void drain();
    return status();
  }
  const flush = async () => { while (running) await running; };
  function close() { accepting = false; return flush(); }
  return Object.freeze({ append, flush, close, getStatus: status });
}
