import { normalizeEstimatedCommissionPercent } from '../../services/feeCalculationService';

export function firstCommissionRate(...values) {
  for (const value of values) {
    const number = normalizeEstimatedCommissionPercent(value);
    if (number !== null) return number;
  }
  return null;
}
