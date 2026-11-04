import { describe, expect, it } from 'vitest';
import { listingSkillPackage } from '../../../test/fixtures/listingSkillPackage.js';
import { createInstallPreviewFromMarkdown, createInstallPreviewFromSource } from './promptLibraryInstall.js';
import { SMART_TOOL_SKILL_DOCUMENT_PARSER_VERSION } from './smartToolSkillDocumentParser.js';

const categories = [
  { value: 'ozon', label: 'Ozon 工具' },
  { value: 'product', label: '商品优化' },
];

describe('promptLibraryInstall', () => {
  it('parses SKILL.md frontmatter and sections into executable skill metadata', () => {
    const markdown = `---
name: public-ozon-product-search
description: Search Ozon products through a public read-only skill.
---

# Public Ozon Product Search

Use when the user needs Ozon product search.

## Inputs
- keyword
- sku

## Capabilities
- Search Ozon products
- Read product detail

## Outputs
- Product candidates
- Price and stock notes

## Workflow
- Read keyword or sku
- Query readonly source
- Return candidates with risks

## Safety
- Read only
`;

    const preview = createInstallPreviewFromMarkdown(markdown, 'SKILL.md', categories);

    expect(preview.title).toBe('public-ozon-product-search');
    expect(preview.goal).toBe('Search Ozon products through a public read-only skill.');
    expect(preview.variables).toEqual(['keyword', 'sku']);
    expect(preview.skillProfile).toMatchObject({
      sourceName: 'public-ozon-product-search',
      installType: 'skill-md',
      runType: 'local-ai-preview',
      capabilities: ['Search Ozon products', 'Read product detail'],
      inputs: ['keyword', 'sku'],
      usageInputs: ['keyword', 'sku'],
      outputs: ['Product candidates', 'Price and stock notes'],
      workflowSteps: ['Read keyword or sku', 'Query readonly source', 'Return candidates with risks'],
      safetyNotes: ['Read only'],
    });
    expect(preview.skillProfile).toMatchObject({
      adapterKey: 'builtin.generic-skill-runtime',
      adapterVersion: 3,
      runtimeStatus: 'ready',
      runtimeStatusLabel: '通用运行引擎可用',
      apiBindingVersion: 2,
    });
    expect(preview.skillProfile.apiBindings).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'ozon.products.read' })])
    );
    expect(preview.status).toBe('可用');
    expect(preview.promptConfig.workflowSteps).toEqual([
      'Read keyword or sku',
      'Query readonly source',
      'Return candidates with risks',
    ]);
  });

  it('把只读 API Skill 自动匹配到通用执行引擎', () => {
    const preview = createInstallPreviewFromMarkdown(
      `---
name: ozon-order-reader
---

# Ozon order reader

## Inputs
- order id

## Workflow
- Call Ozon order API
- Return data
`,
      'SKILL.md',
      categories
    );

    expect(preview.status).toBe('可用');
    expect(preview.skillProfile.runType).toBe('api-assisted-readonly');
    expect(preview.skillProfile.runtimeStatus).toBe('ready');
    expect(preview.skillProfile.adapterKey).toBe('builtin.generic-skill-runtime');
    expect(preview.skillProfile.apiBindings).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'ozon.salesOrders.read' })])
    );
  });

  it('按任意安装包自己的文档生成图片位置、SKU、验收和安全规则，不依赖固定 Skill 名称', () => {
    const preview = createInstallPreviewFromMarkdown(
      `---
name: generic-product-visual-flow
description: 通用商品视觉流程
---

# 通用商品视觉流程

## 输入
- 商品身份
- SKU 信息

## 执行流程
1. 锁定商品事实
2. 生成图片
`,
      'SKILL.md',
      categories,
      {
        referenceFiles: [
          {
            path: 'rules/images.md',
            content: `# 图片规则

## 图片位置
1. **主图**: 完整展示真实商品，使用一个简短俄语标题。不得出现价格或虚假参数。
2. **结构图**: 展示真实结构和连接方式。不得增加配件。

## SKU 图片
- 每个 SKU 只展示对应颜色和数量。

## 验收检查
- 商品结构不得漂移。
- 俄语文字必须准确。
`,
          },
          {
            path: 'SAFETY.md',
            content: '# 安全\n\n## 停止条件\n- 缺少商品身份资料时停止生成。',
          },
        ],
      }
    );

    expect(preview.skillProfile.imageJobs).toHaveLength(2);
    expect(preview.skillProfile.imageJobs[0]).toMatchObject({ purpose: '首图 / 点击图', sourceIndex: 0 });
    expect(preview.promptConfig.imagePositionRules.main[0]).toMatchObject({
      purpose: '首图 / 点击图',
      visibleText: expect.stringMatching(/俄语标题/u),
      mustAvoid: expect.stringMatching(/不得出现价格/u),
    });
    expect(preview.skillProfile.skuImageRules).toEqual(expect.arrayContaining([expect.stringMatching(/每个 SKU/u)]));
    expect(preview.skillProfile.qaRules).toEqual(expect.arrayContaining([expect.stringMatching(/结构不得漂移/u)]));
    expect(preview.skillProfile.stopConditions).toEqual(
      expect.arrayContaining([expect.stringMatching(/缺少商品身份资料/u)])
    );
  });

  it('keeps a GitHub Skill package together and parses workflow, inputs and outputs from referenced files', () => {
    const preview = createInstallPreviewFromMarkdown(
      `---
name: ozon-card-optimizer
description: Build a verified Ozon listing package without publishing it.
---

# Ozon Card Optimizer

## Run the gates
1. Read the evidence workflow.
2. Freeze product facts.
3. Prepare SEO and image plans.

## Stop conditions
Never publish or change a live listing without separate authorization.
`,
      'SKILL.md',
      categories,
      {
        installType: 'github-skill',
        sourceUrl: 'https://github.com/ndjefn/ozon-listing-flow-skill',
        repository: 'ndjefn/ozon-listing-flow-skill',
        ref: 'main',
        sourceHash: 'hash-1',
        executableFiles: [],
        referenceFiles: [
          {
            path: 'agents/openai.yaml',
            content:
              'interface:\n  display_name: "Ozon 商品卡优化与生图"\n  short_description: "生成俄语 SEO 和完整商品图套组"',
          },
          {
            path: 'references/workflow-and-evidence.md',
            content: '# Workflow and evidence\n\n## Intake record\n\n- product identity\n- SKU matrix',
          },
          {
            path: 'references/output-contract.md',
            content:
              '# Output and acceptance contract\n\n## Complete operator bundle\n\n1. Russian title\n2. Image generation and final assets',
          },
          {
            path: 'SECURITY.md',
            content: '# Security notes\n\nThis package does not include executable scripts.',
          },
        ],
      }
    );

    expect(preview).toMatchObject({
      title: 'Ozon 商品卡优化与生图',
      goal: '生成俄语 SEO 和完整商品图套组',
      status: '可用',
      skillProfile: {
        installType: 'github-skill',
        repository: 'ndjefn/ozon-listing-flow-skill',
        ref: 'main',
        sourceHash: 'hash-1',
        runType: 'local-ai-preview',
        runtimeStatus: 'ready',
        usageInputs: ['商品信息', 'SKU 规格信息'],
      },
    });
    expect(preview.variables).toEqual(['商品信息', 'SKU 规格信息']);
    expect(preview.skillProfile.inputs).toEqual(['商品信息', 'SKU 规格信息']);
    expect(preview.skillProfile.workflowSteps).toEqual(
      expect.arrayContaining(['Read the evidence workflow.', 'Freeze product facts.', 'Prepare SEO and image plans.'])
    );
    expect(preview.skillProfile.outputs).toEqual(
      expect.arrayContaining(['Russian title', 'Image generation and final assets'])
    );
    expect(preview.skillProfile.referenceFiles).toHaveLength(4);
    expect(preview.skillProfile.executionPlan).toMatchObject({
      canStart: true,
      requiresImageExecution: true,
      unsupportedCount: 0,
    });
    expect(preview.skillProfile.executionPlan.steps.every((step) => step.executor)).toBe(true);
    expect(preview.promptConfig.systemPrompt).toContain('# Ozon Card Optimizer');
  });

  it('compiles a complete synthetic Ozon listing package into an executable text and image workflow', () => {
    const packageSource = listingSkillPackage;
    const preview = createInstallPreviewFromSource(packageSource, categories, {
      installType: packageSource.installType,
      sourceUrl: packageSource.sourceUrl,
      repository: packageSource.repository,
      referenceFiles: packageSource.referenceFiles,
      executableFiles: packageSource.executableFiles,
    });

    expect(preview.title).toBe('Ozon 商品卡优化与生图');
    expect(preview.status).toBe('可用');
    expect(preview.skillProfile.parserVersion).toBe(SMART_TOOL_SKILL_DOCUMENT_PARSER_VERSION);
    expect(preview.skillProfile.parseSummary).toMatchObject({
      documentCount: 8,
      imageJobCount: 6,
      unclassifiedSectionCount: 4,
      moduleCount: 17,
    });
    expect(preview.skillProfile.moduleAnalysis).toMatchObject({
      completed: true,
      moduleCount: 17,
    });
    expect(preview.skillProfile.modules.map((item) => item.id)).toEqual([
      'execution-mode-router',
      'intake-and-context',
      'declared-capability-contract',
      'workflow-orchestration',
      'product-truth-ledger',
      'sku-matrix',
      'evidence-review',
      'search-evidence',
      'seo-and-russian-copy',
      'attribute-consistency',
      'listing-image-plan',
      'sku-image-map',
      'image-generation',
      'content-and-image-qa',
      'operator-output-bundle',
      'post-launch-analysis',
      'safety-and-authorization-gate',
    ]);
    expect(preview.skillProfile.referencedTools.map((item) => item.id).sort()).toEqual(
      ['$drive-cross-border-ecommerce', '$grill-me', '$imagegen', '$ozon-step4-prompt-library'].sort()
    );
    expect(preview.skillProfile.dependencyManifest).toMatchObject({
      version: 1,
      requiredCount: 0,
      conditionalCount: 3,
      embeddedCount: 1,
    });
    expect(preview.skillProfile.dependencyBindings).toMatchObject({
      $imagegen: {
        resolution: 'builtin',
        builtinAdapter: 'builtin.protected-image-generation',
      },
      '$grill-me': {
        resolution: 'builtin',
        builtinAdapter: 'builtin.evidence-gap-interview',
      },
      '$drive-cross-border-ecommerce': { resolution: 'disabled' },
      '$ozon-step4-prompt-library': { resolution: 'disabled' },
    });
    expect(preview.skillProfile.modules.find((item) => item.id === 'image-generation')).toMatchObject({
      requiredCapabilities: ['model.image.generate', 'product-image-storage'],
      requiredTools: expect.arrayContaining(['$imagegen']),
    });
    expect(preview.skillProfile.inputs).toEqual(
      expect.arrayContaining(['处理模式', '店铺、市场与语言', '商品、SPU/SKC 与 SKU 信息', '参考图授权与生图范围'])
    );
    expect(preview.skillProfile.operatingModes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: 'full-card', label: '完整商品卡' }),
        expect.objectContaining({ value: 'step4-images', label: '只做商品图' }),
      ])
    );
    expect(preview.skillProfile.imageJobs).toHaveLength(6);
    expect(preview.skillProfile.imageJobs[0]).toMatchObject({
      sourceIndex: 0,
      purpose: '首图 / 点击图',
      sourcePath: 'references/image-set.md',
    });
    expect(preview.skillProfile.imageJobs[0].visibleText).toMatch(/Russian headline/iu);
    expect(preview.skillProfile.imageJobs[0].mustAvoid).toMatch(/price.*discount/iu);
    expect(preview.skillProfile.imageJobs[2].mustAvoid).toMatch(/never guess/iu);
    expect(preview.skillProfile.imageJobs[4].mustAvoid).toMatch(/without exaggeration/iu);
    expect(preview.skillProfile.imageJobs[5].mustAvoid).toMatch(/differ from slots 1-5/iu);
    expect(preview.promptConfig.imagePositionRules.main).toHaveLength(6);
    expect(preview.promptConfig.imagePositionRules.main[0].visibleText).toMatch(/Russian headline/iu);
    expect(preview.skillProfile.skuImageRules).toEqual(
      expect.arrayContaining([expect.stringMatching(/one image for every real SKU/iu)])
    );
    expect(preview.skillProfile.qaRules).toEqual(
      expect.arrayContaining([expect.stringMatching(/structural drift/iu), expect.stringMatching(/Russian spelling/iu)])
    );
    expect(preview.skillProfile.stopConditions).toEqual(
      expect.arrayContaining([expect.stringMatching(/Stop before generation/iu)])
    );
    expect(preview.skillProfile.evidenceRules.length).toBeGreaterThan(0);
    expect(preview.skillProfile.ruleCatalog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourcePath: 'references/image-set.md',
          heading: 'Six differentiated jobs',
          category: 'image',
        }),
      ])
    );
    expect(preview.skillProfile.unclassifiedSections).toEqual(
      expect.arrayContaining([expect.objectContaining({ sourcePath: 'README.md', heading: '安装' })])
    );
    expect(preview.skillProfile.executionPlan).toMatchObject({
      canStart: true,
      requiresImageExecution: true,
      unsupportedCount: 0,
    });
    expect(preview.skillProfile.executionPlan.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'ozon.products.read', compileStatus: 'executable' }),
        expect.objectContaining({ id: 'model.text.generate', compileStatus: 'executable' }),
        expect.objectContaining({ id: 'model.image.generate', compileStatus: 'executable' }),
      ])
    );
  });
});
