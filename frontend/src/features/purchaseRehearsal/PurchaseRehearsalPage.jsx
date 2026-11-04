import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import SettingsRounded from '@mui/icons-material/SettingsRounded';
import React from 'react';

import { AutomaticOrderBatchPage, AutomaticOrderRunLog } from './components/AutomaticOrderBatchPage.jsx';
import { PurchaseAutoOrderProductList } from './components/PurchaseAutoOrderProductList.jsx';
import { useAutomaticOrderWorkflow } from './model/useAutomaticOrderWorkflow.js';
import { automaticOrderSections } from './services/automaticOrderWorkflowService.js';
import { PurchaseAutoPaySettingsDialog } from './components/PurchaseAutoPaySettingsDialog.jsx';

const SECTIONS = Object.freeze([
  { id: automaticOrderSections.autoOrder, label: '真自动拍单' },
  { id: automaticOrderSections.stock, label: '一键备货' },
  { id: automaticOrderSections.forecast, label: '一键预报' },
  { id: automaticOrderSections.binding, label: '货源绑定' },
]);

export function PurchaseRehearsalPage({ shops = [], isActive = true }) {
  const [activeSection, setActiveSection] = React.useState(automaticOrderSections.autoOrder);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const workflow = useAutomaticOrderWorkflow({ shops, isActive });

  return (
    <Box
      sx={{
        width: '100%',
        pb: 3,
        '& .MuiButton-root, & .MuiCard-root, & .MuiAlert-root, & .MuiChip-root, & .MuiPaper-rounded, & .MuiOutlinedInput-root': {
          borderRadius: '6px',
        },
      }}
    >
      <Stack spacing={2}>
        <Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" alignItems={{ xs: 'stretch', md: 'flex-start' }} gap={1.5}>
          <Box>
            <Typography variant="h4" fontWeight={800}>自动拍单</Typography>
            <Typography color="text.secondary" sx={{ mt: 0.5 }}>
              自动采购付款、Ozon 批量备货和跨境巴士批量预报使用同一份订单数据。
            </Typography>
          </Box>
          <Stack direction="row" spacing={1} alignItems="center">
            {workflow.fixture ? <Chip color="info" label="虚拟订单测试模式" sx={{ borderRadius: '6px' }} /> : null}
            <Button variant="outlined" size="small" startIcon={<SettingsRounded />} onClick={() => setSettingsOpen(true)}>
              拍单配置
            </Button>
          </Stack>
        </Stack>

        <Box
          role="group"
          aria-label="自动拍单页面选择"
          sx={{
            alignSelf: 'flex-start',
            display: 'inline-flex',
            gap: 0.5,
            p: 0.5,
            border: '1px solid',
            borderColor: 'divider',
            borderRadius: '6px',
            bgcolor: 'background.paper',
          }}
        >
          {SECTIONS.map((section) => (
            <Button
              key={section.id}
              size="small"
              variant={activeSection === section.id ? 'contained' : 'text'}
              onClick={() => setActiveSection(section.id)}
              disableElevation
              sx={{ minWidth: 104, borderRadius: '5px' }}
            >
              {section.label}
            </Button>
          ))}
        </Box>

        {workflow.errorMessage ? <Alert severity="warning">{workflow.errorMessage}</Alert> : null}

        {activeSection === automaticOrderSections.binding ? (
          <PurchaseAutoOrderProductList isActive={isActive} />
        ) : (
          <AutomaticOrderBatchPage section={activeSection} workflow={workflow} />
        )}

        <AutomaticOrderRunLog workflow={workflow} />
      </Stack>
      <PurchaseAutoPaySettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} logs={workflow.logs} />
    </Box>
  );
}
