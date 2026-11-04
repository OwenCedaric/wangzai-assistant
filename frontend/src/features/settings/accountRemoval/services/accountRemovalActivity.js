const activities = new Map();
const ownerKey = owner => JSON.stringify([owner?.ownerType || '', owner?.ownerId || '']);

export function registerAccountRemovalActivity(instanceId, owner, resume) {
  const entry = { owner, operationId: '', resume: task => activities.get(instanceId) === entry ? resume(task) : Promise.resolve(null) };
  activities.set(instanceId, entry);
  return entry;
}

export function updateAccountRemovalActivity(instanceId, operation) {
  const entry = activities.get(instanceId);
  if (entry) entry.operationId = String(operation?.operationId || '').trim();
}

export function releaseAccountRemovalActivity(instanceId, entry) {
  if (activities.get(instanceId) === entry) activities.delete(instanceId);
}

export function findAccountRemovalActivity(instanceId, task) {
  const others = [...activities.entries()].filter(([id]) => id !== instanceId).map(([, entry]) => entry);
  const matching = others.find(entry => entry.operationId === task.operationId
    || (!entry.operationId && ownerKey(entry.owner) === ownerKey(task.pendingOwner)));
  return { matching, blocked: !matching && others.length > 0 };
}
