import {
  getContinuousSyncStatus,
  getMaintenanceStatus,
  getSchedulerStatus,
} from '../../../api/localApiClient.js';
import React from 'react';

const EMPTY_MAINTENANCE_STATUS = Object.freeze({
  loaded: false,
  loading: false,
  error: '',
  data: null,
});

export function useStatusObservationRemoteState({ enabled = true } = {}) {
  const [continuousSyncStatus, setContinuousSyncStatus] = React.useState(null);
  const [schedulerStatus, setSchedulerStatus] = React.useState(null);
  const [maintenanceStatus, setMaintenanceStatus] = React.useState(EMPTY_MAINTENANCE_STATUS);

  React.useEffect(() => {
    if (!enabled) return undefined;
    let disposed = false;
    let controller = null;
    const refresh = async () => {
      controller?.abort();
      const requestController = new AbortController();
      controller = requestController;
      const [continuousResult, schedulerResult] = await Promise.allSettled([
        getContinuousSyncStatus({ timeoutMs: 3000, signal: requestController.signal, observe: false }),
        getSchedulerStatus({ timeoutMs: 3000, signal: requestController.signal, observe: false }),
      ]);
      if (disposed || requestController.signal.aborted) return;
      if (continuousResult.status === 'fulfilled') setContinuousSyncStatus(continuousResult.value);
      if (schedulerResult.status === 'fulfilled') setSchedulerStatus(schedulerResult.value);
    };
    refresh();
    const timer = globalThis.setInterval(refresh, 5000);
    return () => {
      disposed = true;
      controller?.abort();
      globalThis.clearInterval(timer);
    };
  }, [enabled]);

  React.useEffect(() => {
    if (!enabled) return undefined;
    const controller = new AbortController();
    let disposed = false;
    setMaintenanceStatus((current) => ({ ...current, loading: true, error: '' }));
    getMaintenanceStatus({ timeoutMs: 15000, signal: controller.signal, observe: false })
      .then((data) => {
        if (!disposed) setMaintenanceStatus({ loaded: true, loading: false, error: '', data });
      })
      .catch((error) => {
        if (disposed || error?.name === 'AbortError') return;
        setMaintenanceStatus({
          loaded: false,
          loading: false,
          error: error instanceof Error ? error.message : String(error || '维护状态读取失败'),
          data: null,
        });
      });
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [enabled]);

  return { continuousSyncStatus, schedulerStatus, maintenanceStatus };
}
