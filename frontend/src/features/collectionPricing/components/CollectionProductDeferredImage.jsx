import Box from '@mui/material/Box';
import React from 'react';

const DEFAULT_ROOT_MARGIN = '320px';

export function CollectionProductDeferredImage({
  src = '',
  alt = '',
  priority = false,
  rootMargin = DEFAULT_ROOT_MARGIN,
  onLoad,
  onError,
  sx,
  imgSx,
}) {
  const hostRef = React.useRef(null);
  const [shouldLoad, setShouldLoad] = React.useState(Boolean(priority));

  React.useEffect(() => {
    if (!src) {
      setShouldLoad(false);
      return undefined;
    }
    if (priority || typeof globalThis.IntersectionObserver !== 'function') {
      setShouldLoad(true);
      return undefined;
    }
    setShouldLoad(false);
    const observer = new globalThis.IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting || entry.intersectionRatio > 0)) return;
      setShouldLoad(true);
      observer.disconnect();
    }, { root: null, rootMargin, threshold: 0.01 });
    if (hostRef.current) observer.observe(hostRef.current);
    return () => observer.disconnect();
  }, [priority, rootMargin, src]);

  return (
    <Box
      ref={hostRef}
      data-image-deferred={priority ? 'priority' : 'viewport'}
      sx={{
        width: '100%',
        height: '100%',
        minWidth: 0,
        minHeight: 0,
        maxWidth: '100%',
        maxHeight: '100%',
        overflow: 'hidden',
        display: 'grid',
        placeItems: 'center',
        ...sx,
        position: 'relative',
      }}
    >
      {shouldLoad && src ? (
        <Box
          component="img"
          src={src}
          alt={alt}
          loading={priority ? 'eager' : 'lazy'}
          fetchPriority={priority ? 'high' : 'auto'}
          decoding="async"
          referrerPolicy="no-referrer"
          onLoad={onLoad}
          onError={onError}
          style={{
            width: '100%',
            height: '100%',
            maxWidth: '100%',
            maxHeight: '100%',
            objectFit: 'contain',
            display: 'block',
            position: 'absolute',
            inset: 0,
          }}
          sx={{
            width: '100%',
            height: '100%',
            minWidth: 0,
            minHeight: 0,
            maxWidth: '100%',
            maxHeight: '100%',
            objectFit: 'contain',
            display: 'block',
            position: 'absolute',
            inset: 0,
            ...imgSx,
          }}
        />
      ) : null}
    </Box>
  );
}
