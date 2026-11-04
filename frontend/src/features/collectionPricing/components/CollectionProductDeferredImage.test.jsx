import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CollectionProductDeferredImage } from './CollectionProductDeferredImage.jsx';

describe('CollectionProductDeferredImage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not request an offscreen image until it reaches the viewport preload margin', () => {
    let callback = null;
    const disconnect = vi.fn();
    vi.stubGlobal('IntersectionObserver', class {
      constructor(nextCallback) {
        callback = nextCallback;
      }

      observe() {}

      disconnect() {
        disconnect();
      }
    });

    render(<CollectionProductDeferredImage src="https://img.example/offscreen.webp" alt="离屏图片" />);
    expect(screen.queryByRole('img', { name: '离屏图片' })).not.toBeInTheDocument();

    act(() => callback([{ isIntersecting: true, intersectionRatio: 1 }]));
    expect(screen.getByRole('img', { name: '离屏图片' }))
      .toHaveAttribute('src', 'https://img.example/offscreen.webp');
    expect(disconnect).toHaveBeenCalled();
  });

  it('loads priority thumbnails immediately', () => {
    render(<CollectionProductDeferredImage priority src="https://img.example/priority.webp" alt="首屏图片" />);
    const image = screen.getByRole('img', { name: '首屏图片' });
    expect(image).toHaveAttribute('src', 'https://img.example/priority.webp');
    expect(image).toHaveStyle({
      width: '100%',
      height: '100%',
      maxWidth: '100%',
      maxHeight: '100%',
      objectFit: 'contain',
      position: 'absolute',
      inset: '0',
    });
    expect(image.parentElement).toHaveStyle({
      maxWidth: '100%',
      maxHeight: '100%',
      overflow: 'hidden',
      position: 'relative',
    });
  });
});
