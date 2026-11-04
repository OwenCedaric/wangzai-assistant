function stable(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(stable);
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}
const ownerKey = preview => JSON.stringify([preview?.owner?.ownerType || '', preview?.owner?.ownerId || '']);
const leaseKey = preview => JSON.stringify([ownerKey(preview), preview?.previewFingerprint || '', stable(preview?.ownerGeneration || {})]);

// A late cancel/completion for an old incarnation must not unlock a newer lease
// using the same account id. The caller supplies verified server outcome only.
export function createAccountRemovalFenceLeases() {
  const leases = new Map();
  return {
    register(preview, value = {}) {
      leases.set(ownerKey(preview), { ...value, owner: preview.owner, key: leaseKey(preview) });
    },
    diagnostics(preview) {
      const current = leases.get(ownerKey(preview));
      return current?.key === leaseKey(preview) ? { ...(current.diagnostics || {}) } : null;
    },
    release(preview, proof = {}, release) {
      if (proof.verifiedNoOperation !== true && proof.completed !== true) throw new Error('ACCOUNT_REMOVAL_FENCE_RELEASE_UNVERIFIED');
      const key = ownerKey(preview);
      const current = leases.get(key);
      if (!current || current.key !== leaseKey(preview)) return { released: false, stale: Boolean(current) };
      const protectedIdentifiers = new Set([...leases.entries()].filter(([entryKey]) => entryKey !== key)
        .flatMap(([, entry]) => entry.identifiers || []));
      release(current, { completed: proof.completed === true, protectedIdentifiers });
      leases.delete(key);
      return { released: true };
    },
  };
}
