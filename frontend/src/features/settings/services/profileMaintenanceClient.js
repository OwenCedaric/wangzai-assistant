import { requestLocalApi } from '../../../api/localApiClient.js';

const ROUTE_PREFIX = '/api/app/profile-maintenance';

export const PROFILE_MAINTENANCE_COMMANDS = Object.freeze({
  RELEASE_SPACE: 'release-space',
  REBUILD_DOMAIN: 'rebuild-domain',
});

const CONFIRMATIONS = Object.freeze({
  [PROFILE_MAINTENANCE_COMMANDS.RELEASE_SPACE]: 'RELEASE_RETIRED_PROFILE_SPACE_ONLY',
  [PROFILE_MAINTENANCE_COMMANDS.REBUILD_DOMAIN]: 'REBUILD_ONE_PROFILE_DOMAIN_FROM_SOURCE_ONLY',
});

function requiredText(value, code) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(code);
  return normalized;
}

function assertHumanConfirmed(value) {
  if (value !== true) throw new Error('PROFILE_MAINTENANCE_HUMAN_CONFIRMATION_REQUIRED');
}

function post(path, body, options = {}) {
  return requestLocalApi(`${ROUTE_PREFIX}/${path}`, {
    ...options,
    method: 'POST',
    body,
  });
}

export function getProfileMaintenanceContracts(options = {}) {
  return requestLocalApi(`${ROUTE_PREFIX}/contracts`, { ...options, method: 'GET' });
}

export function previewProfileSpaceRelease(options = {}) {
  return post('preview', { command: PROFILE_MAINTENANCE_COMMANDS.RELEASE_SPACE }, options);
}

export function confirmProfileSpaceRelease({
  humanConfirmationToken,
  humanConfirmed,
} = {}, options = {}) {
  assertHumanConfirmed(humanConfirmed);
  return post('confirm', {
    command: PROFILE_MAINTENANCE_COMMANDS.RELEASE_SPACE,
    confirmation: CONFIRMATIONS[PROFILE_MAINTENANCE_COMMANDS.RELEASE_SPACE],
    humanConfirmationToken: requiredText(
      humanConfirmationToken,
      'PROFILE_MAINTENANCE_PREVIEW_TOKEN_REQUIRED',
    ),
  }, options);
}

export function previewProfileDomainRebuild(domain, options = {}) {
  return post('preview', {
    command: PROFILE_MAINTENANCE_COMMANDS.REBUILD_DOMAIN,
    domain: requiredText(domain, 'PROFILE_MAINTENANCE_DOMAIN_REQUIRED'),
  }, options);
}

export function prepareProfileDomainRebuildTicket({
  domain,
  humanConfirmationToken,
} = {}, options = {}) {
  return post('prepare-ticket', {
    domain: requiredText(domain, 'PROFILE_MAINTENANCE_DOMAIN_REQUIRED'),
    humanConfirmationToken: requiredText(
      humanConfirmationToken,
      'PROFILE_MAINTENANCE_PREVIEW_TOKEN_REQUIRED',
    ),
  }, options);
}

export function confirmProfileDomainRebuild(input = {}, options = {}) {
  const {
    domain,
    humanConfirmationToken,
    humanConfirmed,
    trustedSourceTicket,
  } = input;
  assertHumanConfirmed(humanConfirmed);
  if (Object.hasOwn(input, 'replacementRows') || Object.hasOwn(input, 'proof')) {
    throw new Error('PROFILE_MAINTENANCE_CALLER_SUPPLIED_PROOF_FORBIDDEN');
  }
  return post('confirm', {
    command: PROFILE_MAINTENANCE_COMMANDS.REBUILD_DOMAIN,
    confirmation: CONFIRMATIONS[PROFILE_MAINTENANCE_COMMANDS.REBUILD_DOMAIN],
    domain: requiredText(domain, 'PROFILE_MAINTENANCE_DOMAIN_REQUIRED'),
    humanConfirmationToken: requiredText(
      humanConfirmationToken,
      'PROFILE_MAINTENANCE_PREVIEW_TOKEN_REQUIRED',
    ),
    trustedSourceTicket: requiredText(
      trustedSourceTicket,
      'PROFILE_MAINTENANCE_TRUSTED_SOURCE_TICKET_REQUIRED',
    ),
  }, options);
}
