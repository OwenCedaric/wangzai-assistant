import React from 'react';
import { hydrateProfitLocalInputs } from '../../../entities/order/orderSourceLinks.jsx';
import { safeWarn } from '../../../services/safeLog.js';

const emptyInputs = () => ({ purchaseLocalOverrides: {}, productSourceLinks: {} });
const objectOrEmpty = value => value && typeof value === 'object' ? value : {};

export function useProfitLocalInputs({
  isActive, readableShops, sourceKey, refreshTick = 0, hydrate = hydrateProfitLocalInputs,
}) {
  const [inputs, setInputs] = React.useState(emptyInputs);
  const [error, setError] = React.useState('');
  const [retryRevision, setRetryRevision] = React.useState(0);
  const appliedRef = React.useRef('');
  const requestedKey = JSON.stringify([sourceKey, refreshTick, retryRevision]);
  const retry = React.useCallback(() => setRetryRevision(current => current + 1), []);

  React.useEffect(() => {
    if (!isActive || appliedRef.current === requestedKey) return undefined;
    let alive = true;
    setError('');
    hydrate(readableShops).then(value => {
      if (!alive) return;
      setInputs({
        purchaseLocalOverrides: objectOrEmpty(value?.purchaseLocalOverrides),
        productSourceLinks: objectOrEmpty(value?.productSourceLinks),
      });
      // A cancelled or failed read must remain pending when the tab is activated.
      appliedRef.current = requestedKey;
    }).catch(reason => {
      if (!alive) return;
      setError('成本和跨境费用读取失败，当前金额可能不是最新值，请重试。');
      safeWarn('profit local inputs hydrate failed', reason);
    });
    return () => { alive = false; };
  }, [hydrate, isActive, readableShops, requestedKey]);

  return { inputs, setInputs, error, retry };
}
