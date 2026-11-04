import assert from "node:assert/strict";
import test from "node:test";
import {
  createImagePromptPlanService,
  createUserMessage,
} from "./imagePromptPlanService.js";

function createRepository(model = "gpt-5.5", modelMetadata = {}) {
  return {
    getAccountForInternalUse(accountId) {
      if (accountId !== "text-account") return null;
      return {
        id: accountId,
        baseUrl: "https://relay.example/v1",
        apiKey: "secret-key",
        discoveryVerified: true,
        availableModels: [
          { id: model, capabilities: ["text-generation"], ...modelMetadata },
        ],
      };
    },
  };
}

test('local planner references use the authorized scoped reader, never the global profile blob fallback', async () => {
  const scope = { tenantId: 'a', userId: 'u', shopId: 'shop-a' };
  let requests = 0;
  const service = createImagePromptPlanService({
    modelApiAccountRepository: createRepository(),
    profileAssetRepository: { getAsset() { throw new Error('GLOBAL_BLOB_FALLBACK_FORBIDDEN'); } },
    readLocalImageAsset: async (id, context) => {
      assert.equal(id, 'asset-private');
      assert.equal(context, scope);
      return null;
    },
    fetchImpl: async () => { requests += 1; throw new Error('UNEXPECTED_PROVIDER_REQUEST'); },
  });
  await assert.rejects(service.generatePlan({ accountId: 'text-account', model: 'gpt-5.5',
    systemPrompt: 'Analyze', userPrompt: 'Product', referenceImages: [{ sourceIndex: 0, assetId: 'asset-private' }],
  }, scope), { code: 'IMAGE_PROMPT_REFERENCE_UNAVAILABLE' });
  assert.equal(requests, 0);
});

test("keeps a text-only planner request free of reference images", async () => {
  let request = null;
  const service = createImagePromptPlanService({
    modelApiAccountRepository: createRepository(),
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"plans":[]}' } }],
        }),
      };
    },
  });
  const result = await service.generatePlan({
    accountId: "text-account",
    model: "gpt-5.5",
    systemPrompt: "完整 Skill 规则",
    userPrompt: "商品：保温杯。",
    referenceImageUrls: ["https://img.example/cup.jpg"],
  });
  const body = JSON.parse(request.options.body);
  assert.equal(result.planText, '{"plans":[]}');
  assert.equal(request.url, "https://relay.example/v1/chat/completions");
  assert.equal(body.model, "gpt-5.5");
  assert.equal(body.messages[0].content, "完整 Skill 规则");
  assert.equal(body.messages[1].content, "商品：保温杯。");
  assert.equal(result.referenceImageCount, 0);
  assert.equal(result.requestedReferenceImageCount, 1);
  assert.equal(result.referenceImagePolicy, "deferred-to-image-model");
  assert.equal(JSON.stringify(body).includes("secret-key"), false);
});

test("renders the protected image-plan template sent by the frontend", async () => {
  let request = null;
  const service = createImagePromptPlanService({
    modelApiAccountRepository: createRepository(),
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content:
                  '{"plans":[{"sourceIndex":2,"prompt":"执行材质特写"}]}',
              },
            },
          ],
        }),
      };
    },
  });

  const result = await service.generatePlan({
    accountId: "text-account",
    model: "gpt-5.5",
    templateId: "image-plan.v1",
    imageGroup: "main",
    sourceImageIndexes: [2],
    customRules: "用户要求：第三张必须生成材质细节特写，不得改成白底图。",
    templateInput: {
      productTitle: "汽车脚垫",
      skuFacts: "黑色毛毡材质",
      imageGroup: "main",
      sourceImageIndexes: [2],
      plannerReadsReferenceImages: false,
      availableReferenceImages: [
        { sourceIndex: 2, url: "https://img.example/mat.jpg" },
      ],
      imageSlotInstructions: [
        {
          sourceIndex: 2,
          title: "材质细节特写",
          instruction: "放大纤维纹理；画面文字：使用自然俄语短标题",
        },
      ],
      outputContract: {
        version: "1.1",
        plans: [{ sourceIndex: 2, prompt: "本位置完整可执行提示词" }],
      },
      skillContext: { userPrompt: "严格按 {{productTitle}} 的位置规则执行。" },
    },
    requestedReferenceImageCount: 1,
  });

  const body = JSON.parse(request.options.body);
  assert.equal(result.planText.includes("执行材质特写"), true);
  assert.match(body.messages[0].content, /用户保存的完整 Skill 规则/u);
  assert.match(body.messages[0].content, /第三张必须生成材质细节特写/u);
  assert.match(body.messages[0].content, /可见文案按当前位置规则创作自然俄语/u);
  assert.doesNotMatch(body.messages[0].content, /不得臆造.*可见文字/u);
  assert.match(body.messages[1].content, /商品名称：汽车脚垫/u);
  assert.match(
    body.messages[1].content,
    /位置 3；用途=材质细节特写；规则=放大纤维纹理；画面文字：使用自然俄语短标题/u,
  );
  assert.match(body.messages[1].content, /严格按 汽车脚垫 的位置规则执行/u);
  assert.match(body.messages[1].content, /只能包含位置：2/u);
  assert.equal(result.requestedReferenceImageCount, 1);
});

test("sends reference images only when the selected planner advertises vision input", async () => {
  let request = null;
  const service = createImagePromptPlanService({
    modelApiAccountRepository: createRepository("gpt-5.5-vision", {
      capabilities: ["text-generation", "multimodal"],
      modalities: ["text", "image"],
    }),
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"plans":[]}' } }],
        }),
      };
    },
  });
  const result = await service.generatePlan({
    accountId: "text-account",
    model: "gpt-5.5-vision",
    systemPrompt: "完整 Skill 规则",
    userPrompt: "商品：保温杯。",
    referenceImageUrls: ["https://img.example/cup.jpg"],
  });
  const content = JSON.parse(request.options.body).messages[1].content;
  assert.equal(content[0].text, "商品：保温杯。");
  assert.equal(content[1].text, "下面这张图片对应商品图片位置 1。");
  assert.equal(content[2].image_url.url, "https://img.example/cup.jpg");
  assert.equal(result.referenceImageCount, 1);
  assert.equal(result.referenceImagePolicy, "vision-planner");
});

test("resolves a local product image asset for a vision planner with its position", async () => {
  let request = null;
  const service = createImagePromptPlanService({
    modelApiAccountRepository: createRepository("gpt-5.5", {
      capabilities: ["text-generation", "vision"],
    }),
    profileAssetRepository: {
      getAsset(id) {
        return id === "asset-local"
          ? {
              id,
              mimeType: "image/png",
              dataBase64: Buffer.from("local-image").toString("base64"),
            }
          : null;
      },
    },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"plans":[]}' } }],
        }),
      };
    },
  });

  const result = await service.generatePlan({
    accountId: "text-account",
    model: "gpt-5.5",
    systemPrompt: "完整 Skill 规则",
    userPrompt: "商品：保温杯。",
    referenceImages: [{ sourceIndex: 3, assetId: "asset-local" }],
  });
  const content = JSON.parse(request.options.body).messages[1].content;
  assert.equal(result.referenceImageCount, 1);
  assert.equal(content[1].text, "下面这张图片对应商品图片位置 4。");
  assert.match(content[2].image_url.url, /^data:image\/png;base64,/u);
});

test("keeps text-only analysis requests simple for relays without vision input", () => {
  assert.equal(createUserMessage("只分析文字", []), "只分析文字");
});

test("converts a model timeout into a controlled retry message", async () => {
  const timeout = Object.assign(
    new Error("The operation was aborted due to timeout"),
    { name: "TimeoutError" },
  );
  const service = createImagePromptPlanService({
    modelApiAccountRepository: createRepository(),
    fetchImpl: async () => {
      throw timeout;
    },
  });
  await assert.rejects(
    service.generatePlan({
      accountId: "text-account",
      model: "gpt-5.5",
      systemPrompt: "完整 Skill 规则",
      userPrompt: "商品：保温杯。",
    }),
    /分析模型响应超时.*原图仍然保留/u,
  );
});

test("rejects an image-only model selected as the analysis model", async () => {
  const service = createImagePromptPlanService({
    modelApiAccountRepository: {
      getAccountForInternalUse: () => ({
        id: "text-account",
        baseUrl: "https://relay.example/v1",
        apiKey: "secret-key",
        discoveryVerified: true,
        availableModels: [
          { id: "image-model", capabilities: ["image-generation"] },
        ],
      }),
    },
    fetchImpl: async () => {
      throw new Error("must not call");
    },
  });
  await assert.rejects(
    service.generatePlan({
      accountId: "text-account",
      model: "image-model",
      systemPrompt: "system",
      userPrompt: "user",
    }),
    /不是文本\/分析模型/u,
  );
});
