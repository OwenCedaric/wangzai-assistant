import EditRounded from '@mui/icons-material/EditRounded';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';

export function PromptLibraryCategoryFilter({ sceneCounts, activeScene, onSelectScene, onOpenCategoryDialog }) {
  return (
    <Card className="prompt-library-filter-card">
      <CardContent>
        <Box className="prompt-library-filter-shell">
          <Box className="prompt-library-filter-copy">
            <Box>
              <Typography variant="h6">工具分类</Typography>
              <Typography variant="body2" color="text.secondary">
                按用途筛选，快速找到要用的工具。
              </Typography>
            </Box>
            <Button size="small" variant="outlined" startIcon={<EditRounded />} onClick={onOpenCategoryDialog}>
              管理工具分类
            </Button>
          </Box>
          <Box className="prompt-library-status-grid">
            {sceneCounts.map((item) => (
              <Box
                key={item.value}
                component="button"
                type="button"
                className={`status-tab status-${item.value === 'all' ? 'primary' : 'default'}${activeScene === item.value ? ' active' : ''}`}
                onClick={() => onSelectScene(item.value)}
              >
                <span>{item.label}</span>
                <strong>{item.count}</strong>
              </Box>
            ))}
          </Box>
        </Box>
      </CardContent>
    </Card>
  );
}
