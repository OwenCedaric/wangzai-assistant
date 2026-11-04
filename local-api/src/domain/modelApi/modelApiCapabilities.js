const IMAGE_GENERATION_CAPABILITY_PATTERN = /(?:^|[/_.-])(?:image[-_ ]?(?:generation|generate|edit|editing)|images[/_-](?:generations|edits)|text[-_ ]?to[-_ ]?image)(?:$|[/_.-])/iu;

const IMAGE_MODEL_FAMILY_PATTERN = /(?:gpt[-_.]?image|dall[-_.]?e|(?:^|[-_.])(?:image\d*|imagen\d*|flux|stable[-_.]?diffusion|sdxl|recraft|ideogram|midjourney|banana|seedream|dreamina|jimeng|kolors|playground)(?:$|[-_.\d]))/iu;

function normalizeText(value) {
  return value == null ? '' : String(value).trim();
}

function arrayValues(value) {
  return Array.isArray(value) ? value : value == null ? [] : [value];
}

export function isKnownImageGenerationModelId(value) {
  return IMAGE_MODEL_FAMILY_PATTERN.test(normalizeText(value));
}

export function isImageGenerationModel(model = {}) {
  const capabilities = [
    ...arrayValues(model.capabilities),
    ...arrayValues(model.supportedEndpoints),
    ...arrayValues(model.supported_endpoints),
    ...arrayValues(model.endpoints),
  ].map((value) => normalizeText(value).toLowerCase()).filter(Boolean);
  if (
    capabilities.includes('image-generation') ||
    capabilities.includes('image-edit') ||
    capabilities.some((value) => IMAGE_GENERATION_CAPABILITY_PATTERN.test(value))
  ) {
    return true;
  }

  const outputModalities = arrayValues(model.outputModalities ?? model.output_modalities);
  if (outputModalities.some((value) => /^(?:image|picture)$/iu.test(normalizeText(value)))) return true;

  return isKnownImageGenerationModelId(model.id || model.model || model.name || model.label);
}
