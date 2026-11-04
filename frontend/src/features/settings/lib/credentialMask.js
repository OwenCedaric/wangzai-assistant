export const SAVED_CREDENTIAL_MASK = '••••••••••';

export function toCredentialMaskValue(value, hasSavedCredential = false) {
  const rawValue = String(value ?? '');
  if (rawValue) return rawValue;
  return hasSavedCredential ? SAVED_CREDENTIAL_MASK : '';
}

export function toStoredCredentialValue(value) {
  return String(value ?? '').replaceAll(SAVED_CREDENTIAL_MASK, '');
}

export function selectCredentialMaskOnFocus(event) {
  if (event?.target?.value === SAVED_CREDENTIAL_MASK) event.target.select();
}
