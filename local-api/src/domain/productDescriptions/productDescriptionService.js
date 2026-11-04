import { isVerifiedModelApiAccount } from '../paidCapabilities/paidCapabilityPolicy.js';

function text(value) {
  return String(value ?? '').trim();
}

function normalizeCapabilities(value) {
  return (Array.isArray(value) ? value : []).map((item) => text(item).toLowerCase()).filter(Boolean);
}

function readCompletionText(payload = {}) {
  const direct = text(payload.output_text || payload.text || payload.result);
  if (direct) return direct;
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return text(content);
  if (Array.isArray(content)) {
    return content.map((item) => text(item?.text || item?.content || item)).filter(Boolean).join('\n').trim();
  }
  const output = Array.isArray(payload.output) ? payload.output : [];
  return output
    .flatMap((item) => Array.isArray(item?.content) ? item.content : [])
    .map((item) => text(item?.text || item?.content))
    .filter(Boolean)
    .join('\n')
    .trim();
}

function assertTextModel(account = {}, model = '') {
  if (!text(model)) throw new Error('没有选择商品描述文本模型。');
  const availableModels = Array.isArray(account.availableModels) ? account.availableModels : [];
  const discovered = availableModels.length
    ? availableModels.find((item) => text(item?.id || item?.model) === model)
    : null;
  if (availableModels.length && !discovered) throw new Error('当前接口没有发现所选文本模型。');
  const capabilities = normalizeCapabilities(discovered?.capabilities || account.capabilities);
  if (capabilities.length && !capabilities.includes('text-generation')) {
    throw new Error('当前所选模型不是文本生成模型。');
  }
}

export function createProductDescriptionService({
  modelApiAccountRepository,
  paidCapabilityAccess,
  fetchImpl = globalThis.fetch,
} = {}) {
  return {
    async generateDescription(input = {}, paidContext = {}) {
      const accountId = text(input.accountId || input.account_id);
      const model = text(input.model);
      const systemPrompt = text(input.systemPrompt || input.system_prompt);
      const userPrompt = text(input.userPrompt || input.user_prompt);
      if (!systemPrompt || !userPrompt) throw new Error('缺少商品描述生成提示词。');
      if (systemPrompt.length > 12000 || userPrompt.length > 30000) throw new Error('商品描述生成提示词过长。');
      const account = modelApiAccountRepository?.getAccountForInternalUse(accountId);
      const byokUsable = Boolean(model && isVerifiedModelApiAccount(account));
      if (!byokUsable) {
        const paid = await paidCapabilityAccess.execute({
          capability: 'text.product-description',
          input: { systemPrompt, userPrompt },
          context: paidContext,
        });
        const description = text(paid.result?.text);
        if (!description) throw new Error('内置文本模型没有返回商品描述。');
        return {
          ok: true,
          description,
          model: 'builtin-points',
          accountId: '',
          usage: null,
          billing: { chargedPoints: paid.chargedPoints, source: 'paid-cloud' },
        };
      }
      assertTextModel(account, model);
      const baseUrl = text(account.baseUrl).replace(/\/+$/u, '');
      if (!baseUrl.startsWith('https://')) throw new Error('文本模型 Base URL 必须使用 HTTPS。');
      const response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${account.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.25,
        }),
        signal: AbortSignal.timeout(120000),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error?.message || `商品描述生成失败：HTTP ${response.status}`);
      const description = readCompletionText(payload);
      if (!description) throw new Error('文本模型没有返回商品描述。');
      return {
        ok: true,
        description,
        model,
        accountId,
        usage: payload.usage || null,
      };
    },
  };
}

export { assertTextModel, readCompletionText };
