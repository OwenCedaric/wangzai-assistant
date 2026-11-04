export function hasDirectCrossBorderAuthorization(settings = {}) {
  return Boolean(
    settings.companySecret?.trim() &&
    settings.accessToken?.trim() &&
    settings.accessToken !== 'legacy-bridge' &&
    settings.appUid?.trim()
  );
}

export function getCrossBorderLocalApiAccountId(settings = {}) {
  return String(settings.crossBorderAccountId || settings.accountId || '').trim();
}

export function hasLocalApiCrossBorderAuthorization(settings = {}) {
  return Boolean(
    getCrossBorderLocalApiAccountId(settings) &&
    settings.hasCompanySecret &&
    settings.hasAccessToken &&
    settings.hasAppUid
  );
}

export function hasServerCrossBorderAuthorization(settings = {}) {
  return Boolean(
    getCrossBorderLocalApiAccountId(settings)
    && String(settings.authorizationRef || settings.authorization_ref || '').trim(),
  );
}

export function hasUsableCrossBorderAuthorization(settings = {}) {
  return (
    hasServerCrossBorderAuthorization(settings)
    || hasDirectCrossBorderAuthorization(settings)
    || hasLocalApiCrossBorderAuthorization(settings)
  );
}
