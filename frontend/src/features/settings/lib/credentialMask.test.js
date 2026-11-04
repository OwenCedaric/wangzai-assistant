import { describe, expect, it } from 'vitest';
import { SAVED_CREDENTIAL_MASK, toCredentialMaskValue, toStoredCredentialValue } from './credentialMask.js';

describe('credential mask presentation', () => {
  it('renders a saved but undisclosed secret as a real fixed input value', () => {
    expect(toCredentialMaskValue('', true)).toBe(SAVED_CREDENTIAL_MASK);
    expect(toCredentialMaskValue('replacement-secret', true)).toBe('replacement-secret');
    expect(toCredentialMaskValue('', false)).toBe('');
  });

  it('never treats the fixed display mask as a replacement secret during save', () => {
    expect(toStoredCredentialValue(SAVED_CREDENTIAL_MASK)).toBe('');
    expect(toStoredCredentialValue(`${SAVED_CREDENTIAL_MASK}new-secret`)).toBe('new-secret');
  });
});
