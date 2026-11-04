import AddRounded from '@mui/icons-material/AddRounded';
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded';
import ArrowDownwardRounded from '@mui/icons-material/ArrowDownwardRounded';
import ArrowUpwardRounded from '@mui/icons-material/ArrowUpwardRounded';
import SaveRounded from '@mui/icons-material/SaveRounded';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '../../../shared/ui/minimizedTasks/GlobalMinimizableDialog.jsx';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import MenuItem from '@mui/material/MenuItem';
import Switch from '@mui/material/Switch';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import {
  joinSkillSystemPromptSections,
  normalizeAttributeRules,
  normalizeImagePositionRules,
  SMART_TOOL_ATTRIBUTE_RULE_FIELDS,
  splitSkillSystemPromptSections,
} from '../lib/smartToolSkillConfiguration.js';
import {
  EXTERNAL_OZON_REPORT_ACCENT_OPTIONS,
  EXTERNAL_OZON_REPORT_DENSITY_OPTIONS,
  EXTERNAL_OZON_REPORT_LOGO_OPTIONS,
  EXTERNAL_OZON_REPORT_SECTION_ICON_OPTIONS,
  normalizeExternalOzonReportPresentation,
} from '../lib/smartToolExternalOzonInsightConfig.js';
import {
  normalizeProfitReviewPresentation,
  PROFIT_REVIEW_DENSITY_OPTIONS,
} from '../lib/smartToolProfitReviewConfig.js';

function emitField(onChangeField, field, value) {
  onChangeField(field)({ target: { value } });
}

function EditorSection({ eyebrow, title, description, children }) {
  return (
    <Box component="section" className="prompt-library-skill-settings-section">
      <Box className="prompt-library-skill-settings-section-head">
        <Typography component="span" variant="overline">{eyebrow}</Typography>
        <Typography variant="h6">{title}</Typography>
        <Typography variant="body2" color="text.secondary">{description}</Typography>
      </Box>
      {children}
    </Box>
  );
}

function SkillPromptSectionsEditor({ sections, onChangeSection }) {
  return (
    <Box className="prompt-library-skill-rule-sections">
      {sections.map((section, index) => {
        const sectionLabel = section.label || section.title;
        return (
          <Box
            component="article"
            className="prompt-library-skill-rule-section"
            key={section.id}
          >
            <Box className="prompt-library-skill-rule-section-head">
              <Typography variant="subtitle2">{sectionLabel}</Typography>
              <Typography variant="caption">选填，留空则不增加自定义内容</Typography>
            </Box>
            <TextField
              value={section.content}
              onChange={(event) => onChangeSection(index, event.target.value)}
              placeholder="留空时不增加这一部分的自定义内容"
              inputProps={{ 'aria-label': `${sectionLabel}规则内容` }}
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

function ImagePositionRulesEditor({ rules, group, onChange }) {
  const groupLabel = group === 'detail' ? '详情图' : '主图';
  const rows = rules[group] || [];
  const sortRules = (value) => [...value].sort((left, right) => left.sourceIndex - right.sourceIndex);
  const updateRule = (index, field, value) => {
    const nextGroup = rows.map((item, rowIndex) => (
      rowIndex === index ? { ...item, [field]: value } : item
    ));
    onChange({ ...rules, [group]: nextGroup });
  };
  const updateBoundPosition = (index, value) => {
    const nextSourceIndex = Math.max(0, Math.floor(Number(value) || 1) - 1);
    const previousSourceIndex = rows[index]?.sourceIndex ?? index;
    const nextGroup = rows.map((item, rowIndex) => {
      if (rowIndex === index) {
        return { ...item, sourceIndex: nextSourceIndex, position: nextSourceIndex + 1 };
      }
      if (item.sourceIndex === nextSourceIndex) {
        return { ...item, sourceIndex: previousSourceIndex, position: previousSourceIndex + 1 };
      }
      return item;
    });
    onChange({ ...rules, [group]: sortRules(nextGroup) });
  };
  const addRule = () => {
    const usedPositions = new Set(rows.map((item) => item.sourceIndex));
    let sourceIndex = 0;
    while (usedPositions.has(sourceIndex)) sourceIndex += 1;
    onChange({
      ...rules,
      [group]: sortRules([...rows, {
        sourceIndex,
        position: sourceIndex + 1,
        purpose: '',
        instructions: '',
        visibleText: '',
        mustAvoid: '',
      }]),
    });
  };
  const removeRule = (index) => {
    onChange({ ...rules, [group]: rows.filter((_, rowIndex) => rowIndex !== index) });
  };

  return (
    <Box className="prompt-library-position-rule-editor">
      <Box className="prompt-library-position-rule-toolbar">
        <Box>
          <Typography variant="subtitle2">已设置 {rows.length} 个{groupLabel}位置</Typography>
          <Typography variant="caption" color="text.secondary">每条规则绑定商品图片中的具体位置，可以自由新增或删除。</Typography>
        </Box>
        <Button size="small" variant="outlined" startIcon={<AddRounded />} onClick={addRule}>
          新增{groupLabel}规则
        </Button>
      </Box>
      {rows.length ? (
        <Box className="prompt-library-position-rule-grid">
          {rows.map((rule, index) => (
            <Box component="article" className="prompt-library-position-rule-card" key={`${group}-${rule.sourceIndex}`}>
              <Box className="prompt-library-position-rule-card-head">
                <Box>
                  <Typography variant="subtitle1">绑定商品{groupLabel}第 {rule.sourceIndex + 1} 张</Typography>
                  <Typography variant="caption" color="text.secondary">只影响这张原图；未单独设置的图片使用全局 Skill。</Typography>
                </Box>
                <Button
                  size="small"
                  color="error"
                  startIcon={<DeleteOutlineRounded />}
                  onClick={() => removeRule(index)}
                >
                  删除
                </Button>
              </Box>
              <TextField
                size="small"
                type="number"
                label={`绑定商品${groupLabel}位置`}
                value={rule.sourceIndex + 1}
                onChange={(event) => updateBoundPosition(index, event.target.value)}
                helperText="填写商品图片中的顺序，例如 1 表示第一张；与已有位置重复时会自动交换。"
                inputProps={{ min: 1, step: 1 }}
                fullWidth
              />
              <TextField
                size="small"
                label="这张图负责什么"
                value={rule.purpose}
                onChange={(event) => updateRule(index, 'purpose', event.target.value)}
                placeholder="例如：白底主图、使用场景、材质细节"
                fullWidth
              />
              <TextField
                size="small"
                label="构图、背景和重点"
                value={rule.instructions}
                onChange={(event) => updateRule(index, 'instructions', event.target.value)}
                placeholder="填写这个位置独有的画面要求"
                multiline
                minRows={2}
                maxRows={4}
                fullWidth
              />
              <TextField
                size="small"
                label="画面文字"
                value={rule.visibleText}
                onChange={(event) => updateRule(index, 'visibleText', event.target.value)}
                placeholder="无文字要求可以留空"
                multiline
                minRows={2}
                maxRows={3}
                fullWidth
              />
              <TextField
                size="small"
                label="这个位置不能出现什么"
                value={rule.mustAvoid}
                onChange={(event) => updateRule(index, 'mustAvoid', event.target.value)}
                placeholder="留空时沿用全局禁止规则"
                multiline
                minRows={2}
                maxRows={3}
                fullWidth
              />
            </Box>
          ))}
        </Box>
      ) : (
        <Box className="prompt-library-position-rule-empty">
          <Typography variant="subtitle2">暂未设置{groupLabel}位置规则</Typography>
          <Typography variant="body2" color="text.secondary">运行时会使用全局 Skill；需要单独控制某张图片时再新增。</Typography>
          <Button size="small" variant="outlined" startIcon={<AddRounded />} onClick={addRule}>
            新增第一个{groupLabel}规则
          </Button>
        </Box>
      )}
    </Box>
  );
}

function AttributeRulesEditor({ rules, onChange }) {
  const normalizedRules = normalizeAttributeRules(rules);
  return (
    <Box className="prompt-library-skill-rule-sections prompt-library-attribute-rule-sections">
      {SMART_TOOL_ATTRIBUTE_RULE_FIELDS.map((item) => (
        <Box component="article" className="prompt-library-skill-rule-section" key={item.key}>
          <Box className="prompt-library-skill-rule-section-head">
            <Typography variant="subtitle2">{item.label}</Typography>
            <Typography variant="caption">{item.description}</Typography>
          </Box>
          <TextField
            value={normalizedRules[item.key]}
            onChange={(event) => onChange({ ...normalizedRules, [item.key]: event.target.value })}
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
  );
}

function ReportPresentationEditor({ value = {}, onChange }) {
  const presentation = normalizeExternalOzonReportPresentation(value);
  const update = (field, nextValue) => onChange({ ...presentation, [field]: nextValue });
  const updateSection = (index, field, nextValue) => update(
    'sections',
    presentation.sections.map((item, itemIndex) => (
      itemIndex === index ? { ...item, [field]: nextValue } : item
    ))
  );
  const moveSection = (index, direction) => {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= presentation.sections.length) return;
    const sections = [...presentation.sections];
    [sections[index], sections[nextIndex]] = [sections[nextIndex], sections[index]];
    update('sections', sections);
  };

  return (
    <Box className="prompt-library-report-style-editor">
      <Box className="prompt-library-report-style-controls">
        <TextField
          size="small"
          label="报告顶部的小标题"
          value={presentation.eyebrow}
          onChange={(event) => update('eyebrow', event.target.value)}
          inputProps={{ 'aria-label': '报告顶部的小标题' }}
        />
        <TextField
          select
          size="small"
          label="报告标志"
          value={presentation.logo}
          onChange={(event) => update('logo', event.target.value)}
          inputProps={{ 'aria-label': '报告标志' }}
        >
          {EXTERNAL_OZON_REPORT_LOGO_OPTIONS.map((item) => (
            <MenuItem key={item.value} value={item.value}>{item.label}</MenuItem>
          ))}
        </TextField>
        <TextField
          select
          size="small"
          label="重点颜色"
          value={presentation.accent}
          onChange={(event) => update('accent', event.target.value)}
          inputProps={{ 'aria-label': '重点颜色' }}
        >
          {EXTERNAL_OZON_REPORT_ACCENT_OPTIONS.map((item) => (
            <MenuItem key={item.value} value={item.value}>{item.label}</MenuItem>
          ))}
        </TextField>
        <TextField
          select
          size="small"
          label="内容间距"
          value={presentation.density}
          onChange={(event) => update('density', event.target.value)}
          inputProps={{ 'aria-label': '内容间距' }}
        >
          {EXTERNAL_OZON_REPORT_DENSITY_OPTIONS.map((item) => (
            <MenuItem key={item.value} value={item.value}>{item.label}</MenuItem>
          ))}
        </TextField>
      </Box>

      <Box className="prompt-library-report-style-switches">
        {[
          ['showSectionIcons', '显示分区图标'],
          ['showModel', '显示模型名称'],
          ['showGeneratedAt', '显示生成时间'],
          ['showPriority', '显示优先级'],
          ['showEvidenceLabels', '显示“数据依据”'],
          ['showActionLabels', '显示“建议动作”'],
        ].map(([field, label]) => (
          <FormControlLabel
            key={field}
            control={(
              <Switch
                size="small"
                checked={presentation[field]}
                onChange={(event) => update(field, event.target.checked)}
              />
            )}
            label={label}
          />
        ))}
      </Box>

      <Box className="prompt-library-report-section-editor">
        <Box className="prompt-library-report-section-editor-head">
          <Typography variant="subtitle2">报告分区</Typography>
          <Typography variant="caption">名称、图标、显示顺序都能改；关闭后该分区不展示。</Typography>
        </Box>
        {presentation.sections.map((section, index) => (
          <Box className="prompt-library-report-section-row" key={section.id}>
            <FormControlLabel
              className="prompt-library-report-section-visible"
              control={(
                <Switch
                  size="small"
                  checked={section.visible}
                  onChange={(event) => updateSection(index, 'visible', event.target.checked)}
                  inputProps={{ 'aria-label': `${section.title}是否显示` }}
                />
              )}
              label="显示"
            />
            <TextField
              size="small"
              label="分区名称"
              value={section.title}
              onChange={(event) => updateSection(index, 'title', event.target.value)}
              inputProps={{ 'aria-label': `${section.id}分区名称` }}
            />
            <TextField
              select
              size="small"
              label="图标"
              value={section.icon}
              onChange={(event) => updateSection(index, 'icon', event.target.value)}
              inputProps={{ 'aria-label': `${section.id}分区图标` }}
            >
              {EXTERNAL_OZON_REPORT_SECTION_ICON_OPTIONS.map((item) => (
                <MenuItem key={item.value} value={item.value}>{item.label}</MenuItem>
              ))}
            </TextField>
            <Box className="prompt-library-report-section-order">
              <Button
                size="small"
                aria-label={`${section.title}上移`}
                disabled={index === 0}
                onClick={() => moveSection(index, -1)}
              >
                <ArrowUpwardRounded fontSize="small" />
              </Button>
              <Button
                size="small"
                aria-label={`${section.title}下移`}
                disabled={index === presentation.sections.length - 1}
                onClick={() => moveSection(index, 1)}
              >
                <ArrowDownwardRounded fontSize="small" />
              </Button>
            </Box>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

function ProfitReviewPresentationEditor({ value = {}, onChange }) {
  const presentation = normalizeProfitReviewPresentation(value);
  const update = (field, nextValue) => onChange({ ...presentation, [field]: nextValue });
  return (
    <Box className="prompt-library-report-style-editor">
      <Box className="prompt-library-report-style-controls">
        <TextField
          size="small"
          label="顶部助手名称"
          value={presentation.assistantName}
          onChange={(event) => update('assistantName', event.target.value)}
          inputProps={{ 'aria-label': '顶部助手名称' }}
        />
        <TextField
          size="small"
          label="顶部说明"
          value={presentation.assistantSubtitle}
          onChange={(event) => update('assistantSubtitle', event.target.value)}
          inputProps={{ 'aria-label': '顶部说明' }}
        />
        <TextField
          select
          size="small"
          label="内容间距"
          value={presentation.density}
          onChange={(event) => update('density', event.target.value)}
          inputProps={{ 'aria-label': '订单分析内容间距' }}
        >
          {PROFIT_REVIEW_DENSITY_OPTIONS.map((item) => (
            <MenuItem key={item.value} value={item.value}>{item.label}</MenuItem>
          ))}
        </TextField>
      </Box>
      <Box className="prompt-library-report-style-switches">
        {[
          ['paragraphIndent', '长段正文首行缩进两字'],
          ['showAssistantBrand', '显示顶部助手标志'],
          ['showMarketSignal', '显示市场信号'],
          ['showModel', '显示模型名称'],
          ['showMetricNotes', '显示核心数字说明'],
          ['showSectionIcons', '显示分区小图标'],
        ].map(([field, label]) => (
          <FormControlLabel
            key={field}
            control={(
              <Switch
                size="small"
                checked={presentation[field]}
                onChange={(event) => update(field, event.target.checked)}
                inputProps={{ 'aria-label': label }}
              />
            )}
            label={label}
          />
        ))}
      </Box>
    </Box>
  );
}

function AnalysisTextEditor({
  title,
  description,
  value,
  onChange,
  ariaLabel = title,
  minRows = 3,
  className = '',
}) {
  return (
    <Box component="article" className={`prompt-library-analysis-config-row ${className}`.trim()}>
      <Box className="prompt-library-analysis-config-copy">
        <Typography variant="subtitle2">{title}</Typography>
        {description ? <Typography variant="caption">{description}</Typography> : null}
      </Box>
      <TextField
        value={value}
        onChange={onChange}
        inputProps={{ 'aria-label': ariaLabel }}
        multiline
        minRows={minRows}
        fullWidth
      />
    </Box>
  );
}

function AnalysisModeEditor({ mode, label, fields, config, onChange }) {
  return (
    <Box component="section" className="prompt-library-analysis-mode-block">
      <Box className="prompt-library-analysis-mode-head">
        <Typography component="h3">{label}</Typography>
        <Typography component="p">这套内容只在选择“{label.replace('分析', '')}”时使用。</Typography>
      </Box>
      <Box className="prompt-library-analysis-mode-fields">
        {fields.map((item) => (
          <AnalysisTextEditor
            key={`${mode}-${item.field}`}
            title={item.title}
            description={item.description}
            value={(config.analysisModes?.[mode]?.[item.field] || []).join('\n')}
            onChange={(event) => onChange(mode, item.field, event.target.value)}
            ariaLabel={`${label}${item.title}`}
            minRows={item.minRows}
            className="prompt-library-analysis-mode-field"
          />
        ))}
      </Box>
    </Box>
  );
}

function ExternalInsightConfigEditor({ config = {}, onChange }) {
  const updateField = (field, value) => onChange({ ...config, [field]: value });
  const updateList = (field, value) => updateField(field, String(value ?? '').split(/\r?\n/u));
  const listValue = (field) => (Array.isArray(config[field]) ? config[field] : []).join('\n');
  const updateModeList = (mode, field, value) => onChange({
    ...config,
    analysisModes: {
      ...config.analysisModes,
      [mode]: {
        ...config.analysisModes?.[mode],
        [field]: String(value ?? '').split(/\r?\n/u),
      },
    },
  });
  const fields = [
    {
      field: 'analysisGoals',
      title: '你希望这份报告回答什么',
      description: '例如“这个商品值不值得做”“现在最该解决什么问题”，一行写一个。',
      minRows: 3,
    },
    {
      field: 'workflowSteps',
      title: '分析时先看什么、再看什么',
      description: '按你平时判断业务的顺序填写，一行写一步。',
      minRows: 5,
    },
    {
      field: 'analysisRules',
      title: '哪些判断必须遵守',
      description: '例如“没有成本就不要算利润”“必须写清数据依据”，一行写一条。',
      minRows: 6,
    },
    {
      field: 'reportStyleRules',
      title: '报告怎么写',
      description: '控制语言、段落、重点和建议的写法，不需要懂提示词。',
      minRows: 5,
    },
  ];
  const modeFields = fields.filter((item) => item.field !== 'reportStyleRules');

  return (
    <Box className="prompt-library-analysis-config">
      <Box className="prompt-library-analysis-config-rows">
        {fields.map((item) => (
          <AnalysisTextEditor
            key={item.field}
            title={item.title}
            description={item.description}
            value={listValue(item.field)}
            onChange={(event) => updateList(item.field, event.target.value)}
            minRows={item.minRows}
          />
        ))}

        <Box component="article" className="prompt-library-analysis-config-row prompt-library-report-style-config-row">
          <Box>
            <Typography variant="subtitle2">报告看起来是什么样</Typography>
            <Typography variant="caption">当前是清晰的网页报告预设；标志、颜色、分区和显示内容都可以自己改。</Typography>
          </Box>
          <ReportPresentationEditor
            value={config.reportPresentation}
            onChange={(value) => updateField('reportPresentation', value)}
          />
        </Box>

        {config.analysisModes ? (
          <Box component="section" className="prompt-library-analysis-modes">
            <Box className="prompt-library-analysis-modes-head">
              <Typography variant="subtitle2">竞对商品和自己商品分别怎么分析</Typography>
              <Typography variant="caption">两种情况可以使用不同判断方法，下面的内容都能单独修改。</Typography>
            </Box>
            <Box className="prompt-library-analysis-mode-list">
              <AnalysisModeEditor
                mode="competitor"
                label="竞对商品分析"
                fields={modeFields}
                config={config}
                onChange={updateModeList}
              />
              <AnalysisModeEditor
                mode="own"
                label="自己商品分析"
                fields={modeFields}
                config={config}
                onChange={updateModeList}
              />
            </Box>
          </Box>
        ) : null}

        <Box component="details" className="prompt-library-analysis-advanced">
          <Box component="summary">
            <Typography component="span" variant="subtitle2">专业设置（一般不用改）</Typography>
            <Typography component="span" variant="caption">给熟悉模型配置的用户保留完整修改能力</Typography>
          </Box>
          <Box className="prompt-library-analysis-config-rows">
            <AnalysisTextEditor
              title="模型的总说明"
              description="控制模型扮演什么角色，以及怎样使用上面的分析方案。"
              value={config.systemPrompt || ''}
              onChange={(event) => updateField('systemPrompt', event.target.value)}
              minRows={10}
            />
            <AnalysisTextEditor
              title="本次数据说明模板"
              description="决定查询结果怎样交给模型；不熟悉其中的双大括号内容时保持原样。"
              value={config.userPrompt || ''}
              onChange={(event) => updateField('userPrompt', event.target.value)}
              minRows={10}
            />
            <AnalysisTextEditor
              title="报告内容对应关系"
              description="软件识别报告各部分使用的内部名称，普通修改不需要动这里。"
              value={listValue('outputSections')}
              onChange={(event) => updateList('outputSections', event.target.value)}
              minRows={8}
            />
            <AnalysisTextEditor
              title="系统返回要求"
              description="保证模型结果能被软件正常读取；没有特殊需求时保持默认。"
              value={listValue('outputRules')}
              onChange={(event) => updateList('outputRules', event.target.value)}
              minRows={5}
            />
          </Box>
        </Box>
      </Box>

    </Box>
  );
}

export function PromptLibrarySimpleEditorDialog({
  open,
  onClose,
  formError,
  editorForm,
  isImageSkill = false,
  isExternalDataSkill = false,
  isProfitReviewSkill = false,
  onChangeField,
  onSavePrompt,
}) {
  const [activeArea, setActiveArea] = React.useState('global');
  const [positionGroup, setPositionGroup] = React.useState('main');
  const [promptSections, setPromptSections] = React.useState(() =>
    splitSkillSystemPromptSections(editorForm.systemPrompt)
  );
  const openedTitleRef = React.useRef('');

  React.useEffect(() => {
    if (!open) {
      openedTitleRef.current = '';
      return;
    }
    if (openedTitleRef.current === editorForm.title) return;
    openedTitleRef.current = editorForm.title;
    setActiveArea('global');
    setPositionGroup('main');
    setPromptSections(splitSkillSystemPromptSections(editorForm.systemPrompt));
  }, [editorForm.systemPrompt, editorForm.title, open]);

  const positionRules = normalizeImagePositionRules(editorForm.imagePositionRules);
  const updatePromptSection = (index, value) => {
    const nextSections = promptSections.map((section, sectionIndex) => (
      sectionIndex === index ? { ...section, content: value } : section
    ));
    setPromptSections(nextSections);
    emitField(onChangeField, 'systemPrompt', joinSkillSystemPromptSections(nextSections));
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="lg" fullWidth className="prompt-library-simple-editor-dialog">
      <DialogTitle component="div">
        <Box>
          <Typography variant="h6">设置工具规则</Typography>
          <Typography variant="body2" color="text.secondary">{editorForm.title}</Typography>
        </Box>
        <Typography component="span" className="prompt-library-skill-editor-badge">
          {isExternalDataSkill
            ? '分析方法 + 报告样式'
            : isProfitReviewSkill
              ? '分析规则 + 报告样式'
            : isImageSkill
              ? '全局规则 + 图片规则 + 属性规则'
              : '全局 Skill'}
        </Typography>
      </DialogTitle>
      <DialogContent dividers>
        {formError ? (
          <Alert severity="warning" className="prompt-library-local-alert prompt-library-skill-editor-error">
            {formError}
          </Alert>
        ) : null}

        <Tabs
          value={activeArea}
          onChange={(_, value) => setActiveArea(value)}
          className="prompt-library-skill-area-tabs"
          variant="fullWidth"
        >
          <Tab value="global" label={isExternalDataSkill ? '通用规则' : '全局 Skill'} />
          {isExternalDataSkill ? <Tab value="analysis" label="分析报告" /> : null}
          {isProfitReviewSkill ? <Tab value="presentation" label="报告样式" /> : null}
          {isImageSkill ? <Tab value="position" label="图片位置规则" /> : null}
          {isImageSkill ? <Tab value="attributes" label="属性规则" /> : null}
        </Tabs>

        <Box className="prompt-library-skill-area-content">
          {activeArea === 'global' ? (
            <EditorSection
              eyebrow="完整 Skill"
              title="所有规则直接显示"
              description="规则名称在左、内容在右，可以直接查看和修改；不需要调整的内容保持原样即可。"
            >
              <SkillPromptSectionsEditor sections={promptSections} onChangeSection={updatePromptSection} />
            </EditorSection>
          ) : null}

          {isExternalDataSkill && activeArea === 'analysis' ? (
            <EditorSection
              eyebrow="报告设置"
              title="分析方法和报告样式都能自己改"
              description="先按大白话修改分析方法、报告写法和页面样式；完整模型设置保留在最下面，熟悉后再展开。"
            >
              <ExternalInsightConfigEditor
                config={editorForm.externalInsightConfig}
                onChange={(value) => emitField(onChangeField, 'externalInsightConfig', value)}
              />
            </EditorSection>
          ) : null}

          {isProfitReviewSkill && activeArea === 'presentation' ? (
            <EditorSection
              eyebrow="页面显示"
              title="报告排版可以自己调整"
              description="控制长段落缩进、内容间距、顶部标志和页面中显示的小信息；不会改变利润计算结果。"
            >
              <ProfitReviewPresentationEditor
                value={editorForm.profitReviewPresentation}
                onChange={(value) => emitField(onChangeField, 'profitReviewPresentation', value)}
              />
            </EditorSection>
          ) : null}

          {isImageSkill && activeArea === 'position' ? (
            <EditorSection
              eyebrow="固定位置"
              title="每张商品图片可以单独设置"
              description="规则数量不再固定；新增规则后绑定商品图片中的具体位置，没有单独规则的图片继续使用全局 Skill。"
            >
              <Tabs
                value={positionGroup}
                onChange={(_, value) => setPositionGroup(value)}
                className="prompt-library-position-group-tabs"
              >
                <Tab value="main" label={`主图规则 (${positionRules.main.length})`} />
                <Tab value="detail" label={`详情图规则 (${positionRules.detail.length})`} />
              </Tabs>
              <ImagePositionRulesEditor
                rules={positionRules}
                group={positionGroup}
                onChange={(value) => emitField(onChangeField, 'imagePositionRules', value)}
              />
            </EditorSection>
          ) : null}

          {isImageSkill && activeArea === 'attributes' ? (
            <EditorSection
              eyebrow="现有商品优化"
              title="设置商品属性生成规则"
              description="属性生成时会同时使用全局 Skill 和这里的规则；图片位置规则不会混入属性生成。"
            >
              <AttributeRulesEditor
                rules={editorForm.attributeRules}
                onChange={(value) => emitField(onChangeField, 'attributeRules', value)}
              />
            </EditorSection>
          ) : null}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>取消</Button>
        <Button variant="contained" startIcon={<SaveRounded />} onClick={onSavePrompt}>
          保存工具设置
        </Button>
      </DialogActions>
    </Dialog>
  );
}
