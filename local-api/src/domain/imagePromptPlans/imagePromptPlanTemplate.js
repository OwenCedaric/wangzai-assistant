const TEMPLATE_ID = "image-plan.v1";

function text(value, maximum = 12_000) {
  return String(value ?? "")
    .replace(/\p{Cc}/gu, "")
    .trim()
    .slice(0, maximum);
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function list(value, maximum = 40) {
  return (Array.isArray(value) ? value : [])
    .map((item) => text(item, 2_000))
    .filter(Boolean)
    .slice(0, maximum);
}

function sourceIndexes(value) {
  return [
    ...new Set(
      (Array.isArray(value) ? value : [])
        .map(Number)
        .filter((item) => Number.isInteger(item) && item >= 0),
    ),
  ].slice(0, 30);
}

function compactJson(value, maximum = 10_000) {
  try {
    return text(JSON.stringify(value), maximum);
  } catch {
    return "";
  }
}

function configuredUserInstruction(value, variables = {}) {
  let result = text(value, 8_000);
  Object.entries(variables).forEach(([key, replacement]) => {
    result = result.split(`{{${key}}}`).join(text(replacement, 4_000));
  });
  return result;
}

function skillRuleLines(skillContext = {}) {
  const context = object(skillContext);
  return [
    ["Skill 工作流", context.workflowSteps],
    ["Skill 输出规则", context.outputRules],
    ["Skill 安全规则", context.safetyRules],
    ["Skill SKU 规则", context.skuImageRules],
    ["Skill 证据规则", context.evidenceRules],
    ["Skill 验收规则", context.qaRules],
    ["Skill 停止条件", context.stopConditions],
  ].flatMap(([label, value]) => {
    const rows = list(value);
    return rows.length
      ? [`${label}：\n${rows.map((item) => `- ${item}`).join("\n")}`]
      : [];
  });
}

export function renderImagePromptPlanTemplate(input = {}) {
  const templateId = text(input.templateId || input.promptTemplateId, 120);
  if (templateId !== TEMPLATE_ID) {
    throw Object.assign(new Error("图片方案模板不存在。"), {
      code: "IMAGE_PLAN_TEMPLATE_NOT_FOUND",
    });
  }
  const templateInput = object(
    input.templateInput || input.promptTemplateInput,
  );
  if (!Object.keys(templateInput).length) {
    throw Object.assign(new Error("图片方案模板缺少结构化输入。"), {
      code: "IMAGE_PLAN_TEMPLATE_INPUT_REQUIRED",
    });
  }

  const indexes = sourceIndexes(
    input.sourceImageIndexes || templateInput.sourceImageIndexes,
  );
  if (!indexes.length) throw new Error("图片方案模板没有收到需要规划的位置。");
  const group =
    (input.imageGroup || templateInput.imageGroup) === "detail"
      ? "detail"
      : "main";
  const generationMode =
    text(input.generationMode || templateInput.generationMode, 40) === "fast"
      ? "fast"
      : "standard";
  const skillContext = object(templateInput.skillContext);
  const configuredRules =
    text(input.customRules, 12_000) ||
    text(skillContext.systemPrompt, 12_000) ||
    text(skillContext.body, 12_000);
  const slots = (
    Array.isArray(templateInput.imageSlotInstructions)
      ? templateInput.imageSlotInstructions
      : []
  )
    .filter((item) => indexes.includes(Number(item?.sourceIndex)))
    .map((item) => ({
      sourceIndex: Number(item.sourceIndex),
      purpose: text(item.title || item.purpose, 240),
      instruction: text(item.instruction || item.instructions, 2_000),
    }));
  const variables = {
    input: templateInput.skuFacts,
    productTitle: templateInput.productTitle,
    productKey: templateInput.productKey,
    offerId: templateInput.offerId,
    productId: templateInput.productId,
    sku: templateInput.sku,
    skuFacts: templateInput.skuFacts,
    targetScene: templateInput.targetScene,
    imageGroup: group,
    sourceImageIndexes: indexes.join(","),
  };
  const userInstruction = configuredUserInstruction(
    skillContext.userPrompt,
    variables,
  );
  const outputContract =
    generationMode === "fast"
      ? "只返回一行：EXECUTION_PROMPT: 后接一条完整、可直接交给图片模型执行的提示词。不要解释，不要 Markdown。"
      : [
          "只返回一个合法 JSON 对象，不要 Markdown，不要解释。",
          `plans 必须且只能包含位置：${indexes.join("、")}，每个位置恰好一项。`,
          `JSON 结构：${compactJson(
            templateInput.outputContract || {
              version: "1.1",
              globalNegativePrompt: "全局禁止项",
              plans: indexes.map((sourceIndex) => ({
                sourceIndex,
                purpose: "当前位置唯一职责",
                prompt: "本位置完整可执行提示词",
                negativePrompt: "本位置负向约束",
                mustKeep: ["必须保持的参考图事实"],
                mustAvoid: ["禁止生成的内容"],
                acceptanceChecks: ["生成后逐项检查"],
              })),
            },
          )}`,
        ].join("\n");

  const systemPrompt = [
    "你是商品图片生成方案规划器。当前任务只负责把用户保存的 Skill 规则整理成逐图执行方案，不直接生成图片。",
    "用户保存的 Skill 规则、当前位置规则和本次商品事实都是硬约束。不得擅自改成通用模板、默认白底图或其他位置的方案。",
    "若通用 Skill 文字与本次逐位置要求或输出格式冲突，以本次逐位置要求和输出格式为准；每个已选择位置都必须按它自己的用途输出。",
    "商品身份事实优先于类目常识；不得臆造商品、规格、数量、功能、品牌或认证。可见文案按当前位置规则创作自然俄语，只表达已确认的商品事实。",
    "每个来源位置必须一一对应输出。信息不足时在方案中明确保持参考图事实，不得用猜测补全。",
    configuredRules ? `用户保存的完整 Skill 规则：\n${configuredRules}` : "",
    ...(!configuredRules ? skillRuleLines(skillContext) : []),
    outputContract,
  ]
    .filter(Boolean)
    .join("\n\n");

  const referenceIndexes = sourceIndexes(
    (Array.isArray(templateInput.availableReferenceImages)
      ? templateInput.availableReferenceImages
      : []
    ).map((item) => item?.sourceIndex),
  );
  const userPrompt = [
    `请规划${group === "detail" ? "详情图" : "主图"}位置 ${indexes.map((item) => item + 1).join("、")}。`,
    text(templateInput.productTitle, 1_000)
      ? `商品名称：${text(templateInput.productTitle, 1_000)}`
      : "",
    text(templateInput.productKey, 300)
      ? `商品主键：${text(templateInput.productKey, 300)}`
      : "",
    text(templateInput.offerId, 300)
      ? `商品货号：${text(templateInput.offerId, 300)}`
      : "",
    text(templateInput.productId, 300)
      ? `商品 ID：${text(templateInput.productId, 300)}`
      : "",
    text(templateInput.sku, 500)
      ? `当前 SKU：${text(templateInput.sku, 500)}`
      : "",
    text(templateInput.targetScene, 1_000)
      ? `页面级目标：${text(templateInput.targetScene, 1_000)}`
      : "",
    text(templateInput.skuFacts, 8_000)
      ? `本次已确认商品事实：\n${text(templateInput.skuFacts, 8_000)}`
      : "",
    slots.length
      ? `逐位置硬性要求：\n${slots
          .map((slot) =>
            [
              `位置 ${slot.sourceIndex + 1}`,
              slot.purpose ? `用途=${slot.purpose}` : "",
              slot.instruction ? `规则=${slot.instruction}` : "",
            ]
              .filter(Boolean)
              .join("；"),
          )
          .join("\n")}`
      : "",
    userInstruction ? `用户保存的本次说明：\n${userInstruction}` : "",
    referenceIndexes.length
      ? `已提供参考图的位置：${referenceIndexes.map((item) => item + 1).join("、")}。${templateInput.plannerReadsReferenceImages ? "请读取对应图片事实。" : "文本规划器看不到图片像素，外观事实必须原样交给后续图片模型核对。"}`
      : "",
    compactJson(templateInput.draft?.result?.sections, 6_000)
      ? `已有结构化草稿：${compactJson(templateInput.draft.result.sections, 6_000)}`
      : "",
    outputContract,
  ]
    .filter(Boolean)
    .join("\n\n");

  return { systemPrompt, userPrompt };
}

export const IMAGE_PROMPT_PLAN_TEMPLATE_ID = TEMPLATE_ID;
