import { nowIso } from "./productCanonicalDto.js";

export function createProductHydrationMarkerRepository(db) {
  if (!db) throw new Error("createProductHydrationMarkerRepository requires db.");
  const refreshProductHydratedAtStatement = db.prepare(`
    UPDATE ozon_products
    SET hydrated_at = CASE
      WHEN COALESCE(
          json_extract(facet_observations_json, '$.detail.status') IN ('returned', 'returned_empty', 'not_applicable', 'unavailable'),
          detail_synced_at IS NOT NULL
        )
        AND COALESCE(
          json_extract(facet_observations_json, '$.pictures.status') IN ('returned', 'returned_empty', 'not_applicable', 'unavailable'),
          pictures_synced_at IS NOT NULL
        )
        AND COALESCE(
          json_extract(facet_observations_json, '$.prices.status') IN ('returned', 'returned_empty', 'not_applicable', 'unavailable'),
          prices_synced_at IS NOT NULL
        )
        AND COALESCE(
          json_extract(facet_observations_json, '$.stocks.status') IN ('returned', 'returned_empty', 'not_applicable', 'unavailable'),
          stocks_synced_at IS NOT NULL
        )
        AND COALESCE(
          json_extract(facet_observations_json, '$.attributes.status') IN ('returned', 'returned_empty', 'not_applicable', 'unavailable'),
          attributes_synced_at IS NOT NULL
        )
      THEN ?
      ELSE NULL
    END
    WHERE id = ?
  `);

  function refreshProductHydratedAt(id, timestamp = nowIso()) {
    return refreshProductHydratedAtStatement.run(timestamp, id);
  }

  return { refreshProductHydratedAt };
}
