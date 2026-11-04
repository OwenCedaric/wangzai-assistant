import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readProjectSource } from '../test/appSource';

const projectRoot = process.cwd();

function readSibling(relativePath) {
  return readFileSync(resolve(projectRoot, '..', relativePath), 'utf8');
}

describe('profile maintenance command boundaries', () => {
  it('keeps the raw route and fixed confirmation contracts inside the typed client', () => {
    const client = readProjectSource('src/features/settings/services/profileMaintenanceClient.js');
    const model = readProjectSource('src/features/settings/model/useDataMaintenance.js');
    const panel = readProjectSource('src/features/settings/ui/DataMaintenancePanel.jsx');

    expect(client).toContain("const ROUTE_PREFIX = '/api/app/profile-maintenance'");
    expect(client).toContain('RELEASE_RETIRED_PROFILE_SPACE_ONLY');
    expect(client).toContain('REBUILD_ONE_PROFILE_DOMAIN_FROM_SOURCE_ONLY');
    expect(client).toContain('PROFILE_MAINTENANCE_HUMAN_CONFIRMATION_REQUIRED');
    expect(`${model}\n${panel}`).not.toContain('/api/app/profile-maintenance');
    expect(`${model}\n${panel}`).not.toContain('DELETE FROM ');
    expect(`${model}\n${panel}`).not.toContain('DROP TABLE ');
    expect(`${model}\n${panel}`).not.toContain('db.prepare(');
  });

  it('derives release-space resources from the unified registry instead of a parallel table allowlist', () => {
    const service = readSibling('local-api/src/maintenance/profileMaintenanceCommandService.js');
    const route = readSibling('local-api/src/app/profileMaintenanceRoute.js');
    const createApp = readSibling('local-api/src/app/createApp.js');

    expect(service).toContain('getOrdinaryCacheClearResourceIds');
    expect(service).toContain('DATA_RESOURCE_REGISTRY');
    expect(service).toContain("resource.ordinaryCacheClearDisposition === 'delete'");
    expect(service).toContain("db.exec('BEGIN IMMEDIATE')");
    expect(service).toContain('assertProtectedUnchanged');
    expect(service).toContain('stagedProofVerifiedBeforeActivation: true');
    expect(service).toContain('PROFILE_MAINTENANCE_CALLER_SUPPLIED_PROOF_FORBIDDEN');
    expect(service).toContain('issueTrustedRebuildTicket');
    expect(service).toContain('readVerifiedCandidate');
    expect(service).toContain('PROFILE_MAINTENANCE_TRUSTED_SOURCE_TICKET_REPLAYED');
    expect(service).not.toMatch(/DELETE FROM\s+(?:shops|ozon_products|ozon_orders|profile_settings)/u);
    expect(route).toContain("const ROUTE_PREFIX = '/api/app/profile-maintenance'");
    expect(route).toContain("pathname === `${ROUTE_PREFIX}/prepare-ticket`");
    expect(route).toContain('service.issueTrustedRebuildTicket(normalizeTicketRequest(body))');
    expect(route).toContain('PROFILE_MAINTENANCE_CALLER_SUPPLIED_PROOF_FORBIDDEN');
    expect(route).toContain("'replacementRows'");
    expect(route).toContain("'proof'");
    expect(route).not.toContain('readVerifiedCandidate');
    expect(createApp).toContain('createProfileMaintenanceTrustedRebuildSourceAdapters({ db })');
    expect(createApp).toContain('trustedRebuildSourceAdapters:');
    expect(createApp).toContain('handleProfileMaintenanceRoute');
  });

  it('keeps permanent account removal as a different route and command contract', () => {
    const service = readSibling('local-api/src/maintenance/profileMaintenanceCommandService.js');
    const accountRemovalRoute = readSibling('local-api/src/app/accountRemovalRoute.js');

    expect(service).toContain("excludedCommand: 'permanent-delete'");
    expect(service).toContain("permanentDeleteRoute: '/api/account-removal/preview'");
    expect(accountRemovalRoute).toContain("pathname === '/api/account-removal/preview'");
    expect(accountRemovalRoute).toContain("pathname === '/api/account-removal/confirm'");
  });
});
