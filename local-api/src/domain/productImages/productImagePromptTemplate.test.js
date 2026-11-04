import assert from "node:assert/strict";
import test from "node:test";
import { renderProductImagePromptTemplate } from "./productImagePromptTemplate.js";

test("renders the server-side image instruction from structured client facts", () => {
  const prompt = renderProductImagePromptTemplate({
    promptTemplateId: "product-image-generation.v1",
    promptTemplateInput: {
      generationMode: "fast",
      product: {
        title: "黑色保温杯",
        productKey: "BX-500",
        sku: "SKU-BLACK",
        skuFacts: "黑色，500ml",
      },
      image: { group: "detail", sourceIndex: 1 },
      positionRules: {
        detail: [
          {},
          {
            purpose: "杯盖特写",
            visibleText: "Герметичная крышка",
            mustAvoid: "不要添加吸管",
          },
        ],
      },
      approvedPlan: {
        items: [{ sourceIndex: 1, prompt: "侧面近景", mustKeep: ["黑色杯盖"] }],
      },
      skillContext: {
        policyVersion: "ozon-product-image-skill.v1",
        toolId: "ozon-product-image-generation",
        safetyRules: ["禁止复制源图中文广告"],
        qaRules: ["检查俄语拼写"],
      },
    },
  });

  assert.match(prompt, /详情图 2/u);
  assert.match(prompt, /BX-500/u);
  assert.match(prompt, /SKU-BLACK/u);
  assert.match(prompt, /Герметичная крышка/u);
  assert.match(prompt, /侧面近景/u);
  assert.match(prompt, /黑色杯盖/u);
  assert.match(prompt, /极速模式/u);
  assert.match(prompt, /允许出现的文字：Герметичная крышка/u);
  assert.doesNotMatch(prompt, /没有明确给出俄语文字时，最终图片保持无文字/u);
  assert.doesNotMatch(prompt, /禁止复制源图中文广告/u);
});

test("keeps a configured real-scene position instead of silently degrading it to white", () => {
  const prompt = renderProductImagePromptTemplate({
    promptTemplateId: "product-image-generation.v1",
    promptTemplateInput: {
      product: { title: "汽车脚垫片材", targetScene: "Ozon 商品主图" },
      image: { group: "main", sourceIndex: 3 },
      positionRules: {
        main: [
          {
            sourceIndex: 3,
            purpose: "真实使用场景图",
            instructions: "放入真实汽车使用场景",
          },
        ],
      },
      approvedPlan: { items: [{ sourceIndex: 3, prompt: "汽车内真实场景" }] },
    },
  });

  assert.match(prompt, /目标场景：Ozon 商品主图/u);
  assert.match(prompt, /位置用途：真实使用场景图/u);
  assert.match(prompt, /构图和背景：放入真实汽车使用场景/u);
  assert.doesNotMatch(prompt, /标准白底图/u);
});

test("keeps legacy development requests compatible without shipping a client builder", () => {
  assert.equal(
    renderProductImagePromptTemplate({ prompt: "legacy prompt" }),
    "legacy prompt",
  );
});

test("rejects an unknown server template id", () => {
  assert.throws(
    () =>
      renderProductImagePromptTemplate({
        promptTemplateId: "unknown.v1",
        promptTemplateInput: {},
      }),
    { code: "IMAGE_PROMPT_TEMPLATE_NOT_FOUND" },
  );
});
