import { createProfitCoreBatch, decodeProfitWire, PRIVATE_PROFIT_VERSION } from '../../../../shared/profitCoreWire.js';
import { protectedComputeContractError } from './protectedComputeError.js';

const invalid = () => { throw protectedComputeContractError('PROTECTED_COMPUTE_INPUT_INVALID', 'Private profit contract is invalid.'); };
export function normalizePrivateProfitInput(input) {
  if (!input || Object.keys(input).sort().join(',') !== 'calculationVersion,callsJson'
    || input.calculationVersion !== PRIVATE_PROFIT_VERSION || typeof input.callsJson !== 'string'
    || Buffer.byteLength(input.callsJson) > 1024 * 1024) invalid();
  try {
    createProfitCoreBatch(decodeProfitWire(JSON.parse(input.callsJson)));
  } catch { invalid(); }
  return { calculationVersion: input.calculationVersion, callsJson: input.callsJson };
}
export function validatePrivateProfitResult(result) {
  if (!result || Object.keys(result).sort().join(',') !== 'calculationVersion,resultsJson'
    || result.calculationVersion !== PRIVATE_PROFIT_VERSION || typeof result.resultsJson !== 'string'
    || Buffer.byteLength(result.resultsJson) > 16 * 1024 * 1024) {
    throw protectedComputeContractError('PROTECTED_COMPUTE_RESULT_INVALID', 'Private profit result is invalid.');
  }
  try {
    const rows = decodeProfitWire(JSON.parse(result.resultsJson));
    const seen = new Set();
    if (!Array.isArray(rows) || rows.length < 1 || rows.length > 64) throw new Error('invalid rows');
    for (const row of rows) {
      if (!row || Object.keys(row).sort().join(',') !== 'id,value' || typeof row.id !== 'string'
        || !/^[A-Za-z0-9_-]{1,80}$/u.test(row.id) || seen.has(row.id)) throw new Error('invalid identity');
      seen.add(row.id);
    }
  } catch {
    throw protectedComputeContractError('PROTECTED_COMPUTE_RESULT_INVALID', 'Private profit result is invalid.');
  }
  return result;
}
