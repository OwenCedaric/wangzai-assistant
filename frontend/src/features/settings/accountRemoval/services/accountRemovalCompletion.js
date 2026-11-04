import { normalizeOzonShopGenerationScope } from '../../../../shared/ozon/ozonShopGeneration.js';

const listeners = new Set();
const emitted = new Set();
const ownerKey = owner => JSON.stringify([owner?.ownerType || '', owner?.ownerId || '']);
function emit(event) { for (const listener of listeners) { try { listener(event); } catch { /* A view callback cannot downgrade verified deletion. */ } } }
export function subscribeAccountRemovalCompletion(listener) { listeners.add(listener); return () => listeners.delete(listener); }
export function observePendingAccountRemoval(operation) {
  if (!operation?.operationId || !operation.pendingOwner?.ownerId || operation.completed) return;
  emit({ type: 'observing', operationId: operation.operationId, owner: operation.pendingOwner, ownerGeneration: operation.pendingOwnerGeneration });
}
export function publishAccountRemovalCompletion(operation, owner, ownerGeneration) {
  if (operation?.completed !== true || !operation.operationId || !owner?.ownerId) return false;
  if (emitted.has(operation.operationId)) return false;
  emitted.add(operation.operationId);
  if (emitted.size > 500) emitted.delete(emitted.values().next().value);
  emit({ type: 'completed', completed: true, operationId: operation.operationId, owner, ownerGeneration });
  return true;
}
function bindingStamp(row = {}) {
  const values = [row.ownerIncarnation, row.accountIncarnation, row.createdAt, row.savedAt, row.updatedAt,
    row.crossBorderSettings?.createdAt, row.crossBorderSettings?.updatedAt].map(value => String(value || '').trim());
  return values.some(Boolean) ? JSON.stringify(values) : '';
}
export function observeAccountRemovalRow(rows, event) {
  const row = rows.find(item => item?.id === event.owner?.ownerId);
  return row ? { row, stamp: bindingStamp(row), operationId: event.operationId, ownerKey: ownerKey(event.owner) } : null;
}
export function filterObservedAccountRemoval(rows, observation, event) {
  if (!observation || event.completed !== true || observation.operationId !== event.operationId || observation.ownerKey !== ownerKey(event.owner)) return rows;
  const next = rows.filter(row => row.id !== event.owner.ownerId
    || (observation.stamp ? bindingStamp(row) !== observation.stamp : row !== observation.row));
  return next.length === rows.length ? rows : next;
}
export function filterCompletedOzonOwner(rows, event) {
  if (event.completed !== true || event.owner?.ownerType !== 'ozon_shop') return rows;
  const removed = normalizeOzonShopGenerationScope(event.ownerGeneration || {});
  if (!removed.shopIncarnation || !removed.credentialRevision || removed.ownerId !== event.owner.ownerId) return rows;
  const next = rows.filter(row => {
    const current = normalizeOzonShopGenerationScope(row);
    return current.ownerId !== removed.ownerId || current.shopIncarnation !== removed.shopIncarnation
      || current.credentialRevision !== removed.credentialRevision;
  });
  return next.length === rows.length ? rows : next;
}
