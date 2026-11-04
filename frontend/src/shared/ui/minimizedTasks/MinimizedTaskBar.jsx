import CloseRounded from '@mui/icons-material/CloseRounded';
import OpenInFullRounded from '@mui/icons-material/OpenInFullRounded';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import React from 'react';
import { useMinimizedTasks } from './MinimizedTaskProvider.jsx';

export function MinimizedTaskBar() {
  const registry = useMinimizedTasks();
  const tasks = registry?.tasks || [];
  if (!tasks.length) return null;

  return (
    <Box className="minimized-task-bar" role="region" aria-label="已最小化的订单任务">
      <Box className="minimized-task-bar-label">
        <Typography variant="caption">已最小化</Typography>
        <Typography variant="caption" className="minimized-task-count">{tasks.length}</Typography>
      </Box>
      <Box className="minimized-task-list">
        {tasks.map((task) => (
          <Box className="minimized-task-item" key={task.id} data-task-kind={task.kind}>
            <Box
              component="button"
              type="button"
              className="minimized-task-restore"
              onClick={() => registry.restoreTask(task.id)}
              aria-label={`恢复${task.title}`}
              title={task.subtitle ? `${task.title} · ${task.subtitle}` : task.title}
            >
              <OpenInFullRounded fontSize="small" />
              <Box minWidth={0} textAlign="left">
                <Typography variant="body2" noWrap>{task.title}</Typography>
                {task.subtitle ? <Typography variant="caption" noWrap>{task.subtitle}</Typography> : null}
              </Box>
            </Box>
            <Tooltip title={task.closeDisabled ? '当前操作进行中，暂时不能关闭' : '关闭任务'}>
              <span>
                <IconButton
                  size="small"
                  aria-label={`关闭${task.title}`}
                  disabled={task.closeDisabled}
                  onClick={() => registry.closeTask(task.id)}
                >
                  <CloseRounded fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
