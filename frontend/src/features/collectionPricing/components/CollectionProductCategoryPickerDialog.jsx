import ChevronRightRounded from '@mui/icons-material/ChevronRightRounded';
import ExpandMoreRounded from '@mui/icons-material/ExpandMoreRounded';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Collapse from '@mui/material/Collapse';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';

import Dialog from '../../../shared/ui/minimizedTasks/GlobalMinimizableDialog.jsx';
import {
  buildCollectionCategoryAttributeRows,
  buildCollectionCategoryTree,
  collectionCategoryOptionKey,
  searchCollectionCategoryOptions,
} from '../lib/collectionCategoryTemplate.js';

function CategoryTreeNode({ node, expanded, selectedKey, onToggle, onSelect }) {
  const hasChildren = node.children.length > 0;
  const isExpanded = expanded.has(node.id);
  const isSelected = node.option && collectionCategoryOptionKey(node.option) === selectedKey;
  return (
    <Box>
      <Button
        fullWidth
        size="small"
        variant="text"
        onClick={() => (node.option ? onSelect(node.option) : onToggle(node.id))}
        startIcon={hasChildren ? (isExpanded ? <ExpandMoreRounded /> : <ChevronRightRounded />) : <Box sx={{ width: 24 }} />}
        sx={{
          minHeight: 36,
          justifyContent: 'flex-start',
          pl: 1 + node.depth * 2,
          borderRadius: 0.5,
          color: isSelected ? 'primary.main' : 'text.primary',
          bgcolor: isSelected ? 'primary.50' : 'transparent',
          fontWeight: node.option ? 550 : 800,
          textTransform: 'none',
        }}
      >
        <Typography variant="body2" noWrap title={node.pathText} fontWeight="inherit">{node.name}</Typography>
      </Button>
      {hasChildren ? (
        <Collapse in={isExpanded} timeout="auto" unmountOnExit>
          {node.children.map((child) => (
            <CategoryTreeNode
              key={child.id}
              node={child}
              expanded={expanded}
              selectedKey={selectedKey}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
        </Collapse>
      ) : null}
    </Box>
  );
}

function AttributeTemplateRow({ row }) {
  const statusColor = row.status === 'failed' ? 'error.main' : row.status === 'model' ? 'text.secondary' : 'success.main';
  return (
    <Box sx={{ py: 0.85, borderBottom: '1px solid', borderColor: 'divider' }}>
      <Stack direction="row" alignItems="center" spacing={0.7} minWidth={0}>
        {row.required ? <Typography component="span" variant="caption" color="error.main" fontWeight={800}>必填</Typography> : null}
        <Typography component="span" variant="body2" color="text.secondary">[{row.typeLabel}]</Typography>
        <Typography component="span" variant="body2" noWrap title={row.description || row.name}>{row.name}</Typography>
        {row.statusLabel ? (
          <Typography component="span" variant="caption" color={statusColor} fontWeight={750} sx={{ whiteSpace: 'nowrap' }}>
            {row.statusLabel}{row.status === 'loaded' && row.optionCount ? `（${row.optionCount}）` : ''}
          </Typography>
        ) : null}
      </Stack>
    </Box>
  );
}

export function CollectionProductCategoryPickerDialog({
  open = false,
  options = [],
  value = null,
  templateState = {},
  onPreview,
  onConfirm,
  onClose,
}) {
  const [query, setQuery] = React.useState('');
  const [selected, setSelected] = React.useState(value);
  const [expanded, setExpanded] = React.useState(() => new Set());
  const tree = React.useMemo(() => buildCollectionCategoryTree(options), [options]);
  const searchResults = React.useMemo(
    () => searchCollectionCategoryOptions(options, query, { limit: 300 }),
    [options, query],
  );
  const selectedKey = collectionCategoryOptionKey(selected);
  const templateMatches = Boolean(
    selected
    && templateState?.template
    && collectionCategoryOptionKey({
      descriptionCategoryId: templateState.template.descriptionCategoryId,
      typeId: templateState.template.typeId,
    }) === selectedKey
  );
  const rows = React.useMemo(() => (templateMatches ? buildCollectionCategoryAttributeRows({
    definitions: templateState.template.definitions,
    optionsByAttributeId: templateState.template.optionsByAttributeId,
    dictionaryLoadedIds: templateState.template.dictionaryLoadedIds,
    dictionaryFailedIds: templateState.template.dictionaryFailedIds,
  }) : []), [templateMatches, templateState.template]);

  React.useEffect(() => {
    if (!open) return;
    setQuery('');
    setSelected(value);
    const parts = String(value?.pathText || '').split(/\s*>\s*/u).filter(Boolean);
    const paths = new Set();
    let path = '';
    parts.slice(0, -1).forEach((part) => {
      path = path ? `${path} > ${part}` : part;
      paths.add(path);
    });
    setExpanded(paths);
    if (value) onPreview?.(value);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectOption = (option) => {
    setSelected(option);
    onPreview?.(option);
  };
  const toggle = (id) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  const loading = templateState?.status === 'loading' && templateState?.categoryKey === selectedKey;
  const ready = templateMatches && templateState?.status === 'ready' && rows.length > 0;
  const categoryLabel = selected?.name || String(selected?.pathText || '').split('>').at(-1)?.trim() || '';

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="lg" PaperProps={{ sx: { height: 'min(880px, 92vh)', borderRadius: 1.5 } }}>
      <DialogTitle sx={{ py: 1.75 }}>
        <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
          <Box>
            <Typography variant="h6" fontWeight={900}>选择 Ozon 类目</Typography>
            <Typography variant="body2" color="text.secondary">
              {loading ? `正在加载：${categoryLabel}` : ready ? `已就绪：${categoryLabel}` : '选择叶子类目后自动加载完整字段和标准选项'}
            </Typography>
          </Box>
          <Button variant="outlined" color="inherit" onClick={onClose}>关闭</Button>
        </Stack>
      </DialogTitle>
      <Divider />
      <DialogContent sx={{ p: 0, display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr)', overflow: 'hidden' }}>
        <Box sx={{ p: 1.75, borderBottom: '1px solid', borderColor: 'divider' }}>
          <TextField
            fullWidth
            size="small"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索类目名称"
            inputProps={{ 'aria-label': '搜索类目名称' }}
          />
        </Box>
        <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(320px, 1fr) minmax(420px, 1fr)', minHeight: 0 }}>
          <Box sx={{ overflowY: 'auto', p: 1.25, borderRight: '1px solid', borderColor: 'divider' }}>
            {query ? searchResults.map((option) => {
              const optionKey = collectionCategoryOptionKey(option);
              return (
                <Button
                  key={optionKey}
                  fullWidth
                  size="small"
                  onClick={() => selectOption(option)}
                  sx={{ justifyContent: 'flex-start', textTransform: 'none', borderRadius: 0.5, py: 0.8, bgcolor: optionKey === selectedKey ? 'primary.50' : 'transparent' }}
                >
                  <Typography variant="body2" textAlign="left">{option.pathText || option.name}</Typography>
                </Button>
              );
            }) : tree.map((node) => (
              <CategoryTreeNode
                key={node.id}
                node={node}
                expanded={expanded}
                selectedKey={selectedKey}
                onToggle={toggle}
                onSelect={selectOption}
              />
            ))}
          </Box>
          <Box sx={{ overflowY: 'auto', p: 2 }}>
            {loading ? (
              <Stack alignItems="center" justifyContent="center" spacing={1.25} sx={{ minHeight: 300 }}>
                <CircularProgress size={28} />
                <Typography variant="body2" color="text.secondary">正在读取类目字段和全部Ozon标准选项…</Typography>
                {templateState?.progress?.total ? (
                  <Typography variant="caption" color="text.secondary">{templateState.progress.current} / {templateState.progress.total}</Typography>
                ) : null}
              </Stack>
            ) : templateState?.status === 'error' && templateState?.categoryKey === selectedKey ? (
              <Alert severity="error">{templateState.error}</Alert>
            ) : ready ? (
              <Stack spacing={1}>
                {templateState.template.warning ? <Alert severity="warning">{templateState.template.warning}</Alert> : null}
                <Typography variant="caption" color="text.secondary">
                  共 {rows.length} 个字段 · 必填 {rows.filter((row) => row.required).length} 个 · 字典已加载 {rows.filter((row) => row.status === 'loaded').length} 个 · 系统填写 {rows.filter((row) => row.status === 'managed').length} 个
                </Typography>
                <Box>{rows.map((row) => <AttributeTemplateRow key={row.id} row={row} />)}</Box>
              </Stack>
            ) : (
              <Stack alignItems="center" justifyContent="center" sx={{ minHeight: 300 }}>
                <Typography variant="body2" color="text.secondary">请从左侧选择一个可上架的叶子类目。</Typography>
              </Stack>
            )}
          </Box>
        </Box>
      </DialogContent>
      <Divider />
      <DialogActions sx={{ px: 2.25, py: 1.5, justifyContent: 'space-between' }}>
        <Typography variant="body2" color="text.secondary">已选：{selected?.pathText || selected?.name || '—'}</Typography>
        <Button variant="contained" disabled={!ready} onClick={() => onConfirm?.(selected)}>确认选择</Button>
      </DialogActions>
    </Dialog>
  );
}
