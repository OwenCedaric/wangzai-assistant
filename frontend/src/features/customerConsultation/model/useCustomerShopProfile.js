import { readCustomerShopProfile } from '../services/customerConsultationClient.js';
import { normalizeCustomerShopProfile } from '../lib/customerShopProfile.js';
import { translateCustomerError } from '../lib/customerConsultationLocale.js';
import React from 'react';

const EMPTY_PROFILE = Object.freeze({
  shopId: '',
  logoUrl: '',
  logoField: '',
  sellerName: '',
  source: '',
});

export function useCustomerShopProfile(shopId = '', { enabled = true, accountId = '' } = {}) {
  const [state, setState] = React.useState({
    status: 'idle',
    profile: EMPTY_PROFILE,
    error: '',
  });
  const requestIdRef = React.useRef(0);

  React.useEffect(() => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const controller = new AbortController();
    const activeShopId = String(shopId || '').trim();

    if (!enabled || !activeShopId) {
      setState({ status: 'idle', profile: EMPTY_PROFILE, error: '' });
      return () => controller.abort();
    }

    setState({ status: 'loading', profile: { ...EMPTY_PROFILE, shopId: activeShopId }, error: '' });
    readCustomerShopProfile(
      { shopId: activeShopId, accountId: accountId || activeShopId },
      { signal: controller.signal }
    )
      .then((payload) => {
        if (controller.signal.aborted || requestId !== requestIdRef.current) return;
        if (payload?.ok === false) {
          throw Object.assign(new Error(payload?.error?.message || '店铺资料读取失败'), {
            code: payload?.error?.code,
          });
        }
        setState({
          status: 'success',
          profile: normalizeCustomerShopProfile(payload, { shopId: activeShopId }),
          error: '',
        });
      })
      .catch((error) => {
        if (controller.signal.aborted || error?.name === 'AbortError') return;
        if (requestId !== requestIdRef.current) return;
        setState({
          status: 'error',
          profile: { ...EMPTY_PROFILE, shopId: activeShopId },
          error: translateCustomerError(error, '店铺 Logo 读取失败。'),
        });
      });

    return () => controller.abort();
  }, [accountId, enabled, shopId]);

  return state;
}
