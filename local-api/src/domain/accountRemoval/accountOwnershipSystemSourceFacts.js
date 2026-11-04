import { createHash } from 'node:crypto';

// Audited source facts are not deletion resources. Keep this separately versioned
// from the immutable B0 ledger/Catalog and never infer a class-wide Set exemption.
export const ACCOUNT_OWNERSHIP_SYSTEM_SOURCE_FACTS_VERSION = 'account-ownership-system-source-facts-v1';
export const ACCOUNT_OWNERSHIP_SYSTEM_SOURCE_FACTS = Object.freeze([
  Object.freeze({
    id: 'system-source:renderer-account-removal-completion-listeners',
    sourceFile: 'frontend/src/features/settings/accountRemoval/services/accountRemovalCompletion.js',
    sourceSymbol: 'listeners',
    sourceSHA256: 'AE4942433785AA5FEFB7854B7CF3A73CA7DEAEB00B9F9E9735484C45EA7B06E5',
    kind: 'set',
    declaration: 'const listeners = new Set();',
    ownerType: 'system',
    disposition: 'preserve system',
    removable: false,
    deletePrimitive: 'prohibited:shared-view-subscriptions',
    preserveRule: 'Preserve live cross-view subscriptions; each subscriber owns and returns its unsubscribe cleanup.',
    retainedValues: 'listeners contains callback references only; emitted contains opaque operation IDs only, not account rows, generations, credentials, or event payloads.',
    payloadLifetime: 'Events are delivered synchronously, not retained by these module Sets; subscriber-owned view state is outside this source-fact classification.',
    listenerBound: 'One Set entry per distinct live callback, removed by unsubscribe; no numeric listener cap is claimed.',
    deduplication: Object.freeze({ sourceSymbol: 'emitted', value: 'operationId', maximumEntries: 500, eviction: 'oldest-first' }),
    requiredSourceStatements: Object.freeze([
      'const listeners = new Set();',
      'const emitted = new Set();',
      'function emit(event) { for (const listener of listeners) { try { listener(event); } catch { /* A view callback cannot downgrade verified deletion. */ } } }',
      'export function subscribeAccountRemovalCompletion(listener) { listeners.add(listener); return () => listeners.delete(listener); }',
      'if (operation?.completed !== true || !operation.operationId || !owner?.ownerId) return false;',
      'if (emitted.has(operation.operationId)) return false;',
      'emitted.add(operation.operationId);',
      'if (emitted.size > 500) emitted.delete(emitted.values().next().value);',
    ]),
  }),
]);

export function verifyAccountOwnershipSystemSourceFacts({ sourceByFile, discoveredStateFacts } = {}) {
  return Object.freeze(ACCOUNT_OWNERSHIP_SYSTEM_SOURCE_FACTS.map((reviewed) => {
    const source = sourceByFile?.get(reviewed.sourceFile);
    const matching = discoveredStateFacts?.filter((fact) => (
      fact.sourceFile === reviewed.sourceFile
      && fact.sourceSymbol === reviewed.sourceSymbol
      && fact.structured?.kind === reviewed.kind
      && fact.structured?.declaration === reviewed.sourceSymbol
    )) || [];
    const sourceSHA256 = typeof source === 'string'
      ? createHash('sha256').update(source, 'utf8').digest('hex').toUpperCase() : null;
    const concreteLines = typeof source === 'string' ? source.split(/\r\n|\n|\r/u).map((line) => line.trim()) : [];
    if (sourceSHA256 !== reviewed.sourceSHA256 || matching.length !== 1
      || reviewed.requiredSourceStatements.some((statement) => !concreteLines.includes(statement))) {
      const error = new Error(`ACCOUNT_OWNERSHIP_SYSTEM_SOURCE_FACT_DRIFT:${reviewed.id}`);
      error.code = 'ACCOUNT_OWNERSHIP_SYSTEM_SOURCE_FACT_DRIFT';
      error.resourceId = reviewed.id;
      throw error;
    }
    return Object.freeze({ ...reviewed, discovery: matching[0], version: ACCOUNT_OWNERSHIP_SYSTEM_SOURCE_FACTS_VERSION });
  }));
}
