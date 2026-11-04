export function createProductLegacyMigrationRepository(supportRepository) {
  if (!supportRepository) {
    throw new Error("createProductLegacyMigrationRepository requires supportRepository.");
  }
  return {
    importLegacyProductMaterialProfiles: supportRepository.importLegacyProductMaterialProfiles,
    listProductMaterialProfilesPage: supportRepository.listProductMaterialProfilesPage,
    importLegacyProductSourceLinks: supportRepository.importLegacyProductSourceLinks,
    listProductSourceLinksPage: supportRepository.listProductSourceLinksPage,
  };
}
