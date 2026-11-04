import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isKnownImageGenerationModelId } from './modelApiCapabilities.js';
import { APPROVED_IMAGE_API_BASE_URL } from './imageGenerationProviderPolicy.js';

const DEFAULT_TIMEOUT_MS = 6_000;
const DEFAULT_DNS_TIMEOUT_MS = 4_000;
const MAX_MODELS = 100;
const MAX_MODEL_ID_LENGTH = 160;
const MAX_OPTIONS = 32;
const MAX_OPTION_ID_LENGTH = 96;
const PRIVATE_HOSTNAMES = new Set(['localhost', 'localhost.localdomain', '::1']);
const OPTION_GROUPS = ['size', 'quality', 'style', 'upscale'];
const OPTION_ALIASES = {
  size: ['sizeOptions', 'size_options', 'sizes', 'supportedSizes', 'supported_sizes', 'imageSizes', 'image_sizes', 'resolutions', 'supportedResolutions', 'supported_resolutions', 'size'],
  quality: ['qualityOptions', 'quality_options', 'qualities', 'supportedQualities', 'supported_qualities', 'imageQuality', 'image_quality', 'quality'],
  style: ['styleOptions', 'style_options', 'styles', 'supportedStyles', 'supported_styles', 'style'],
  upscale: ['upscaleOptions', 'upscale_options', 'upscales', 'supportedUpscales', 'supported_upscales', 'upscaleFactor', 'upscale_factor', 'upscale'],
};

function normalizeText(value) {
  return value == null ? '' : String(value).trim();
}

function normalizeLower(value) {
  return normalizeText(value).toLowerCase();
}

function isPrivateAddress(address) {
  const normalized = normalizeLower(address);
  if (!normalized || PRIVATE_HOSTNAMES.has(normalized)) return true;
  if (!isIP(normalized)) return true;
  if (normalized.includes(':')) {
    return normalized === '::1'
      || normalized.startsWith('fe8')
      || normalized.startsWith('fe9')
      || normalized.startsWith('fea')
      || normalized.startsWith('feb')
      || normalized.startsWith('fc')
      || normalized.startsWith('fd');
  }
  const parts = normalized.split('.').map(Number);
  return parts[0] === 0
    || parts[0] === 10
    || parts[0] === 127
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}

function parseWebsiteUrl(value) {
  const raw = normalizeText(value);
  if (!raw) throw new Error('请填写中转站登录网址。');
  const url = new URL(/^[a-z][a-z\d+.-]*:\/\//iu.test(raw) ? raw : `https://${raw}`);
  if (url.protocol !== 'https:') throw new Error('中转站登录网址必须使用 HTTPS。');
  if (url.username || url.password) throw new Error('登录网址不能包含账号或密码。');
  return url;
}

async function assertPublicUrl(url, lookupImpl, dnsTimeoutMs) {
  const hostname = normalizeLower(url.hostname);
  if (!hostname || PRIVATE_HOSTNAMES.has(hostname) || (isIP(hostname) && isPrivateAddress(hostname))) {
    throw new Error('中转站网址不能指向本机或内网地址。');
  }
  let timerId;
  const records = await Promise.race([
    lookupImpl(hostname, { all: true }),
    new Promise((_, reject) => {
      timerId = setTimeout(() => reject(new Error('中转站域名解析超时。')), dnsTimeoutMs);
    }),
  ]).finally(() => {
    if (timerId) clearTimeout(timerId);
  });
  if (!Array.isArray(records) || !records.length || records.some((item) => isPrivateAddress(item.address))) {
    throw new Error('中转站网址不能指向本机或内网地址。');
  }
}

function joinUrl(baseUrl, path) {
  return baseUrl.replace(/\/$/u, '') + '/' + path.replace(/^\//u, '');
}

function knownProfile(url) {
  const hostname = normalizeLower(url.hostname);
  if (hostname === new URL(APPROVED_IMAGE_API_BASE_URL).hostname) {
    return {
      provider: 'codesonline',
      alias: 'codesonline 中转站',
      baseUrl: `${url.origin}/v1`,
      fallbackModels: [
        {
          id: 'gpt-image-2',
          label: 'gpt-image-2',
          capabilities: ['image-generation', 'image-edit'],
          modalities: ['text', 'image'],
        },
      ],
    };
  }
  return null;
}

function candidateBaseUrls(url, profile) {
  const candidates = [];
  if (profile?.baseUrl) candidates.push(profile.baseUrl);
  const path = url.pathname.replace(/\/+$/u, '');
  if (/\/v1$/iu.test(path)) candidates.push(`${url.origin}${path}`);
  candidates.push(`${url.origin}/v1`, `${url.origin}/api/v1`);
  return [...new Set(candidates.map((item) => item.replace(/\/$/u, '')))].slice(0, 4);
}

function normalizeCapabilityList(value) {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  return [...new Set(values
    .flatMap((item) => typeof item === 'string' ? item.split(/[\s,|]+/u) : [])
    .map(normalizeLower)
    .filter(Boolean))].slice(0, 32);
}

function optionRows(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    return Object.entries(value).map(([id, item]) => (
      item && typeof item === 'object' && !Array.isArray(item)
        ? { ...item, id: item.id || item.value || id }
        : { id, label: item }
    ));
  }
  return value == null || value === '' ? [] : [value];
}

function normalizeOptionList(value) {
  const seen = new Set();
  return optionRows(value)
    .map((item) => {
      const id = normalizeText(typeof item === 'string' || typeof item === 'number'
        ? item
        : item?.id || item?.value || item?.name || item?.key);
      if (!id || id.length > MAX_OPTION_ID_LENGTH || seen.has(id)) return null;
      seen.add(id);
      return {
        id,
        label: normalizeText(typeof item === 'string' || typeof item === 'number'
          ? item
          : item?.label || item?.displayName || item?.name || item?.value || id).slice(0, MAX_OPTION_ID_LENGTH) || id,
      };
    })
    .filter(Boolean)
    .slice(0, MAX_OPTIONS);
}

function normalizeOptionGroups(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const group of OPTION_GROUPS) {
    const source = OPTION_ALIASES[group].find((key) => Object.prototype.hasOwnProperty.call(value, key));
    if (!source) continue;
    const options = normalizeOptionList(value[source]);
    if (options.length) result[group] = options;
  }
  return result;
}

function mergeOptionGroups(...groups) {
  const result = {};
  for (const group of OPTION_GROUPS) {
    const seen = new Set();
    const options = groups.flatMap((item) => item?.[group] || [])
      .filter((item) => item && !seen.has(item.id) && seen.add(item.id));
    if (options.length) result[group] = options.slice(0, MAX_OPTIONS);
  }
  return result;
}

function hasAny(values, patterns) {
  return values.some((value) => patterns.some((pattern) => value.includes(pattern)));
}

function modelCapabilities(rawModel = {}) {
  const id = normalizeLower(rawModel.id || rawModel.name || rawModel.model);
  const metadata = [
    ...normalizeCapabilityList(rawModel.capabilities),
    ...normalizeCapabilityList(rawModel.supported_endpoints),
    ...normalizeCapabilityList(rawModel.endpoints),
    ...normalizeCapabilityList(rawModel.modalities),
    ...normalizeCapabilityList(rawModel.input_modalities),
    ...normalizeCapabilityList(rawModel.output_modalities),
  ];
  const capabilities = new Set();
  const modalities = new Set();
  if (hasAny(metadata, ['image', 'vision', 'picture'])) modalities.add('image');
  if (hasAny(metadata, ['text', 'chat', 'completion', 'response'])) modalities.add('text');
  if (hasAny(metadata, ['audio', 'speech'])) modalities.add('audio');
  if (hasAny(metadata, ['video'])) modalities.add('video');
  if (hasAny(metadata, ['edit', 'image_edit', 'images/edits'])) capabilities.add('image-edit');
  if (hasAny(metadata, ['generation', 'generate', 'images/generations', 'text-to-image'])) {
    capabilities.add('image-generation');
  }
  if (hasAny(metadata, ['chat', 'completion', 'response']) || /gpt|claude|gemini|qwen|deepseek/u.test(id)) {
    capabilities.add('text-generation');
  }
  if (modalities.has('image') && modalities.has('text')) capabilities.add('multimodal');
  if (isKnownImageGenerationModelId(id)) {
    capabilities.add('image-generation');
  }
  if (/gpt-image|dall-e/u.test(id)) capabilities.add('image-edit');
  if (!capabilities.size && !modalities.size) capabilities.add('unknown');
  return {
    capabilities: [...capabilities].sort(),
    modalities: [...modalities].sort(),
  };
}

function normalizeModels(payload) {
  const rows = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : Array.isArray(payload)
        ? payload
        : [];
  const globalOptions = mergeOptionGroups(
    normalizeOptionGroups(payload),
    normalizeOptionGroups(payload?.options),
    normalizeOptionGroups(payload?.parameters),
    normalizeOptionGroups(payload?.supported_parameters),
    normalizeOptionGroups(payload?.parameter_options),
    normalizeOptionGroups(payload?.supported_options),
  );
  const seen = new Set();
  const models = [];
  for (const row of rows) {
    const id = normalizeText(typeof row === 'string' ? row : row?.id || row?.name || row?.model);
    if (!id || id.length > MAX_MODEL_ID_LENGTH || seen.has(id)) continue;
    seen.add(id);
    const raw = typeof row === 'string' ? { id } : row;
    const { capabilities, modalities } = modelCapabilities(raw);
    const options = mergeOptionGroups(
      globalOptions,
      normalizeOptionGroups(raw),
      normalizeOptionGroups(raw?.options),
      normalizeOptionGroups(raw?.parameters),
      normalizeOptionGroups(raw?.supported_parameters),
      normalizeOptionGroups(raw?.parameter_options),
      normalizeOptionGroups(raw?.supported_options),
    );
    const model = {
      id,
      label: normalizeText(raw?.display_name || raw?.label || id).slice(0, MAX_MODEL_ID_LENGTH),
      capabilities,
      modalities,
    };
    if (Object.keys(options).length) model.options = options;
    models.push(model);
    if (models.length >= MAX_MODELS) break;
  }
  return models;
}

function aggregateCapabilities(models) {
  return [...new Set(models.flatMap((item) => item.capabilities || []))].sort();
}

function usageSceneForCapabilities(capabilities) {
  const labels = [];
  if (capabilities.includes('text-generation')) labels.push('文本');
  if (capabilities.includes('image-generation')) labels.push('文生图');
  if (capabilities.includes('image-edit')) labels.push('图生图');
  if (capabilities.includes('multimodal')) labels.push('多模态');
  return labels.join(' / ') || '待识别能力';
}

function createAlias(url, profile) {
  if (profile?.alias) return profile.alias;
  return `${url.hostname.replace(/^www\./iu, '')} 中转站`;
}

function responseStatusMessage({ verified, models, profile, unauthorized }) {
  if (verified) return `已自动识别接口，发现 ${models.length} 个可用模型。`;
  if (unauthorized) return '已找到接口，但 API Key 校验失败，请检查密钥。';
  if (profile) return '已识别中转站类型，暂未读取到模型列表，可稍后重新保存重试。';
  return '暂未识别到可用 API 接口，请检查网址或更换受支持的中转站。';
}

export function createModelApiDiscoveryService({
  fetchImpl = globalThis.fetch,
  lookupImpl = dnsLookup,
  now = () => new Date(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  dnsTimeoutMs = DEFAULT_DNS_TIMEOUT_MS,
} = {}) {
  async function readModels(url, apiKey) {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}`, 'X-API-Key': apiKey } : {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 401 || response.status === 403) return { unauthorized: true, models: [] };
    if (!response.ok) return { unauthorized: false, models: [] };
    const contentLength = Number(response.headers?.get?.('content-length') || 0);
    if (contentLength > 2 * 1024 * 1024) return { unauthorized: false, models: [] };
    const payload = await response.json().catch(() => null);
    return { unauthorized: false, models: normalizeModels(payload) };
  }

  async function discover(input = {}) {
    const websiteUrl = parseWebsiteUrl(input.websiteUrl);
    await assertPublicUrl(websiteUrl, lookupImpl, dnsTimeoutMs);
    const apiKey = normalizeText(input.apiKey);
    const profile = knownProfile(websiteUrl);
    const candidates = candidateBaseUrls(websiteUrl, profile);
    let unauthorized = false;
    for (const baseUrl of candidates) {
      try {
        const result = await readModels(joinUrl(baseUrl, '/models'), apiKey);
        unauthorized ||= result.unauthorized;
        if (result.models.length > 0) {
          const capabilities = aggregateCapabilities(result.models);
          return {
            updates: {
              apiAlias: normalizeText(input.apiAlias) || createAlias(websiteUrl, profile),
              provider: profile?.provider || websiteUrl.hostname,
              baseUrl,
              defaultModel: result.models.find((item) => item.capabilities.includes('image-edit'))?.id
                || result.models.find((item) => item.capabilities.includes('image-generation'))?.id
                || result.models[0].id,
              usageScene: usageSceneForCapabilities(capabilities),
              detectionStatus: responseStatusMessage({ verified: true, models: result.models, profile, unauthorized }),
              detectedSource: joinUrl(baseUrl, '/models'),
              detectedAt: now().toISOString(),
              availableModels: result.models,
              capabilities,
              discoveryVerified: true,
            },
          };
        }
      } catch {
        // Continue through the bounded candidate list. Details are intentionally not returned to the UI.
      }
    }

    const fallbackModels = profile?.fallbackModels || [];
    const capabilities = aggregateCapabilities(fallbackModels);
    return {
      updates: {
        apiAlias: normalizeText(input.apiAlias) || createAlias(websiteUrl, profile),
        provider: profile?.provider || websiteUrl.hostname,
        baseUrl: profile?.baseUrl || '',
        defaultModel: fallbackModels[0]?.id || '',
        usageScene: usageSceneForCapabilities(capabilities),
        detectionStatus: responseStatusMessage({ verified: false, models: fallbackModels, profile, unauthorized }),
        detectedSource: profile ? '内置中转站规则' : '',
        detectedAt: now().toISOString(),
        availableModels: fallbackModels,
        capabilities,
        discoveryVerified: false,
      },
    };
  }

  return { discover };
}
