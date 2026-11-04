import { isVerifiedModelApiAccount } from '../paidCapabilities/paidCapabilityPolicy.js';
import { renderImagePromptPlanTemplate } from './imagePromptPlanTemplate.js';

function text(value) {
  return String(value ?? '').trim();
}

function normalizeCapabilities(value) {
  return (Array.isArray(value) ? value : [])
    .map((item) => text(item).toLowerCase())
    .filter(Boolean);
}

function readCompletionText(payload = {}) {
  const direct = text(payload.output_text || payload.text || payload.result);
  if (direct) return direct;
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return text(content);
  if (Array.isArray(content)) {
    return content
      .map((item) => text(item?.text || item?.content || item))
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  const output = Array.isArray(payload.output) ? payload.output : [];
  return output
    .flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
    .map((item) => text(item?.text || item?.content))
    .filter(Boolean)
    .join('\n')
    .trim();
}

function assertTextModel(account = {}, model = '') {
  if (!text(model)) throw new Error('没有选择分析/文案模型。');
  const availableModels = Array.isArray(account.availableModels) ? account.availableModels : [];
  const discovered = availableModels.length
    ? availableModels.find((item) => text(item?.id || item?.model) === model)
    : null;
  if (availableModels.length && !discovered) throw new Error('当前接口没有发现所选分析模型。');
  const capabilities = normalizeCapabilities(discovered?.capabilities || account.capabilities);
  if (capabilities.length && !capabilities.includes('text-generation')) {
    throw new Error('当前所选模型不是文本/分析模型。');
  }
  return { discovered, capabilities };
}

function supportsReferenceImageInput(account = {}, discovered = null) {
  const capabilities = normalizeCapabilities(discovered?.capabilities || account.capabilities);
  const modalities = normalizeCapabilities(discovered?.modalities || account.modalities);
  return (
    modalities.includes('image')
    || capabilities.some((capability) => [
      'multimodal',
      'vision',
      'image-input',
      'image-understanding',
    ].includes(capability))
  );
}

function isModelTimeoutError(error) {
  const name = text(error?.name);
  const message = text(error?.message);
  return name === 'TimeoutError'
    || name === 'AbortError'
    || /aborted due to timeout|timed?\s*out|超时/iu.test(message);
}

function normalizeDataUrl(value) {
  const normalized = text(value);
  return /^data:image\/(?:png|jpeg|webp);base64,/iu.test(normalized) ? normalized : '';
}

function readLocalAssetId(value) {
  const match = text(value).match(/^\/api\/(?:profile-assets|product-images\/preview)\/([^/?#]+)/u);
  if (!match) return '';
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

async function normalizeReferenceImages(input = {}, readLocalImageAsset) {
  const structured = Array.isArray(input.referenceImages)
    ? input.referenceImages
    : (Array.isArray(input.referenceImageUrls) ? input.referenceImageUrls.map((url, sourceIndex) => ({ url, sourceIndex })) : []);
  const references = [];
  const seen = new Set();
  for (const [index, item] of structured.slice(0, 10).entries()) {
    const sourceIndex = Number.isInteger(item?.sourceIndex) ? item.sourceIndex : index;
    const remoteUrl = text(item?.url);
    const dataUrl = normalizeDataUrl(item?.dataUrl || (remoteUrl.startsWith('data:') ? remoteUrl : ''));
    const assetId = text(item?.assetId) || readLocalAssetId(remoteUrl);
    let imageUrl = /^https:\/\//iu.test(remoteUrl) ? remoteUrl : dataUrl;
    if (!imageUrl && assetId && readLocalImageAsset) {
      const asset = await readLocalImageAsset(assetId);
      if (!asset) throw Object.assign(new Error('参考图片不存在或不属于当前店铺。'), { code: 'IMAGE_PROMPT_REFERENCE_UNAVAILABLE' });
      const mimeType = text(asset?.mimeType).toLowerCase();
      const dataBase64 = text(asset?.dataBase64);
      if (/^image\/(?:png|jpeg|webp)$/iu.test(mimeType) && dataBase64) {
        imageUrl = `data:${mimeType};base64,${dataBase64}`;
      }
    }
    if (!imageUrl) continue;
    const key = `${sourceIndex}:${imageUrl.slice(0, 80)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    references.push({ sourceIndex, url: imageUrl });
  }
  return references;
}

function createUserMessage(userPrompt, referenceImages = []) {
  if (!referenceImages.length) return userPrompt;
  return [
    { type: 'text', text: userPrompt },
    ...referenceImages.flatMap((reference) => [
      Number.isInteger(reference.sourceIndex)
        ? { type: 'text', text: `下面这张图片对应商品图片位置 ${reference.sourceIndex + 1}。` }
        : null,
      { type: 'image_url', image_url: { url: reference.url || reference } },
    ].filter(Boolean)),
  ];
}

export function createImagePromptPlanService({
  modelApiAccountRepository,
  profileAssetRepository,
  readLocalImageAsset = null,
  paidCapabilityAccess,
  fetchImpl = globalThis.fetch,
} = {}) {
  return {
    async generatePlan(input = {}, paidContext = {}) {
      const accountId = text(input.accountId || input.account_id);
      const model = text(input.model);
      const renderedPrompts = text(input.templateId || input.promptTemplateId)
        ? renderImagePromptPlanTemplate(input)
        : {
            systemPrompt: input.systemPrompt || input.system_prompt,
            userPrompt: input.userPrompt || input.user_prompt,
          };
      const systemPrompt = text(renderedPrompts.systemPrompt);
      const userPrompt = text(renderedPrompts.userPrompt);
      if (!systemPrompt || !userPrompt) throw new Error('缺少 Skill 分析提示词。');
      if (systemPrompt.length > 20_000 || userPrompt.length > 50_000) {
        throw new Error('Skill 分析提示词过长。');
      }
      const account = modelApiAccountRepository?.getAccountForInternalUse(accountId);
      const requestedReferenceImages = await normalizeReferenceImages(input, readLocalImageAsset
        ? assetId => readLocalImageAsset(assetId, paidContext)
        : profileAssetRepository?.getAsset ? assetId => profileAssetRepository.getAsset(assetId, { includeData: true }) : null);
      const byokUsable = Boolean(model && isVerifiedModelApiAccount(account));
      if (!byokUsable) {
        const referenceImageUrls = requestedReferenceImages
          .map((item) => text(item.url))
          .filter((url) => url.startsWith('https://'));
        const paid = await paidCapabilityAccess.execute({
          capability: 'text.image-plan',
          input: { systemPrompt, userPrompt, referenceImageUrls },
          context: paidContext,
        });
        const planText = text(paid.result?.text);
        if (!planText) throw new Error('内置分析模型没有返回图片方案。');
        return {
          ok: true,
          planText,
          model: 'builtin-points',
          accountId: '',
          referenceImageCount: referenceImageUrls.length,
          requestedReferenceImageCount: requestedReferenceImages.length,
          referenceImagePolicy: referenceImageUrls.length
            ? 'vision-planner'
            : 'deferred-to-image-model',
          usage: null,
          billing: { chargedPoints: paid.chargedPoints, source: 'paid-cloud' },
        };
      }
      const modelProfile = assertTextModel(account, model);
      const baseUrl = text(account.baseUrl).replace(/\/+$/u, '');
      if (!baseUrl.startsWith('https://')) throw new Error('分析模型 Base URL 必须使用 HTTPS。');
      const referenceImages = supportsReferenceImageInput(account, modelProfile.discovered)
        ? requestedReferenceImages
        : [];
      let response;
      try {
        response = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${account.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: createUserMessage(userPrompt, referenceImages) },
            ],
            temperature: 0.2,
          }),
          signal: AbortSignal.timeout(150_000),
        });
      } catch (error) {
        if (isModelTimeoutError(error)) {
          throw new Error('分析模型响应超时，原图仍然保留，请稍后重试或更换分析模型。');
        }
        throw new Error(`无法连接分析模型：${text(error?.message) || '未知连接错误'}`);
      }
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error?.message || `Skill 分析失败：HTTP ${response.status}`);
      const planText = readCompletionText(payload);
      if (!planText) throw new Error('分析模型没有返回图片方案。');
      return {
        ok: true,
        planText,
        model,
        accountId,
        referenceImageCount: referenceImages.length,
        requestedReferenceImageCount: Math.max(
          requestedReferenceImages.length,
          Math.min(10, Math.max(0, Number(input.requestedReferenceImageCount) || 0)),
        ),
        referenceImagePolicy: referenceImages.length
          ? 'vision-planner'
          : 'deferred-to-image-model',
        usage: payload.usage || null,
      };
    },
  };
}

export { assertTextModel, createUserMessage, normalizeReferenceImages, readCompletionText, supportsReferenceImageInput };
