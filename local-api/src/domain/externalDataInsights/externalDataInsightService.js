import {
  assertTextModel,
  readCompletionText,
} from "../productDescriptions/productDescriptionService.js";
import { isVerifiedModelApiAccount } from "../paidCapabilities/paidCapabilityPolicy.js";

export const EXTERNAL_DATA_INSIGHT_MODEL_TIMEOUT_MS = 270_000;
export const EXTERNAL_DATA_INSIGHT_PREFLIGHT_TIMEOUT_MS = 15_000;

function text(value) {
  return String(value ?? "").trim();
}

function isModelTimeoutError(error) {
  const name = text(error?.name);
  const message = text(error?.message);
  return (
    name === "TimeoutError" ||
    /aborted due to timeout|timed?\s*out|超时/iu.test(message)
  );
}

function isModelTransportError(error) {
  const message = [error?.message, error?.cause?.message, error?.cause?.code]
    .map(text)
    .filter(Boolean)
    .join(" ");
  return /fetch failed|network|ECONN|ENOTFOUND|EAI_AGAIN|socket|TLS|certificate|连接|网络/iu.test(
    message,
  );
}

function createModelConnectionError(error) {
  const wrapped = new Error(
    "自有模型接口当前无法连接，请检查中转站服务状态、网络或代理设置后重试。",
    {
      cause: error,
    },
  );
  wrapped.code = "MODEL_API_CONNECTION_FAILED";
  return wrapped;
}

export function createExternalDataInsightService({
  modelApiAccountRepository,
  paidCapabilityAccess,
  fetchImpl = globalThis.fetch,
  modelRequestTimeoutMs = EXTERNAL_DATA_INSIGHT_MODEL_TIMEOUT_MS,
  modelPreflightTimeoutMs = EXTERNAL_DATA_INSIGHT_PREFLIGHT_TIMEOUT_MS,
} = {}) {
  return {
    async generate(input = {}, paidContext = {}) {
      const accountId = text(input.accountId || input.account_id);
      const model = text(input.model);
      const systemPrompt = text(input.systemPrompt || input.system_prompt);
      const userPrompt = text(input.userPrompt || input.user_prompt);
      if (!systemPrompt || !userPrompt) throw new Error("缺少数据分析提示词。");
      if (systemPrompt.length > 24_000 || userPrompt.length > 120_000) {
        throw new Error("数据分析内容过长，请缩小本次查询范围。");
      }
      const executePaidFallback = async () => {
        const paid = await paidCapabilityAccess.execute({
          capability: "text.external-insight",
          input: { systemPrompt, userPrompt },
          context: paidContext,
        });
        const reportText = text(paid.result?.text);
        if (!reportText) throw new Error("内置文本模型没有返回分析报告。");
        return {
          ok: true,
          reportText,
          model: "builtin-points",
          accountId: "",
          usage: null,
          billing: { chargedPoints: paid.chargedPoints, source: "paid-cloud" },
        };
      };
      const account =
        modelApiAccountRepository?.getAccountForInternalUse(accountId);
      const byokUsable = Boolean(model && isVerifiedModelApiAccount(account));
      if (!byokUsable) {
        return executePaidFallback();
      }
      assertTextModel(account, model);
      const baseUrl = text(account.baseUrl).replace(/\/+$/u, "");
      if (!baseUrl.startsWith("https://"))
        throw new Error("文本模型 Base URL 必须使用 HTTPS。");
      if (input.allowPaidFallback === true) {
        try {
          const preflight = await fetchImpl(`${baseUrl}/models`, {
            method: "GET",
            headers: {
              Authorization: `Bearer ${account.apiKey}`,
              Accept: "application/json",
            },
            signal: AbortSignal.timeout(
              Math.max(
                1_000,
                Number(modelPreflightTimeoutMs) ||
                  EXTERNAL_DATA_INSIGHT_PREFLIGHT_TIMEOUT_MS,
              ),
            ),
          });
          const unavailable = preflight.ok !== true;
          await preflight.body?.cancel?.().catch(() => undefined);
          if (unavailable) return executePaidFallback();
        } catch (error) {
          if (isModelTimeoutError(error) || isModelTransportError(error)) {
            return executePaidFallback();
          }
          throw error;
        }
      }
      let response;
      try {
        response = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${account.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt },
            ],
            temperature: 0.15,
          }),
          signal: AbortSignal.timeout(
            Math.max(
              1_000,
              Number(modelRequestTimeoutMs) ||
                EXTERNAL_DATA_INSIGHT_MODEL_TIMEOUT_MS,
            ),
          ),
        });
      } catch (error) {
        if (isModelTimeoutError(error)) {
          throw new Error(
            "分析模型响应超时，本次查询数据仍然保留，请点击“重新分析”。",
          );
        }
        if (isModelTransportError(error))
          throw createModelConnectionError(error);
        throw error;
      }
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(
          payload?.error?.message || `数据分析失败：HTTP ${response.status}`,
        );
      }
      const reportText = readCompletionText(payload);
      if (!reportText) throw new Error("文本模型没有返回分析报告。");
      return {
        ok: true,
        reportText,
        model,
        accountId,
        usage: payload.usage || null,
      };
    },
  };
}
