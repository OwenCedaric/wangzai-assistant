import { customerConsultationPagination } from '../constants/customerConsultationRules.js';
import {
  readCustomerConsultationPreferences,
  updateCustomerConsultationPreferences,
} from '../services/customerConsultationPreferences.js';
import React from 'react';

export function useCustomerConsultationDraft(defaultConversationId, scopeKey = '') {
  const [selectedFilterId, setSelectedFilterId] = React.useState('all');
  const [selectedStatusId, setSelectedStatusId] = React.useState('all');
  const [unreadOnly, setUnreadOnly] = React.useState(false);
  const [selectedConversationId, setSelectedConversationId] = React.useState(defaultConversationId || '');
  const [searchText, setSearchText] = React.useState('');
  const [debouncedSearchText, setDebouncedSearchText] = React.useState('');
  const [draftsByConversation, setDraftsByConversation] = React.useState({});
  const preferencesLoadedRef = React.useRef(false);

  React.useEffect(() => {
    const timer = globalThis.setTimeout(
      () => setDebouncedSearchText(searchText),
      customerConsultationPagination.searchDebounceMs
    );
    return () => globalThis.clearTimeout(timer);
  }, [searchText]);

  React.useEffect(() => {
    setSelectedConversationId(defaultConversationId || '');
    setSearchText('');
    setDebouncedSearchText('');
    setDraftsByConversation({});
    preferencesLoadedRef.current = false;
    if (!scopeKey) return undefined;
    const controller = new AbortController();
    void readCustomerConsultationPreferences(scopeKey, { signal: controller.signal })
      .then((preferences) => {
        if (controller.signal.aborted) return;
        setDraftsByConversation(preferences.drafts || {});
        preferencesLoadedRef.current = true;
      })
      .catch(() => {
        if (!controller.signal.aborted) preferencesLoadedRef.current = true;
      });
    return () => controller.abort();
  }, [defaultConversationId, scopeKey]);

  React.useEffect(() => {
    if (!scopeKey || !preferencesLoadedRef.current) return undefined;
    const timer = globalThis.setTimeout(() => {
      void updateCustomerConsultationPreferences(scopeKey, { drafts: draftsByConversation }).catch(() => undefined);
    }, 500);
    return () => globalThis.clearTimeout(timer);
  }, [draftsByConversation, scopeKey]);

  const selectFilter = React.useCallback((filterId) => {
    setSelectedFilterId(filterId);
  }, []);

  const selectStatus = React.useCallback((statusId) => {
    setSelectedStatusId(statusId);
  }, []);

  const selectConversation = React.useCallback((conversationId) => {
    setSelectedConversationId(conversationId);
  }, []);

  const updateDraft = React.useCallback((conversationId, value) => {
    if (!conversationId) return;
    setDraftsByConversation((current) => ({ ...current, [conversationId]: value }));
  }, []);

  const clearDraft = React.useCallback((conversationId) => {
    if (!conversationId) return;
    setDraftsByConversation((current) => ({ ...current, [conversationId]: '' }));
  }, []);

  return {
    selectedFilterId,
    selectedStatusId,
    selectedConversationId,
    unreadOnly,
    searchText,
    debouncedSearchText,
    draftsByConversation,
    selectFilter,
    selectStatus,
    selectConversation,
    setUnreadOnly,
    setSearchText,
    updateDraft,
    clearDraft,
  };
}
