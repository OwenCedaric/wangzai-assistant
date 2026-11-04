import { render, fireEvent, act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LazyHoverImagePreview } from '../shared/ui/ImagePreview.jsx';

function createRect(overrides = {}) {
  return {
    x: overrides.left ?? 0,
    y: overrides.top ?? 0,
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
    toJSON: () => ({}),
    ...overrides,
  };
}

describe('image preview placement', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('moves hover previews inside the viewport instead of shrinking or clipping the image', () => {
    vi.useFakeTimers();
    Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 1000 });
    Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 768 });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function getBoundingClientRect() {
      if (this.classList.contains('test-image-hover')) {
        return createRect({ left: 100, right: 136, top: 700, bottom: 748, width: 36, height: 48 });
      }
      if (this.classList.contains('test-image-preview')) {
        return createRect({ left: -9999, right: -9579, top: -9999, bottom: -9439, width: 420, height: 560 });
      }
      return createRect();
    });

    const { container } = render(
      <LazyHoverImagePreview
        className="test-image-hover"
        previewClassName="test-image-preview"
        imageUrl="https://example.test/image.jpg"
        alt="商品图片"
        delay={0}
      >
        <button type="button">主图</button>
      </LazyHoverImagePreview>
    );

    const hoverTarget = container.querySelector('.test-image-hover');
    act(() => {
      fireEvent.mouseEnter(hoverTarget);
      vi.runOnlyPendingTimers();
    });

    const preview = document.body.querySelector('.test-image-preview');
    expect(preview).toHaveStyle({
      position: 'fixed',
      left: '148px',
      top: '192px',
      transform: 'none',
      visibility: 'visible',
    });
    expect(preview.style.width).toBe('');
    expect(preview.style.height).toBe('');
    expect(preview.style.maxWidth).toBe('');
    expect(preview.style.maxHeight).toBe('');
  });

  it('moves hover previews to the left when the right side would be covered', () => {
    vi.useFakeTimers();
    Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 1000 });
    Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 900 });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function getBoundingClientRect() {
      if (this.classList.contains('test-image-hover')) {
        return createRect({ left: 950, right: 986, top: 160, bottom: 208, width: 36, height: 48 });
      }
      if (this.classList.contains('test-image-preview')) {
        return createRect({ left: -9999, right: -9579, top: -9999, bottom: -9439, width: 420, height: 560 });
      }
      return createRect();
    });

    const { container } = render(
      <LazyHoverImagePreview
        className="test-image-hover"
        previewClassName="test-image-preview"
        imageUrl="https://example.test/image.jpg"
        alt="商品图片"
        delay={0}
      >
        <button type="button">主图</button>
      </LazyHoverImagePreview>
    );

    act(() => {
      fireEvent.mouseEnter(container.querySelector('.test-image-hover'));
      vi.runOnlyPendingTimers();
    });

    expect(document.body.querySelector('.test-image-preview')).toHaveStyle({
      position: 'fixed',
      left: '518px',
      transform: 'none',
      visibility: 'visible',
    });
  });
});
