import { afterEach, describe, expect, it } from 'vitest';
import {
  getRendererTreeMeasureName,
  isRendererTreeTelemetryEnabled,
  markRendererTreeRender,
} from './rendererTreeTelemetry.js';

afterEach(() => {
  delete globalThis.__wangzaiRendererTreeTelemetryEnabled;
});

describe('renderer tree telemetry', () => {
  it('stays disabled unless the isolated performance fixture explicitly enables it', () => {
    expect(isRendererTreeTelemetryEnabled()).toBe(false);
    expect(markRendererTreeRender('products:page-view', 0)).toBeNull();
  });

  it('uses a stable user timing name only when enabled', () => {
    globalThis.__wangzaiRendererTreeTelemetryEnabled = true;
    expect(getRendererTreeMeasureName('products:page-view')).toBe('wangzai-render-tree:products:page-view');
    expect(markRendererTreeRender('products:page-view', performance.now())).toEqual(
      expect.objectContaining({ name: 'wangzai-render-tree:products:page-view' })
    );
  });
});
