/**
 * A fixed visual mask for a saved credential. The settings UI never needs the
 * credential value to render the mask.
 */
export function createSavedSecretHint(encryptedValue) {
  return encryptedValue ? '••••••••••' : '';
}
