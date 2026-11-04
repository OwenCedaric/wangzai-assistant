import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  emptyFeeSettings,
  getActiveFeeSettingsFromFileStore,
  getFeePlanStateFromFileStore,
  hasFeePlanStateValues,
  hasFeeSettingsFileStoreEntry,
  normalizeFeePlanState,
  normalizeFeeSettingsFileStore,
  snapshotActiveRechargeRate,
  upsertFeePlanStateInFileStore,
} from './feeSettingsStore.js';

const feeRuntimeSource = readFileSync(join(process.cwd(), 'src', 'services', 'feeSettingsRuntime.js'), 'utf8');

describe('feeSettingsStore', () => {
  it('normalizes legacy browser settings into a fee plan state', () => {
    const state = normalizeFeePlanState(null, {
      platform: 'crossBorderBus',
      labelFeeUnit: '1.5',
      rechargeAmount: '100',
      giftAmount: '20',
      forecastOrderFee: '0.2',
    });

    expect(state.plans).toHaveLength(1);
    expect(state.plans[0].name).toBe('跨境巴士费用');
    expect(state.plans[0].settings).toMatchObject({
      platform: 'crossBorderBus',
      labelFeeUnit: '1.5',
      rechargeAmount: '100',
      giftAmount: '20',
      forecastOrderFee: '0.2',
    });
    expect(hasFeePlanStateValues(state)).toBe(true);
  });

  it('appends a time-effective recharge rate only when paid or gift amount changes', () => {
    const first = snapshotActiveRechargeRate({
      activeId: 'bus',
      plans: [{
        id: 'bus',
        name: '跨境巴士费用',
        settings: { platform: 'crossBorderBus', rechargeAmount: '300', giftAmount: '100' },
      }],
    }, { effectiveAt: '2026-08-11T00:00:00.000Z' });
    expect(first.plans[0].settings.rechargeRateHistory).toEqual([expect.objectContaining({
      effectiveAt: '2026-08-11T00:00:00.000Z',
      rechargeAmount: '300',
      giftAmount: '100',
    })]);

    const unchanged = snapshotActiveRechargeRate(first, { effectiveAt: '2026-08-12T00:00:00.000Z' });
    expect(unchanged.plans[0].settings.rechargeRateHistory).toHaveLength(1);
    unchanged.plans[0].settings.rechargeAmount = '500';
    unchanged.plans[0].settings.giftAmount = '100';
    const changed = snapshotActiveRechargeRate(unchanged, { effectiveAt: '2026-08-12T00:00:00.000Z' });
    expect(changed.plans[0].settings.rechargeRateHistory).toHaveLength(2);
    expect(changed.plans[0].settings.rechargeRateHistory[1]).toMatchObject({
      rechargeAmount: '500',
      giftAmount: '100',
    });
  });

  it('keeps legacy per-shop plans readable while global settings are being migrated', () => {
    const shopAState = normalizeFeePlanState({
      activeId: 'a',
      plans: [
        {
          id: 'a',
          name: 'A 店费用',
          settings: {
            platform: 'crossBorderBus',
            labelFeeUnit: '1.5',
            rechargeAmount: '100',
            forecastOrderFee: '0.2',
          },
        },
      ],
    });
    const shopBState = normalizeFeePlanState({
      activeId: 'b',
      plans: [
        {
          id: 'b',
          name: 'B 店费用',
          settings: {
            platform: 'crossBorderBus',
            labelFeeUnit: '2',
            rechargeAmount: '200',
            forecastOrderFee: '0.5',
          },
        },
      ],
    });

    const withShopA = upsertFeePlanStateInFileStore({}, 'ozon-shop:client:client-a', shopAState, {
      updatedAt: '2026-06-24T00:00:00.000Z',
    });
    const store = upsertFeePlanStateInFileStore(withShopA, 'ozon-shop:client:other', shopBState, {
      updatedAt: '2026-06-24T00:01:00.000Z',
    });

    expect(hasFeeSettingsFileStoreEntry(store, 'ozon-shop:client:client-a')).toBe(true);
    expect(getFeePlanStateFromFileStore(store, 'ozon-shop:client:client-a').activeId).toBe('a');
    expect(getActiveFeeSettingsFromFileStore(store, 'ozon-shop:client:client-a').labelFeeUnit).toBe('1.5');
    expect(getActiveFeeSettingsFromFileStore(store, 'ozon-shop:client:other').labelFeeUnit).toBe('2');
  });

  it('uses the first legacy shop plan as the global fallback when no global plan exists', () => {
    const shopState = normalizeFeePlanState({
      activeId: 'legacy',
      plans: [
        {
          id: 'legacy',
          name: 'legacy shop fees',
          settings: {
            platform: 'crossBorderBus',
            labelFeeUnit: '1.5',
            rechargeAmount: '100',
            giftAmount: '20',
            forecastOrderFee: '0.2',
          },
        },
      ],
    });
    const store = upsertFeePlanStateInFileStore({}, 'ozon-shop:client:client-a', shopState, {
      updatedAt: '2026-06-24T00:00:00.000Z',
    });

    expect(getFeePlanStateFromFileStore(store, '').activeId).toBe('legacy');
    expect(getActiveFeeSettingsFromFileStore(store, '').labelFeeUnit).toBe('1.5');
  });

  it('falls back to empty settings instead of inventing missing fees', () => {
    const store = normalizeFeeSettingsFileStore(null);

    expect(hasFeeSettingsFileStoreEntry(store, 'ozon-shop:client:client-a')).toBe(false);
    expect(getActiveFeeSettingsFromFileStore(store, 'ozon-shop:client:client-a')).toEqual(emptyFeeSettings);
  });

  it('uses profile SQLite as the only durable fee-settings input', () => {
    const saveStart = feeRuntimeSource.indexOf('function saveFeePlanState(nextState)');
    const saveEnd = feeRuntimeSource.indexOf('function toFiniteFeeNumber(value)', saveStart);
    const saveSource = feeRuntimeSource.slice(saveStart, saveEnd);

    expect(feeRuntimeSource).toContain('export async function loadFeePlanState()');
    expect(feeRuntimeSource).not.toContain('wangzai-fee-plan-state');
    expect(feeRuntimeSource).not.toContain('wangzai-fee-settings');
    expect(feeRuntimeSource).not.toContain('readLegacyJsonValue');
    expect(feeRuntimeSource).not.toContain('readLocalDataFile');
    expect(feeRuntimeSource).not.toContain('writeLocalDataFile');
    expect(feeRuntimeSource).not.toContain('scrubLegacyFeeSources');
    expect(saveSource).toContain('saveProfileSetting(PROFILE_FEE_SETTINGS_NAMESPACE, normalizedState');
    expect(feeRuntimeSource).not.toContain('function saveFeePlanStateToBrowser');
  });
});
