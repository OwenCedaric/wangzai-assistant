function clone(value) {
  return structuredClone(value);
}

export class MemoryProtectedComputeReplayGuard {
  #seen = new Map();

  claim(responseId, expiresAt, nowMs = Date.now()) {
    for (const [key, expiry] of this.#seen) {
      if (expiry <= nowMs) this.#seen.delete(key);
    }
    const key = String(responseId);
    if (this.#seen.has(key)) return false;
    const expiryMs = new Date(expiresAt).getTime();
    this.#seen.set(key, Number.isFinite(expiryMs) ? expiryMs : nowMs + 60_000);
    return true;
  }

  clear() {
    this.#seen.clear();
  }
}

export class MemoryProtectedComputeSignedResultStore {
  #records = new Map();

  static keyOf({ capability, version, inputHash }) {
    return `${capability}@${version}:${inputHash}`;
  }

  async put(envelope) {
    const key = MemoryProtectedComputeSignedResultStore.keyOf(envelope);
    this.#records.set(key, { envelope: clone(envelope), uses: 0 });
  }

  async get(identity) {
    const record = this.#records.get(
      MemoryProtectedComputeSignedResultStore.keyOf(identity),
    );
    return record
      ? { envelope: clone(record.envelope), uses: record.uses }
      : null;
  }

  async consume(identity, responseId, maxUses) {
    const key = MemoryProtectedComputeSignedResultStore.keyOf(identity);
    const record = this.#records.get(key);
    if (!record || record.envelope.responseId !== responseId) return false;
    if (!Number.isInteger(maxUses) || maxUses < 1 || record.uses >= maxUses) {
      return false;
    }
    record.uses += 1;
    return true;
  }

  async delete(identity) {
    this.#records.delete(
      MemoryProtectedComputeSignedResultStore.keyOf(identity),
    );
  }

  clear() {
    this.#records.clear();
  }
}
