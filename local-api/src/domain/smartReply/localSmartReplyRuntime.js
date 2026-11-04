import { createLocalSmartReplyService } from '../../../../local-cache-agent/src/smartReply/localService.js';
import { createJsonResponse, readJsonRequestBody } from '../../utils/http.js';
import { createLocalSmartReplyRecordStore } from './localSmartReplyRecordStore.js';

const SCOPE_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/u;
const MODE_NAMESPACE = 'smart-reply-runtime';
const MODE_KEY = 'execution-mode';
const RULE_NAMESPACE = 'smart-reply-local-rules';
const NOTIFICATION_CURSOR_NAMESPACE = 'smart-reply-local-notification-cursor';
const NOTIFICATION_CURSOR_KEY = 'orders';
const ORDER_EVENT_TYPES = Object.freeze([
  'order_new',
  'order_paid',
  'order_status_changed',
  'order_cancelled',
  'fbo_order_new',
  'fbo_order_status_changed',
  'fbo_order_cancelled',
]);
const NOTIFICATION_POLL_PATH = '/api/smart-reply/local/notification-poll';

function normalizeScope(value, fallbackScopeId) {
  const candidate = String(Array.isArray(value) ? value[0] : value || '').trim();
  if (SCOPE_PATTERN.test(candidate)) return candidate;
  return fallbackScopeId;
}

function errorPayload(error) {
  return {
    ok: false,
    error: {
      code: String(error?.code || 'SMART_REPLY_LOCAL_REQUEST_FAILED'),
      message: String(error?.message || '本地智能回复请求失败。'),
    },
  };
}

export function createLocalSmartReplyRuntime({
  db,
  shopRepository,
  fallbackScopeId = 'local-profile',
  fetchImpl = globalThis.fetch,
} = {}) {
  const safeFallbackScopeId = SCOPE_PATTERN.test(String(fallbackScopeId || '').trim())
    ? String(fallbackScopeId).trim()
    : 'local-profile';
  const store = createLocalSmartReplyRecordStore({ db, shopRepository });
  const service = createLocalSmartReplyService({ store, fetchImpl });
  const notificationPlaceholders = ORDER_EVENT_TYPES.map(() => '?').join(', ');
  const selectNotificationsAfterCursor = db.prepare(`
    SELECT id, shop_id, event_type, posting_number, created_at
    FROM ozon_notification_events
    WHERE enabled = 1
      AND domain = 'orders'
      AND event_type IN (${notificationPlaceholders})
      AND TRIM(COALESCE(shop_id, '')) <> ''
      AND TRIM(COALESCE(posting_number, '')) <> ''
      AND (created_at > ? OR (created_at = ? AND id > ?))
    ORDER BY created_at ASC, id ASC
    LIMIT 100
  `);
  const selectNotificationsSince = db.prepare(`
    SELECT id, shop_id, event_type, posting_number, created_at
    FROM ozon_notification_events
    WHERE enabled = 1
      AND domain = 'orders'
      AND event_type IN (${notificationPlaceholders})
      AND TRIM(COALESCE(shop_id, '')) <> ''
      AND TRIM(COALESCE(posting_number, '')) <> ''
      AND created_at >= ?
    ORDER BY created_at ASC, id ASC
    LIMIT 100
  `);
  const selectLatestOrderNotification = db.prepare(`
    SELECT id, created_at
    FROM ozon_notification_events
    WHERE enabled = 1
      AND domain = 'orders'
      AND event_type IN (${notificationPlaceholders})
      AND TRIM(COALESCE(shop_id, '')) <> ''
      AND TRIM(COALESCE(posting_number, '')) <> ''
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `);

  function requestScope(req) {
    return normalizeScope(req?.headers?.['x-wangzai-cache-scope'], safeFallbackScopeId);
  }

  async function execute({ method, pathname, searchParams, payload, scopeId }) {
    const normalizedScopeId = normalizeScope(scopeId, safeFallbackScopeId);
    if (String(method || 'GET').toUpperCase() === 'POST' && pathname === NOTIFICATION_POLL_PATH) {
      const mode = store.getRecord({
        scopeId: normalizedScopeId,
        namespace: MODE_NAMESPACE,
        key: MODE_KEY,
      })?.payload?.mode;
      if (mode !== 'local') {
        return { handled: true, status: 200, payload: { ok: true, accepted: 0, scanned: 0, mode: 'cloud' } };
      }

      const activeRules = store.listRecords({
        scopeId: normalizedScopeId,
        namespace: RULE_NAMESPACE,
        limit: 1000,
      }).filter((record) => record?.payload?.enabled === true);
      const cursor = store.getRecord({
        scopeId: normalizedScopeId,
        namespace: NOTIFICATION_CURSOR_NAMESPACE,
        key: NOTIFICATION_CURSOR_KEY,
      })?.payload || null;

      if (!activeRules.length) {
        const latest = selectLatestOrderNotification.get(...ORDER_EVENT_TYPES);
        if (latest?.id && latest?.created_at) {
          store.putRecord({
            scopeId: normalizedScopeId,
            namespace: NOTIFICATION_CURSOR_NAMESPACE,
            key: NOTIFICATION_CURSOR_KEY,
            payload: {
              lastCreatedAt: String(latest.created_at),
              lastId: String(latest.id),
              updatedAt: new Date().toISOString(),
            },
          });
        }
        return { handled: true, status: 200, payload: { ok: true, accepted: 0, scanned: 0, mode: 'local' } };
      }

      const rows = cursor?.lastCreatedAt
        ? selectNotificationsAfterCursor.all(
            ...ORDER_EVENT_TYPES,
            String(cursor.lastCreatedAt),
            String(cursor.lastCreatedAt),
            String(cursor.lastId || ''),
          )
        : selectNotificationsSince.all(
            ...ORDER_EVENT_TYPES,
            activeRules
              .map((record) => String(record?.payload?.enabledAt || ''))
              .filter(Boolean)
              .sort()[0] || new Date().toISOString(),
          );
      const notifications = rows.map((row) => ({
        id: String(row.id || ''),
        domain: 'orders',
        eventType: String(row.event_type || ''),
        shopId: String(row.shop_id || ''),
        postingNumber: String(row.posting_number || ''),
        createdAt: String(row.created_at || ''),
      }));
      const result = await service.handle({
        method: 'POST',
        pathname: '/v1/internal/smart-reply/notification-hints',
        searchParams: new URLSearchParams(),
        payload: { notifications },
        scopeId: normalizedScopeId,
      });
      const latest = rows.at(-1);
      if (latest?.id && latest?.created_at) {
        store.putRecord({
          scopeId: normalizedScopeId,
          namespace: NOTIFICATION_CURSOR_NAMESPACE,
          key: NOTIFICATION_CURSOR_KEY,
          payload: {
            lastCreatedAt: String(latest.created_at),
            lastId: String(latest.id),
            updatedAt: new Date().toISOString(),
          },
        });
      }
      return {
        handled: true,
        status: 200,
        payload: {
          ok: true,
          accepted: Number(result?.payload?.accepted) || 0,
          scanned: notifications.length,
          mode: 'local',
        },
      };
    }
    return service.handle({
      method: String(method || 'GET').toUpperCase(),
      pathname: String(pathname || ''),
      searchParams: searchParams || new URLSearchParams(),
      payload: payload || {},
      scopeId: normalizedScopeId,
    });
  }

  return Object.freeze({
    start() {
      service.start();
    },

    stop() {
      return service.stop();
    },

    handleRequest({ req, res, requestUrl, corsHeaders }) {
      const ownsNotificationPoll = req.method === 'POST' && requestUrl.pathname === NOTIFICATION_POLL_PATH;
      if (!ownsNotificationPoll && !service.supports(req.method, requestUrl.pathname)) return false;
      const run = async (payload) => {
        try {
          const result = await execute({
            method: req.method,
            pathname: requestUrl.pathname,
            searchParams: requestUrl.searchParams,
            payload,
            scopeId: requestScope(req),
          });
          createJsonResponse(res, result.status, result.payload, corsHeaders);
        } catch (error) {
          createJsonResponse(
            res,
            Math.max(400, Math.min(599, Number(error?.status) || 400)),
            errorPayload(error),
            corsHeaders,
          );
        }
      };
      if (req.method === 'GET') {
        void run({});
      } else {
        readJsonRequestBody(req, { maxBytes: 8 * 1024 * 1024 })
          .then(run)
          .catch((error) => createJsonResponse(res, 400, errorPayload(error), corsHeaders));
      }
      return true;
    },

    replaceEntitlements({ scopeId, grants }) {
      return execute({
        method: 'POST',
        pathname: '/v1/internal/smart-reply/shop-entitlements',
        payload: { grants: Array.isArray(grants) ? grants : [] },
        scopeId,
      });
    },

    async acceptNotificationsForActiveScopes(notifications) {
      const rows = Array.isArray(notifications) ? notifications.filter(Boolean) : [];
      if (!rows.length) return { accepted: 0 };
      let accepted = 0;
      const scopes = store.listScopesByNamespace(MODE_NAMESPACE).filter((scopeId) => (
        store.getRecord({ scopeId, namespace: MODE_NAMESPACE, key: MODE_KEY })?.payload?.mode === 'local'
      ));
      for (const scopeId of scopes) {
        const result = await execute({
          method: 'POST',
          pathname: '/v1/internal/smart-reply/notification-hints',
          payload: { notifications: rows },
          scopeId,
        });
        accepted += Number(result?.payload?.accepted) || 0;
      }
      return { accepted };
    },
  });
}
