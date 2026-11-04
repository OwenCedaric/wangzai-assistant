/** Drain observes settlement, not save success. Original write promises remain
 * rejected for their callers; a genuinely pending write is always awaited. */
export async function settleOwnerWriteDrain(pending = []) {
  const writes = [...new Set((Array.isArray(pending) ? pending : [pending]).filter(Boolean))];
  const results = await Promise.allSettled(writes);
  const failedWrites = results.filter(result => result.status === 'rejected').length;
  return { drained: true, lastWriteFailed: failedWrites > 0, failedWrites };
}
