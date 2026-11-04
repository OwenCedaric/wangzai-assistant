import Inventory2Outlined from '@mui/icons-material/Inventory2Outlined';
import OpenInNewRounded from '@mui/icons-material/OpenInNewRounded';
import SearchRounded from '@mui/icons-material/SearchRounded';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import React from 'react';
import {
  getInternalBrowserLinkErrorMessage,
  openInternalBrowserLink,
} from '../../../services/internalBrowserLinkClient.js';

function text(value) {
  return String(value ?? '').trim();
}

function SourceImage({ item }) {
  if (!item?.image) {
    return (
      <Box className="prompt-library-product-selection-source-image is-empty" aria-hidden="true">
        <Inventory2Outlined />
      </Box>
    );
  }
  return (
    <Box
      component="img"
      className="prompt-library-product-selection-source-image"
      src={item.image}
      alt=""
      loading="lazy"
    />
  );
}

export function PromptLibraryProductSelectionSources({ sourceSearch = null }) {
  const [openError, setOpenError] = React.useState('');
  if (!sourceSearch) return null;
  const candidates = Array.isArray(sourceSearch.candidates) ? sourceSearch.candidates : [];
  const searches = Array.isArray(sourceSearch.searches) ? sourceSearch.searches : [];
  const openSource = async (url) => {
    setOpenError('');
    try {
      await openInternalBrowserLink(url, { platformName: '1688' });
    } catch (error) {
      setOpenError(getInternalBrowserLinkErrorMessage(error));
    }
  };

  return (
    <Box component="section" className="prompt-library-product-selection-sources">
      <Box className="prompt-library-product-selection-sources-head">
        <Box className="prompt-library-product-selection-sources-title">
          <Box className="prompt-library-product-selection-sources-icon" aria-hidden="true">
            <Inventory2Outlined />
          </Box>
          <Box minWidth={0}>
            <Typography component="h2">1688 候选货源</Typography>
            <Typography component="p">
              {text(sourceSearch.message) || '根据 Ozon 代表商品自动寻找可继续核对的货源。'}
            </Typography>
          </Box>
        </Box>
        <Typography component="span" className="prompt-library-product-selection-sources-status">
          {text(sourceSearch.statusLabel) || '等待核对'}
        </Typography>
      </Box>

      {searches.length ? (
        <Box className="prompt-library-product-selection-keyword-searches">
          <Typography component="span">中文找货词</Typography>
          <Box>
            {searches.map((item, index) => (
              <Button
                key={`${item.query}-${index}`}
                size="small"
                variant="outlined"
                endIcon={<OpenInNewRounded />}
                onClick={() => openSource(item.url)}
              >
                {item.query}
              </Button>
            ))}
          </Box>
        </Box>
      ) : null}

      {candidates.length ? (
        <Box className="prompt-library-product-selection-source-grid">
          {candidates.map((item, index) => (
            <Box className="prompt-library-product-selection-source-card" key={item.id || `${item.link}-${index}`}>
              <SourceImage item={item} />
              <Box className="prompt-library-product-selection-source-copy">
                <Typography component="h3" title={item.title || ''}>
                  {item.title || `候选货源 ${index + 1}`}
                </Typography>
                <Typography component="p">{item.hint || '请人工核对价格、规格和起订量'}</Typography>
                <Button
                  size="small"
                  endIcon={<OpenInNewRounded />}
                  onClick={() => openSource(item.link)}
                >
                  查看货源
                </Button>
              </Box>
            </Box>
          ))}
        </Box>
      ) : (
        <Box className="prompt-library-product-selection-source-empty">
          <SearchRounded />
          <Typography>{sourceSearch.statusLabel || '暂未返回可展示的候选商品'}</Typography>
        </Box>
      )}

      <Box className="prompt-library-product-selection-source-actions">
        {sourceSearch.searchUrl ? (
          <Button size="small" variant="outlined" onClick={() => openSource(sourceSearch.searchUrl)}>
            {sourceSearch.imageSearchUrl ? '打开完整识图结果' : '打开 1688 搜索'}
          </Button>
        ) : null}
        {sourceSearch.keywordSearchUrl && sourceSearch.keywordSearchUrl !== sourceSearch.searchUrl ? (
          <Button size="small" variant="text" onClick={() => openSource(sourceSearch.keywordSearchUrl)}>
            按关键词继续搜索
          </Button>
        ) : null}
        {sourceSearch.sourceImage?.title ? (
          <Typography component="span">
            识图参考：{sourceSearch.sourceImage.title}
          </Typography>
        ) : null}
      </Box>
      {openError ? (
        <Typography className="prompt-library-product-selection-source-error">{openError}</Typography>
      ) : null}
    </Box>
  );
}
