CREATE TABLE IF NOT EXISTS catalog_cache_key_registry (
  cache_key TEXT PRIMARY KEY,
  namespace TEXT NOT NULL DEFAULT 'catalog',
  scope TEXT NOT NULL DEFAULT 'global' CHECK (scope IN ('global', 'shop')),
  shop_id TEXT,
  catalog_type TEXT NOT NULL CHECK (catalog_type IN ('category_tree', 'attributes', 'attribute_values', 'metadata')),
  locale TEXT NOT NULL DEFAULT 'DEFAULT',
  category_id TEXT,
  type_id TEXT,
  attribute_id TEXT,
  query_hash TEXT,
  payload_version TEXT NOT NULL DEFAULT 'catalog-cache-v1',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((scope = 'global' AND shop_id IS NULL) OR (scope = 'shop' AND shop_id IS NOT NULL)),
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS catalog_category_nodes (
  cache_key TEXT NOT NULL,
  node_id TEXT NOT NULL,
  shop_id TEXT,
  category_id TEXT NOT NULL,
  parent_category_id TEXT,
  type_id TEXT,
  title TEXT NOT NULL,
  level INTEGER NOT NULL DEFAULT 0,
  is_disabled INTEGER NOT NULL DEFAULT 0 CHECK (is_disabled IN (0, 1)),
  remote_hash TEXT,
  last_seen_at TEXT,
  missing_from_remote_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (cache_key, node_id),
  FOREIGN KEY (cache_key) REFERENCES catalog_cache_key_registry(cache_key) ON DELETE CASCADE,
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS catalog_cache_sync_state (
  cache_key TEXT PRIMARY KEY,
  shop_id TEXT,
  catalog_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'syncing', 'success', 'partial', 'failed')),
  last_success_at TEXT,
  last_attempt_at TEXT,
  last_error TEXT,
  remote_hash TEXT,
  snapshot_version TEXT,
  changed_count INTEGER NOT NULL DEFAULT 0,
  unchanged_count INTEGER NOT NULL DEFAULT 0,
  stale_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (cache_key) REFERENCES catalog_cache_key_registry(cache_key) ON DELETE CASCADE,
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_catalog_cache_key_scope_type ON catalog_cache_key_registry(scope, shop_id, catalog_type, locale);
CREATE INDEX IF NOT EXISTS idx_catalog_nodes_parent ON catalog_category_nodes(cache_key, parent_category_id);
CREATE INDEX IF NOT EXISTS idx_catalog_nodes_category ON catalog_category_nodes(category_id, type_id);
CREATE INDEX IF NOT EXISTS idx_catalog_sync_status ON catalog_cache_sync_state(status, catalog_type, updated_at);

PRAGMA user_version = 2;
