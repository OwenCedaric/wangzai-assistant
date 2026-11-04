import { describe, expect, it } from 'vitest';
import {
  areCrossBorderOrderCacheKeysEquivalent,
  getCrossBorderOrderRecordCacheKey,
  getCrossBorderOrderFamilyKey,
  mergeCrossBorderOrderRecordItems,
  normalizeCrossBorderOrderCacheRecord,
} from './crossBorderOrderCache.js';

describe('crossBorderOrderCache', () => {
  it('matches cached cross-border records across child posting and compact order key variants', () => {
    expect(getCrossBorderOrderFamilyKey('11279330-0313-1')).toBe('11279330-0313');
    expect(areCrossBorderOrderCacheKeysEquivalent('11279330-0313-1', '11279330-0313-2')).toBe(true);
    expect(areCrossBorderOrderCacheKeysEquivalent('11279330-0313-1', '1127933003131')).toBe(true);
    expect(areCrossBorderOrderCacheKeysEquivalent('11279330-0313-1', '67012372-0248-1')).toBe(false);

    const record = normalizeCrossBorderOrderCacheRecord(
      {
        order_id: 'bus-1',
        platform_order: '11279330-0313-1',
      },
      { shopClientId: 'client-a', cachedAt: '2026-06-24T00:00:00.000Z' }
    );
    const searchValues = [
      record.id,
      record.orderId,
      record.orderNumber,
      record.platformOrder,
      record.fromOrder,
      record.purchaseOrderNumber,
    ].filter(Boolean);

    expect(searchValues.some((value) => areCrossBorderOrderCacheKeysEquivalent(value, '11279330-0313-2'))).toBe(true);
    expect(searchValues.some((value) => areCrossBorderOrderCacheKeysEquivalent(value, '1127933003131'))).toBe(true);
  });

  it('normalizes common cross-border order identifiers for local search reuse', () => {
    const record = normalizeCrossBorderOrderCacheRecord(
      {
        order_id: 'bus-1',
        platform_order: '11279330-0313-1',
        from_order: 'purchase-1',
        tracking_number: 'track-1',
      },
      { shopClientId: 'client-a', cachedAt: '2026-06-24T00:00:00.000Z' }
    );

    expect(record).toMatchObject({
      id: 'bus-1',
      orderId: 'bus-1',
      orderNumber: '11279330-0313-1',
      purchaseOrderNumber: 'purchase-1',
      trackingNumber: 'track-1',
      shopClientId: 'client-a',
    });
    expect(getCrossBorderOrderRecordCacheKey(record, { shopClientId: 'client-a' })).toBe('client-a:bus-1');
  });

  it('merges fresh records without duplicates or empty-field overwrites', () => {
    const items = mergeCrossBorderOrderRecordItems(
      [
        {
          orderId: 'bus-1',
          orderNumber: '11279330-0313-1',
          status: '已提单',
          packageWeight: '1 kg',
        },
      ],
      [
        {
          order_id: 'bus-1',
          platform_order: '11279330-0313-1',
          status: '',
          package_size: '10x20x30',
        },
      ],
      { shopClientId: 'client-a', cachedAt: '2026-06-24T00:00:00.000Z' }
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      orderId: 'bus-1',
      orderNumber: '11279330-0313-1',
      status: '已提单',
      packageWeight: '1 kg',
      package_size: '10x20x30',
    });
  });

  it('keeps protected local manual fields when API records are merged', () => {
    const items = mergeCrossBorderOrderRecordItems(
      [
        {
          orderId: 'bus-1',
          manualNote: '人工核对',
          manualStatus: '保留',
        },
      ],
      [
        {
          order_id: 'bus-1',
          manualNote: '接口覆盖',
          manualStatus: '接口覆盖',
          status: '运输中',
        },
      ],
      { shopClientId: 'client-a', cachedAt: '2026-06-24T00:00:00.000Z' }
    );

    expect(items[0]).toMatchObject({
      manualNote: '人工核对',
      manualStatus: '保留',
      status: '运输中',
    });
  });

  it('keeps same cross-border order id isolated by shop client id when merging another shop', () => {
    const items = mergeCrossBorderOrderRecordItems(
      [
        {
          shopClientId: 'client-a',
          orderId: 'bus-1',
          orderNumber: '11279330-0313-1',
          status: 'A店已提单',
        },
      ],
      [
        {
          order_id: 'bus-1',
          platform_order: '11279330-0313-1',
          status: 'B店已提单',
        },
      ],
      { shopClientId: 'client-b', cachedAt: '2026-06-24T00:00:00.000Z' }
    );

    expect(items).toHaveLength(2);
    expect(items.map((item) => getCrossBorderOrderRecordCacheKey(item)).sort()).toEqual([
      'client-a:bus-1',
      'client-b:bus-1',
    ]);
    expect(items.find((item) => item.shopClientId === 'client-a')).toMatchObject({ status: 'A店已提单' });
    expect(items.find((item) => item.shopClientId === 'client-b')).toMatchObject({ status: 'B店已提单' });
  });

  it('keeps old and rebound internal shops isolated when they reuse the same client id and order id', () => {
    const items = mergeCrossBorderOrderRecordItems(
      [
        {
          shopId: 'shop-old',
          shopClientId: 'client-rebound',
          orderId: 'bus-1',
          orderNumber: '11279330-0313-1',
          status: '旧店记录',
        },
      ],
      [
        {
          order_id: 'bus-1',
          platform_order: '11279330-0313-1',
          status: '新店记录',
        },
      ],
      {
        shopId: 'shop-new',
        shopClientId: 'client-rebound',
        cachedAt: '2026-07-17T00:00:00.000Z',
      }
    );

    expect(items).toHaveLength(2);
    expect(items.map((item) => getCrossBorderOrderRecordCacheKey(item)).sort()).toEqual([
      'shop-new:bus-1',
      'shop-old:bus-1',
    ]);
    expect(items.find((item) => item.shopId === 'shop-old')).toMatchObject({ status: '旧店记录' });
    expect(items.find((item) => item.shopId === 'shop-new')).toMatchObject({ status: '新店记录' });
  });
});
