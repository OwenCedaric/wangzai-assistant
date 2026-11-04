import { getProfileSetting, saveProfileSetting } from '../../../api/localApiClient.js';

export const CUSTOMER_CONSULTATION_PREFERENCES_NAMESPACE = 'customer-consultation-preferences';

const MAX_SCOPES = 40;
const MAX_DRAFTS_PER_SCOPE = 200;
const MAX_DRAFT_LENGTH = 4000;
const MAX_CUSTOM_REPLIES = 100;
const MAX_QUICK_REPLY_LENGTH = 1000;

let updateQueue = Promise.resolve();

function normalizeText(value, maxLength) {
  return String(value ?? '')
    .trim()
    .slice(0, maxLength);
}

function normalizeScopeKey(value) {
  return normalizeText(value, 240);
}

function emptyStore() {
  return { version: 1, scopes: {}, updatedAt: '' };
}

function normalizeDrafts(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([conversationId, text]) => [
        normalizeText(conversationId, 240),
        String(text ?? '').slice(0, MAX_DRAFT_LENGTH),
      ])
      .filter(([conversationId, text]) => conversationId && text)
      .slice(-MAX_DRAFTS_PER_SCOPE)
  );
}

function normalizeQuickReplies(value = []) {
  if (!Array.isArray(value)) return [];
  const rows = [];
  const seen = new Set();
  for (const raw of value) {
    const text = normalizeText(raw?.text ?? raw, MAX_QUICK_REPLY_LENGTH);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    rows.push({
      id: normalizeText(raw?.id, 160) || `custom-${rows.length + 1}`,
      title: normalizeText(raw?.title, 80) || (text.length > 12 ? `${text.slice(0, 12)}…` : text),
      text,
      custom: true,
    });
    if (rows.length >= MAX_CUSTOM_REPLIES) break;
  }
  return rows;
}

function normalizeScope(value = {}) {
  return {
    drafts: normalizeDrafts(value?.drafts),
    customQuickReplies: normalizeQuickReplies(value?.customQuickReplies),
    updatedAt: normalizeText(value?.updatedAt, 80),
  };
}

function normalizeStore(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const scopes = Object.fromEntries(
    Object.entries(source.scopes || {})
      .map(([scopeKey, scope]) => [normalizeScopeKey(scopeKey), normalizeScope(scope)])
      .filter(([scopeKey]) => scopeKey)
      .sort((left, right) => String(right[1].updatedAt).localeCompare(String(left[1].updatedAt)))
      .slice(0, MAX_SCOPES)
  );
  return {
    version: 1,
    scopes,
    updatedAt: normalizeText(source.updatedAt, 80),
  };
}

export async function readCustomerConsultationPreferences(scopeKey, options = {}) {
  const normalizedScopeKey = normalizeScopeKey(scopeKey);
  if (!normalizedScopeKey) return normalizeScope();
  const response = await getProfileSetting(CUSTOMER_CONSULTATION_PREFERENCES_NAMESPACE, {
    timeoutMs: options.timeoutMs ?? 10000,
    signal: options.signal,
  });
  const store = normalizeStore(response?.setting?.value || emptyStore());
  return normalizeScope(store.scopes[normalizedScopeKey]);
}

export function updateCustomerConsultationPreferences(scopeKey, patch = {}, options = {}) {
  const normalizedScopeKey = normalizeScopeKey(scopeKey);
  if (!normalizedScopeKey) return Promise.resolve(normalizeScope());
  const task = async () => {
    const currentResponse = await getProfileSetting(CUSTOMER_CONSULTATION_PREFERENCES_NAMESPACE, {
      timeoutMs: options.timeoutMs ?? 10000,
      signal: options.signal,
    });
    const currentStore = normalizeStore(currentResponse?.setting?.value || emptyStore());
    const currentScope = normalizeScope(currentStore.scopes[normalizedScopeKey]);
    const nextScope = normalizeScope({
      ...currentScope,
      ...(Object.prototype.hasOwnProperty.call(patch, 'drafts') ? { drafts: patch.drafts } : {}),
      ...(Object.prototype.hasOwnProperty.call(patch, 'customQuickReplies')
        ? { customQuickReplies: patch.customQuickReplies }
        : {}),
      updatedAt: new Date().toISOString(),
    });
    const nextStore = normalizeStore({
      ...currentStore,
      scopes: { ...currentStore.scopes, [normalizedScopeKey]: nextScope },
      updatedAt: new Date().toISOString(),
    });
    const saved = await saveProfileSetting(CUSTOMER_CONSULTATION_PREFERENCES_NAMESPACE, nextStore, {
      timeoutMs: options.timeoutMs ?? 30000,
      signal: options.signal,
    });
    const readback = normalizeStore(saved?.setting?.value || nextStore);
    return normalizeScope(readback.scopes[normalizedScopeKey]);
  };
  const queued = updateQueue.then(task, task);
  updateQueue = queued.catch(() => undefined);
  return queued;
}

export const customerConsultationPreferencesInternals = {
  normalizeStore,
  normalizeScope,
};
