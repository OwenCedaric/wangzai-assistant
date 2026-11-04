import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import React from 'react';

export function SmartReplySceneCard({ description, onSelect, selected, title }) {
  return (
    <Card
      variant="outlined"
      sx={{
        height: '100%',
        borderRadius: '6px !important',
        borderColor: selected ? 'primary.main' : 'divider',
        bgcolor: selected ? 'action.selected' : 'background.paper',
        minWidth: 0,
        scrollSnapAlign: 'start',
      }}
    >
      <Button
        fullWidth
        onClick={onSelect}
        aria-pressed={selected}
        sx={{
          p: 2,
          height: '100%',
          borderRadius: '5px !important',
          textAlign: 'left',
          justifyContent: 'flex-start',
        }}
      >
        <Stack spacing={0.75} alignItems="flex-start" sx={{ minWidth: 0 }}>
          <Typography variant="h6" component="h2" color="text.primary">
            {title}
          </Typography>
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{
              display: '-webkit-box',
              overflow: 'hidden',
              WebkitBoxOrient: 'vertical',
              WebkitLineClamp: 2,
            }}
          >
            {description}
          </Typography>
        </Stack>
      </Button>
    </Card>
  );
}
