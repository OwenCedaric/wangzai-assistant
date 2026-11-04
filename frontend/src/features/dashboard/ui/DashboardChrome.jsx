import KeyboardArrowRightRounded from '@mui/icons-material/KeyboardArrowRightRounded';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

export function DashboardDelta({ trend, children }) {
  if (!children || children === '—') {
    return (
      <Typography component="span" variant="caption" color="text.secondary">
        —
      </Typography>
    );
  }

  return (
    <Typography
      component="span"
      variant="caption"
      className={`dashboard-delta ${trend === 'down' ? 'is-down' : 'is-up'}`}
    >
      {children}
    </Typography>
  );
}

export function DashboardSectionHeader({ title, action }) {
  return (
    <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1.5} mb={1.5}>
      <Typography variant="h6">{title}</Typography>
      {action ? (
        <Button size="small" variant="text" endIcon={<KeyboardArrowRightRounded />}>
          {action}
        </Button>
      ) : null}
    </Stack>
  );
}
