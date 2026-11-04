export const SMART_TOOL_IMAGE_GENERATION_MODE_STANDARD = 'standard';
export const SMART_TOOL_IMAGE_GENERATION_MODE_FAST = 'fast';

export function normalizeSmartToolImageGenerationMode(value) {
  return String(value || '').trim().toLowerCase() === SMART_TOOL_IMAGE_GENERATION_MODE_FAST
    ? SMART_TOOL_IMAGE_GENERATION_MODE_FAST
    : SMART_TOOL_IMAGE_GENERATION_MODE_STANDARD;
}

export function getSmartToolImageGenerationModeLabel(value) {
  return normalizeSmartToolImageGenerationMode(value) === SMART_TOOL_IMAGE_GENERATION_MODE_FAST
    ? '极速生图'
    : '标准生图';
}
