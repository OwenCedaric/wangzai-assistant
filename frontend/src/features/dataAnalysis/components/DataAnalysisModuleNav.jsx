import { dataAnalysisModuleCatalog } from '../constants/dataAnalysisCatalog.js';
import Box from '@mui/material/Box';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';

export function DataAnalysisModuleNav({ activeModuleId, onChange }) {
  return (
    <Box
      sx={{
        p: 0.5,
        minWidth: 0,
        border: 0,
        borderRadius: 2.5,
        bgcolor: '#fff',
        boxShadow: '0 8px 24px rgba(31, 52, 88, 0.045)',
      }}
    >
      <Tabs
        value={activeModuleId}
        onChange={(_event, value) => onChange(value)}
        variant="standard"
        aria-label="数据分析模块"
        sx={{
          width: '100%',
          minWidth: 0,
          minHeight: 38,
          overflowX: 'hidden',
          '& .MuiTabs-indicator': { display: 'none' },
          '& .MuiTabs-scroller': { overflow: 'hidden !important' },
          '& .MuiTabs-list, & .MuiTabs-flexContainer': { flexWrap: 'wrap', gap: 0.35 },
          '& .MuiTab-root': {
            minWidth: 0,
            minHeight: 38,
            flex: '1 0 72px',
            px: 1.35,
            py: 0.75,
            borderRadius: 2,
            color: 'text.secondary',
            fontSize: 13,
            fontWeight: 800,
            textTransform: 'none',
          },
          '& .MuiTab-root.Mui-selected': {
            color: 'primary.main',
            bgcolor: 'rgba(93, 135, 255, 0.1)',
          },
        }}
      >
        {dataAnalysisModuleCatalog.map((item) => (
          <Tab key={item.id} value={item.id} label={item.shortLabel || item.label} />
        ))}
      </Tabs>
    </Box>
  );
}
