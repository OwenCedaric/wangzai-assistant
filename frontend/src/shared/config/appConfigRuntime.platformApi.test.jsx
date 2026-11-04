import { describe, expect, it } from 'vitest';
import { structuredSettingsLayouts } from './appConfigRuntime.jsx';

describe('platform API settings catalog', () => {
  it('contains only integrations with a selectable runtime adapter', () => {
    const config = structuredSettingsLayouts.platformApi;
    const selectableTypes = new Set(
      config.fields
        .find((field) => field.id === 'integrationType')
        .options.map((option) => option.value)
    );

    expect([...selectableTypes]).toEqual([
      'seerfar-open-api',
      'linkfox-agent',
      'ozon-browser-session',
      'ozon-performance',
      'wecom-group-bot',
    ]);
    expect(
      config.records.every((record) => selectableTypes.has(record.values.integrationType))
    ).toBe(true);
    expect(
      config.records.some((record) =>
        ['ozon-seller', 'cross-border', 'tool', 'custom'].includes(
          record.values.integrationType
        )
      )
    ).toBe(false);
  });
});
