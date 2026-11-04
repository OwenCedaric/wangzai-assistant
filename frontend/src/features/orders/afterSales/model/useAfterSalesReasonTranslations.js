import React from 'react';

import {
  applyAfterSalesReasonTranslations,
  buildAfterSalesReasonTranslationMessages,
  createAfterSalesReasonTranslationMap,
  requestAfterSalesReasonTranslations,
} from '../services/afterSalesReasonTranslationService.js';

export function useAfterSalesReasonTranslations(rows = []) {
  const [translations, setTranslations] = React.useState(() => new Map());
  const messages = React.useMemo(
    () => buildAfterSalesReasonTranslationMessages(rows),
    [rows],
  );
  const messagesRef = React.useRef(messages);
  messagesRef.current = messages;
  const requestKey = React.useMemo(
    () => messages.map((message) => `${message.shopId}\u0000${message.text}`).sort().join('\u0001'),
    [messages],
  );

  React.useEffect(() => {
    const pendingMessages = messagesRef.current;
    if (!pendingMessages.length) return undefined;
    const controller = new AbortController();
    requestAfterSalesReasonTranslations(pendingMessages, { signal: controller.signal })
      .then((payload) => {
        if (controller.signal.aborted) return;
        const next = createAfterSalesReasonTranslationMap(payload);
        setTranslations((current) => {
          const merged = new Map(current);
          next.forEach((value, key) => merged.set(key, value));
          return merged;
        });
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setTranslations((current) => {
          const merged = new Map(current);
          pendingMessages.forEach(({ text }) => {
            if (!merged.has(text)) merged.set(text, { translatedText: '', failed: true, provider: '' });
          });
          return merged;
        });
      });
    return () => controller.abort();
  }, [requestKey]);

  return React.useMemo(
    () => applyAfterSalesReasonTranslations(rows, translations),
    [rows, translations],
  );
}
