import { createProductCanonicalFactRepository } from "./productCanonicalFactRepository.js";
import {
  repairLegacyScopedProductSourceLinkKeys,
  repairProductSourceLinkMedia,
  repairProductStockValuesFromStockJson,
} from "./productSupportModel.js";

function hasCanonicalProductFacts(db) {
  return Boolean(
    db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'product_identities' LIMIT 1",
    ).get(),
  );
}

export function createProductRepositoryContext(db, { allowCompatibilityRepairs = true } = {}) {
  if (!db) throw new Error("createProductRepositoryContext requires db.");
  const canonicalFactsAvailable = hasCanonicalProductFacts(db);
  const canonicalFacts = canonicalFactsAvailable
    ? createProductCanonicalFactRepository(db)
    : null;

  if (allowCompatibilityRepairs) {
    repairLegacyScopedProductSourceLinkKeys(db);
    repairProductSourceLinkMedia(db);
    repairProductStockValuesFromStockJson(db);
  }

  return { canonicalFactsAvailable, canonicalFacts };
}
