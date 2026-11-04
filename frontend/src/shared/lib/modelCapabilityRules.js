const IMAGE_GENERATION_CAPABILITY_PATTERN = /(?:^|[/_.-])(?:image[-_ ]?(?:generation|generate|edit|editing)|images[/_-](?:generations|edits)|text[-_ ]?to[-_ ]?image)(?:$|[/_.-])/iu;

const IMAGE_MODEL_FAMILY_PATTERN = /(?:gpt[-_.]?image|dall[-_.]?e|(?:^|[-_.])(?:image\d*|imagen\d*|flux|stable[-_.]?diffusion|sdxl|recraft|ideogram|midjourney|banana|seedream|dreamina|jimeng|kolors|playground)(?:$|[-_.\d]))/iu;

function normalizeText(value) {
  return value == null ? '' : String(value).trim();
}

function capabilityValues(model = {}) {
  return [
    ...(Array.isArray(model.capabilities) ? model.capabilities : []),
    ...(Array.isArray(model.supportedEndpoints) ? model.supportedEndpoints : []),
    ...(Array.isArray(model.supported_endpoints) ? model.supported_endpoints : []),
    ...(Array.isArray(model.endpoints) ? model.endpoints : []),
  ].map((value) => normalizeText(value).toLowerCase()).filter(Boolean);
}

export function isImageGenerationModel(model = {}) {
  const capabilities = capabilityValues(model);
  if (
    capabilities.includes('image-generation') ||
    capabilities.includes('image-edit') ||
    capabilities.some((value) => IMAGE_GENERATION_CAPABILITY_PATTERN.test(value))
  ) {
    return true;
  }

  const outputModalities = Array.isArray(model.outputModalities)
    ? model.outputModalities
    : Array.isArray(model.output_modalities)
      ? model.output_modalities
      : [];
  if (outputModalities.some((value) => /^(?:image|picture)$/iu.test(normalizeText(value)))) return true;

  const identity = [model.id, model.model, model.name, model.label].map(normalizeText).filter(Boolean).join(' ');
  return IMAGE_MODEL_FAMILY_PATTERN.test(identity);
}

export function filterImageGenerationModels(models = []) {
  return (Array.isArray(models) ? models : []).filter(isImageGenerationModel);
}
