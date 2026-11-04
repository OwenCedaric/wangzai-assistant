import { readCustomerOrderContext } from '../services/customerConsultationClient.js';
import { translateCustomerError } from '../lib/customerConsultationLocale.js';
import React from 'react';

function normalizeText(value) {
  return String(value ?? '').trim();
}

function getRawOrder(row = {}) {
  return row?.raw && typeof row.raw === 'object' && !Array.isArray(row.raw) ? row.raw : {};
}

function getOrderMatchRank(row = {}, postingNumber = '') {
  const target = normalizeText(postingNumber);
  const raw = getRawOrder(row);
  const posting = normalizeText(row?.postingNumber || row?.posting_number || row?.id);
  const base = normalizeText(row?.orderNumber || row?.order_number || raw.order_number || raw.orderNumber);
  if (posting === target) return 4;
  if (base === target) return 3;
  if (posting.startsWith(`${target}-`) && /^\d+$/u.test(posting.slice(target.length + 1))) return 2;
  if (base && target.startsWith(`${base}-`) && /^\d+$/u.test(target.slice(base.length + 1))) return 1;
  return 0;
}

export function findCustomerOrders(rows = [], postingNumber = '') {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({ row, rank: getOrderMatchRank(row, postingNumber) }))
    .filter((item) => item.rank > 0)
    .sort((left, right) => right.rank - left.rank)
    .map((item) => item.row);
}

export function useCustomerOrderContext({ shopId = '', conversation = null, enabled: pageActive = true } = {}) {
  const postingNumber = normalizeText(conversation?.orderNumber);
  const enabled = Boolean(
    pageActive &&
    shopId &&
    conversation?.channel === 'chat' &&
    postingNumber &&
    postingNumber !== '—' &&
    postingNumber !== '未关联订单'
  );
  const [state, setState] = React.useState({
    status: 'idle',
    order: null,
    orders: [],
    purchaseRows: [],
    purchaseLinks: [],
    logisticsRows: [],
    error: '',
  });

  React.useEffect(() => {
    if (!enabled) {
      setState({
        status: 'idle',
        order: null,
        orders: [],
        purchaseRows: [],
        purchaseLinks: [],
        logisticsRows: [],
        error: '',
      });
      return undefined;
    }

    const controller = new AbortController();
    setState((current) => ({ ...current, status: 'loading', error: '' }));
    readCustomerOrderContext({ shopId, postingNumber }, { signal: controller.signal })
      .then((payload) => {
        if (controller.signal.aborted) return;
        const orders = findCustomerOrders(payload?.rows, postingNumber);
        const order = orders[0] || null;
        setState({
          status: order ? 'success' : 'empty',
          order,
          orders,
          purchaseRows: Array.isArray(payload?.purchaseRows) ? payload.purchaseRows : [],
          purchaseLinks: Array.isArray(payload?.purchaseLinks) ? payload.purchaseLinks : [],
          logisticsRows: Array.isArray(payload?.logisticsRows) ? payload.logisticsRows : [],
          error: '',
        });
      })
      .catch((error) => {
        if (controller.signal.aborted || error?.name === 'AbortError') return;
        setState({
          status: 'error',
          order: null,
          orders: [],
          purchaseRows: [],
          purchaseLinks: [],
          logisticsRows: [],
          error: translateCustomerError(error, '关联订单读取失败，请稍后重试。'),
        });
      });

    return () => controller.abort();
  }, [enabled, postingNumber, shopId]);

  return state;
}
