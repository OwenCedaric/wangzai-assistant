import { translateCustomerError } from '../lib/customerConsultationLocale.js';
import { findCustomerMessageReadback } from '../lib/customerSubmissionReadback.js';
import {
  confirmCustomerMessageSend,
  previewCustomerMessageSend,
  readCustomerChatHistory,
} from '../services/customerConsultationClient.js';
import React from 'react';

const INITIAL_STATE = Object.freeze({
  open: false,
  status: 'idle',
  preview: null,
  result: null,
  error: '',
  conversation: null,
  text: '',
  shopId: '',
});

export function useCustomerMessageSend({ activeShopId = '', onReadbackConfirmed } = {}) {
  const [state, setState] = React.useState(INITIAL_STATE);
  const controllerRef = React.useRef(null);
  const requestIdRef = React.useRef(0);

  React.useEffect(() => {
    requestIdRef.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
    setState(INITIAL_STATE);
    return () => controllerRef.current?.abort();
  }, [activeShopId]);

  const requestSend = React.useCallback(
    async ({ conversation, text } = {}) => {
      const messageText = String(text || '').trim();
      if (!conversation?.chatId || !messageText) return false;
      if (!activeShopId) {
        setState({
          ...INITIAL_STATE,
          open: true,
          status: 'error',
          conversation,
          text: messageText,
          error: '请先选择 Ozon 店铺。',
        });
        return false;
      }

      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      setState({
        ...INITIAL_STATE,
        open: true,
        status: 'previewing',
        conversation,
        text: messageText,
        shopId: activeShopId,
      });

      try {
        const preview = await previewCustomerMessageSend(
          {
            shopId: activeShopId,
            chatId: conversation.chatId,
            text: messageText,
          },
          { signal: controller.signal }
        );
        if (controller.signal.aborted || requestId !== requestIdRef.current) return false;
        if (preview?.ok === false) {
          throw Object.assign(new Error(preview?.error?.message || '发送预览创建失败'), {
            code: preview?.error?.code,
          });
        }
        setState((current) => ({ ...current, status: 'ready', preview, error: '' }));
        return true;
      } catch (error) {
        if (controller.signal.aborted || error?.name === 'AbortError') return false;
        if (requestId !== requestIdRef.current) return false;
        setState((current) => ({
          ...current,
          status: 'error',
          error: translateCustomerError(error, '发送预览创建失败，请稍后重试。'),
        }));
        return false;
      }
    },
    [activeShopId]
  );

  const confirmSend = React.useCallback(async () => {
    if (!state.preview?.previewId || !state.conversation?.chatId || !state.text) return false;
    if (!activeShopId || state.shopId !== activeShopId) {
      setState((current) => ({
        ...current,
        status: 'error',
        error: '店铺或账号已切换，请重新创建发送预览。',
      }));
      return false;
    }

    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const targetConversation = state.conversation;
    setState((current) => ({ ...current, status: 'confirming', error: '' }));

    try {
      const result = await confirmCustomerMessageSend(
        {
          previewId: state.preview.previewId,
          shopId: activeShopId,
          chatId: targetConversation.chatId,
          text: state.text,
        },
        { signal: controller.signal }
      );
      if (controller.signal.aborted || requestId !== requestIdRef.current) return false;
      if (result?.ok === false) {
        throw Object.assign(new Error(result?.error?.message || 'Ozon 回复提交失败'), {
          code: result?.error?.code,
        });
      }
      const readbackConfirmed = result?.readBack?.status === 'success';
      setState((current) => ({
        ...current,
        status: readbackConfirmed ? 'success' : 'pending',
        result,
        error: '',
      }));
      if (readbackConfirmed && typeof onReadbackConfirmed === 'function') {
        await onReadbackConfirmed(targetConversation.id);
      }
      return readbackConfirmed;
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError') return false;
      if (requestId !== requestIdRef.current) return false;
      setState((current) => ({
        ...current,
        status: 'error',
        error: translateCustomerError(error, 'Ozon 回复提交失败，请稍后重试。'),
      }));
      return false;
    }
  }, [activeShopId, onReadbackConfirmed, state]);

  const retrySendReadback = React.useCallback(async () => {
    if (state.status !== 'pending' || !state.conversation?.chatId || state.shopId !== activeShopId) return false;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const targetConversation = state.conversation;
    setState((current) => ({ ...current, status: 'readingBack', error: '' }));
    try {
      const payload = await readCustomerChatHistory(
        {
          shopId: activeShopId,
          accountId: activeShopId,
          chatId: targetConversation.chatId,
          limit: 50,
          forceRefresh: true,
        },
        { signal: controller.signal }
      );
      if (controller.signal.aborted || requestId !== requestIdRef.current) return false;
      if (payload?.ok === false)
        throw Object.assign(new Error(payload?.error?.message || 'Ozon 回读失败'), payload.error);
      const message = findCustomerMessageReadback(targetConversation, payload, {
        messageId: state.result?.readBack?.messageId,
        text: state.text,
      });
      if (!message) {
        setState((current) => ({
          ...current,
          status: 'pending',
          error: 'Ozon 暂时还没有返回这条消息，可稍后继续回读；系统不会重复发送。',
        }));
        return false;
      }
      setState((current) => ({
        ...current,
        status: 'success',
        result: {
          ...(current.result || {}),
          writeStatus: 'readback_confirmed',
          readBack: {
            ...(current.result?.readBack || {}),
            status: 'success',
            messageId: message.messageId || message.id,
          },
        },
        error: '',
      }));
      if (typeof onReadbackConfirmed === 'function') await onReadbackConfirmed(targetConversation.id);
      return true;
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError' || requestId !== requestIdRef.current) return false;
      setState((current) => ({
        ...current,
        status: 'pending',
        error: translateCustomerError(error, 'Ozon 消息回读失败，请稍后继续回读。'),
      }));
      return false;
    }
  }, [activeShopId, onReadbackConfirmed, state]);

  const closeSend = React.useCallback(() => {
    if (state.status === 'previewing' || state.status === 'confirming' || state.status === 'readingBack') return;
    controllerRef.current?.abort();
    controllerRef.current = null;
    requestIdRef.current += 1;
    setState(INITIAL_STATE);
  }, [state.status]);

  return {
    sendState: state,
    requestSend,
    confirmSend,
    retrySendReadback,
    closeSend,
  };
}
