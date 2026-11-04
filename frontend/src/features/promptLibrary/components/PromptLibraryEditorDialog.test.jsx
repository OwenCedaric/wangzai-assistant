import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PromptLibraryEditorDialog } from './PromptLibraryEditorDialog.jsx';

const editorForm = {
  title: 'Ozon 商品卡优化与生图',
  scene: 'ozon',
  status: '部分可用',
  owner: '工具组',
  goal: '生成俄语 SEO 和完整商品图套组',
  variables: '处理模式\n店铺、市场与语言\n商品、SPU/SKC 与 SKU 信息',
  body: '原始 Skill 说明',
  defaultModelId: 'auto',
  modelPurpose: '商品卡内容准备',
  workflowSteps: '核对商品事实\n生成俄语 SEO\n检查图文一致性',
  inputs: '处理模式\n商品与 SKU 信息',
  outputs: '俄语标题\n商品图方案',
  systemPrompt: '按 Skill 规则执行',
  userPrompt: '{{input}}',
  outputFormat: '标题 / 详情 / 图片方案',
  outputRules: '缺失信息标记待确认',
  safetyRules: '不自动发布商品',
  capabilities: '商品卡内容准备',
};

describe('PromptLibraryEditorDialog installed Skill editor', () => {
  it('analyzes and shows installed-Skill modules before enabling installation', () => {
    render(
      <PromptLibraryEditorDialog
        open
        editorMode="create"
        onClose={vi.fn()}
        formError=""
        installFileInputRef={{ current: null }}
        onInstallFileChange={vi.fn()}
        installUrl=""
        onInstallUrlChange={vi.fn()}
        onInstallFromUrl={vi.fn()}
        installResolving={false}
        installSourceLabel="测试安装包"
        installPreview={{
          id: 'installed-module-analysis',
          title: '完整商品 Skill',
          sceneLabel: 'Ozon 工具',
          status: '可用',
          owner: '工具组',
          goal: '完成商品事实、SEO 和图片流程',
          variables: ['商品信息'],
          promptConfig: {
            inputs: ['商品信息'],
            workflowSteps: ['核对商品', '生成图片'],
            outputs: ['完整结果'],
            capabilities: ['商品分析'],
            safetyRules: ['不得虚构'],
          },
          skillProfile: {
            sourceName: 'complete-product-skill',
            runType: 'api-assisted-readonly',
            moduleAnalysis: {
              completed: true,
              moduleCount: 2,
              modules: [
                {
                  id: 'product-truth-ledger',
                  order: 1,
                  title: '商品事实核对',
                  description: '读取并冻结真实商品资料。',
                  requiredCapabilities: ['ozon.products.read'],
                  requiredTools: [],
                  sourceReferences: [{ sourcePath: 'SKILL.md', heading: '商品事实' }],
                },
                {
                  id: 'image-generation',
                  order: 2,
                  title: '图片模型生成',
                  description: '生成实际商品图片。',
                  requiredCapabilities: ['model.image.generate'],
                  requiredTools: ['$imagegen'],
                  sourceReferences: [{ sourcePath: 'references/images.md', heading: '生成图片' }],
                },
              ],
              referencedTools: [{ id: '$imagegen', sourcePaths: ['references/images.md'] }],
              warnings: ['发现 1 个外部 Skill/工具依赖，安装后需核对可用性。'],
            },
          },
        }}
        apiCapabilityMatch={{ totalCount: 2, bindings: [], executionPlan: { steps: [] } }}
        editorForm={editorForm}
        categories={[{ value: 'ozon', label: 'Ozon 工具' }]}
        statusOptions={['可用']}
        modelOptions={[]}
        onChangeField={vi.fn()}
        onInstallTool={vi.fn()}
        onSavePrompt={vi.fn()}
      />
    );

    expect(screen.getByText('2 分析模块')).toBeVisible();
    expect(screen.getByText('3 核对能力')).toBeVisible();
    expect(screen.getByText('模块分析结果')).toBeVisible();
    expect(screen.getByText('商品事实核对')).toBeVisible();
    expect(screen.getByText('图片模型生成')).toBeVisible();
    expect(screen.getAllByText('$imagegen').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: '确认安装并启用' })).toBeEnabled();
  });

  it('shows the complete imported configuration and a direct delete entry', () => {
    const onDeletePrompt = vi.fn();
    render(
      <PromptLibraryEditorDialog
        open
        editorMode="edit"
        onClose={vi.fn()}
        formError=""
        editorForm={editorForm}
        categories={[{ value: 'ozon', label: 'Ozon 工具' }]}
        statusOptions={['部分可用']}
        modelOptions={[{ id: 'auto', label: '自动选择', statusLabel: '可用' }]}
        onChangeField={() => vi.fn()}
        onSavePrompt={vi.fn()}
        canDelete
        onDeletePrompt={onDeletePrompt}
      />
    );

    expect(screen.getByText('基础信息')).toBeVisible();
    expect(screen.getByText('Skill 自带流程')).toBeVisible();
    expect(screen.getByText('提示词和规则')).toBeVisible();
    expect(screen.getByDisplayValue('核对商品事实')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '删除这个 Skill' }));
    expect(onDeletePrompt).toHaveBeenCalledTimes(1);
  });

  it('uses the native image-rule layout for installed image Skills without changing other installed Skills', () => {
    const emitChange = vi.fn();
    const onChangeField = vi.fn(() => emitChange);
    render(
      <PromptLibraryEditorDialog
        open
        editorMode="edit"
        onClose={vi.fn()}
        formError=""
        editorForm={{
          ...editorForm,
          imagePositionRules: { main: [], detail: [] },
          attributeRules: {},
          dependencyBindings: {
            $imagegen: {
              dependencyId: '$imagegen',
              resolution: 'builtin',
              builtinAdapter: 'builtin.protected-image-generation',
              targetSkillId: '',
            },
          },
        }}
        categories={[{ value: 'ozon', label: 'Ozon 工具' }]}
        statusOptions={['部分可用']}
        modelOptions={[{ id: 'auto', label: '自动选择', statusLabel: '可用' }]}
        isImageSkill
        skillProfile={{
          moduleAnalysis: {
            completed: true,
            sourceSectionCount: 3,
            modules: [
              {
                id: 'product-truth-ledger',
                order: 1,
                title: '商品事实核对',
                kind: 'data-analysis',
                description: '读取并冻结商品资料。',
                requiredCapabilities: ['ozon.products.read'],
                requiredTools: [],
                sourceReferences: [{ sourcePath: 'SKILL.md', heading: '商品事实' }],
              },
            ],
            referencedTools: [],
            warnings: [],
          },
          dependencyManifest: {
            version: 1,
            dependencies: [
              {
                id: '$imagegen',
                label: 'imagegen',
                purpose: '实际生成图片。',
                requirement: 'conditional',
                requirementLabel: '按场景启用',
                activationHint: '仅在实际生图时启用。',
                requiredCapabilities: ['model.image.generate', 'product-image-storage'],
                builtinAdapter: 'builtin.protected-image-generation',
                builtinLabel: '内置图片生成与安全存储',
                recommendedResolution: 'builtin',
              },
            ],
          },
        }}
        imageWorkbench={{
          imageJobs: [{ position: 0, title: '首图 / 点击图', instruction: '突出商品主体' }],
          imageExecutionContext: { detailImageSlots: [] },
        }}
        onChangeField={onChangeField}
        onSavePrompt={vi.fn()}
        canDelete
      />
    );

    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      '全局 Skill',
      '模块与接口 (1)',
      '图片位置规则',
      '属性规则',
    ]);
    expect(screen.getByText('所有规则直接显示')).toBeVisible();
    expect(screen.queryByText('Skill 自带流程')).not.toBeInTheDocument();
    expect(screen.getByText('安装信息与高级规则')).toBeVisible();

    fireEvent.click(screen.getByRole('tab', { name: '模块与接口 (1)' }));

    expect(screen.getByText('模块、接口与实际操作位置')).toBeVisible();
    expect(screen.getByText('商品事实核对')).toBeVisible();
    expect(screen.getByText(/从已绑定店铺读取商品事实/)).toBeVisible();
    expect(screen.getByText('外部依赖接入')).toBeVisible();
    expect(screen.getByText('$imagegen')).toBeVisible();
    expect(screen.getByRole('combobox', { name: '接入方式' })).toHaveTextContent('内置图片生成与安全存储');

    fireEvent.click(screen.getByRole('tab', { name: '图片位置规则' }));

    expect(screen.getByText('每张商品图片可以单独设置')).toBeVisible();
    expect(screen.getByRole('tab', { name: '主图规则 (1)' })).toBeVisible();
    expect(screen.getByRole('tab', { name: '详情图规则 (0)' })).toBeVisible();
    expect(screen.getByText('绑定商品主图第 1 张')).toBeVisible();
    expect(screen.getByDisplayValue('首图 / 点击图')).toBeVisible();
    fireEvent.change(screen.getByLabelText('这张图负责什么'), {
      target: { value: '新的首图职责' },
    });

    expect(onChangeField).toHaveBeenCalledWith('imagePositionRules');
    expect(emitChange).toHaveBeenCalledWith(
      expect.objectContaining({
        target: {
          value: expect.objectContaining({
            main: [
              expect.objectContaining({
                sourceIndex: 0,
                position: 1,
                purpose: '新的首图职责',
                instructions: '突出商品主体',
              }),
            ],
          }),
        },
      })
    );
  });
});
