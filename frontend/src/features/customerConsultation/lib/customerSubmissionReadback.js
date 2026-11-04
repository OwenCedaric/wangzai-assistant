import { mergeCustomerChatHistory } from './customerOzonChatFormatter.js';

function normalizeText(value) {
  return String(value ?? '').trim();
}

function getMergedMessages(conversation = {}, payload = {}) {
  return mergeCustomerChatHistory(conversation, payload).messages || [];
}

export function findCustomerMessageReadback(conversation = {}, payload = {}, { messageId = '' } = {}) {
  const targetId = normalizeText(messageId);
  return (
    getMergedMessages(conversation, payload).find((message) => {
      if (message.senderType !== 'seller') return false;
      if (targetId) return normalizeText(message.messageId || message.id) === targetId;
      return false;
    }) || null
  );
}

export function findCustomerFileReadback(conversation = {}, payload = {}, { messageId = '' } = {}) {
  const targetId = normalizeText(messageId);
  return (
    getMergedMessages(conversation, payload).find((message) => {
      if (message.senderType !== 'seller') return false;
      if (targetId) return normalizeText(message.messageId || message.id) === targetId;
      return false;
    }) || null
  );
}
