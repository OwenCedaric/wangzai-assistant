import AddRounded from '@mui/icons-material/AddRounded';
import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded';
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded';
import LinkRounded from '@mui/icons-material/LinkRounded';
import SaveRounded from '@mui/icons-material/SaveRounded';
import StorefrontRounded from '@mui/icons-material/StorefrontRounded';
import UploadFileRounded from '@mui/icons-material/UploadFileRounded';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '../../../shared/ui/minimizedTasks/GlobalMinimizableDialog.jsx';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import { PromptLibraryApiCapabilityStatus } from './PromptLibraryApiCapabilityStatus.jsx';
import {
  joinSkillSystemPromptSections,
  normalizeAttributeRules,
  normalizeImagePositionRules,
  SMART_TOOL_ATTRIBUTE_RULE_FIELDS,
  splitSkillSystemPromptSections,
} from '../lib/smartToolSkillConfiguration.js';
import {
  normalizeSmartToolDependencyBindings,
  SMART_TOOL_DEPENDENCY_REQUIREMENT,
  SMART_TOOL_DEPENDENCY_RESOLUTION,
} from '../lib/smartToolDependencyRegistry.js';

const INSTALLED_SKILL_MODULE_KIND_LABELS = Object.freeze({
  routing: '任务范围',
  contract: '能力边界',
  orchestration: '流程编排',
  'data-analysis': '真实数据核对',
  'data-read': '数据读取',
  generation: '生成处理',
  'generation-plan': '生成规划',
  validation: '一致性校验',
  delivery: '结果交付',
  analysis: '复盘分析',
  governance: '安全控制',
});

const INSTALLED_SKILL_MODULE_BOUNDARIES = Object.freeze({
  'execution-mode-router': '在运行页选择本次范围；不会替用户扩大执行范围。',
  'intake-and-context': '运行页只读取已绑定店铺和已选商品，不要求重复填写已有资料。',
  'declared-capability-contract': '只作为能力声明核对；未接入的能力不会伪装成可用。',
  'workflow-orchestration': '按安装包原始步骤排列；每个实际动作仍需进入对应工作台。',
  'product-truth-ledger': '从已绑定店铺读取商品事实，只读，不修改商品。',
  'sku-matrix': '从当前商品读取 SKU 与变体资料，只读，不自动改 SKU。',
  'evidence-review': '只检查资料是否足够；缺失内容明确标记待确认。',
  'search-evidence': '仅在接口已配置时读取带时间范围的数据，不能用猜测替代。',
  'seo-and-russian-copy': '在文案与属性编辑区生成草稿，保存前由用户核对。',
  'attribute-consistency': '只做图文与属性一致性检查，不直接写回 Ozon。',
  'listing-image-plan': '在商品图片工作台选择每个图片位置和原图后执行。',
  'sku-image-map': '在商品图片工作台按真实 SKU 绑定图片位置，不自动错配。',
  'image-generation': '只对用户选定的槽位生成图片；替换商品图仍需用户确认。',
  'content-and-image-qa': '输出质检结果和待确认项，不把未完成项标记为成功。',
  'operator-output-bundle': '整理为可继续操作的草稿和结果，不会自动发布。',
  'post-launch-analysis': '仅在分析数据接口可用时生成复盘建议，不修改推广设置。',
  'safety-and-authorization-gate': '涉及外部费用、写入或授权时停止自动执行，交由用户确认。',
});

function installedSkillText(value) {
  return String(value ?? '').trim();
}

function installedSkillModuleBindings(module = {}, apiCapabilityMatch = null) {
  const bindingById = new Map(
    (Array.isArray(apiCapabilityMatch?.bindings) ? apiCapabilityMatch.bindings : []).map((binding) => [
      binding.id,
      binding,
    ])
  );
  const planById = new Map(
    (Array.isArray(apiCapabilityMatch?.executionPlan?.steps) ? apiCapabilityMatch.executionPlan.steps : []).map(
      (step) => [step.id, step]
    )
  );
  return (Array.isArray(module.requiredCapabilities) ? module.requiredCapabilities : []).map((id) => {
    const binding = bindingById.get(id);
    const plan = planById.get(id);
    return {
      id,
      label: binding?.label || id,
      statusLabel: plan?.compileStatusLabel || binding?.statusLabel || '待匹配',
      status: plan?.compileStatus || binding?.status || 'unmatched',
    };
  });
}

function installedSkillModuleStatusColor(status) {
  if (status === 'executable' || status === 'ready') return 'success';
  if (status === 'guarded' || status === 'business_guard' || status === 'missing_configuration') return 'warning';
  if (status === 'unsupported') return 'error';
  return 'default';
}

function InstalledSkillModuleConfiguration({
  skillProfile = {},
  apiCapabilityMatch = null,
  dependencyBindings = {},
  installedSkillOptions = [],
  onDependencyBindingsChange = null,
}) {
  const analysis = skillProfile?.moduleAnalysis || {};
  const modules = Array.isArray(analysis.modules) ? analysis.modules : [];
  const referencedTools = Array.isArray(analysis.referencedTools) ? analysis.referencedTools : [];
  const dependencyManifest = skillProfile?.dependencyManifest || { dependencies: [] };
  const dependencies = Array.isArray(dependencyManifest.dependencies) ? dependencyManifest.dependencies : [];
  const normalizedDependencyBindings = normalizeSmartToolDependencyBindings(dependencyManifest, dependencyBindings);
  const updateDependencyBinding = (dependency, patch) => {
    if (!onDependencyBindingsChange) return;
    const current = normalizedDependencyBindings[dependency.id] || {};
    const nextBinding = { ...current, ...patch, dependencyId: dependency.id };
    if (nextBinding.resolution !== SMART_TOOL_DEPENDENCY_RESOLUTION.INSTALLED_SKILL) {
      nextBinding.targetSkillId = '';
    }
    if (nextBinding.resolution === SMART_TOOL_DEPENDENCY_RESOLUTION.BUILTIN) {
      nextBinding.builtinAdapter = dependency.builtinAdapter;
    } else {
      nextBinding.builtinAdapter = '';
    }
    onDependencyBindingsChange({
      ...normalizedDependencyBindings,
      [dependency.id]: nextBinding,
    });
  };

  if (!analysis.completed || !modules.length) {
    return (
      <Alert severity="warning" className="prompt-library-local-alert">
        当前安装包没有完整模块解析结果。请重新选择包含 SKILL.md 和关联说明的安装包后再安装。
      </Alert>
    );
  }

  return (
    <Box component="section" className="prompt-library-skill-settings-section">
      <Box className="prompt-library-skill-settings-section-head">
        <Typography component="span" variant="overline">
          安装包解析结果
        </Typography>
        <Typography variant="h6">模块、接口与实际操作位置</Typography>
        <Typography variant="body2" color="text.secondary">
          这份清单来自安装包原始规则，按原顺序展示。它只说明每一步如何接入，不会挤进商品图片运行页，也不会把未接入能力显示成可执行。
        </Typography>
      </Box>

      <Box className="prompt-library-installed-module-overview">
        <Box>
          <span>解析模块</span>
          <strong>{modules.length}</strong>
        </Box>
        <Box>
          <span>已匹配接口</span>
          <strong>{apiCapabilityMatch?.totalCount || 0}</strong>
        </Box>
        <Box>
          <span>外部依赖</span>
          <strong>{referencedTools.length}</strong>
        </Box>
        <Box>
          <span>源章节</span>
          <strong>{analysis.sourceSectionCount || 0}</strong>
        </Box>
      </Box>

      {dependencies.length ? (
        <Box className="prompt-library-installed-dependency-section">
          <Box className="prompt-library-installed-dependency-head">
            <Box>
              <Typography variant="subtitle1">外部依赖接入</Typography>
              <Typography variant="body2" color="text.secondary">
                系统先判断依赖是始终需要、按场景启用还是逻辑已内置，再决定运行前是否阻断。
              </Typography>
            </Box>
            <Chip size="small" variant="outlined" label={`${dependencies.length} 项`} />
          </Box>
          <Box className="prompt-library-installed-dependency-list">
            {dependencies.map((dependency) => {
              const binding = normalizedDependencyBindings[dependency.id] || {};
              const isRequired = dependency.requirement === SMART_TOOL_DEPENDENCY_REQUIREMENT.REQUIRED;
              return (
                <Box component="article" key={dependency.id} className="prompt-library-installed-dependency-card">
                  <Box className="prompt-library-installed-dependency-copy">
                    <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap" alignItems="center">
                      <Typography variant="subtitle2">{dependency.id}</Typography>
                      <Chip
                        size="small"
                        color={isRequired ? 'error' : dependency.requirement === 'embedded' ? 'success' : 'primary'}
                        variant="outlined"
                        label={dependency.requirementLabel}
                      />
                    </Stack>
                    <Typography variant="body2" color="text.secondary">
                      {dependency.purpose}
                    </Typography>
                    <Typography variant="caption">启用条件：{dependency.activationHint}</Typography>
                    {dependency.requiredCapabilities?.length ? (
                      <Typography variant="caption" color="text.secondary">
                        需要能力：{dependency.requiredCapabilities.join('、')}
                      </Typography>
                    ) : null}
                  </Box>
                  <Box className="prompt-library-installed-dependency-controls">
                    <TextField
                      size="small"
                      select
                      label="接入方式"
                      value={binding.resolution || dependency.recommendedResolution}
                      onChange={(event) => updateDependencyBinding(dependency, { resolution: event.target.value })}
                      fullWidth
                    >
                      {dependency.builtinAdapter ? (
                        <MenuItem value={SMART_TOOL_DEPENDENCY_RESOLUTION.BUILTIN}>
                          {dependency.builtinLabel || '使用软件内置能力'}
                        </MenuItem>
                      ) : null}
                      <MenuItem value={SMART_TOOL_DEPENDENCY_RESOLUTION.INSTALLED_SKILL}>绑定已安装 Skill</MenuItem>
                      {!isRequired ? (
                        <MenuItem value={SMART_TOOL_DEPENDENCY_RESOLUTION.DISABLED}>按场景暂不启用</MenuItem>
                      ) : null}
                    </TextField>
                    {binding.resolution === SMART_TOOL_DEPENDENCY_RESOLUTION.INSTALLED_SKILL ? (
                      <TextField
                        size="small"
                        select
                        label="绑定 Skill"
                        value={binding.targetSkillId || ''}
                        onChange={(event) => updateDependencyBinding(dependency, { targetSkillId: event.target.value })}
                        fullWidth
                      >
                        <MenuItem value="">尚未选择</MenuItem>
                        {installedSkillOptions.map((item) => (
                          <MenuItem key={`${dependency.id}-${item.id}`} value={item.id}>
                            {item.title}
                          </MenuItem>
                        ))}
                      </TextField>
                    ) : (
                      <Typography variant="caption" color="text.secondary">
                        {binding.resolution === SMART_TOOL_DEPENDENCY_RESOLUTION.BUILTIN
                          ? `内置适配器：${dependency.builtinAdapter}`
                          : '本次范围触发该依赖时，系统会在运行前提示配置。'}
                      </Typography>
                    )}
                  </Box>
                </Box>
              );
            })}
          </Box>
        </Box>
      ) : null}

      <Box className="prompt-library-installed-module-config-list">
        {modules.map((module) => {
          const bindings = installedSkillModuleBindings(module, apiCapabilityMatch);
          const sources = (Array.isArray(module.sourceReferences) ? module.sourceReferences : [])
            .map(
              (reference) => `${installedSkillText(reference.sourcePath)} · ${installedSkillText(reference.heading)}`
            )
            .filter(Boolean);
          return (
            <Box component="article" key={module.id} className="prompt-library-installed-module-config-card">
              <Box className="prompt-library-installed-module-config-order">{module.order}</Box>
              <Box className="prompt-library-installed-module-config-main">
                <Stack direction="row" spacing={0.75} alignItems="center" useFlexGap flexWrap="wrap">
                  <Typography variant="subtitle1">{module.title}</Typography>
                  <Chip
                    size="small"
                    variant="outlined"
                    label={INSTALLED_SKILL_MODULE_KIND_LABELS[module.kind] || module.kind || '通用模块'}
                  />
                </Stack>
                <Typography variant="body2" color="text.secondary">
                  {module.description}
                </Typography>
                <Typography variant="caption" className="prompt-library-installed-module-boundary">
                  实际操作：
                  {INSTALLED_SKILL_MODULE_BOUNDARIES[module.id] || '按 Skill 规则生成草稿；需要写入时必须由用户确认。'}
                </Typography>

                {bindings.length ? (
                  <Box className="prompt-library-installed-module-binding-list">
                    <Typography variant="caption">接口/模型匹配</Typography>
                    <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap">
                      {bindings.map((binding) => (
                        <Chip
                          key={`${module.id}-${binding.id}`}
                          size="small"
                          color={installedSkillModuleStatusColor(binding.status)}
                          variant="outlined"
                          label={`${binding.label} · ${binding.statusLabel}`}
                        />
                      ))}
                    </Stack>
                  </Box>
                ) : null}

                {module.requiredTools?.length ? (
                  <Box className="prompt-library-installed-module-binding-list">
                    <Typography variant="caption">外部 Skill / 工具依赖（不自动执行）</Typography>
                    <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap">
                      {module.requiredTools.map((tool) => (
                        <Chip
                          key={`${module.id}-${tool}`}
                          size="small"
                          color="warning"
                          variant="outlined"
                          label={tool}
                        />
                      ))}
                    </Stack>
                  </Box>
                ) : null}

                {sources.length ? (
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    className="prompt-library-installed-module-sources"
                  >
                    解析来源：{sources.join('；')}
                  </Typography>
                ) : null}
              </Box>
            </Box>
          );
        })}
      </Box>

      <PromptLibraryApiCapabilityStatus match={apiCapabilityMatch} showRegistryTotal />

      {analysis.warnings?.length ? (
        <Alert severity="info" className="prompt-library-local-alert">
          {analysis.warnings.join('；')}
        </Alert>
      ) : null}
    </Box>
  );
}

function splitEditorListText(value) {
  const text = String(value ?? '');
  const rows = text.split(/\r?\n/).map((item) => item.trim());
  return rows.some(Boolean) || text.includes('\n') ? rows : [''];
}

function joinEditorListRows(rows = []) {
  return rows
    .map((item) => String(item ?? '').trim())
    .filter(Boolean)
    .join('\n');
}

function getFirstInstallList(...groups) {
  return groups.find((items) => Array.isArray(items) && items.length) || [];
}

function PromptInstallMiniList({ title, rows, emptyText }) {
  return (
    <Box className="prompt-library-install-mini-list">
      <Typography variant="caption" color="text.secondary">
        {title}
      </Typography>
      {rows.length ? (
        <Box component="ul">
          {rows.slice(0, 4).map((item, index) => (
            <li key={`${title}-${item}-${index}`}>{item}</li>
          ))}
        </Box>
      ) : (
        <Typography variant="body2" color="text.secondary">
          {emptyText}
        </Typography>
      )}
    </Box>
  );
}

function PromptInstallModuleList({ analysis = {} }) {
  const modules = Array.isArray(analysis.modules) ? analysis.modules : [];
  if (!modules.length) {
    return (
      <Alert severity="warning" className="prompt-library-local-alert">
        没有识别出明确功能模块，请检查安装包是否包含完整的 SKILL.md 和关联说明文件。
      </Alert>
    );
  }
  return (
    <Box className="prompt-library-install-module-section">
      <Box className="prompt-library-install-module-head">
        <Box>
          <Typography variant="subtitle1">模块分析结果</Typography>
          <Typography variant="body2" color="text.secondary">
            已按 Skill 原始顺序拆分功能，并标出每个模块需要的接口、模型和其他 Skill。
          </Typography>
        </Box>
        <Chip size="small" color="primary" label={`${modules.length} 个模块`} />
      </Box>
      <Box className="prompt-library-install-module-list">
        {modules.map((module) => (
          <Box key={module.id} className="prompt-library-install-module-row">
            <strong>{module.order}</strong>
            <Box>
              <Typography variant="subtitle2">{module.title}</Typography>
              <Typography variant="body2" color="text.secondary">
                {module.description}
              </Typography>
              <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap">
                {module.requiredCapabilities?.length ? (
                  <Chip size="small" variant="outlined" label={`接口/模型 ${module.requiredCapabilities.length}`} />
                ) : null}
                {module.requiredTools?.map((tool) => (
                  <Chip key={`${module.id}-${tool}`} size="small" variant="outlined" label={tool} />
                ))}
                <Chip size="small" variant="outlined" label={`来源 ${module.sourceReferences?.length || 0} 处`} />
              </Stack>
            </Box>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

function PromptInstallPreview({ installPreview, installSourceLabel, apiCapabilityMatch }) {
  if (!installPreview) {
    return (
      <Box className="prompt-library-install-empty">
        <CheckCircleRounded />
        <Typography variant="subtitle1">等待选择 Skill 安装包</Typography>
        <Typography variant="body2" color="text.secondary">
          上传 SKILL.md / json / zip，或粘贴链接后，会先解析出名称、固定输入、流程、输出和安全规则。
        </Typography>
      </Box>
    );
  }

  const skillProfile = installPreview.skillProfile || {};
  const promptConfig = installPreview.promptConfig || {};
  const fixedInputs = getFirstInstallList(promptConfig.inputs, skillProfile.inputs, installPreview.variables);
  const workflowSteps = getFirstInstallList(promptConfig.workflowSteps, skillProfile.workflowSteps);
  const outputs = getFirstInstallList(promptConfig.outputs, skillProfile.outputs);
  const capabilities = getFirstInstallList(promptConfig.capabilities, skillProfile.capabilities);
  const safetyRules = getFirstInstallList(promptConfig.safetyRules, skillProfile.safetyNotes);
  const moduleAnalysis = skillProfile.moduleAnalysis || {};
  const referencedTools = (Array.isArray(moduleAnalysis.referencedTools) ? moduleAnalysis.referencedTools : []).map(
    (item) => `${item.id} · ${item.sourcePaths?.join('、') || 'Skill 文档'}`
  );
  const installReady = moduleAnalysis.completed === true && fixedInputs.length && workflowSteps.length;
  const hideSkillSource =
    installPreview.id === 'ozon-product-search' || skillProfile.runType === 'browser-capture-readonly';

  return (
    <Box className="prompt-library-install-summary">
      <Box className="prompt-library-install-hero">
        <Box>
          <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap>
            <Chip size="small" color="success" label="已解析" />
            <Chip
              size="small"
              color={installReady ? 'primary' : 'warning'}
              label={installReady ? '安装后可打开' : '安装后可补全'}
            />
            <Chip size="small" variant="outlined" label={`已分析 ${moduleAnalysis.moduleCount || 0} 个模块`} />
          </Stack>
          <Typography variant="h6">{installPreview.title}</Typography>
          {!hideSkillSource ? (
            <Typography variant="body2" color="text.secondary">
              来源：{installSourceLabel || skillProfile.sourceName || '手动选择'}
            </Typography>
          ) : null}
        </Box>
        <Box className="prompt-library-install-hero-status">
          <CheckCircleRounded />
          <span>确认安装后进入工具库</span>
        </Box>
      </Box>

      <Box className="prompt-library-install-metric-grid">
        <Box>
          <span>功能模块</span>
          <strong>{moduleAnalysis.moduleCount || 0}</strong>
        </Box>
        <Box>
          <span>固定输入</span>
          <strong>{fixedInputs.length}</strong>
        </Box>
        <Box>
          <span>内置流程</span>
          <strong>{workflowSteps.length}</strong>
        </Box>
        <Box>
          <span>输出内容</span>
          <strong>{outputs.length}</strong>
        </Box>
        <Box>
          <span>安全规则</span>
          <strong>{safetyRules.length}</strong>
        </Box>
        <Box>
          <span>匹配接口</span>
          <strong>{apiCapabilityMatch?.totalCount || 0}</strong>
        </Box>
      </Box>

      <Box className="prompt-library-install-summary-grid">
        <span>安装位置</span>
        <strong>{installPreview.sceneLabel}</strong>
        <span>当前状态</span>
        <strong>{installPreview.status}</strong>
        <span>负责人</span>
        <strong>{installPreview.owner}</strong>
        <span>运行方式</span>
        <strong>{skillProfile.runType || 'local-ai-preview'}</strong>
      </Box>

      <Typography variant="body2" className="prompt-library-install-summary-body">
        {installPreview.goal}
      </Typography>

      <PromptLibraryApiCapabilityStatus match={apiCapabilityMatch} showRegistryTotal />

      <PromptInstallModuleList analysis={moduleAnalysis} />

      <Box className="prompt-library-install-package-grid">
        <PromptInstallMiniList title="安装后固定输入" rows={fixedInputs} emptyText="安装后可在编辑工具里补固定输入。" />
        <PromptInstallMiniList title="内置流程" rows={workflowSteps} emptyText="未解析到流程，安装后可补流程。" />
        <PromptInstallMiniList title="公开能力" rows={capabilities} emptyText="未解析到公开能力，安装后可补充。" />
        <PromptInstallMiniList title="输出内容" rows={outputs} emptyText="未解析到输出内容，安装后可补充。" />
        <PromptInstallMiniList
          title="外部 Skill / 工具依赖"
          rows={referencedTools}
          emptyText="没有发现外部 Skill 或工具依赖。"
        />
        <PromptInstallMiniList
          title="分析提示"
          rows={moduleAnalysis.warnings || []}
          emptyText="模块分析没有发现额外风险。"
        />
      </Box>
    </Box>
  );
}

function PromptInstallPanel({
  installFileInputRef,
  onInstallFileChange,
  installUrl,
  onInstallUrlChange,
  onInstallFromUrl,
  installResolving,
  installPreview,
  installSourceLabel,
  apiCapabilityMatch,
}) {
  return (
    <Box className="prompt-library-install-panel">
      <Box className="prompt-library-install-steps">
        <span>1 选择来源</span>
        <span>2 分析模块</span>
        <span>3 核对能力</span>
        <span>4 确认安装</span>
      </Box>
      <Box className="prompt-library-install-options">
        <Box className="prompt-library-install-card">
          <UploadFileRounded color="primary" />
          <Box>
            <Typography variant="subtitle1">从文件上传</Typography>
            <Typography variant="body2" color="text.secondary">
              支持 .json / .md / .txt / .zip，先预览再安装。
            </Typography>
          </Box>
          <Button variant="contained" onClick={() => installFileInputRef.current?.click()}>
            选择文件
          </Button>
          <input
            ref={installFileInputRef}
            type="file"
            hidden
            accept=".json,.md,.txt,.zip"
            onChange={onInstallFileChange}
          />
        </Box>

        <Box className="prompt-library-install-card">
          <LinkRounded color="primary" />
          <Box>
            <Typography variant="subtitle1">从链接安装</Typography>
            <Typography variant="body2" color="text.secondary">
              粘贴 Skill 链接，先生成预览。
            </Typography>
          </Box>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
            <TextField
              size="small"
              placeholder="粘贴 Skill 链接或工具地址"
              value={installUrl}
              onChange={(event) => onInstallUrlChange(event.target.value)}
              fullWidth
            />
            <Button variant="outlined" onClick={onInstallFromUrl} disabled={installResolving}>
              {installResolving ? '正在读取' : '生成预览'}
            </Button>
          </Stack>
        </Box>

        <Box className="prompt-library-install-card is-disabled">
          <StorefrontRounded color="disabled" />
          <Box>
            <Typography variant="subtitle1">从工具市场安装</Typography>
            <Typography variant="body2" color="text.secondary">
              后续接好后，直接选择安装。
            </Typography>
          </Box>
          <Button variant="outlined" disabled>
            后续开放
          </Button>
        </Box>
      </Box>

      <Box className="prompt-library-install-preview">
        <Typography variant="subtitle1">安装前先看一眼</Typography>
        <PromptInstallPreview
          installPreview={installPreview}
          installSourceLabel={installSourceLabel}
          apiCapabilityMatch={apiCapabilityMatch}
        />
      </Box>
    </Box>
  );
}

function PromptEditorSection({ title, description, children, className = '' }) {
  return (
    <Box className={`prompt-library-editor-card${className ? ` ${className}` : ''}`}>
      <Box className="prompt-library-editor-card-head">
        <Typography variant="subtitle1">{title}</Typography>
        {description ? (
          <Typography variant="body2" color="text.secondary">
            {description}
          </Typography>
        ) : null}
      </Box>
      {children}
    </Box>
  );
}

function PromptEditorListField({ title, description = '', value, onChange, addLabel = '新增一项', className = '' }) {
  const rows = splitEditorListText(value);
  const emitRows = (nextRows) => onChange({ target: { value: joinEditorListRows(nextRows) } });
  const updateRow = (rowIndex, nextValue) => {
    const nextRows = rows.map((item, index) => (index === rowIndex ? nextValue : item));
    onChange({ target: { value: nextRows.join('\n') } });
  };
  const removeRow = (rowIndex) => {
    const nextRows = rows.filter((_, index) => index !== rowIndex);
    emitRows(nextRows.length ? nextRows : ['']);
  };
  const addRow = () => onChange({ target: { value: [...rows, ''].join('\n') } });

  return (
    <Box className={`prompt-library-fixed-list-field${className ? ` ${className}` : ''}`}>
      <Box className="prompt-library-fixed-list-head">
        <Box>
          <Typography variant="subtitle2">{title}</Typography>
          {description ? (
            <Typography variant="caption" color="text.secondary">
              {description}
            </Typography>
          ) : null}
        </Box>
        <Button size="small" variant="outlined" startIcon={<AddRounded />} onClick={addRow}>
          {addLabel}
        </Button>
      </Box>
      <Box className="prompt-library-fixed-list-rows">
        {rows.map((item, index) => (
          <Box className="prompt-library-fixed-list-row" key={`${title}-${index}`}>
            <span>{index + 1}</span>
            <TextField
              size="small"
              value={item}
              placeholder={`填写${title}${index + 1}`}
              onChange={(event) => updateRow(index, event.target.value)}
              fullWidth
            />
            <IconButton
              size="small"
              aria-label={`删除${title}${index + 1}`}
              onClick={() => removeRow(index)}
              disabled={rows.length <= 1 && !item}
            >
              <DeleteOutlineRounded fontSize="small" />
            </IconButton>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

function PromptEditorBasicFields({ editorForm, categories, statusOptions, onChangeField }) {
  return (
    <PromptEditorSection title="基础信息" description="这里是工具名称、分类、用途和用户要提供的基础输入。">
      <Box className="prompt-library-editor-grid prompt-library-editor-grid-compact">
        <TextField size="small" label="工具名称" value={editorForm.title} onChange={onChangeField('title')} fullWidth />
        <TextField
          size="small"
          select
          label="工具放哪类"
          value={editorForm.scene}
          onChange={onChangeField('scene')}
          fullWidth
        >
          {categories.map((item) => (
            <MenuItem key={item.value} value={item.value}>
              {item.label}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          size="small"
          select
          label="现在状态"
          value={editorForm.status}
          onChange={onChangeField('status')}
          fullWidth
        >
          {statusOptions.map((item) => (
            <MenuItem key={item} value={item}>
              {item}
            </MenuItem>
          ))}
        </TextField>
        <TextField size="small" label="负责人" value={editorForm.owner} onChange={onChangeField('owner')} fullWidth />
        <TextField
          className="prompt-library-editor-full"
          size="small"
          label="工具用途"
          value={editorForm.goal}
          onChange={onChangeField('goal')}
          fullWidth
        />
        <TextField
          className="prompt-library-editor-full"
          size="small"
          label="说明内容"
          value={editorForm.body}
          onChange={onChangeField('body')}
          multiline
          minRows={2}
          maxRows={4}
          fullWidth
        />
      </Box>
    </PromptEditorSection>
  );
}

function PromptEditorWorkflowFields({ editorForm, modelOptions = [], onChangeField }) {
  return (
    <PromptEditorSection
      title="Skill 自带流程"
      description="流程会从默认 skill 或上传的 SKILL.md 自动带出，你只需要检查和微调，不需要从零手写。"
      className="prompt-library-editor-workflow-card"
    >
      <Box className="prompt-library-editor-grid prompt-library-editor-grid-compact">
        <TextField
          size="small"
          select
          label="默认模型"
          value={editorForm.defaultModelId}
          onChange={onChangeField('defaultModelId')}
          fullWidth
        >
          {modelOptions.map((item) => (
            <MenuItem key={item.id} value={item.id}>
              {item.label} · {item.statusLabel}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          size="small"
          label="模型用途"
          value={editorForm.modelPurpose}
          onChange={onChangeField('modelPurpose')}
          fullWidth
        />
        <PromptEditorListField
          className="prompt-library-editor-full"
          title="快速使用字段"
          description="普通使用窗口只显示这里的少量输入；复杂规则继续保留在下方。"
          value={editorForm.variables}
          onChange={onChangeField('variables')}
          addLabel="新增快速输入"
        />
        <PromptEditorListField
          className="prompt-library-editor-full"
          title="内置流程"
          description="一行一步；这是 skill 自带流程，后续接真实 service/task 时也按这个流程走。"
          value={editorForm.workflowSteps}
          onChange={onChangeField('workflowSteps')}
          addLabel="新增步骤"
        />
        <PromptEditorListField
          className="prompt-library-editor-full"
          title="固定输入字段"
          description="这些就是使用 skill 时要填写的固定输入框，不再把所有输入塞到一个大文本里。"
          value={editorForm.inputs}
          onChange={onChangeField('inputs')}
          addLabel="新增输入"
        />
        <PromptEditorListField
          className="prompt-library-editor-full"
          title="输出内容"
          description="skill 运行后应该返回哪些结构化内容。"
          value={editorForm.outputs}
          onChange={onChangeField('outputs')}
          addLabel="新增输出"
        />
      </Box>
    </PromptEditorSection>
  );
}

function PromptEditorPromptRulesFields({ editorForm, onChangeField }) {
  return (
    <PromptEditorSection
      title="提示词和规则"
      description="System/User 提示词、输出格式和安全规则都在这里。后续统一 API 中转站会读取这里，不从页面临时拼。"
      className="prompt-library-editor-prompt-card"
    >
      <Box className="prompt-library-editor-grid">
        <TextField
          className="prompt-library-editor-full"
          size="small"
          label="System 提示词"
          value={editorForm.systemPrompt}
          onChange={onChangeField('systemPrompt')}
          multiline
          minRows={4}
          maxRows={6}
          fullWidth
        />
        <TextField
          className="prompt-library-editor-full"
          size="small"
          label="User 提示词模板"
          helperText="保留 {{input}}，后续接页面数据或统一 API 中转站时会把真实输入填进去。"
          value={editorForm.userPrompt}
          onChange={onChangeField('userPrompt')}
          multiline
          minRows={5}
          maxRows={7}
          fullWidth
        />
        <TextField
          className="prompt-library-editor-full"
          size="small"
          label="输出格式"
          value={editorForm.outputFormat}
          onChange={onChangeField('outputFormat')}
          multiline
          minRows={2}
          maxRows={3}
          fullWidth
        />
        <PromptEditorListField
          title="输出规则"
          description="skill 输出时必须遵守的固定规则。"
          value={editorForm.outputRules}
          onChange={onChangeField('outputRules')}
          addLabel="新增规则"
        />
        <PromptEditorListField
          title="安全规则"
          description="哪些事情不能做，哪些事情必须人工确认。"
          value={editorForm.safetyRules}
          onChange={onChangeField('safetyRules')}
          addLabel="新增安全规则"
        />
        <PromptEditorListField
          className="prompt-library-editor-full"
          title="公开能力"
          description="这个 skill 已经具备或后续要接入的能力。"
          value={editorForm.capabilities}
          onChange={onChangeField('capabilities')}
          addLabel="新增能力"
        />
      </Box>
    </PromptEditorSection>
  );
}

function emitInstalledImageField(onChangeField, field, value) {
  onChangeField(field)({ target: { value } });
}

function InstalledImageRuleSections({ sections, onChangeSection }) {
  return (
    <Box className="prompt-library-skill-rule-sections">
      {sections.map((section, index) => {
        const label = section.label || section.title;
        return (
          <Box component="article" className="prompt-library-skill-rule-section" key={section.id}>
            <Box className="prompt-library-skill-rule-section-head">
              <Typography variant="subtitle2">{label}</Typography>
              <Typography variant="caption">Skill 安装时自动解析，可直接修改</Typography>
            </Box>
            <TextField
              value={section.content}
              onChange={(event) => onChangeSection(index, event.target.value)}
              placeholder="留空时不增加这一部分的自定义内容"
              inputProps={{ 'aria-label': `${label}规则内容` }}
              multiline
              minRows={4}
              maxRows={8}
              fullWidth
            />
          </Box>
        );
      })}
    </Box>
  );
}

function createInstalledImageInheritedRules(defaultSlots = {}) {
  return {
    main: (Array.isArray(defaultSlots.main) ? defaultSlots.main : []).map((item, index) => ({
      sourceIndex: Number.isInteger(item?.sourceIndex) ? item.sourceIndex : index,
      position: (Number.isInteger(item?.sourceIndex) ? item.sourceIndex : index) + 1,
      purpose: item?.title || '',
      instructions: item?.instruction || '',
      visibleText: item?.visibleText || '',
      mustAvoid: item?.mustAvoid || '',
      inherited: true,
    })),
    detail: (Array.isArray(defaultSlots.detail) ? defaultSlots.detail : []).map((item, index) => ({
      sourceIndex: Number.isInteger(item?.sourceIndex) ? item.sourceIndex : index,
      position: (Number.isInteger(item?.sourceIndex) ? item.sourceIndex : index) + 1,
      purpose: item?.title || '',
      instructions: item?.instruction || '',
      visibleText: item?.visibleText || '',
      mustAvoid: item?.mustAvoid || '',
      inherited: true,
    })),
  };
}

function InstalledImagePositionRulesEditor({ value, defaultSlots = {}, group, onChange }) {
  const rules = normalizeImagePositionRules(value);
  const inheritedRules = createInstalledImageInheritedRules(defaultSlots);
  const groupLabel = group === 'detail' ? '详情图' : '主图';
  const explicitRows = rules[group] || [];
  const inheritedRows = inheritedRules[group] || [];
  const explicitByIndex = new Map(explicitRows.map((item) => [item.sourceIndex, item]));
  const rows = [
    ...new Map(
      [...inheritedRows, ...explicitRows].map((item) => [
        item.sourceIndex,
        explicitByIndex.has(item.sourceIndex) ? explicitByIndex.get(item.sourceIndex) : item,
      ])
    ).values(),
  ].sort((left, right) => left.sourceIndex - right.sourceIndex);

  const saveRows = (nextRows) =>
    onChange({
      ...rules,
      [group]: [...nextRows].sort((left, right) => left.sourceIndex - right.sourceIndex),
    });
  const upsertRule = (row, field, nextValue) => {
    const nextRule = {
      sourceIndex: row.sourceIndex,
      position: row.sourceIndex + 1,
      purpose: row.purpose || '',
      instructions: row.instructions || '',
      visibleText: row.visibleText || '',
      mustAvoid: row.mustAvoid || '',
      [field]: nextValue,
    };
    saveRows(
      explicitByIndex.has(row.sourceIndex)
        ? explicitRows.map((item) => (item.sourceIndex === row.sourceIndex ? nextRule : item))
        : [...explicitRows, nextRule]
    );
  };
  const updateBoundPosition = (row, nextValue) => {
    const nextSourceIndex = Math.max(0, Math.floor(Number(nextValue) || 1) - 1);
    const nextRule = {
      sourceIndex: nextSourceIndex,
      position: nextSourceIndex + 1,
      purpose: row.purpose || '',
      instructions: row.instructions || '',
      visibleText: row.visibleText || '',
      mustAvoid: row.mustAvoid || '',
    };
    saveRows([
      ...explicitRows.filter((item) => item.sourceIndex !== row.sourceIndex && item.sourceIndex !== nextSourceIndex),
      nextRule,
    ]);
  };
  const addRule = () => {
    const usedPositions = new Set(rows.map((item) => item.sourceIndex));
    let sourceIndex = 0;
    while (usedPositions.has(sourceIndex)) sourceIndex += 1;
    saveRows([
      ...explicitRows,
      {
        sourceIndex,
        position: sourceIndex + 1,
        purpose: '',
        instructions: '',
        visibleText: '',
        mustAvoid: '',
      },
    ]);
  };
  const removeRule = (row) => {
    saveRows(explicitRows.filter((item) => item.sourceIndex !== row.sourceIndex));
  };

  return (
    <Box className="prompt-library-position-rule-editor">
      <Box className="prompt-library-position-rule-toolbar">
        <Box>
          <Typography variant="subtitle2">
            已设置 {rows.length} 个{groupLabel}位置
          </Typography>
          <Typography variant="caption" color="text.secondary">
            每条规则对应一张商品图片；Skill 自带规则也可以直接修改。
          </Typography>
        </Box>
        <Button size="small" variant="outlined" startIcon={<AddRounded />} onClick={addRule}>
          新增{groupLabel}规则
        </Button>
      </Box>
      {rows.length ? (
        <Box className="prompt-library-position-rule-grid">
          {rows.map((row) => {
            const isExplicit = explicitByIndex.has(row.sourceIndex);
            const hasInherited = inheritedRows.some((item) => item.sourceIndex === row.sourceIndex);
            return (
              <Box
                component="article"
                className="prompt-library-position-rule-card"
                key={`${group}-${row.sourceIndex}`}
              >
                <Box className="prompt-library-position-rule-card-head">
                  <Box>
                    <Typography variant="subtitle1">
                      绑定商品{groupLabel}第 {row.sourceIndex + 1} 张
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {isExplicit ? '当前为已保存规则。' : '当前为 Skill 安装包自带规则，修改后会保存为自定义规则。'}
                    </Typography>
                  </Box>
                  {isExplicit ? (
                    <Button
                      color="error"
                      size="small"
                      startIcon={<DeleteOutlineRounded />}
                      onClick={() => removeRule(row)}
                    >
                      {hasInherited ? '恢复自带规则' : '删除'}
                    </Button>
                  ) : (
                    <Typography component="span">Skill 自带</Typography>
                  )}
                </Box>
                <TextField
                  size="small"
                  type="number"
                  label={`绑定商品${groupLabel}位置`}
                  value={row.sourceIndex + 1}
                  onChange={(event) => updateBoundPosition(row, event.target.value)}
                  helperText="填写商品图片中的顺序，例如 1 表示第一张。"
                  inputProps={{ min: 1, step: 1 }}
                  fullWidth
                />
                <TextField
                  size="small"
                  label="这张图负责什么"
                  value={row.purpose}
                  onChange={(event) => upsertRule(row, 'purpose', event.target.value)}
                  placeholder="例如：白底主图、使用场景、材质细节"
                  fullWidth
                />
                <TextField
                  size="small"
                  label="构图、背景和重点"
                  value={row.instructions}
                  onChange={(event) => upsertRule(row, 'instructions', event.target.value)}
                  multiline
                  minRows={2}
                  maxRows={4}
                  fullWidth
                />
                <TextField
                  size="small"
                  label="画面文字"
                  value={row.visibleText}
                  onChange={(event) => upsertRule(row, 'visibleText', event.target.value)}
                  multiline
                  minRows={2}
                  maxRows={3}
                  fullWidth
                />
                <TextField
                  size="small"
                  label="这个位置不能出现什么"
                  value={row.mustAvoid}
                  onChange={(event) => upsertRule(row, 'mustAvoid', event.target.value)}
                  multiline
                  minRows={2}
                  maxRows={3}
                  fullWidth
                />
              </Box>
            );
          })}
        </Box>
      ) : (
        <Box className="prompt-library-position-rule-empty">
          <Typography variant="subtitle2">暂未设置{groupLabel}位置规则</Typography>
          <Typography variant="body2" color="text.secondary">
            需要单独控制某张图片时再新增。
          </Typography>
          <Button size="small" variant="outlined" startIcon={<AddRounded />} onClick={addRule}>
            新增第一个{groupLabel}规则
          </Button>
        </Box>
      )}
    </Box>
  );
}

function InstalledImageSkillEditor({
  editorForm,
  categories,
  statusOptions,
  modelOptions,
  apiCapabilityMatch,
  skillProfile,
  installedSkillOptions,
  imageWorkbench = {},
  onChangeField,
}) {
  const [activeArea, setActiveArea] = React.useState('global');
  const [positionGroup, setPositionGroup] = React.useState('main');
  const [promptSections, setPromptSections] = React.useState(() =>
    splitSkillSystemPromptSections(editorForm.systemPrompt)
  );
  const attributeRules = normalizeAttributeRules(editorForm.attributeRules);
  const inheritedImageSlots = React.useMemo(
    () => ({
      main: (Array.isArray(imageWorkbench?.imageJobs) ? imageWorkbench.imageJobs : []).map((item) => ({
        sourceIndex: item.position,
        title: item.title,
        instruction: item.instruction,
      })),
      detail: Array.isArray(imageWorkbench?.imageExecutionContext?.detailImageSlots)
        ? imageWorkbench.imageExecutionContext.detailImageSlots
        : [],
    }),
    [imageWorkbench]
  );
  React.useEffect(() => {
    setActiveArea('global');
    setPositionGroup('main');
  }, [editorForm.title]);

  React.useEffect(() => {
    setPromptSections(splitSkillSystemPromptSections(editorForm.systemPrompt));
  }, [editorForm.systemPrompt]);

  const updatePromptSection = (index, nextValue) => {
    const nextSections = promptSections.map((section, sectionIndex) =>
      sectionIndex === index ? { ...section, content: nextValue } : section
    );
    setPromptSections(nextSections);
    emitInstalledImageField(onChangeField, 'systemPrompt', joinSkillSystemPromptSections(nextSections));
  };

  return (
    <Box className="prompt-library-installed-image-editor">
      <Tabs
        value={activeArea}
        onChange={(_, nextArea) => setActiveArea(nextArea)}
        className="prompt-library-skill-area-tabs"
        variant="fullWidth"
      >
        <Tab value="global" label="全局 Skill" />
        <Tab
          value="modules"
          label={`模块与接口 (${Array.isArray(skillProfile?.moduleAnalysis?.modules) ? skillProfile.moduleAnalysis.modules.length : 0})`}
        />
        <Tab value="position" label="图片位置规则" />
        <Tab value="attributes" label="属性规则" />
      </Tabs>

      <Box className="prompt-library-skill-area-content">
        {activeArea === 'global' ? (
          <Box component="section" className="prompt-library-skill-settings-section">
            <Box className="prompt-library-skill-settings-section-head">
              <Typography component="span" variant="overline">
                完整 Skill
              </Typography>
              <Typography variant="h6">所有规则直接显示</Typography>
              <Typography variant="body2" color="text.secondary">
                规则名称在左、内容在右，可以直接查看和修改；不需要调整的内容保持原样即可。
              </Typography>
            </Box>
            <Box className="prompt-library-installed-image-basic-grid">
              <TextField
                size="small"
                label="工具名称"
                value={editorForm.title}
                onChange={onChangeField('title')}
                fullWidth
              />
              <TextField
                size="small"
                label="工具用途"
                value={editorForm.goal}
                onChange={onChangeField('goal')}
                fullWidth
              />
              <TextField
                size="small"
                select
                label="图片生成模型"
                value={editorForm.imageModelId || editorForm.defaultModelId}
                onChange={onChangeField('imageModelId')}
                fullWidth
              >
                {modelOptions.map((item) => (
                  <MenuItem key={item.id} value={item.id}>
                    {item.label} · {item.statusLabel}
                  </MenuItem>
                ))}
              </TextField>
            </Box>
            <InstalledImageRuleSections sections={promptSections} onChangeSection={updatePromptSection} />
            <Box component="details" className="prompt-library-installed-image-advanced">
              <Box component="summary">
                <Box>
                  <Typography variant="subtitle1">安装信息与高级规则</Typography>
                  <Typography variant="caption">流程、输入输出和安全规则；一般不需要修改。</Typography>
                </Box>
                <span>展开</span>
              </Box>
              <Box className="prompt-library-installed-image-advanced-content">
                <PromptEditorSection title="基础与运行信息">
                  <Box className="prompt-library-editor-grid prompt-library-editor-grid-compact">
                    <TextField
                      size="small"
                      select
                      label="工具分类"
                      value={editorForm.scene}
                      onChange={onChangeField('scene')}
                      fullWidth
                    >
                      {categories.map((item) => (
                        <MenuItem key={item.value} value={item.value}>
                          {item.label}
                        </MenuItem>
                      ))}
                    </TextField>
                    <TextField
                      size="small"
                      select
                      label="当前状态"
                      value={editorForm.status}
                      onChange={onChangeField('status')}
                      fullWidth
                    >
                      {statusOptions.map((item) => (
                        <MenuItem key={item} value={item}>
                          {item}
                        </MenuItem>
                      ))}
                    </TextField>
                    <TextField
                      size="small"
                      label="负责人"
                      value={editorForm.owner}
                      onChange={onChangeField('owner')}
                      fullWidth
                    />
                    <TextField
                      size="small"
                      label="模型用途"
                      value={editorForm.modelPurpose}
                      onChange={onChangeField('modelPurpose')}
                      fullWidth
                    />
                    <TextField
                      className="prompt-library-editor-full"
                      size="small"
                      label="说明内容"
                      value={editorForm.body}
                      onChange={onChangeField('body')}
                      multiline
                      minRows={3}
                      maxRows={6}
                      fullWidth
                    />
                    <TextField
                      className="prompt-library-editor-full"
                      size="small"
                      label="运行输入模板"
                      value={editorForm.userPrompt}
                      onChange={onChangeField('userPrompt')}
                      multiline
                      minRows={4}
                      maxRows={8}
                      fullWidth
                    />
                  </Box>
                  <PromptLibraryApiCapabilityStatus match={apiCapabilityMatch} showRegistryTotal />
                </PromptEditorSection>

                <PromptEditorSection title="流程、输入和输出">
                  <Box className="prompt-library-editor-grid">
                    <PromptEditorListField
                      title="内置流程"
                      value={editorForm.workflowSteps}
                      onChange={onChangeField('workflowSteps')}
                      addLabel="新增步骤"
                    />
                    <PromptEditorListField
                      title="快速使用字段"
                      value={editorForm.variables}
                      onChange={onChangeField('variables')}
                      addLabel="新增快速输入"
                    />
                    <PromptEditorListField
                      title="固定输入字段"
                      value={editorForm.inputs}
                      onChange={onChangeField('inputs')}
                      addLabel="新增输入"
                    />
                    <PromptEditorListField
                      title="输出内容"
                      value={editorForm.outputs}
                      onChange={onChangeField('outputs')}
                      addLabel="新增输出"
                    />
                    <TextField
                      className="prompt-library-editor-full"
                      size="small"
                      label="输出格式"
                      value={editorForm.outputFormat}
                      onChange={onChangeField('outputFormat')}
                      multiline
                      minRows={3}
                      maxRows={6}
                      fullWidth
                    />
                    <PromptEditorListField
                      title="输出规则"
                      value={editorForm.outputRules}
                      onChange={onChangeField('outputRules')}
                      addLabel="新增规则"
                    />
                    <PromptEditorListField
                      title="安全规则"
                      value={editorForm.safetyRules}
                      onChange={onChangeField('safetyRules')}
                      addLabel="新增安全规则"
                    />
                    <PromptEditorListField
                      title="公开能力"
                      value={editorForm.capabilities}
                      onChange={onChangeField('capabilities')}
                      addLabel="新增能力"
                    />
                  </Box>
                </PromptEditorSection>
              </Box>
            </Box>
          </Box>
        ) : null}

        {activeArea === 'modules' ? (
          <InstalledSkillModuleConfiguration
            skillProfile={skillProfile}
            apiCapabilityMatch={apiCapabilityMatch}
            dependencyBindings={editorForm.dependencyBindings}
            installedSkillOptions={installedSkillOptions}
            onDependencyBindingsChange={(nextValue) =>
              emitInstalledImageField(onChangeField, 'dependencyBindings', nextValue)
            }
          />
        ) : null}

        {activeArea === 'position' ? (
          <Box component="section" className="prompt-library-skill-settings-section">
            <Box className="prompt-library-skill-settings-section-head">
              <Typography component="span" variant="overline">
                图片位置
              </Typography>
              <Typography variant="h6">每张商品图片可以单独设置</Typography>
              <Typography variant="body2" color="text.secondary">
                主图和详情图分开管理；每张图只填写自己的用途、构图、文字和禁止内容。
              </Typography>
            </Box>
            <Tabs
              value={positionGroup}
              onChange={(_, nextGroup) => setPositionGroup(nextGroup)}
              className="prompt-library-position-group-tabs"
            >
              <Tab
                value="main"
                label={`主图规则 (${Math.max(normalizeImagePositionRules(editorForm.imagePositionRules).main.length, inheritedImageSlots.main.length)})`}
              />
              <Tab
                value="detail"
                label={`详情图规则 (${Math.max(normalizeImagePositionRules(editorForm.imagePositionRules).detail.length, inheritedImageSlots.detail.length)})`}
              />
            </Tabs>
            <InstalledImagePositionRulesEditor
              value={editorForm.imagePositionRules}
              defaultSlots={inheritedImageSlots}
              group={positionGroup}
              onChange={(nextValue) => emitInstalledImageField(onChangeField, 'imagePositionRules', nextValue)}
            />
          </Box>
        ) : null}

        {activeArea === 'attributes' ? (
          <Box component="section" className="prompt-library-skill-settings-section">
            <Box className="prompt-library-skill-settings-section-head">
              <Typography component="span" variant="overline">
                商品属性
              </Typography>
              <Typography variant="h6">设置商品属性生成规则</Typography>
              <Typography variant="body2" color="text.secondary">
                属性规则单独管理，不再与图片槽位和安装信息混在一起。
              </Typography>
            </Box>
            <Box className="prompt-library-skill-rule-sections prompt-library-attribute-rule-sections">
              {SMART_TOOL_ATTRIBUTE_RULE_FIELDS.map((item) => (
                <Box component="article" className="prompt-library-skill-rule-section" key={item.key}>
                  <Box className="prompt-library-skill-rule-section-head">
                    <Typography variant="subtitle2">{item.label}</Typography>
                    <Typography variant="caption">{item.description}</Typography>
                  </Box>
                  <TextField
                    value={attributeRules[item.key]}
                    onChange={(event) =>
                      emitInstalledImageField(onChangeField, 'attributeRules', {
                        ...attributeRules,
                        [item.key]: event.target.value,
                      })
                    }
                    placeholder={`填写${item.label}，留空则不增加这一项自定义规则`}
                    inputProps={{ 'aria-label': `${item.label}属性规则` }}
                    multiline
                    minRows={3}
                    maxRows={7}
                    fullWidth
                  />
                </Box>
              ))}
            </Box>
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}

function PromptEditorFields({
  editorForm,
  categories,
  statusOptions,
  modelOptions,
  apiCapabilityMatch,
  skillProfile,
  installedSkillOptions,
  onChangeField,
}) {
  const hasModuleAnalysis = skillProfile?.moduleAnalysis?.completed === true;

  return (
    <Box className={`prompt-library-editor-layout${hasModuleAnalysis ? ' has-installed-module-config' : ''}`}>
      {hasModuleAnalysis ? (
        <Box className="prompt-library-editor-installed-module-section">
          <PromptEditorSection
            title="模块与接口"
            description="仅安装型 Skill 显示。模块顺序和依赖来自安装包解析，原生 Skill 不受影响。"
          >
            <InstalledSkillModuleConfiguration
              skillProfile={skillProfile}
              apiCapabilityMatch={apiCapabilityMatch}
              dependencyBindings={editorForm.dependencyBindings}
              installedSkillOptions={installedSkillOptions}
              onDependencyBindingsChange={(nextValue) =>
                emitInstalledImageField(onChangeField, 'dependencyBindings', nextValue)
              }
            />
          </PromptEditorSection>
        </Box>
      ) : null}
      <Box className="prompt-library-editor-left-stack">
        <PromptEditorBasicFields
          editorForm={editorForm}
          categories={categories}
          statusOptions={statusOptions}
          onChangeField={onChangeField}
        />
        <PromptEditorSection
          title="接口自动匹配"
          description="系统根据 Skill 的用途、输入和流程自动匹配预装接口；这里只显示状态，不保存或展示密钥。"
        >
          <PromptLibraryApiCapabilityStatus match={apiCapabilityMatch} showRegistryTotal />
          {!apiCapabilityMatch?.totalCount ? (
            <Typography variant="body2" color="text.secondary">
              当前 Skill 不需要外部接口，或说明中还没有可识别的接口需求。
            </Typography>
          ) : null}
        </PromptEditorSection>
        <PromptEditorWorkflowFields editorForm={editorForm} modelOptions={modelOptions} onChangeField={onChangeField} />
      </Box>
      <Box className="prompt-library-editor-right-stack">
        <PromptEditorPromptRulesFields editorForm={editorForm} onChangeField={onChangeField} />
      </Box>
    </Box>
  );
}

export function PromptLibraryEditorDialog({
  open,
  editorMode,
  onClose,
  formError,
  installFileInputRef,
  onInstallFileChange,
  installUrl,
  onInstallUrlChange,
  onInstallFromUrl,
  installResolving,
  installPreview,
  installSourceLabel,
  apiCapabilityMatch = null,
  skillProfile = null,
  installedSkillOptions = [],
  editorForm,
  categories,
  statusOptions,
  modelOptions,
  isImageSkill = false,
  imageWorkbench = {},
  onChangeField,
  onInstallTool,
  onSavePrompt,
  canDelete = false,
  onDeletePrompt = () => {},
}) {
  const isCreateMode = editorMode === 'create';

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="lg"
      fullWidth
      className={`prompt-library-editor-dialog${!isCreateMode && isImageSkill ? ' is-installed-image-editor' : ''}`}
    >
      <DialogTitle>{editorMode === 'edit' ? '编辑 Skill 配置' : '安装 Skill'}</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2} mt={0.5}>
          {formError ? (
            <Alert severity="warning" className="prompt-library-local-alert">
              {formError}
            </Alert>
          ) : null}
          {isCreateMode ? (
            <PromptInstallPanel
              installFileInputRef={installFileInputRef}
              onInstallFileChange={onInstallFileChange}
              installUrl={installUrl}
              onInstallUrlChange={onInstallUrlChange}
              onInstallFromUrl={onInstallFromUrl}
              installResolving={installResolving}
              installPreview={installPreview}
              installSourceLabel={installSourceLabel}
              apiCapabilityMatch={apiCapabilityMatch}
            />
          ) : isImageSkill ? (
            <InstalledImageSkillEditor
              editorForm={editorForm}
              categories={categories}
              statusOptions={statusOptions}
              modelOptions={modelOptions}
              apiCapabilityMatch={apiCapabilityMatch}
              skillProfile={skillProfile}
              installedSkillOptions={installedSkillOptions}
              imageWorkbench={imageWorkbench}
              onChangeField={onChangeField}
            />
          ) : (
            <PromptEditorFields
              editorForm={editorForm}
              categories={categories}
              statusOptions={statusOptions}
              modelOptions={modelOptions}
              apiCapabilityMatch={apiCapabilityMatch}
              skillProfile={skillProfile}
              installedSkillOptions={installedSkillOptions}
              onChangeField={onChangeField}
            />
          )}
        </Stack>
      </DialogContent>
      <DialogActions className="prompt-library-editor-actions">
        {canDelete ? (
          <Button color="error" startIcon={<DeleteOutlineRounded />} onClick={onDeletePrompt}>
            删除这个 Skill
          </Button>
        ) : null}
        <Box sx={{ flex: 1 }} />
        <Button onClick={onClose}>取消</Button>
        {isCreateMode ? (
          <Button
            variant="contained"
            startIcon={<CheckCircleRounded />}
            onClick={onInstallTool}
            disabled={
              !installPreview || installPreview.skillProfile?.moduleAnalysis?.completed !== true || installResolving
            }
          >
            确认安装并启用
          </Button>
        ) : (
          <Button variant="contained" startIcon={<SaveRounded />} onClick={onSavePrompt}>
            保存配置
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
