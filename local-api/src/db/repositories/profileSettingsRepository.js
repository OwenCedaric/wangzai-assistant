export const PROFILE_SETTING_NAMESPACES = Object.freeze([
  "fee-settings",
  "watermark-settings",
  "prompt-library",
  "ozon-shop-preferences",
  "cross-border-preferences",
  "purchase-plugin-context",
  "logistics-pricing-settings",
  "customer-consultation-preferences",
  "auto-order-sku-bindings",
]);

const PROFILE_SETTING_NAMESPACE_SET = new Set(PROFILE_SETTING_NAMESPACES);
const MAX_PROFILE_SETTING_BYTES = 1024 * 1024;
const FORBIDDEN_SECRET_KEY =
  /(?:apikey|accesstoken|refreshtoken|clientsecret|companysecret|loginpassword|password|token|secret|authorization|credential)/u;
const PURCHASE_PLUGIN_CONTEXT_NAMESPACE = "purchase-plugin-context";
const PURCHASE_PLUGIN_CONTEXT_TEXT_LIMITS = Object.freeze({
  shopName: 120,
  shopId: 120,
  shopClientId: 120,
  purchaseAccountId: 128,
  orderId: 160,
  orderKey: 260,
  productKey: 260,
  legacyProductKey: 160,
  offerId: 160,
  sku: 160,
  productName: 260,
  ozonOrderId: 160,
  salesAmount: 80,
  productImageUrl: 2048,
  lockedAt: 80,
  updatedAt: 80,
});
const PURCHASE_PLUGIN_CONTEXT_TOP_LEVEL_KEYS = new Set([
  "version",
  "context",
  "updatedAt",
]);

function nowIso() {
  return new Date().toISOString();
}

function normalizeNamespace(value) {
  const namespace = String(value ?? "").trim();
  if (!PROFILE_SETTING_NAMESPACE_SET.has(namespace))
    throw new Error("Profile setting namespace is not allowed.");
  return namespace;
}

function assertSafeConfigValue(value, path = "$") {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error(
        `Profile setting contains a non-finite number at ${path}.`,
      );
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertSafeConfigValue(item, `${path}[${index}]`),
    );
    return;
  }
  if (!value || typeof value !== "object")
    throw new Error(`Profile setting has an unsupported value at ${path}.`);
  for (const [key, child] of Object.entries(value)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      throw new Error(`Profile setting key is forbidden: ${key}.`);
    }
    const normalizedKey = key.replaceAll(/[_-]/gu, "").toLowerCase();
    if (FORBIDDEN_SECRET_KEY.test(normalizedKey))
      throw new Error(`Profile setting secret field is forbidden: ${key}.`);
    assertSafeConfigValue(child, `${path}.${key}`);
  }
}

function assertPlainObject(value, message) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(message);
  return value;
}

function normalizePurchasePluginContextProfile(value) {
  const source = assertPlainObject(
    value,
    "Purchase plugin context must be a JSON object.",
  );
  Object.keys(source).forEach((key) => {
    if (!PURCHASE_PLUGIN_CONTEXT_TOP_LEVEL_KEYS.has(key)) {
      throw new Error(`Purchase plugin context has an unknown field: ${key}.`);
    }
  });
  if (Number(source.version) !== 1)
    throw new Error("Purchase plugin context version must be 1.");
  const contextSource = assertPlainObject(
    source.context,
    "Purchase plugin context must contain an object context.",
  );
  const context = {};
  Object.entries(contextSource).forEach(([key, rawValue]) => {
    if (key === "productIndex") {
      const valueAsNumber = Number(rawValue);
      if (!Number.isSafeInteger(valueAsNumber) || valueAsNumber < 0) {
        throw new Error(
          "Purchase plugin context productIndex must be a non-negative safe integer.",
        );
      }
      context.productIndex = valueAsNumber;
      return;
    }
    const maxLength = PURCHASE_PLUGIN_CONTEXT_TEXT_LIMITS[key];
    if (!maxLength)
      throw new Error(
        `Purchase plugin context has an unknown field: context.${key}.`,
      );
    if (typeof rawValue !== "string" || rawValue.length > maxLength) {
      throw new Error(`Purchase plugin context field is invalid: ${key}.`);
    }
    context[key] = rawValue;
  });
  if (
    typeof source.updatedAt !== "string" ||
    source.updatedAt.length > PURCHASE_PLUGIN_CONTEXT_TEXT_LIMITS.updatedAt
  ) {
    throw new Error("Purchase plugin context updatedAt is invalid.");
  }
  return { version: 1, context, updatedAt: source.updatedAt };
}

export function normalizeProfileSettingValue(namespace, value) {
  normalizeNamespace(namespace);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Profile setting value must be a JSON object.");
  }
  assertSafeConfigValue(value);
  const normalizedValue =
    namespace === PURCHASE_PLUGIN_CONTEXT_NAMESPACE
      ? normalizePurchasePluginContextProfile(value)
      : value;
  const serialized = JSON.stringify(normalizedValue);
  if (Buffer.byteLength(serialized, "utf8") > MAX_PROFILE_SETTING_BYTES) {
    throw new Error("Profile setting value exceeds the 1 MiB limit.");
  }
  return JSON.parse(serialized);
}

function publicSetting(row = {}) {
  if (!row?.namespace) return null;
  let value;
  try {
    value = normalizeProfileSettingValue(
      row.namespace,
      JSON.parse(row.value_json),
    );
  } catch {
    throw new Error(`PROFILE_SETTING_STORED_VALUE_INVALID:${row.namespace}`);
  }
  return {
    namespace: row.namespace,
    value,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createProfileSettingsRepository(db) {
  const selectSql =
    "SELECT namespace, value_json, created_at, updated_at FROM profile_settings";
  const getRow = (namespace) =>
    db
      .prepare(`${selectSql} WHERE namespace = ?`)
      .get(normalizeNamespace(namespace)) || null;

  function getSetting(namespace) {
    const row = getRow(namespace);
    return row ? publicSetting(row) : null;
  }

  function listSettings() {
    const placeholders = PROFILE_SETTING_NAMESPACES.map(() => "?").join(", ");
    return db
      .prepare(`${selectSql} WHERE namespace IN (${placeholders}) ORDER BY namespace ASC`)
      .all(...PROFILE_SETTING_NAMESPACES)
      .map(publicSetting);
  }

  function saveSetting(input = {}) {
    const namespace = normalizeNamespace(input.namespace);
    const value = normalizeProfileSettingValue(namespace, input.value);
    const existing = getRow(namespace);
    const timestamp = nowIso();
    db.prepare(
      `
      INSERT INTO profile_settings (namespace, value_json, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(namespace) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `,
    ).run(
      namespace,
      JSON.stringify(value),
      existing?.created_at || timestamp,
      timestamp,
    );
    return { ok: true, created: !existing, setting: getSetting(namespace) };
  }

  function deleteSetting(namespace) {
    const normalizedNamespace = normalizeNamespace(namespace);
    const existing = getRow(normalizedNamespace);
    if (!existing)
      return { ok: true, deleted: false, namespace: normalizedNamespace };
    db.prepare("DELETE FROM profile_settings WHERE namespace = ?").run(
      normalizedNamespace,
    );
    return {
      ok: true,
      deleted: true,
      namespace: normalizedNamespace,
      setting: publicSetting(existing),
    };
  }

  return { getSetting, listSettings, saveSetting, deleteSetting };
}
