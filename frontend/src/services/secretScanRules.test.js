import { describe, expect, it } from 'vitest';
import { isTestFixturePath, scanText } from '../../scripts/scan-secrets.mjs';

describe('secret scan file boundaries', () => {
  it('keeps credential-shaped test fixtures outside the release scan while retaining production coverage', () => {
    expect(isTestFixturePath('frontend/src/services/example.test.js')).toBe(true);
    expect(isTestFixturePath('local-api/tests/test_recovery_api.py')).toBe(true);
    expect(isTestFixturePath('frontend/src/services/ozonRequestControl.js')).toBe(false);
  });

  it('still identifies a real-looking production secret assignment', () => {
    expect(scanText('api_key = "live-key-value-123456"', 'frontend/src/services/runtime.js')).toHaveLength(1);
  });
});
