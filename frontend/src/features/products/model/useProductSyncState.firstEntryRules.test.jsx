import { describe, expect, it } from 'vitest';

import source from './useProductSyncState.jsx?raw';

describe('product list first-entry rules', () => {
  it('opens with a pure SQLite read and never starts an implicit Ozon sync', () => {
    expect(source).toContain('hasLocalData: Boolean(cachedRows || localRows)');
    expect(source).toMatch(/void loadOzonProducts\(\{ localOnly: true \}\)\s*\.then\(\(\) => \{/u);
    expect(source).toContain('if (productPageLoadAttemptRef.current !== attemptId || !isActiveRef.current) return;');
    expect(source).toContain('if (productPageLoadPendingKeyRef.current === productPageLoadKey) return;');
    expect(source).toContain('Opening the page is a pure SQLite query.');
    expect(source).not.toContain('allowRemote');
    expect(source).not.toContain('autoSync');
    expect(source).not.toContain('requestOzonProductPage');
  });
});
