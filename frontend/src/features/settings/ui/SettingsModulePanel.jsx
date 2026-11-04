import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

export function SettingsModulePanel({ module, actionNote, onAction }) {
  return (
    <Box className="settings-module-panel">
      <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1.5} mb={2}>
        <Box>
          <Typography variant="h6">{module.title}</Typography>
          <Typography variant="body2" color="text.secondary">
            {module.description}
          </Typography>
        </Box>
        <Chip color="primary" label={module.status} variant="outlined" />
      </Stack>

      <Box className="settings-module-card-grid">
        {module.items.map((item) => (
          <Box key={item.title} className="settings-module-card">
            <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
              <Typography variant="subtitle1">{item.title}</Typography>
              <Chip size="small" color="primary" label={item.tag} variant="outlined" />
            </Stack>
            <Typography variant="body2" color="text.secondary">
              {item.text}
            </Typography>
          </Box>
        ))}
      </Box>

      <Box className="settings-module-actions">
        {module.actions.map((action) => (
          <Button key={action} size="small" variant="outlined" onClick={() => onAction(action)}>
            {action}
          </Button>
        ))}
      </Box>

      <Box className="settings-module-note">
        <Typography variant="subtitle2">当前交互</Typography>
        <Typography variant="body2" color="text.secondary">
          {actionNote}
        </Typography>
      </Box>
    </Box>
  );
}
