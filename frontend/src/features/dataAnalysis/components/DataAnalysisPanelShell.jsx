import InfoOutlined from '@mui/icons-material/InfoOutlined';
import { formatDataAnalysisChineseText } from '../lib/dataAnalysisFormatter.js';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';

export function DataAnalysisPanelShell({
  title,
  subtitle,
  action,
  sourceLabel,
  children,
  dense = false,
  className,
  ariaLabel,
  sx,
}) {
  const padding = dense ? { xs: 1.4, md: 1.65 } : { xs: 1.65, md: 2 };
  return (
    <Card
      component="section"
      aria-label={ariaLabel || title}
      className={className}
      sx={{
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        borderRadius: 2.75,
        border: 0,
        bgcolor: '#fff',
        boxShadow: '0 10px 30px rgba(31, 52, 88, 0.055)',
        '& .MuiTableCell-root': {
          px: { xs: 1, md: 1.25 },
          py: { xs: 0.95, md: 1.1 },
          fontSize: { xs: 13, md: 14 },
          lineHeight: 1.45,
        },
        '& .MuiTableHead-root .MuiTableCell-root': {
          bgcolor: '#f6f8fc',
          color: 'text.secondary',
          fontWeight: 850,
          fontSize: { xs: 13, md: 13.5 },
        },
        '& .MuiTableBody-root .MuiTypography-body2': {
          fontSize: { xs: 13.25, md: 14 },
        },
        '& .MuiTypography-caption': {
          fontSize: '0.78rem',
        },
        '& .MuiTypography-body2': {
          fontSize: { xs: 13.75, md: 14.5 },
        },
        ...sx,
      }}
    >
      <CardContent
        sx={{
          display: 'flex',
          flex: 1,
          width: '100%',
          minWidth: 0,
          maxWidth: '100%',
          minHeight: 0,
          overflow: 'hidden',
          p: padding,
          '&:last-child': { pb: padding },
        }}
      >
        <Stack spacing={dense ? 1.25 : 1.6} sx={{ flex: 1, width: '100%', minWidth: 0, maxWidth: '100%', minHeight: 0 }}>
          <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={1.25} sx={{ minWidth: 0 }}>
            <Box minWidth={0}>
              <Stack direction="row" spacing={0.65} alignItems="center">
                <Typography variant="h6" fontWeight={900} sx={{ fontSize: dense ? 16.5 : 19, lineHeight: 1.3 }}>
                  {formatDataAnalysisChineseText(title)}
                </Typography>
                {sourceLabel ? (
                  <Tooltip title={`数据来源：${formatDataAnalysisChineseText(sourceLabel)}`} arrow>
                    <InfoOutlined sx={{ fontSize: 16, color: 'text.disabled', cursor: 'help' }} />
                  </Tooltip>
                ) : null}
              </Stack>
              {subtitle ? (
                <Typography color="text.secondary" variant="body2" mt={0.28} sx={{ fontSize: dense ? 13.5 : 14.5, lineHeight: 1.55 }}>
                  {formatDataAnalysisChineseText(subtitle)}
                </Typography>
              ) : null}
            </Box>
            {action ? (
              <Stack direction="row" spacing={0.75} alignItems="center" flex="0 0 auto">
                {action}
              </Stack>
            ) : null}
          </Stack>
          {children}
        </Stack>
      </CardContent>
    </Card>
  );
}
