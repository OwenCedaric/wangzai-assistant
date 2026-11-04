import { describe, expect, it } from 'vitest';
import { readSplitAppSource } from '../test/appSource';

const appSource = readSplitAppSource();

function sliceFunction(source, startToken, endToken) {
  const start = source.indexOf(startToken);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = endToken ? source.indexOf(endToken, start) : source.length;
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('settings deletion rules', () => {
  it('allows structured setting records to delete the last saved item without falling back to fixed defaults', () => {
    const structuredSource = sliceFunction(appSource, 'function StructuredSettingsLayout', 'export default');

    expect(structuredSource).toContain('const safeRecords =');
    expect(structuredSource).toContain(
      'isPlatformApi ? createBlankPlatformApiRecord(config, 1) : createBlankStructuredRecord(config, 1)'
    );
    expect(structuredSource).not.toContain('saveStructuredRecords');
    expect(structuredSource).toContain('getStructuredRecordCountLabel(config, displayRecords.length)');
    expect(structuredSource).not.toContain(
      'disabled={isCrossBorder ? crossBorderLoading : config.records.length <= 1}'
    );
    expect(structuredSource).not.toContain('config.records.map((record)');
  });

  it('keeps the cross-border list badge synced with the real authorization state', () => {
    const structuredSource = sliceFunction(appSource, 'function StructuredSettingsLayout', 'export default');

    expect(structuredSource).toContain('const displayRecords = localRecords;');
    expect(structuredSource).toContain('.map((settings) => buildCrossBorderDisplayRecord(config, settings))');
    expect(structuredSource).toContain('setLocalRecords(records)');
    const displaySource = sliceFunction(appSource, 'function buildCrossBorderDisplayRecord', 'function createCrossBorderDraftSettings');
    const build = new Function('cloneStructuredRecord', `${displaySource}; return buildCrossBorderDisplayRecord;`)(structuredClone);
    const config = { records: [{ id: 'synthetic' }] };
    expect(build(config, { hasServerAuthorization: true })).toMatchObject({ status: '服务器已授权', statusColor: 'success' });
    expect(build(config, { userName: 'local-only', connectionState: 'connected' })).toMatchObject({ status: '待授权', statusColor: 'default' });
  });

  it('allows deleting the last model API, fee plan, and watermark template by replacing old data with blank placeholders', () => {
    const modelApiSource = sliceFunction(appSource, 'function ModelApiSettingsPanel', 'function FeeSettingsPanel');
    const feeSource = sliceFunction(appSource, 'function FeeSettingsPanel', 'function ShopSettingsDialog');
    const watermarkSource = sliceFunction(
      appSource,
      'function WatermarkSettingsPanel',
      'function ModelApiSettingsPanel'
    );

    expect(modelApiSource).not.toContain('if (modelApiState.interfaces.length <= 1) return;');
    expect(modelApiSource).not.toContain('disabled={modelApiState.interfaces.length <= 1}');
    expect(modelApiSource).toContain(
      'const safeInterfaces = nextInterfaces.length > 0 ? nextInterfaces : [createBlankModelApiSettings(1)];'
    );

    expect(feeSource).not.toContain('if (current.plans.length <= 1) return current;');
    expect(feeSource).not.toContain('disabled={feePlanState.plans.length <= 1}');
    expect(feeSource).toContain('const safePlans = nextPlans.length > 0 ? nextPlans : [createFeePlan(1)];');

    expect(watermarkSource).not.toContain('if (templates.length <= 1) return;');
    expect(watermarkSource).not.toContain('disabled={templates.length <= 1}');
    expect(watermarkSource).toContain(
      'const safeTemplates = nextTemplates.length > 0 ? nextTemplates : [createBlankWatermarkTemplate(1)];'
    );
  });
});
