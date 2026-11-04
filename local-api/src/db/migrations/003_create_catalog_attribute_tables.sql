CREATE TABLE IF NOT EXISTS catalog_attributes (
  cache_key TEXT NOT NULL,
  attribute_id TEXT NOT NULL,
  shop_id TEXT,
  category_id TEXT,
  type_id TEXT,
  name TEXT NOT NULL,
  description TEXT,
  group_name TEXT,
  value_type TEXT,
  is_required INTEGER NOT NULL DEFAULT 0 CHECK (is_required IN (0, 1)),
  is_collection INTEGER NOT NULL DEFAULT 0 CHECK (is_collection IN (0, 1)),
  is_dictionary INTEGER NOT NULL DEFAULT 0 CHECK (is_dictionary IN (0, 1)),
  remote_hash TEXT,
  last_seen_at TEXT,
  missing_from_remote_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (cache_key, attribute_id),
  FOREIGN KEY (cache_key) REFERENCES catalog_cache_key_registry(cache_key) ON DELETE CASCADE,
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS catalog_attribute_values (
  cache_key TEXT NOT NULL,
  attribute_id TEXT NOT NULL,
  value_id TEXT NOT NULL,
  shop_id TEXT,
  category_id TEXT,
  type_id TEXT,
  value_text TEXT NOT NULL,
  info TEXT,
  remote_hash TEXT,
  last_seen_at TEXT,
  missing_from_remote_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (cache_key, attribute_id, value_id),
  FOREIGN KEY (cache_key) REFERENCES catalog_cache_key_registry(cache_key) ON DELETE CASCADE,
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS catalog_category_mappings (
  id TEXT PRIMARY KEY,
  shop_id TEXT,
  source_namespace TEXT NOT NULL,
  source_category_id TEXT NOT NULL,
  source_type_id TEXT,
  ozon_category_id TEXT NOT NULL,
  ozon_type_id TEXT,
  mapping_status TEXT NOT NULL DEFAULT 'draft' CHECK (mapping_status IN ('draft', 'confirmed', 'disabled')),
  confidence INTEGER NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 100),
  local_hash TEXT,
  remote_hash TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (shop_id, source_namespace, source_category_id, source_type_id),
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_catalog_attributes_category ON catalog_attributes(category_id, type_id, attribute_id);
CREATE INDEX IF NOT EXISTS idx_catalog_attributes_seen ON catalog_attributes(cache_key, missing_from_remote_at, updated_at);
CREATE INDEX IF NOT EXISTS idx_catalog_attribute_values_lookup ON catalog_attribute_values(attribute_id, value_text);
CREATE INDEX IF NOT EXISTS idx_catalog_attribute_values_seen ON catalog_attribute_values(cache_key, missing_from_remote_at, updated_at);
CREATE INDEX IF NOT EXISTS idx_catalog_category_mappings_source ON catalog_category_mappings(shop_id, source_namespace, source_category_id, source_type_id);
CREATE INDEX IF NOT EXISTS idx_catalog_category_mappings_ozon ON catalog_category_mappings(ozon_category_id, ozon_type_id, mapping_status);

PRAGMA user_version = 3;
