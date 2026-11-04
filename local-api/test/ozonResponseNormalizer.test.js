import assert from 'node:assert/strict';
import test from 'node:test';
import { getOzonEndpoint } from '../src/ozon/ozonEndpointRegistry.js';
import { normalizeOzonResponse } from '../src/ozon/ozonResponseNormalizer.js';

test('rFBS return detail endpoint extracts object-shaped v2 returns payload as one entity row', () => {
  const endpoint = getOzonEndpoint('returns.rfbsGet');
  assert.equal(endpoint.responseShape.itemsPath, 'returns');
  assert.equal(endpoint.rate.bucket, 'returns.rfbs.detail');
  assert.equal(endpoint.rate.minIntervalMs, 1000);

  const normalized = normalizeOzonResponse({
    domain: 'returns',
    endpointKey: 'returns.rfbsGet',
    params: { return_id: 92675795 },
    response: {
      ok: true,
      data: {
        returns: {
          posting_number: '14885060-0318-1',
          return_reason: { name: 'Покупатель отказался при вручении: товар не подошел' },
        },
      },
    },
  });

  assert.equal(normalized.rowCount, 1);
  assert.equal(normalized.rows[0].posting_number, '14885060-0318-1');
  assert.equal(normalized.rows[0].return_reason.name, 'Покупатель отказался при вручении: товар не подошел');
});
