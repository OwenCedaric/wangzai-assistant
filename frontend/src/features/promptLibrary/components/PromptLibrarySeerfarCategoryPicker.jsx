import ChevronRightRounded from '@mui/icons-material/ChevronRightRounded';
import KeyboardArrowLeftRounded from '@mui/icons-material/KeyboardArrowLeftRounded';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import ClickAwayListener from '@mui/material/ClickAwayListener';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import Paper from '@mui/material/Paper';
import Popper from '@mui/material/Popper';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import { loadSmartToolSeerfarCategoryOptions } from '../services/smartToolSeerfarCategoryService.js';

const CATEGORY_ID_PATTERN = /^\d+(?:_\d+)*$/u;

function getNodeLabel(node) {
  return node?.cnTitle || node?.title || node?.id || '';
}

export function PromptLibrarySeerfarCategoryPicker({
  label,
  value = '',
  placeholder = '',
  helperText = '',
  error = false,
  errorText = '',
  onChange = () => {},
}) {
  const fieldRef = React.useRef(null);
  const [anchorEl, setAnchorEl] = React.useState(null);
  const [query, setQuery] = React.useState(String(value || ''));
  const deferredQuery = React.useDeferredValue(String(query || '').trim());
  const [options, setOptions] = React.useState([]);
  const [selectedNode, setSelectedNode] = React.useState(null);
  const [branchNodes, setBranchNodes] = React.useState([]);
  const [loading, setLoading] = React.useState(false);
  const [loadError, setLoadError] = React.useState('');
  const open = Boolean(anchorEl);

  React.useEffect(() => {
    if (open) return;
    setQuery(selectedNode?.pathText || String(value || ''));
  }, [open, selectedNode?.pathText, value]);

  const currentParentId = branchNodes[branchNodes.length - 1]?.id || '0';
  React.useEffect(() => {
    if (!open) return undefined;
    const controller = new AbortController();
    let active = true;
    const delay = deferredQuery ? 180 : 0;
    const timer = setTimeout(() => {
      setLoading(true);
      setLoadError('');
      loadSmartToolSeerfarCategoryOptions({
        query: deferredQuery,
        parentId: currentParentId,
        limit: 80,
        signal: controller.signal,
      })
        .then((result) => {
          if (!active) return;
          const nextOptions = Array.isArray(result?.nodes) ? result.nodes : [];
          setOptions(nextOptions);
          const exact = nextOptions.find((node) => node.id === String(value || ''));
          if (exact) setSelectedNode(exact);
        })
        .catch((loadFailure) => {
          if (!active || loadFailure?.name === 'AbortError') return;
          setOptions([]);
          setLoadError(loadFailure instanceof Error ? loadFailure.message : '类目树加载失败');
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, delay);
    return () => {
      active = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [currentParentId, deferredQuery, open, value]);

  const openPicker = React.useCallback(() => {
    if (fieldRef.current) setAnchorEl(fieldRef.current);
  }, []);

  const closePicker = React.useCallback(() => {
    setAnchorEl(null);
    setQuery(selectedNode?.pathText || String(value || ''));
  }, [selectedNode?.pathText, value]);

  const openTreeBrowser = React.useCallback((event) => {
    event.preventDefault();
    event.stopPropagation();
    setQuery('');
    setBranchNodes([]);
    openPicker();
  }, [openPicker]);

  const selectNode = React.useCallback((node) => {
    if (!node?.id) return;
    setSelectedNode(node);
    onChange(node.id);
    setQuery(node.pathText || getNodeLabel(node));
    setAnchorEl(null);
  }, [onChange]);

  const commitManualId = React.useCallback(() => {
    const manualId = String(query || '').trim();
    if (!CATEGORY_ID_PATTERN.test(manualId)) return false;
    const matched = options.find((node) => node.id === manualId);
    if (matched) setSelectedNode(matched);
    onChange(manualId);
    setQuery(matched?.pathText || manualId);
    setAnchorEl(null);
    return true;
  }, [onChange, options, query]);

  const showSearchRows = deferredQuery.length > 0;

  return (
    <Box className="prompt-library-seerfar-category-field" ref={fieldRef}>
      <TextField
        className="prompt-library-standard-usage-field"
        size="small"
        label={label}
        value={query}
        placeholder={placeholder}
        error={error}
        helperText={error ? errorText : helperText}
        autoComplete="off"
        onFocus={openPicker}
        onClick={openPicker}
        onChange={(event) => {
          setQuery(event.target.value);
          setBranchNodes([]);
          openPicker();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && commitManualId()) event.preventDefault();
          if (event.key === 'Escape') closePicker();
        }}
        InputProps={{
          endAdornment: (
            <InputAdornment position="end">
              <Button className="prompt-library-seerfar-category-open" onClick={openTreeBrowser} size="small">
                类目树
              </Button>
            </InputAdornment>
          ),
        }}
        fullWidth
      />

      {selectedNode ? (
        <Box className="prompt-library-seerfar-category-selected">
          <Typography variant="caption" title={selectedNode.pathText}>{selectedNode.pathText}</Typography>
          <Typography variant="caption">ID {selectedNode.id}</Typography>
        </Box>
      ) : value ? (
        <Typography className="prompt-library-seerfar-category-manual" variant="caption">
          当前类目 ID：{value}
        </Typography>
      ) : null}

      <Popper
        className="prompt-library-seerfar-category-popper"
        open={open}
        anchorEl={anchorEl}
        placement="bottom-start"
        modifiers={[{ name: 'offset', options: { offset: [0, 5] } }]}
      >
        <ClickAwayListener
          mouseEvent="onMouseDown"
          onClickAway={(event) => {
            if (fieldRef.current?.contains(event.target)) return;
            closePicker();
          }}
        >
          <Paper className="prompt-library-seerfar-category-popover" elevation={0}>
            <Box className="prompt-library-seerfar-category-popover-head">
              <Box>
                <Typography variant="subtitle2">{showSearchRows ? '搜索结果' : '选择类目'}</Typography>
                <Typography variant="caption">
                  {showSearchRows ? `正在匹配“${deferredQuery}”` : '按层级选择，也可在上方直接搜索'}
                </Typography>
              </Box>
              {CATEGORY_ID_PATTERN.test(String(query || '').trim()) ? (
                <Button onClick={commitManualId} size="small">使用这个 ID</Button>
              ) : null}
            </Box>

            {!showSearchRows && branchNodes.length ? (
              <Box className="prompt-library-seerfar-category-breadcrumb">
                <IconButton
                  aria-label="返回上一级类目"
                  onClick={() => setBranchNodes((current) => current.slice(0, -1))}
                  size="small"
                >
                  <KeyboardArrowLeftRounded />
                </IconButton>
                <Typography variant="caption">
                  {branchNodes.map(getNodeLabel).filter(Boolean).join(' / ')}
                </Typography>
              </Box>
            ) : null}

            <Box className="prompt-library-seerfar-category-list">
              {loading ? (
                <Box className="prompt-library-seerfar-category-state">
                  <CircularProgress size={20} />
                  <Typography variant="body2">正在读取类目…</Typography>
                </Box>
              ) : loadError ? (
                <Box className="prompt-library-seerfar-category-state is-error">
                  <Typography variant="body2">{loadError}</Typography>
                  <Typography variant="caption">仍可直接输入完整类目 ID。</Typography>
                </Box>
              ) : options.length ? (
                options.map((node) => (
                  <Box
                    className="prompt-library-seerfar-category-option"
                    key={node.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      if (showSearchRows || !node.hasChildren) selectNode(node);
                      else {
                        setBranchNodes((current) => [...current, node]);
                        setQuery('');
                      }
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter') return;
                      if (showSearchRows || !node.hasChildren) selectNode(node);
                      else {
                        setBranchNodes((current) => [...current, node]);
                        setQuery('');
                      }
                    }}
                  >
                    <Box className="prompt-library-seerfar-category-option-copy">
                      <Typography variant="body2">{getNodeLabel(node)}</Typography>
                      <Typography variant="caption" title={node.pathText}>
                        {showSearchRows ? node.pathText : node.title || node.enTitle || `ID ${node.id}`}
                      </Typography>
                      <Typography variant="caption">ID {node.id}</Typography>
                    </Box>
                    {node.hasChildren && !showSearchRows ? (
                      <Box className="prompt-library-seerfar-category-option-actions">
                        <Button
                          onClick={(event) => {
                            event.stopPropagation();
                            selectNode(node);
                          }}
                          size="small"
                        >
                          选择
                        </Button>
                        <ChevronRightRounded />
                      </Box>
                    ) : (
                      <Typography className="prompt-library-seerfar-category-select-label" variant="caption">选择</Typography>
                    )}
                  </Box>
                ))
              ) : (
                <Box className="prompt-library-seerfar-category-state">
                  <Typography variant="body2">没有找到匹配类目</Typography>
                  <Typography variant="caption">换个中文、俄文名称，或直接输入 ID。</Typography>
                </Box>
              )}
            </Box>
          </Paper>
        </ClickAwayListener>
      </Popper>
    </Box>
  );
}
