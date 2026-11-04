import CloseRounded from '@mui/icons-material/CloseRounded';
import MinimizeRounded from '@mui/icons-material/MinimizeRounded';
import Box from '@mui/material/Box';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import React from 'react';
import { useMinimizableDialogTask } from './useMinimizableDialogTask.js';

function readPlainText(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node).trim();
  if (!React.isValidElement(node)) {
    return React.Children.toArray(node).map(readPlainText).filter(Boolean).join(' ').trim();
  }
  return readPlainText(node.props?.children);
}

function isDialogTitleElement(node) {
  return React.isValidElement(node) && (
    node.type === DialogTitle ||
    (Boolean(DialogTitle.muiName) && node.type?.muiName === DialogTitle.muiName) ||
    node.type?.displayName === 'DialogTitle'
  );
}

function findDialogTitle(children) {
  let title = '';
  React.Children.forEach(children, (child) => {
    if (title || !React.isValidElement(child)) return;
    if (isDialogTitleElement(child)) {
      title = readPlainText(child.props.children);
      return;
    }
    if (child.type === React.Fragment) title = findDialogTitle(child.props.children);
  });
  return title;
}

function DialogActionBar({ title, minimizeDisabled = false, closeDisabled = false, onMinimize, onClose }) {
  return (
    <Box className="global-dialog-action-bar">
      <Tooltip title={`最小化${title}`}>
        <span className="global-dialog-action-wrap">
          <IconButton
            size="small"
            className="global-dialog-control global-dialog-minimize-control"
            aria-label={`最小化${title}`}
            disabled={minimizeDisabled}
            onClick={onMinimize}
          >
            <MinimizeRounded fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
      <Tooltip title={`关闭${title}`}>
        <span className="global-dialog-action-wrap">
          <IconButton
            size="small"
            className="global-dialog-control global-dialog-close-control"
            aria-label={`关闭${title}`}
            disabled={closeDisabled}
            onClick={onClose}
          >
            <CloseRounded fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
    </Box>
  );
}

function decorateDialogTitle(children, { title, minimizeDisabled, closeDisabled, onMinimize, onClose }) {
  let decorated = false;
  const decorate = (nodes) => React.Children.map(nodes, (child) => {
    if (!React.isValidElement(child)) return child;
    if (!decorated && isDialogTitleElement(child)) {
      decorated = true;
      const className = [child.props.className, 'global-minimizable-dialog-title'].filter(Boolean).join(' ');
      return (
        <React.Fragment key={child.key || 'global-minimizable-dialog-title'}>
          {React.cloneElement(child, { className })}
          <DialogActionBar
            title={title}
            minimizeDisabled={minimizeDisabled}
            closeDisabled={closeDisabled}
            onMinimize={onMinimize}
            onClose={onClose}
          />
        </React.Fragment>
      );
    }
    if (!decorated && child.type === React.Fragment) {
      return React.cloneElement(child, undefined, decorate(child.props.children));
    }
    return child;
  });

  return { children: decorate(children), decorated };
}

export const GlobalMinimizableDialog = React.forwardRef(function GlobalMinimizableDialog({
  open = false,
  onClose,
  children,
  className = '',
  keepMounted = false,
  minimizeTaskTitle = '',
  minimizeTaskSubtitle = '',
  minimizeTaskKind = 'dialog',
  disableMinimize = false,
  ...dialogProps
}, ref) {
  const inferredTitle = findDialogTitle(children);
  const taskTitle = String(minimizeTaskTitle || inferredTitle || '弹窗任务').trim();
  const closeFromTaskBar = React.useCallback(() => {
    if (typeof onClose === 'function') return onClose(undefined, 'taskClose');
    return undefined;
  }, [onClose]);
  const closeFromButton = React.useCallback(() => {
    if (typeof onClose === 'function') return onClose(undefined, 'closeButton');
    return undefined;
  }, [onClose]);
  const dialogTask = useMinimizableDialogTask({
    open,
    kind: minimizeTaskKind,
    title: taskTitle,
    subtitle: minimizeTaskSubtitle,
    closeDisabled: typeof onClose !== 'function',
    onClose: closeFromTaskBar,
  });
  const decoratedTitle = decorateDialogTitle(children, {
    title: taskTitle,
    onMinimize: dialogTask.minimize,
    minimizeDisabled: disableMinimize,
    closeDisabled: typeof onClose !== 'function',
    onClose: closeFromButton,
  });
  const mergedClassName = ['global-minimizable-dialog', className].filter(Boolean).join(' ');

  return (
    <Dialog
      {...dialogProps}
      ref={ref}
      open={dialogTask.visibleOpen}
      onClose={onClose}
      keepMounted={Boolean(keepMounted || open || dialogTask.minimized)}
      className={mergedClassName}
      data-dialog-minimizable="true"
      data-dialog-minimized={dialogTask.minimized ? 'true' : 'false'}
    >
      {decoratedTitle.children}
      {!decoratedTitle.decorated ? (
        <DialogActionBar
          title={taskTitle}
          minimizeDisabled={disableMinimize}
          closeDisabled={typeof onClose !== 'function'}
          onMinimize={dialogTask.minimize}
          onClose={closeFromButton}
        />
      ) : null}
    </Dialog>
  );
});

export default GlobalMinimizableDialog;
