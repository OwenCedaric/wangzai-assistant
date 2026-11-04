import { translateCustomerError } from '../lib/customerConsultationLocale.js';
import { findCustomerFileReadback } from '../lib/customerSubmissionReadback.js';
import {
  confirmCustomerFileSend,
  previewCustomerFileSend,
  readCustomerChatHistory,
  stageCustomerMessageFile,
} from '../services/customerConsultationClient.js';
import React from 'react';

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const INITIAL_STATE = Object.freeze({
  open: false,
  status: 'idle',
  preview: null,
  result: null,
  error: '',
  conversation: null,
  file: null,
  shopId: '',
});

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('附件读取失败'));
    reader.onload = () =>
      resolve(
        String(reader.result || '')
          .split(',')
          .pop() || ''
      );
    reader.readAsDataURL(file);
  });
}

export function useCustomerFileSend({ activeShopId = '', onReadbackConfirmed } = {}) {
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

  const requestFileSend = React.useCallback(
    async ({ conversation, file } = {}) => {
      if (!conversation?.chatId || !file) return false;
      if (!activeShopId || !file.name || !file.size || file.size > MAX_FILE_BYTES) {
        setState({
          ...INITIAL_STATE,
          open: true,
          status: 'error',
          conversation,
          error: !activeShopId ? '请先选择 Ozon 店铺。' : '附件必须小于等于 5 MB，且不能为空。',
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
        file: { name: file.name, size: file.size, mimeType: file.type || '' },
        shopId: activeShopId,
      });
      try {
        const base64Content = await readFileAsBase64(file);
        const staged = await stageCustomerMessageFile(
          {
            shopId: activeShopId,
            chatId: conversation.chatId,
            name: file.name,
            mimeType: file.type || '',
            base64Content,
          },
          { signal: controller.signal }
        );
        if (staged?.ok === false || !staged?.file?.token) {
          throw Object.assign(new Error(staged?.error?.message || '附件暂存失败'), { code: staged?.error?.code });
        }
        const preview = await previewCustomerFileSend(
          { shopId: activeShopId, chatId: conversation.chatId, file: staged.file },
          { signal: controller.signal }
        );
        if (controller.signal.aborted || requestId !== requestIdRef.current) return false;
        if (preview?.ok === false) {
          throw Object.assign(new Error(preview?.error?.message || '附件发送预览创建失败'), {
            code: preview?.error?.code,
          });
        }
        setState((current) => ({ ...current, status: 'ready', preview, file: staged.file, error: '' }));
        return true;
      } catch (error) {
        if (controller.signal.aborted || error?.name === 'AbortError') return false;
        if (requestId !== requestIdRef.current) return false;
        setState((current) => ({
          ...current,
          status: 'error',
          error: translateCustomerError(error, '附件发送预览创建失败，请稍后重试。'),
        }));
        return false;
      }
    },
    [activeShopId]
  );

  const confirmFileSend = React.useCallback(async () => {
    if (!state.preview?.previewId || !state.conversation?.chatId || !state.file?.token) return false;
    if (!activeShopId || state.shopId !== activeShopId) {
      setState((current) => ({ ...current, status: 'error', error: '店铺或账号已切换，请重新选择附件。' }));
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
      const result = await confirmCustomerFileSend(
        {
          previewId: state.preview.previewId,
          shopId: activeShopId,
          chatId: targetConversation.chatId,
          file: state.file,
        },
        { signal: controller.signal }
      );
      if (controller.signal.aborted || requestId !== requestIdRef.current) return false;
      if (result?.ok === false) {
        throw Object.assign(new Error(result?.error?.message || 'Ozon 附件提交失败'), { code: result?.error?.code });
      }
      const readbackConfirmed = result?.readBack?.status === 'success';
      setState((current) => ({ ...current, status: readbackConfirmed ? 'success' : 'pending', result, error: '' }));
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
        error: translateCustomerError(error, 'Ozon 附件提交失败，请稍后重试。'),
      }));
      return false;
    }
  }, [activeShopId, onReadbackConfirmed, state]);

  const retryFileReadback = React.useCallback(async () => {
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
      const message = findCustomerFileReadback(targetConversation, payload, {
        messageId: state.result?.readBack?.messageId,
        fileName: state.file?.name,
        isImage: String(state.file?.mimeType || '')
          .toLowerCase()
          .startsWith('image/'),
      });
      if (!message) {
        setState((current) => ({
          ...current,
          status: 'pending',
          error: 'Ozon 暂时还没有返回该附件，可稍后继续回读；系统不会重复上传。',
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
        error: translateCustomerError(error, 'Ozon 附件回读失败，请稍后继续回读。'),
      }));
      return false;
    }
  }, [activeShopId, onReadbackConfirmed, state]);

  const closeFileSend = React.useCallback(() => {
    if (state.status === 'previewing' || state.status === 'confirming' || state.status === 'readingBack') return;
    controllerRef.current?.abort();
    requestIdRef.current += 1;
    setState(INITIAL_STATE);
  }, [state.status]);

  return { fileSendState: state, requestFileSend, confirmFileSend, retryFileReadback, closeFileSend };
}
