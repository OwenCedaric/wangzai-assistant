import ButtonBase from '@mui/material/ButtonBase';
import React from 'react';
import {
  buildOzonProductPageUrl,
  getOzonProductPageErrorMessage,
  openOzonProductPage,
} from '../../../services/ozonProductPageLink.js';

/**
 * Product titles in analysis use the same single internal-browser route as
 * the product list. When a row only has a title, the shared resolver opens an
 * Ozon search result; when it has an Ozon id or URL, it opens the exact page.
 */
export function DataAnalysisProductLink({ source, children, onError, ariaLabel = '打开 Ozon 商品页面', className = '', sx }) {
  const url = buildOzonProductPageUrl(source);
  if (!url) return children;

  const handleClick = async () => {
    try {
      await openOzonProductPage(source);
    } catch (error) {
      onError?.(getOzonProductPageErrorMessage(error));
    }
  };

  return (
    <ButtonBase
      type="button"
      className={className}
      aria-label={ariaLabel}
      onClick={() => void handleClick()}
      sx={{
        display: 'block',
        width: '100%',
        minWidth: 0,
        maxWidth: '100%',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        borderRadius: 1,
        justifyContent: 'flex-start',
        textAlign: 'left',
        '&:hover': { color: 'primary.main' },
        '& > .MuiTypography-root': {
          display: 'block',
          minWidth: 0,
          maxWidth: '100%',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        },
        ...sx,
      }}
    >
      {children}
    </ButtonBase>
  );
}
