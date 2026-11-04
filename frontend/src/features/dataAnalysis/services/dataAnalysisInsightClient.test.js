import { beforeEach, describe, expect, it, vi } from 'vitest';

const { requestLocalApiMock } = vi.hoisted(() => ({
  requestLocalApiMock: vi.fn(),
}));

vi.mock('../../../api/localApiClient.js', () => ({
  requestLocalApi: requestLocalApiMock,
}));

import {
  DATA_ANALYSIS_INSIGHT_REQUEST_TIMEOUT_MS,
  generateDataAnalysisInsight,
} from './dataAnalysisInsightClient.js';

describe('dataAnalysisInsightClient', () => {
  beforeEach(() => {
    requestLocalApiMock.mockReset();
    requestLocalApiMock.mockResolvedValue({ ok: true, insight: '完成' });
  });

  it('allows the model request to finish after the previous three-minute cutoff', async () => {
    expect(DATA_ANALYSIS_INSIGHT_REQUEST_TIMEOUT_MS).toBe(300_000);

    await generateDataAnalysisInsight({ model: 'gpt-5.5' });

    expect(requestLocalApiMock).toHaveBeenCalledWith('/api/data-analysis/insights', expect.objectContaining({
      method: 'POST',
      timeoutMs: 300_000,
    }));
  });
});
