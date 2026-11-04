import CloseRounded from '@mui/icons-material/CloseRounded';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Typography from '@mui/material/Typography';
import React from 'react';

import Dialog from '../../../shared/ui/minimizedTasks/GlobalMinimizableDialog.jsx';
import { PromptLibrarySimpleEditorDialog } from '../../promptLibrary/components/PromptLibrarySimpleEditorDialog.jsx';
import {
  normalizeAttributeRules,
  normalizeImagePositionRules,
  SMART_TOOL_ATTRIBUTE_RULE_FIELDS,
  splitSkillSystemPromptSections,
} from '../../promptLibrary/lib/smartToolSkillConfiguration.js';
import { createCollectionProductImageSkillEditorForm } from '../services/collectionProductImageSkillService.js';

function RuleList({ title, rows = [], emptyText = '暂无规则' }) {
  const values = (Array.isArray(rows) ? rows : []).map((item) => String(item || '').trim()).filter(Boolean);
  return (
    <Box>
      <Typography variant="subtitle2" fontWeight={800} sx={{ mb: 0.75 }}>{title}</Typography>
      {values.length ? (
        <Stack spacing={0.65}>
          {values.map((item, index) => (
            <Stack key={`${title}-${index}`} direction="row" spacing={0.8} alignItems="flex-start">
              <Chip size="small" label={index + 1} sx={{ width: 25, height: 21, flex: '0 0 25px' }} />
              <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>{item}</Typography>
            </Stack>
          ))}
        </Stack>
      ) : <Typography variant="body2" color="text.secondary">{emptyText}</Typography>}
    </Box>
  );
}

function PositionRuleCards({ rules = {} }) {
  const [group, setGroup] = React.useState('main');
  const normalized = normalizeImagePositionRules(rules);
  const rows = normalized[group] || [];
  return (
    <Stack spacing={1.25}>
      <Tabs value={group} onChange={(_event, value) => setGroup(value)}>
        <Tab value="main" label={`主图规则 ${normalized.main.length}`} />
        <Tab value="detail" label={`详情图规则 ${normalized.detail.length}`} />
      </Tabs>
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 1 }}>
        {rows.map((item) => (
          <Paper key={`${group}-${item.sourceIndex}`} variant="outlined" sx={{ p: 1.25, borderRadius: 0.8 }}>
            <Stack spacing={0.65}>
              <Stack direction="row" alignItems="center" justifyContent="space-between">
                <Typography variant="subtitle2" fontWeight={800}>位置 {item.sourceIndex + 1}</Typography>
                <Chip size="small" label={group === 'detail' ? '详情图' : '主图'} />
              </Stack>
              <Typography variant="body2" fontWeight={700}>{item.purpose || '沿用全局 Skill'}</Typography>
              {item.instructions ? <Typography variant="body2" color="text.secondary">构图：{item.instructions}</Typography> : null}
              {item.visibleText ? <Typography variant="body2" color="text.secondary">文字：{item.visibleText}</Typography> : null}
              {item.mustAvoid ? <Typography variant="body2" color="error.main">禁止：{item.mustAvoid}</Typography> : null}
            </Stack>
          </Paper>
        ))}
      </Box>
    </Stack>
  );
}

function PromptSections({ value = '' }) {
  const sections = splitSkillSystemPromptSections(value);
  return (
    <Stack spacing={0.85}>
      {sections.map((section) => (
        <Paper key={section.id} component="details" variant="outlined" sx={{ p: 1, borderRadius: 0.75 }}>
          <Typography component="summary" variant="subtitle2" fontWeight={800} sx={{ cursor: 'pointer' }}>
            {section.label}
          </Typography>
          <Typography component="pre" variant="body2" sx={{ mt: 1, mb: 0, whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>
            {section.content}
          </Typography>
        </Paper>
      ))}
    </Stack>
  );
}

function AttributeRuleCards({ rules = {} }) {
  const normalized = normalizeAttributeRules(rules);
  return (
    <Stack spacing={0.85}>
      {SMART_TOOL_ATTRIBUTE_RULE_FIELDS.map((field) => (
        <Paper key={field.key} variant="outlined" sx={{ p: 1.15, borderRadius: 0.75 }}>
          <Typography variant="subtitle2" fontWeight={800}>{field.label}</Typography>
          <Typography variant="caption" color="text.secondary">{field.description}</Typography>
          <Typography variant="body2" sx={{ mt: 0.6, whiteSpace: 'pre-wrap' }}>
            {normalized[field.key] || '未单独设置'}
          </Typography>
        </Paper>
      ))}
    </Stack>
  );
}

export function CollectionProductImageSkillRulesPanel({ open, onClose, skill, status = 'ready', error = '', onSaveSkill }) {
  const [tab, setTab] = React.useState('workflow');
  const [editorOpen, setEditorOpen] = React.useState(false);
  const [editorForm, setEditorForm] = React.useState(() => createCollectionProductImageSkillEditorForm(skill));
  const [formError, setFormError] = React.useState('');
  React.useEffect(() => {
    if (open) {
      setTab('workflow');
      setEditorForm(createCollectionProductImageSkillEditorForm(skill));
    } else {
      setEditorOpen(false);
    }
  }, [open, skill]);
  const promptConfig = skill?.promptConfig || {};
  const openEditor = () => {
    setEditorForm(createCollectionProductImageSkillEditorForm(skill));
    setFormError('');
    setEditorOpen(true);
  };
  const updateEditorField = (field) => (event) => {
    setEditorForm((current) => ({ ...current, [field]: event.target.value }));
    setFormError('');
  };
  const saveEditor = async () => {
    if (typeof onSaveSkill !== 'function') {
      setFormError('当前规则面板没有连接保存服务。');
      return;
    }
    const saved = await onSaveSkill(editorForm);
    if (!saved) {
      setFormError('规则保存失败，请稍后重试。');
      return;
    }
    setEditorOpen(false);
    setFormError('');
  };
  return (
    <>
      <Dialog open={open} onClose={onClose} maxWidth="lg" fullWidth aria-labelledby="collection-image-skill-rules-title">
      <DialogTitle component="div" sx={{ pr: 6 }}>
        <Typography id="collection-image-skill-rules-title" variant="h6" fontWeight={850}>图片 Skill 规则</Typography>
        <Typography variant="body2" color="text.secondary">
          {skill?.title || 'Ozon 商品图生成'} · 当前图片生成会直接使用这里的流程、提示词和位置规则
        </Typography>
        <IconButton aria-label="关闭 Skill 规则" onClick={onClose} sx={{ position: 'absolute', right: 12, top: 12 }}>
          <CloseRounded />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers sx={{ p: 0, height: '72vh' }}>
        {error ? <Alert severity="warning" sx={{ m: 1.5 }}>{error}</Alert> : null}
        <Box sx={{ px: 1.5, pt: 1.25 }}>
          <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
            <Chip size="small" color="primary" variant="outlined" label="跟随智能工具配置" />
            <Chip size="small" label={`规划模型：${promptConfig.plannerModelId || 'auto'}`} />
            <Chip size="small" label={`图片模型：${promptConfig.imageModelId || promptConfig.defaultModelId || 'auto'}`} />
            <Chip size="small" label={status === 'loading' ? '正在刷新规则' : '规则已加载'} />
          </Stack>
        </Box>
        <Tabs value={tab} onChange={(_event, value) => setTab(value)} variant="fullWidth" sx={{ mt: 0.75, borderBottom: '1px solid', borderColor: 'divider' }}>
          <Tab value="workflow" label="执行流程" />
          <Tab value="positions" label="图片位置" />
          <Tab value="prompt" label="完整提示词" />
          <Tab value="attributes" label="属性规则" />
        </Tabs>
        <Box sx={{ p: 1.75, height: 'calc(72vh - 104px)', overflowY: 'auto' }}>
          {tab === 'workflow' ? (
            <Stack spacing={1.5}>
              <Box>
                <Typography variant="subtitle2" fontWeight={800}>工具目标</Typography>
                <Typography variant="body2">{skill?.goal || '按商品图生成规则生成主图和详情图方案'}</Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>{skill?.body || ''}</Typography>
              </Box>
              <Divider />
              <RuleList title="Skill 自带流程" rows={promptConfig.workflowSteps} />
              <RuleList title="输出规则" rows={promptConfig.outputRules} />
              <RuleList title="安全规则" rows={promptConfig.safetyRules} />
              <Box>
                <Typography variant="subtitle2" fontWeight={800}>输出格式</Typography>
                <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>{promptConfig.outputFormat || '使用 PromptPlan 结构输出'}</Typography>
              </Box>
            </Stack>
          ) : null}
          {tab === 'positions' ? <PositionRuleCards rules={promptConfig.imagePositionRules} /> : null}
          {tab === 'prompt' ? <PromptSections value={promptConfig.systemPrompt} /> : null}
          {tab === 'attributes' ? <AttributeRuleCards rules={promptConfig.attributeRules} /> : null}
        </Box>
      </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>关闭</Button>
          <Button variant="contained" onClick={openEditor} disabled={!skill || status === 'saving'}>
            {status === 'saving' ? '保存中…' : '编辑规则'}
          </Button>
        </DialogActions>
      </Dialog>
      <PromptLibrarySimpleEditorDialog
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        formError={formError || error}
        editorForm={editorForm}
        isImageSkill
        onChangeField={updateEditorField}
        onSavePrompt={saveEditor}
      />
    </>
  );
}
