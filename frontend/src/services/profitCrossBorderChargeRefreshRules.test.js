import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const appSource = readFileSync(join(process.cwd(), 'src', 'App.jsx'), 'utf8');
const profitPageSource = readFileSync(
  join(process.cwd(), 'src', 'features', 'profit', 'ProfitPage.jsx'),
  'utf8',
);

describe('profit cross-border actual charge refresh boundary', () => {
  it('refreshes only the profit local-input ledger after verified charge persistence', () => {
    expect(appSource).toContain("payload.event === 'cross-border-charges-committed'");
    expect(appSource).toContain('payload?.summary?.readbackVerified === true');
    expect(appSource).toContain('setProfitLocalInputsRefreshTick((current) => current + 1)');
    expect(appSource).toContain('localInputsRefreshTick={profitLocalInputsRefreshTick}');
    expect(profitPageSource).toContain('useProfitLocalInputs({');
    expect(profitPageSource).toContain('refreshTick: localInputsRefreshTick');
    expect(profitPageSource).not.toMatch(
      /localInputsRefreshTick[\s\S]{0,900}profitSync\.refresh\(\)/u,
    );
  });
});
