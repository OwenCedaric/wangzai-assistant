import { translateCustomerError } from '../lib/customerConsultationLocale.js';
import {
  confirmCustomerConversationStart,
  previewCustomerConversationStart,
  readCustomerChatHistory,
  readCustomerOrderContext,
} from '../services/customerConsultationClient.js';
import React from 'react';

const INITIAL_STATE = Object.freeze({
  open: false,
  status: 'idle',
  postingNumber: '',
  preview: null,
  result: null,
  error: '',
  shopId: '',
  verifiedOrder: null,
  orders: [],
  ordersStatus: 'idle',
});

function normalizeText(value) {
  return String(value ?? '').trim();
}

export function getCustomerOrderPostingNumber(order = {}) {
  const raw = order?.raw && typeof order.raw === 'object' && !Array.isArray(order.raw) ? order.raw : {};
  return normalizeText(
    order.postingNumber || order.posting_number || order.id || raw.posting_number || raw.postingNumber
  );
}

function findExactOrder(rows = [], postingNumber = '') {
  const target = normalizeText(postingNumber);
  return (Array.isArray(rows) ? rows : []).find((order) => getCustomerOrderPostingNumber(order) === target) || null;
}

export function useCustomerConversationStart({ activeShopId = '', onReadbackConfirmed } = {}) {
  const [state, setState] = React.useState(INITIAL_STATE);
  const controllerRef = React.useRef(null);
  const ordersControllerRef = React.useRef(null);

  React.useEffect(() => {
    controllerRef.current?.abort();
    ordersControllerRef.current?.abort();
    setState(INITIAL_STATE);
    return () => {
      controllerRef.current?.abort();
      ordersControllerRef.current?.abort();
    };
  }, [activeShopId]);

  React.useEffect(() => {
    if (!state.open || !activeShopId) return undefined;
    const controller = new AbortController();
    ordersControllerRef.current?.abort();
    ordersControllerRef.current = controller;
    setState((current) => ({ ...current, ordersStatus: 'loading' }));
    Promise.resolve(readCustomerOrderContext({ shopId: activeShopId }, { signal: controller.signal }))
      .then((payload) => {
        if (controller.signal.aborted) return;
        const byPostingNumber = new Map();
        for (const order of Array.isArray(payload?.rows) ? payload.rows : []) {
          const postingNumber = getCustomerOrderPostingNumber(order);
          if (postingNumber && !byPostingNumber.has(postingNumber)) byPostingNumber.set(postingNumber, order);
        }
        setState((current) => ({
          ...current,
          orders: [...byPostingNumber.values()],
          ordersStatus: 'success',
          postingNumber:
            current.postingNumber || getCustomerOrderPostingNumber(byPostingNumber.values().next().value || {}),
        }));
      })
      .catch((error) => {
        if (controller.signal.aborted || error?.name === 'AbortError') return;
        setState((current) => ({
          ...current,
          ordersStatus: 'error',
          error: translateCustomerError(error, '真实订单列表读取失败，请稍后重试。'),
        }));
      });
    return () => controller.abort();
  }, [activeShopId, state.open]);

  const openStart = React.useCallback(
    (defaultPostingNumber = '') => {
      setState({
        ...INITIAL_STATE,
        open: true,
        shopId: activeShopId,
        postingNumber: typeof defaultPostingNumber === 'string' ? defaultPostingNumber.trim() : '',
      });
    },
    [activeShopId]
  );
  const setPostingNumber = React.useCallback((postingNumber) => {
    setState((current) => ({ ...current, postingNumber, preview: null, result: null, status: 'idle', error: '' }));
  }, []);
  const requestStart = React.useCallback(async () => {
    const postingNumber = String(state.postingNumber || '').trim();
    if (!activeShopId || !postingNumber) {
      setState((current) => ({
        ...current,
        status: 'error',
        error: !activeShopId ? '请先选择 Ozon 店铺。' : '请输入发货单号。',
      }));
      return false;
    }
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setState((current) => ({ ...current, status: 'previewing', error: '', shopId: activeShopId }));
    try {
      const orderContext = await readCustomerOrderContext(
        { shopId: activeShopId, postingNumber },
        { signal: controller.signal }
      );
      const verifiedOrder = findExactOrder(orderContext?.rows, postingNumber);
      if (!verifiedOrder) {
        setState((current) => ({
          ...current,
          status: 'error',
          preview: null,
          verifiedOrder: null,
          error: '当前店铺没有找到这个发货单，请从已读取的真实订单中复制完整发货单号。',
        }));
        return false;
      }
      const preview = await previewCustomerConversationStart(
        { shopId: activeShopId, postingNumber },
        { signal: controller.signal }
      );
      if (preview?.ok === false)
        throw Object.assign(new Error(preview?.error?.message || '新建会话预览失败'), { code: preview?.error?.code });
      setState((current) => ({ ...current, status: 'ready', preview, verifiedOrder, error: '' }));
      return true;
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError') return false;
      setState((current) => ({
        ...current,
        status: 'error',
        error: translateCustomerError(error, '新建会话预览失败。'),
      }));
      return false;
    }
  }, [activeShopId, state.postingNumber]);
  const confirmStart = React.useCallback(async () => {
    if (!state.preview?.previewId || state.shopId !== activeShopId) return false;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setState((current) => ({ ...current, status: 'confirming', error: '' }));
    try {
      const result = await confirmCustomerConversationStart(
        { previewId: state.preview.previewId, shopId: activeShopId, postingNumber: state.postingNumber },
        { signal: controller.signal }
      );
      if (result?.ok === false)
        throw Object.assign(new Error(result?.error?.message || '新建会话失败'), { code: result?.error?.code });
      const confirmed = result?.readBack?.status === 'success';
      setState((current) => ({ ...current, status: confirmed ? 'success' : 'pending', result, error: '' }));
      if (confirmed && typeof onReadbackConfirmed === 'function') await onReadbackConfirmed(result);
      return confirmed;
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError') return false;
      setState((current) => ({
        ...current,
        status: 'error',
        error: translateCustomerError(error, 'Ozon 新建会话失败。'),
      }));
      return false;
    }
  }, [activeShopId, onReadbackConfirmed, state]);
  const retryStartReadback = React.useCallback(async () => {
    const chatId = String(state.result?.readBack?.chatId || '').trim();
    if (state.status !== 'pending' || !chatId || state.shopId !== activeShopId) {
      if (state.status === 'pending' && !chatId) {
        setState((current) => ({
          ...current,
          error: 'Ozon 尚未返回新会话编号，当前只能等待后台同步；系统不会重复新建。',
        }));
      }
      return false;
    }
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setState((current) => ({ ...current, status: 'readingBack', error: '' }));
    try {
      const payload = await readCustomerChatHistory(
        { shopId: activeShopId, accountId: activeShopId, chatId, limit: 1, forceRefresh: true },
        { signal: controller.signal }
      );
      if (payload?.ok === false)
        throw Object.assign(new Error(payload?.error?.message || 'Ozon 回读失败'), payload.error);
      const confirmed = payload?.ok === true && payload?.data != null;
      if (!confirmed) {
        setState((current) => ({
          ...current,
          status: 'pending',
          error: 'Ozon 暂时还没有返回新会话，可稍后继续回读；系统不会重复新建。',
        }));
        return false;
      }
      const result = {
        ...(state.result || {}),
        writeStatus: 'readback_confirmed',
        readBack: { ...(state.result?.readBack || {}), status: 'success', chatId },
      };
      setState((current) => ({ ...current, status: 'success', result, error: '' }));
      if (typeof onReadbackConfirmed === 'function') await onReadbackConfirmed(result);
      return true;
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError') return false;
      setState((current) => ({
        ...current,
        status: 'pending',
        error: translateCustomerError(error, 'Ozon 新会话回读失败，请稍后继续回读。'),
      }));
      return false;
    }
  }, [activeShopId, onReadbackConfirmed, state]);
  const closeStart = React.useCallback(() => {
    if (state.status === 'previewing' || state.status === 'confirming' || state.status === 'readingBack') return;
    controllerRef.current?.abort();
    ordersControllerRef.current?.abort();
    setState(INITIAL_STATE);
  }, [state.status]);
  return {
    startState: state,
    openStart,
    setPostingNumber,
    requestStart,
    confirmStart,
    retryStartReadback,
    closeStart,
  };
}
