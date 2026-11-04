/** Keep retired runtimes fenced after their UI/controller references are gone.
 * Timeout/failure is not a release receipt and cannot authorize replacement. */
export function createRuntimeRetirementBarrier({ onFailure = () => undefined } = {}) {
  const pending = new Map();
  function failure(code) { return Object.assign(new Error(code), { code }); }

  function retire(runtime) {
    if (!runtime) return Promise.resolve({ ok: true });
    if (pending.has(runtime)) return pending.get(runtime);
    let disposal;
    try { disposal = runtime.dispose(); }
    catch (error) { disposal = Promise.reject(error); }
    const completion = Promise.resolve(disposal).then(async result => {
      // Some runtime APIs return a caller deadline while their real shutdown
      // continues. Await that same retirement, never treat the deadline as exit.
      if (result?.timedOut === true && typeof runtime.shutdown === 'function') {
        result = await runtime.shutdown({ timeoutMs: 15000 });
      }
      if (result?.ok !== true || result?.timedOut === true || result?.exitVerified !== true) {
        throw failure('DESKTOP_NATIVE_RETIREMENT_UNVERIFIED');
      }
      return result;
    });
    const tracked = completion.then(result => {
      if (pending.get(runtime) === tracked) pending.delete(runtime);
      return result;
    }, error => {
      try { onFailure(error); } catch { /* diagnostics cannot release the fence */ }
      throw error;
    });
    pending.set(runtime, tracked);
    // Suspend/quit can initiate retirement without awaiting it at that callsite.
    // Keep a failure observable by wait(), but never reject unhandled.
    tracked.catch(() => undefined);
    return tracked;
  }

  async function wait({ timeoutMs = 15000 } = {}) {
    let timer;
    const drain = async () => {
      // Include retirements added while the previous generation is draining.
      while (pending.size) await Promise.all([...pending.values()]);
      return { ok: true };
    };
    try {
      return await Promise.race([
        drain(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(failure('DESKTOP_NATIVE_RETIREMENT_TIMEOUT')), timeoutMs);
        }),
      ]);
    } finally { clearTimeout(timer); }
  }
  return Object.freeze({ retire, wait, get size() { return pending.size; } });
}
