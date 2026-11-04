import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  publishCollectionBrowserCapture,
  resetCollectionBrowserCaptureInboxForTests,
  subscribeCollectionBrowserCapture,
} from './collectionBrowserCaptureInbox.js';

beforeEach(() => resetCollectionBrowserCaptureInboxForTests());

describe('collection browser capture inbox', () => {
  it('delivers a capture published before the collection page mounts exactly once', () => {
    const capture = { productTitle: '测试商品' };
    expect(publishCollectionBrowserCapture(capture)).toBe(true);
    const first = vi.fn();
    const second = vi.fn();
    subscribeCollectionBrowserCapture(first);
    subscribeCollectionBrowserCapture(second);
    expect(first).toHaveBeenCalledWith(capture);
    expect(second).not.toHaveBeenCalled();
  });

  it('delivers live toolbar captures to the mounted workbench', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeCollectionBrowserCapture(listener);
    publishCollectionBrowserCapture({ productTitle: '实时商品' });
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});
