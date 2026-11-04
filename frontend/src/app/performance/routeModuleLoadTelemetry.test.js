import { describe, expect, it, vi } from 'vitest';
import {
  getRouteModuleMeasureName,
  getRouteRenderPhaseMeasureName,
  getRouteRenderMeasureName,
  measureRouteModuleLoad,
  measureRouteRenderPhase,
  measureRouteRenderCommit,
} from './routeModuleLoadTelemetry.js';

describe('route module load telemetry', () => {
  it('writes a small named performance measure for a lazy route module', () => {
    const measure = vi.fn();
    const result = measureRouteModuleLoad('products', 12, {
      performanceApi: { measure, now: () => 47 },
    });

    expect(result).toEqual({ name: 'wangzai-route-module:products', durationMs: 35 });
    expect(measure).toHaveBeenCalledWith('wangzai-route-module:products', { start: 12, duration: 35 });
    expect(getRouteModuleMeasureName('products')).toBe('wangzai-route-module:products');
  });

  it('fails closed when browser performance measurement is unavailable', () => {
    expect(measureRouteModuleLoad('products', 12, { performanceApi: {} })).toBeNull();
  });

  it('records the first route render through the committed DOM tree', () => {
    const measure = vi.fn();
    const result = measureRouteRenderCommit('products', 10, {
      performanceApi: { measure, now: () => 19 },
    });

    expect(result).toEqual({ name: 'wangzai-route-render:products', durationMs: 9 });
    expect(measure).toHaveBeenCalledWith('wangzai-route-render:products', { start: 10, duration: 9 });
    expect(getRouteRenderMeasureName('products')).toBe('wangzai-route-render:products');
  });

  it('segments first render preparation from committed view work', () => {
    const measure = vi.fn();
    const result = measureRouteRenderPhase('products', 'model', 3, {
      performanceApi: { measure, now: () => 11 },
    });

    expect(result).toEqual({ name: 'wangzai-route-phase:products:model', durationMs: 8 });
    expect(measure).toHaveBeenCalledWith('wangzai-route-phase:products:model', { start: 3, duration: 8 });
    expect(getRouteRenderPhaseMeasureName('products', 'view')).toBe('wangzai-route-phase:products:view');
  });
});
