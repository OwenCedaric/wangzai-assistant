const FIELD_LIMITS = Object.freeze({
  shopId: 160,
  accountScope: 260,
  chatId: 520,
  lastMessageId: 520,
  lastMessageAt: 100,
});

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function requiredText(value, field) {
  const text = normalizeText(value);
  if (!text) throw new Error(`CUSTOMER_PUSH_VIEW_MARKER_${field.toUpperCase()}_REQUIRED`);
  if (text.length > FIELD_LIMITS[field]) {
    throw new Error(`CUSTOMER_PUSH_VIEW_MARKER_${field.toUpperCase()}_TOO_LONG`);
  }
  return text;
}

function optionalText(value, field) {
  const text = normalizeText(value);
  if (text.length > FIELD_LIMITS[field]) {
    throw new Error(`CUSTOMER_PUSH_VIEW_MARKER_${field.toUpperCase()}_TOO_LONG`);
  }
  return text;
}

function normalizeScope(input = {}) {
  const shopId = requiredText(input.shopId ?? input.shop_id, 'shopId');
  const accountScope = requiredText(
    input.accountScope ?? input.account_scope ?? input.accountId ?? input.account_id ?? shopId,
    'accountScope',
  );
  return { shopId, accountScope };
}

function publicMarker(row = {}) {
  return {
    shopId: row.shop_id,
    accountScope: row.account_scope,
    chatId: row.chat_id,
    lastMessageId: row.last_message_id || '',
    lastMessageAt: row.last_message_at || '',
    viewedAt: row.viewed_at,
  };
}

export function createCustomerPushViewMarkerRepository(db) {
  if (!db?.prepare) throw new Error('CUSTOMER_PUSH_VIEW_MARKER_DB_REQUIRED');

  function listMarkers(input = {}) {
    const { shopId, accountScope } = normalizeScope(input);
    return db.prepare(`
      SELECT shop_id, account_scope, chat_id, last_message_id, last_message_at, viewed_at
      FROM customer_service_push_view_markers
      WHERE shop_id = ? AND account_scope = ?
      ORDER BY viewed_at DESC, chat_id ASC
      LIMIT 5000
    `).all(shopId, accountScope).map(publicMarker);
  }

  function saveMarker(input = {}) {
    const { shopId, accountScope } = normalizeScope(input);
    const chatId = requiredText(input.chatId ?? input.chat_id, 'chatId');
    const lastMessageId = optionalText(input.lastMessageId ?? input.last_message_id, 'lastMessageId');
    const lastMessageAt = optionalText(input.lastMessageAt ?? input.last_message_at, 'lastMessageAt');
    if (!lastMessageId && !lastMessageAt) {
      throw new Error('CUSTOMER_PUSH_VIEW_MARKER_MESSAGE_IDENTITY_REQUIRED');
    }
    const viewedAt = new Date().toISOString();

    db.exec('BEGIN IMMEDIATE;');
    try {
      // Only the newest viewed message is authoritative for one scoped chat.
      // Losing a marker is safe (the UI shows unread); retaining an older one is not useful.
      db.prepare(`
        DELETE FROM customer_service_push_view_markers
        WHERE shop_id = ? AND account_scope = ? AND chat_id = ?
      `).run(shopId, accountScope, chatId);
      db.prepare(`
        INSERT INTO customer_service_push_view_markers (
          shop_id, account_scope, chat_id, last_message_id, last_message_at, viewed_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(shopId, accountScope, chatId, lastMessageId, lastMessageAt, viewedAt);
      db.exec('COMMIT;');
    } catch (error) {
      db.exec('ROLLBACK;');
      throw error;
    }

    return publicMarker({
      shop_id: shopId,
      account_scope: accountScope,
      chat_id: chatId,
      last_message_id: lastMessageId,
      last_message_at: lastMessageAt,
      viewed_at: viewedAt,
    });
  }

  return { listMarkers, saveMarker };
}
