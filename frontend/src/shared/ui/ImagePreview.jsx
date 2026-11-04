import { safeImageUrl } from '../lib/imageUrlRules.js';
import Inventory2Rounded from '@mui/icons-material/Inventory2Rounded';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import React from 'react';
import { createPortal } from 'react-dom';

export function LazyHoverImagePreview({ className, previewClassName, imageUrl, alt, children, delay = 200 }) {
  const [shouldRenderPreview, setShouldRenderPreview] = React.useState(false);
  const [previewPlacement, setPreviewPlacement] = React.useState(null);
  const anchorRef = React.useRef(null);
  const previewRef = React.useRef(null);
  const hoverTimerRef = React.useRef(null);

  const updatePreviewPlacement = React.useCallback(() => {
    if (typeof window === 'undefined' || !anchorRef.current || !previewRef.current) return;
    const anchorRect = anchorRef.current.getBoundingClientRect();
    const previewRect = previewRef.current.getBoundingClientRect();
    const viewportWidth = document.documentElement?.clientWidth || window.innerWidth || 0;
    const viewportHeight = document.documentElement?.clientHeight || window.innerHeight || 0;
    const gap = 12;
    const margin = 16;

    let left = anchorRect.right + gap;
    if (left + previewRect.width > viewportWidth - margin) {
      const leftSide = anchorRect.left - previewRect.width - gap;
      left = leftSide >= margin ? leftSide : Math.max(margin, viewportWidth - previewRect.width - margin);
    }

    let top = anchorRect.top + anchorRect.height / 2 - previewRect.height / 2;
    if (top + previewRect.height > viewportHeight - margin) {
      top = viewportHeight - previewRect.height - margin;
    }
    top = Math.max(margin, top);

    setPreviewPlacement((current) => {
      if (current?.left === left && current?.top === top) return current;
      return { left, top };
    });
  }, []);

  const clearHoverTimer = React.useCallback(() => {
    if (!hoverTimerRef.current) return;
    window.clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = null;
  }, []);

  const handleMouseEnter = React.useCallback(() => {
    if (!imageUrl || typeof window === 'undefined') return;
    clearHoverTimer();
    hoverTimerRef.current = window.setTimeout(() => {
      setPreviewPlacement(null);
      setShouldRenderPreview(true);
      hoverTimerRef.current = null;
    }, delay);
  }, [clearHoverTimer, delay, imageUrl]);

  const handleMouseLeave = React.useCallback(() => {
    clearHoverTimer();
    setShouldRenderPreview(false);
    setPreviewPlacement(null);
  }, [clearHoverTimer]);

  React.useLayoutEffect(() => {
    if (!shouldRenderPreview || typeof window === 'undefined') return undefined;
    updatePreviewPlacement();
    const scheduleFrame =
      typeof window.requestAnimationFrame === 'function'
        ? window.requestAnimationFrame
        : (callback) => window.setTimeout(callback, 0);
    const cancelFrame =
      typeof window.cancelAnimationFrame === 'function' ? window.cancelAnimationFrame : window.clearTimeout;
    const frameId = scheduleFrame(updatePreviewPlacement);
    return () => cancelFrame(frameId);
  }, [shouldRenderPreview, updatePreviewPlacement]);

  React.useEffect(() => {
    if (!shouldRenderPreview || typeof window === 'undefined') return undefined;
    window.addEventListener('resize', updatePreviewPlacement);
    window.addEventListener('scroll', updatePreviewPlacement, true);
    return () => {
      window.removeEventListener('resize', updatePreviewPlacement);
      window.removeEventListener('scroll', updatePreviewPlacement, true);
    };
  }, [shouldRenderPreview, updatePreviewPlacement]);

  React.useEffect(() => () => clearHoverTimer(), [clearHoverTimer]);

  const previewStyle = shouldRenderPreview
    ? {
        position: 'fixed',
        left: previewPlacement ? `${previewPlacement.left}px` : '-9999px',
        top: previewPlacement ? `${previewPlacement.top}px` : '-9999px',
        right: 'auto',
        bottom: 'auto',
        transform: 'none',
        visibility: previewPlacement ? 'visible' : 'hidden',
      }
    : undefined;

  return (
    <Box ref={anchorRef} className={className} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave}>
      {children}
      {imageUrl && shouldRenderPreview && typeof document !== 'undefined'
        ? createPortal(
            <Box
              ref={previewRef}
              className={previewClassName}
              style={{
                ...previewStyle,
                // Preview coordinates are measured in viewport space. Rendering
                // at document.body keeps them out of the workspace CSS zoom
                // context, so every list uses the same coordinate system.
                display: 'block',
              }}
            >
              <Box
                component="img"
                src={imageUrl}
                alt={alt}
                referrerPolicy="no-referrer"
                onLoad={updatePreviewPlacement}
              />
            </Box>,
            document.body,
          )
        : null}
    </Box>
  );
}

export function OrderImagePreviewSlot({ preview, variant = 'sales' }) {
  const imageUrl = safeImageUrl(preview?.image);
  const prefix = variant === 'purchase' ? 'purchase-order' : 'sales-order';

  return (
    <LazyHoverImagePreview
      className={`${prefix}-image-hover`}
      previewClassName={`${prefix}-image-preview`}
      imageUrl={imageUrl}
      alt={preview?.alt || 'Ozon 商品图片'}
    >
      <Box className={`${prefix}-image-thumb${imageUrl ? '' : ' empty'}`}>
        {imageUrl ? (
          <Box
            component="img"
            src={imageUrl}
            alt={preview?.alt || 'Ozon 商品图片'}
            loading="eager"
            decoding="async"
            fetchPriority="high"
            referrerPolicy="no-referrer"
          />
        ) : (
          <Inventory2Rounded fontSize="small" />
        )}
      </Box>
      <Typography variant="caption" className={`${prefix}-image-label`}>
        {preview?.label || '未返回'}
      </Typography>
    </LazyHoverImagePreview>
  );
}
