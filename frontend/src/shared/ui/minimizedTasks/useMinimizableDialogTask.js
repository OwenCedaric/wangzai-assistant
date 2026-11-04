import React from 'react';
import { useMinimizedTaskRegistration } from './MinimizedTaskProvider.jsx';

let dialogTaskSequence = 0;

export function useMinimizableDialogTask({
  open = false,
  kind = 'order-dialog',
  title = '订单弹窗',
  subtitle = '',
  closeDisabled = false,
  onClose = () => {},
} = {}) {
  const taskIdRef = React.useRef('');
  if (!taskIdRef.current) taskIdRef.current = `order_dialog_${++dialogTaskSequence}`;
  const [minimized, setMinimized] = React.useState(false);
  const onCloseRef = React.useRef(onClose);
  onCloseRef.current = onClose;

  React.useEffect(() => {
    if (!open) setMinimized(false);
  }, [open]);

  const minimize = React.useCallback(() => {
    if (open) setMinimized(true);
  }, [open]);

  const restore = React.useCallback(() => {
    if (open) setMinimized(false);
  }, [open]);

  const close = React.useCallback(() => {
    setMinimized(false);
    return onCloseRef.current();
  }, []);

  useMinimizedTaskRegistration({
    active: Boolean(open && minimized),
    id: taskIdRef.current,
    kind,
    title,
    subtitle,
    closeDisabled,
    restore,
    close,
  });

  return React.useMemo(() => ({
    minimized,
    visibleOpen: Boolean(open && !minimized),
    minimize,
    restore,
    close,
  }), [close, minimize, minimized, open, restore]);
}
