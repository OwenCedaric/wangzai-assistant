import { customerQuickReplyPresets } from '../constants/customerConsultationRules.js';
import {
  readCustomerConsultationPreferences,
  updateCustomerConsultationPreferences,
} from '../services/customerConsultationPreferences.js';
import React from 'react';

function normalizeText(value) {
  return String(value || '').trim();
}

export function useCustomerQuickReplies(scopeKey = '') {
  const [open, setOpen] = React.useState(false);
  const [searchText, setSearchText] = React.useState('');
  const [newPhraseText, setNewPhraseText] = React.useState('');
  const [phrases, setPhrases] = React.useState(() => [...customerQuickReplyPresets]);
  const preferencesLoadedRef = React.useRef(false);

  React.useEffect(() => {
    setPhrases([...customerQuickReplyPresets]);
    preferencesLoadedRef.current = false;
    if (!scopeKey) return undefined;
    const controller = new AbortController();
    void readCustomerConsultationPreferences(scopeKey, { signal: controller.signal })
      .then((preferences) => {
        if (controller.signal.aborted) return;
        setPhrases([...customerQuickReplyPresets, ...(preferences.customQuickReplies || [])]);
        preferencesLoadedRef.current = true;
      })
      .catch(() => {
        if (!controller.signal.aborted) preferencesLoadedRef.current = true;
      });
    return () => controller.abort();
  }, [scopeKey]);

  React.useEffect(() => {
    if (!scopeKey || !preferencesLoadedRef.current) return undefined;
    const customQuickReplies = phrases.filter((phrase) => phrase.custom);
    const timer = globalThis.setTimeout(() => {
      void updateCustomerConsultationPreferences(scopeKey, { customQuickReplies }).catch(() => undefined);
    }, 300);
    return () => globalThis.clearTimeout(timer);
  }, [phrases, scopeKey]);

  const visiblePhrases = React.useMemo(() => {
    const query = normalizeText(searchText).toLocaleLowerCase();
    if (!query) return phrases;
    return phrases.filter((phrase) =>
      [phrase.title, phrase.text].some((value) =>
        String(value || '')
          .toLocaleLowerCase()
          .includes(query)
      )
    );
  }, [phrases, searchText]);

  const addPhrase = React.useCallback(() => {
    const text = normalizeText(newPhraseText);
    if (!text) return false;
    setPhrases((current) => [
      ...current,
      {
        id: `custom-${Date.now()}`,
        title: text.length > 12 ? `${text.slice(0, 12)}…` : text,
        text,
        custom: true,
      },
    ]);
    setNewPhraseText('');
    return true;
  }, [newPhraseText]);

  const removePhrase = React.useCallback((phraseId) => {
    setPhrases((current) => current.filter((phrase) => phrase.id !== phraseId || !phrase.custom));
  }, []);

  return {
    open,
    searchText,
    newPhraseText,
    visiblePhrases,
    setOpen,
    setSearchText,
    setNewPhraseText,
    addPhrase,
    removePhrase,
  };
}
