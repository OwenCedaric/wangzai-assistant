import { describe, expect, it } from 'vitest';
import { normalizeProfitReviewPresentation } from './smartToolProfitReviewConfig.js';

describe('smartToolProfitReviewConfig', () => {
  it('uses editable compact report defaults and preserves explicit switches', () => {
    expect(normalizeProfitReviewPresentation()).toMatchObject({
      density: 'compact',
      paragraphIndent: true,
      showAssistantBrand: true,
      showMarketSignal: true,
    });
    expect(normalizeProfitReviewPresentation({
      assistantName: '我的分析助手',
      paragraphIndent: false,
      showModel: false,
    })).toMatchObject({
      assistantName: '我的分析助手',
      paragraphIndent: false,
      showModel: false,
    });
  });
});
