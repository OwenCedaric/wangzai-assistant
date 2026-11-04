export function createProductWriteReadbackRepository(syncRepository) {
  if (!syncRepository) {
    throw new Error("createProductWriteReadbackRepository requires syncRepository.");
  }
  return {
    upsertProducts: syncRepository.upsertProducts,
    mergeProductInfoRows: syncRepository.mergeProductInfoRows,
    mergeProductPictureRows: syncRepository.mergeProductPictureRows,
    mergeProductPriceRows: syncRepository.mergeProductPriceRows,
    mergeProductStockRows: syncRepository.mergeProductStockRows,
    mergeProductWarehouseStockRows:
      syncRepository.mergeProductWarehouseStockRows,
    recordProductWarehouseStockObservations:
      syncRepository.recordProductWarehouseStockObservations,
    mergeProductAttributeRows: syncRepository.mergeProductAttributeRows,
    reconcileVisibilitySnapshot: syncRepository.reconcileVisibilitySnapshot,
  };
}
