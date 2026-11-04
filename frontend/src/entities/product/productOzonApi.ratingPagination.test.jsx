import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('../../shared/ozon/ozonRuntime.jsx', () => ({
  requestOzonReadOnly: vi.fn(),
  isOzonAbortReadError: error => error?.name === 'AbortError',
  isOzonRetryableReadError: () => false,
}));
import { requestOzonReadOnly } from '../../shared/ozon/ozonRuntime.jsx';
import { requestOzonReadOnlyVariantsWithRows } from './productOzonApi.jsx';

const endpoint = '/v1/rating/index/fbs/posting/list';
const bodies = [{ offset: 0 }, { page: 1 }];
const rows = data => data.postings || [];
beforeEach(() => { vi.mocked(requestOzonReadOnly).mockReset(); });

for (const status of ['partial', 'canceled', 'rate_limited', 'timeout']) {
  it(`does not restart a ${status} fee sync with another request shape`, async () => {
    const error = Object.assign(new Error('isolated incomplete sync'), {
      code: 'LOCAL_RATING_SYNC_INCOMPLETE', payload: { status },
    });
    vi.mocked(requestOzonReadOnly).mockRejectedValueOnce(error).mockResolvedValue({ postings: [] });
    await expect(requestOzonReadOnlyVariantsWithRows(endpoint, {}, bodies, rows)).rejects.toBe(error);
    expect(requestOzonReadOnly).toHaveBeenCalledTimes(1);
  });
}

it('propagates a caller abort instead of trying a new fee query', async () => {
  const error = Object.assign(new Error('isolated abort'), { name: 'AbortError' });
  vi.mocked(requestOzonReadOnly).mockRejectedValueOnce(error).mockResolvedValue({ postings: [] });
  await expect(requestOzonReadOnlyVariantsWithRows(endpoint, {}, bodies, rows)).rejects.toBe(error);
  expect(requestOzonReadOnly).toHaveBeenCalledTimes(1);
});

it('retains parameter-compatibility fallback for a fully rejected first request', async () => {
  vi.mocked(requestOzonReadOnly).mockRejectedValueOnce(Object.assign(new Error('isolated bad shape'), {
    code: 'LOCAL_RATING_SYNC_INCOMPLETE', payload: { status: 'failed' },
  })).mockResolvedValue({ postings: [{ posting_number: 'fixture-posting' }] });
  expect((await requestOzonReadOnlyVariantsWithRows(endpoint, {}, bodies, rows)).postings).toHaveLength(1);
  expect(requestOzonReadOnly).toHaveBeenCalledTimes(2);
});

it('does not change compatibility fallback for other endpoints', async () => {
  vi.mocked(requestOzonReadOnly).mockRejectedValueOnce(Object.assign(new Error('isolated other endpoint'), {
    code: 'LOCAL_RATING_CACHE_INCOMPLETE',
  })).mockResolvedValue({ postings: [] });
  await expect(requestOzonReadOnlyVariantsWithRows('/fixture/unrelated', {}, bodies, rows)).resolves.toEqual({ postings: [] });
  expect(requestOzonReadOnly).toHaveBeenCalledTimes(2);
});
