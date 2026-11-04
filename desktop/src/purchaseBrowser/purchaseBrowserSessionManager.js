import { randomUUID } from 'node:crypto';

export const PURCHASE_BROWSER_PHASES = Object.freeze([
  'idle',
  'opening',
  'ready',
  'busy',
  'hidden',
  'closing',
  'crashed',
  'recovering',
]);

const TERMINAL_PHASES = new Set(['closing', 'crashed']);

const ALLOWED_PHASE_TRANSITIONS = Object.freeze({
  idle: new Set(['idle', 'opening', 'ready', 'hidden', 'closing', 'crashed']),
  opening: new Set(['opening', 'ready', 'hidden', 'busy', 'closing', 'crashed']),
  ready: new Set(['ready', 'busy', 'hidden', 'closing', 'crashed', 'recovering']),
  busy: new Set(['busy', 'ready', 'hidden', 'closing', 'crashed', 'recovering']),
  hidden: new Set(['hidden', 'opening', 'ready', 'busy', 'closing', 'crashed', 'recovering']),
  recovering: new Set(['recovering', 'opening', 'ready', 'hidden', 'busy', 'closing', 'crashed']),
  crashed: new Set(['crashed', 'recovering', 'closing']),
  closing: new Set(['closing']),
});

function error(code) {
  const value = new Error(code);
  value.code = code;
  return value;
}

function text(value, maximum = 300) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001F\u007F]/gu, '').trim().slice(0, maximum)
    : '';
}

function required(value, code) {
  const result = text(value, 160);
  if (!result) throw error(code);
  return result;
}

function phase(value, fallback = 'idle') {
  return PURCHASE_BROWSER_PHASES.includes(value) ? value : fallback;
}

/**
 * Keeps native browser events tied to the session that created them.  A
 * session generation changes whenever an account is recovered, so a late
 * response from a killed Sidecar can never update the replacement tab.
 */
export function createPurchaseBrowserSessionManager({
  createSessionId = () => `purchase_session_${randomUUID()}`,
  now = () => new Date().toISOString(),
  onChanged = () => undefined,
} = {}) {
  const sessions = new Map();
  const sessionKeyIndex = new Map();
  const accountIndex = new Map();
  const generationBySessionKey = new Map();

  function publicSession(session) {
    if (!session) return null;
    return Object.freeze({
      sessionId: session.sessionId,
      sessionKey: session.sessionKey,
      accountId: session.accountId,
      generation: session.generation,
      phase: session.phase,
      health: session.health,
      profilePath: session.profilePath,
      currentUrl: session.currentUrl,
      target: session.target,
      invalidatedAt: session.invalidatedAt,
      updatedAt: session.updatedAt,
    });
  }

  function notify(session) {
    try { onChanged(publicSession(session)); } catch { /* telemetry only */ }
  }

  function getSession(sessionId) {
    return sessions.get(text(sessionId, 180)) || null;
  }

  function getByAccount(accountId) {
    const ids = accountIndex.get(text(accountId, 160));
    if (!ids?.size) return null;
    return [...ids]
      .map(getSession)
      .filter(Boolean)
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))[0] || null;
  }

  function getBySessionKey(sessionKey) {
    const sessionId = sessionKeyIndex.get(text(sessionKey, 180));
    return sessionId ? getSession(sessionId) : null;
  }

  function createSession(input = {}) {
    const accountId = required(input.accountId, 'PURCHASE_BROWSER_ACCOUNT_ID_REQUIRED');
    const sessionKey = required(input.sessionKey || accountId, 'PURCHASE_BROWSER_SESSION_KEY_REQUIRED');
    const current = getBySessionKey(sessionKey);
    if (current && !TERMINAL_PHASES.has(current.phase)) return publicSession(current);
    if (current) removeSession(current.sessionId);
    const generation = (generationBySessionKey.get(sessionKey) || 0) + 1;
    generationBySessionKey.set(sessionKey, generation);
    const session = {
      sessionId: required(input.sessionId || createSessionId(), 'PURCHASE_BROWSER_SESSION_ID_REQUIRED'),
      sessionKey,
      accountId,
      generation,
      phase: phase(input.phase),
      health: text(input.health, 40) || 'unknown',
      profilePath: text(input.profilePath, 1200),
      currentUrl: text(input.currentUrl, 1800) || 'about:blank',
      target: input.target && typeof input.target === 'object' ? { ...input.target } : null,
      invalidatedAt: '',
      updatedAt: now(),
    };
    sessions.set(session.sessionId, session);
    sessionKeyIndex.set(sessionKey, session.sessionId);
    const accountSessions = accountIndex.get(accountId) || new Set();
    accountSessions.add(session.sessionId);
    accountIndex.set(accountId, accountSessions);
    notify(session);
    return publicSession(session);
  }

  function updateSession(sessionId, patch = {}) {
    const session = getSession(sessionId);
    if (!session) throw error('PURCHASE_BROWSER_SESSION_STALE');
    if (patch.phase !== undefined) {
      const nextPhase = phase(patch.phase, session.phase);
      if (!ALLOWED_PHASE_TRANSITIONS[session.phase]?.has(nextPhase)) {
        throw error('PURCHASE_BROWSER_SESSION_PHASE_INVALID');
      }
      session.phase = nextPhase;
    }
    if (patch.health !== undefined) session.health = text(patch.health, 40) || session.health;
    if (patch.profilePath !== undefined) session.profilePath = text(patch.profilePath, 1200);
    if (patch.currentUrl !== undefined) session.currentUrl = text(patch.currentUrl, 1800) || 'about:blank';
    if (Object.prototype.hasOwnProperty.call(patch, 'target')) {
      session.target = patch.target && typeof patch.target === 'object' ? { ...patch.target } : null;
    }
    session.updatedAt = now();
    notify(session);
    return publicSession(session);
  }

  function isCurrent(sessionId, generation) {
    const session = getSession(sessionId);
    return Boolean(session && session.generation === Number(generation) && !session.invalidatedAt);
  }

  function invalidate(sessionId, reason = 'invalidated') {
    const session = getSession(sessionId);
    if (!session) return null;
    session.invalidatedAt = now();
    session.phase = reason === 'crashed' ? 'crashed' : 'closing';
    session.health = 'unhealthy';
    session.updatedAt = now();
    notify(session);
    return publicSession(session);
  }

  function removeSession(sessionId) {
    const session = getSession(sessionId);
    if (!session) return false;
    sessions.delete(session.sessionId);
    if (sessionKeyIndex.get(session.sessionKey) === session.sessionId) sessionKeyIndex.delete(session.sessionKey);
    const accountSessions = accountIndex.get(session.accountId);
    accountSessions?.delete(session.sessionId);
    if (!accountSessions?.size) accountIndex.delete(session.accountId);
    return true;
  }

  function snapshot() {
    return Object.freeze({
      sessions: [...sessions.values()].map(publicSession),
    });
  }

  return Object.freeze({
    createSession,
    getByAccount,
    getBySessionKey,
    getSession,
    invalidate,
    isCurrent,
    removeSession,
    snapshot,
    updateSession,
  });
}
