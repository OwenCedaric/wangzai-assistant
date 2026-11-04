import { SmartReplySceneCard } from './components/SmartReplySceneCard.jsx';
import { SmartReplyAutomationPanel } from './components/SmartReplyAutomationPanel.jsx';
import { SmartReplySendHistoryDrawer } from './components/SmartReplySendHistoryDrawer.jsx';
import { SmartReplyTemplateCard } from './components/SmartReplyTemplateCard.jsx';
import { SmartReplyTemplateEditorDialog } from './components/SmartReplyTemplateEditorDialog.jsx';
import { SmartReplyVariablePreview } from './components/SmartReplyVariablePreview.jsx';
import { smartReplyScenes } from './constants/smartReplyScenes.js';
import { useSmartReplyTemplateWorkspace } from './model/useSmartReplyTemplateWorkspace.js';
import { useSmartReplyAutomation } from './model/useSmartReplyAutomation.js';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Divider from '@mui/material/Divider';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import HistoryRounded from '@mui/icons-material/HistoryRounded';
import React, { useEffect, useState } from 'react';

export function SmartReplyPage({ activeShopId = '', isActive = false, shops = [] }) {
  const workspace = useSmartReplyTemplateWorkspace();
  const { hydrateSavedTemplate } = workspace;
  const automation = useSmartReplyAutomation({
    activeShopId,
    enabled: isActive,
    scene: workspace.selectedScene.value,
    selectedTemplate: workspace.selectedTemplate,
    shops,
  });
  const [templateEditor, setTemplateEditor] = useState(null);
  const [sendHistoryOpen, setSendHistoryOpen] = useState(false);

  useEffect(() => {
    const rule = automation.currentRule;
    if (!rule) return;
    hydrateSavedTemplate({
      scene: rule.scene,
      templateId: rule.templateId,
      messageTemplate: rule.messageTemplate,
      messageTemplateZh: rule.messageTemplateZh,
    });
  }, [automation.currentRule, hydrateSavedTemplate]);

  const closeTemplateEditor = () => setTemplateEditor(null);
  const saveTemplateDraft = (draft) => {
    workspace.saveTemplate(draft);
    closeTemplateEditor();
  };

  return (
    <Box sx={{ p: 3, minHeight: '100%' }}>
      <Stack spacing={2.5}>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 2 }}>
          <Box>
            <Typography variant="h4" component="h1" gutterBottom>
              智能回复
            </Typography>
            <Typography variant="body1" color="text.secondary">
              为订单不同阶段准备俄语消息，并在发送前查看中文译文和最终效果。
            </Typography>
          </Box>
          <Button
            variant="outlined"
            startIcon={<HistoryRounded />}
            onClick={() => setSendHistoryOpen(true)}
            sx={{ mt: 0.5, flexShrink: 0, borderRadius: '6px !important' }}
          >
            发送记录
          </Button>
        </Box>

        <Box
          data-testid="smart-reply-scene-row"
          data-layout="single-row"
          sx={{
            display: 'grid',
            gridAutoFlow: 'column',
            gridAutoColumns: 'minmax(240px, 1fr)',
            gap: 1.5,
            overflowX: 'auto',
            scrollSnapType: 'x proximity',
            scrollbarWidth: 'none',
            msOverflowStyle: 'none',
            '&::-webkit-scrollbar': {
              display: 'none',
            },
          }}
        >
          {smartReplyScenes.map((scene) => (
            <SmartReplySceneCard
              key={scene.id}
              {...scene}
              selected={workspace.selectedScene.value === scene.value}
              onSelect={() => workspace.selectScene(scene.value)}
            />
          ))}
        </Box>

        <SmartReplyAutomationPanel
          automation={automation}
          sceneTitle={workspace.selectedScene.title}
        />

        <Divider />

        <Stack direction="row" justifyContent="space-between" alignItems="flex-end" spacing={2}>
          <Stack spacing={0.5}>
            <Typography variant="h5" component="h2">
              {workspace.selectedScene.title}模板
            </Typography>
            <Typography variant="body2" color="text.secondary">
              选择合适的消息模板，填写订单信息后即可查看最终效果。
            </Typography>
          </Stack>
          <Button
            variant="contained"
            sx={{ borderRadius: '6px !important' }}
            onClick={() => setTemplateEditor({ mode: 'create', template: null })}
          >
            创建模板
          </Button>
        </Stack>

        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', xl: 'minmax(0, 1.6fr) minmax(360px, 0.9fr)' },
            gap: 2,
            alignItems: 'start',
          }}
        >
          <Stack spacing={2}>
            {workspace.templates.map((template, index) => (
              <SmartReplyTemplateCard
                key={template.id}
                index={index}
                template={template}
                selected={workspace.selectedTemplate.id === template.id}
                onApply={() => workspace.selectTemplate(template.id)}
                onEdit={() => setTemplateEditor({ mode: 'edit', template })}
              />
            ))}
          </Stack>

          <SmartReplyVariablePreview
            missingVariables={workspace.missingVariables}
            onValueChange={workspace.updateSampleValue}
            preview={workspace.preview}
            values={workspace.sampleValues}
          />
        </Box>
      </Stack>

      <SmartReplyTemplateEditorDialog
        mode={templateEditor?.mode || 'create'}
        open={Boolean(templateEditor)}
        template={templateEditor?.template || null}
        onClose={closeTemplateEditor}
        onSave={saveTemplateDraft}
      />

      <SmartReplySendHistoryDrawer
        automation={automation}
        open={sendHistoryOpen}
        onClose={() => setSendHistoryOpen(false)}
      />
    </Box>
  );
}

export default SmartReplyPage;
