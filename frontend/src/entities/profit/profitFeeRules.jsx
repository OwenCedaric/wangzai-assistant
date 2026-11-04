import { calculateCrossBorderBusFeeCny } from '../../services/feeCalculationService';
import { readSavedFeeSettings } from '../../services/feeSettingsRuntime.js';

export function getCrossBorderFixedFeeValue() {
  const settings = readSavedFeeSettings();
  return calculateCrossBorderBusFeeCny(settings);
}
