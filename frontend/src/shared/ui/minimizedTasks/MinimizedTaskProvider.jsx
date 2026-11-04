import React from 'react';

const MinimizedTaskContext = React.createContext(null);

function normalizeTask(task = {}) {
  const id = String(task.id || '').trim();
  if (!id) return null;
  return {
    id,
    kind: String(task.kind || 'order-dialog').trim() || 'order-dialog',
    title: String(task.title || '订单任务').trim() || '订单任务',
    subtitle: String(task.subtitle || '').trim(),
    closeDisabled: Boolean(task.closeDisabled),
    restore: typeof task.restore === 'function' ? task.restore : () => {},
    close: typeof task.close === 'function' ? task.close : () => {},
  };
}

export function MinimizedTaskProvider({ children }) {
  const [tasks, setTasks] = React.useState([]);

  const registerTask = React.useCallback((task) => {
    const normalized = normalizeTask(task);
    if (!normalized) return;
    setTasks((current) => {
      const index = current.findIndex((item) => item.id === normalized.id);
      if (index < 0) return [...current, normalized];
      const next = [...current];
      next[index] = normalized;
      return next;
    });
  }, []);

  const removeTask = React.useCallback((taskId) => {
    const normalizedId = String(taskId || '').trim();
    if (!normalizedId) return;
    setTasks((current) => current.filter((item) => item.id !== normalizedId));
  }, []);

  const restoreTask = React.useCallback((taskId) => {
    const normalizedId = String(taskId || '').trim();
    const task = tasks.find((item) => item.id === normalizedId);
    if (!task) return;
    removeTask(normalizedId);
    task.restore();
  }, [removeTask, tasks]);

  const closeTask = React.useCallback((taskId) => {
    const normalizedId = String(taskId || '').trim();
    const task = tasks.find((item) => item.id === normalizedId);
    if (!task || task.closeDisabled) return;
    removeTask(normalizedId);
    task.close();
  }, [removeTask, tasks]);

  const value = React.useMemo(() => ({
    tasks,
    registerTask,
    removeTask,
    restoreTask,
    closeTask,
  }), [closeTask, registerTask, removeTask, restoreTask, tasks]);

  return (
    <MinimizedTaskContext.Provider value={value}>
      {children}
    </MinimizedTaskContext.Provider>
  );
}

export function useMinimizedTasks() {
  return React.useContext(MinimizedTaskContext);
}

export function useMinimizedTaskRegistration({
  active = false,
  id = '',
  kind = 'order-dialog',
  title = '订单任务',
  subtitle = '',
  closeDisabled = false,
  restore = () => {},
  close = () => {},
} = {}) {
  const registry = useMinimizedTasks();
  const registerTask = registry?.registerTask;
  const removeTask = registry?.removeTask;

  React.useEffect(() => {
    if (!registerTask || !removeTask || !active || !id) return undefined;
    registerTask({ id, kind, title, subtitle, closeDisabled, restore, close });
    return () => removeTask(id);
  }, [active, close, closeDisabled, id, kind, registerTask, removeTask, restore, subtitle, title]);
}
