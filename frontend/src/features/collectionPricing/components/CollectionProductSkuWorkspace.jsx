import AddRounded from '@mui/icons-material/AddRounded';
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded';
import ImageOutlined from '@mui/icons-material/ImageOutlined';
import SearchRounded from '@mui/icons-material/SearchRounded';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TablePagination from '@mui/material/TablePagination';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';

import { getCollectionProductImageUrls } from '../lib/collectionProductImageUrl.js';

function CompactInput({ label, value, onChange, width = '100%' }) {
  return (
    <TextField
      size="small" value={value ?? ''} onChange={(event) => onChange(event.target.value)}
      inputProps={{ 'aria-label': label }}
      sx={{ width, '& .MuiInputBase-input': { px: 0.75, py: 0.65, fontSize: 12.5 } }}
    />
  );
}

function SkuImage({ sku }) {
  const sources = React.useMemo(() => getCollectionProductImageUrls(sku.imageUrl), [sku.imageUrl]);
  const [sourceIndex, setSourceIndex] = React.useState(0);
  React.useEffect(() => setSourceIndex(0), [sku.imageUrl]);
  const source = sources[sourceIndex] || '';
  return (
    <Box sx={{ width: 34, height: 34, flex: '0 0 34px', display: 'grid', placeItems: 'center', borderRadius: 0.5, bgcolor: '#f2f4f7', overflow: 'hidden' }}>
      {source ? (
        <Box component="img" src={source} alt="" referrerPolicy="no-referrer" onError={() => setSourceIndex((value) => value + 1)} sx={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      ) : <ImageOutlined sx={{ fontSize: 18, color: '#98a2b3' }} />}
    </Box>
  );
}

function duplicateValues(items, field) {
  const counts = new Map();
  items.forEach((item) => {
    const value = String(item[field] || '').trim().toLowerCase();
    if (value) counts.set(value, (counts.get(value) || 0) + 1);
  });
  return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([value]) => value));
}

export function CollectionProductSkuWorkspace({ skus, onChange }) {
  const [query, setQuery] = React.useState('');
  const [page, setPage] = React.useState(0);
  const [rowsPerPage, setRowsPerPage] = React.useState(50);
  const [bulk, setBulk] = React.useState({ price: '', weightG: '', packageLengthCm: '', packageWidthCm: '', packageHeightCm: '' });
  const duplicateIds = React.useMemo(() => duplicateValues(skus, 'id'), [skus]);
  const duplicateNames = React.useMemo(() => duplicateValues(skus, 'name'), [skus]);
  const filtered = React.useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return skus.map((sku, index) => ({ sku, index })).filter(({ sku }) => {
      const attributeText = (sku.attributes || []).map((item) => (
        item && typeof item === 'object' ? `${item.name || ''} ${item.value || ''}` : String(item || '')
      )).join(' ');
      return !keyword || `${sku.id} ${sku.name} ${attributeText}`.toLowerCase().includes(keyword);
    });
  }, [query, skus]);
  const visible = filtered.slice(page * rowsPerPage, page * rowsPerPage + rowsPerPage);

  React.useEffect(() => {
    const maxPage = Math.max(0, Math.ceil(filtered.length / rowsPerPage) - 1);
    if (page > maxPage) setPage(maxPage);
  }, [filtered.length, page, rowsPerPage]);

  const update = (index, field, value) => {
    onChange(skus.map((sku, rowIndex) => rowIndex === index ? { ...sku, [field]: value } : sku));
  };

  const applyBulk = () => {
    const fields = Object.entries(bulk).filter(([, value]) => String(value).trim());
    if (!fields.length) return;
    const targetIndexes = new Set(filtered.map((item) => item.index));
    onChange(skus.map((sku, index) => targetIndexes.has(index) ? { ...sku, ...Object.fromEntries(fields) } : sku));
  };

  return (
    <Stack sx={{ height: '100%', minHeight: 0 }}>
      <Box sx={{ px: 1.25, py: 1, borderBottom: '1px solid', borderColor: 'divider' }}>
        <Stack direction="row" spacing={0.75} alignItems="center">
          <Box sx={{ minWidth: 170 }}>
            <Typography variant="subtitle1" fontWeight={850}>SKU 编辑</Typography>
            <Typography variant="caption" color="text.secondary">{filtered.length} / {skus.length} 条</Typography>
          </Box>
          <TextField
            size="small" placeholder="搜索 SKU、规格或属性" value={query}
            onChange={(event) => { setQuery(event.target.value); setPage(0); }}
            sx={{ width: 230 }}
            InputProps={{ startAdornment: <InputAdornment position="start"><SearchRounded fontSize="small" /></InputAdornment> }}
          />
          {['price', 'weightG', 'packageLengthCm', 'packageWidthCm', 'packageHeightCm'].map((field) => (
            <TextField
              key={field} size="small"
              label={{ price: '批量价格', weightG: '重量 g', packageLengthCm: '长 cm', packageWidthCm: '宽 cm', packageHeightCm: '高 cm' }[field]}
              value={bulk[field]} onChange={(event) => setBulk((current) => ({ ...current, [field]: event.target.value }))}
              sx={{ width: field === 'price' ? 100 : 82 }}
            />
          ))}
          <Button size="small" variant="outlined" onClick={applyBulk}>应用到筛选结果</Button>
          <Button
            size="small" variant="outlined" startIcon={<AddRounded />} sx={{ ml: 'auto' }}
            onClick={() => onChange([...skus, {
              id: `sku-${Date.now()}`, name: '新规格', attributes: [], price: '', imageUrl: '', enabled: true,
              weightG: '', packageLengthCm: '', packageWidthCm: '', packageHeightCm: '', option: null,
            }])}
          >
            增加 SKU
          </Button>
        </Stack>
        {duplicateIds.size || duplicateNames.size ? (
          <Stack direction="row" spacing={0.5} mt={0.75}>
            {duplicateIds.size ? <Chip size="small" color="warning" label={`重复 SKU ID ${duplicateIds.size} 组`} /> : null}
            {duplicateNames.size ? <Chip size="small" color="warning" label={`重复规格 ${duplicateNames.size} 组`} /> : null}
          </Stack>
        ) : null}
      </Box>

      <TableContainer sx={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}>
        <Table stickyHeader size="small" aria-label="SKU 编辑列表" sx={{ width: '100%', tableLayout: 'fixed' }}>
          <colgroup>
            <col style={{ width: 44 }} /><col style={{ width: '23%' }} /><col style={{ width: '13%' }} />
            <col style={{ width: 82 }} /><col style={{ width: 76 }} /><col style={{ width: 64 }} />
            <col style={{ width: 64 }} /><col style={{ width: 64 }} /><col style={{ width: '24%' }} /><col style={{ width: 42 }} />
          </colgroup>
          <TableHead>
            <TableRow>
              <TableCell padding="checkbox">启用</TableCell><TableCell>规格组合</TableCell><TableCell>SKU ID</TableCell>
              <TableCell>采购价</TableCell><TableCell>重量 g</TableCell><TableCell>长</TableCell><TableCell>宽</TableCell><TableCell>高</TableCell>
              <TableCell>SKU 图片地址</TableCell><TableCell />
            </TableRow>
          </TableHead>
          <TableBody>
            {visible.map(({ sku, index }) => {
              const idDuplicate = duplicateIds.has(String(sku.id || '').trim().toLowerCase());
              const nameDuplicate = duplicateNames.has(String(sku.name || '').trim().toLowerCase());
              return (
                <TableRow key={index} hover sx={{ opacity: sku.enabled === false ? 0.55 : 1 }}>
                  <TableCell padding="checkbox">
                    <Checkbox size="small" checked={sku.enabled !== false} onChange={(event) => update(index, 'enabled', event.target.checked)} inputProps={{ 'aria-label': `启用 SKU ${index + 1}` }} />
                  </TableCell>
                  <TableCell sx={{ px: 0.5 }}>
                    <CompactInput label={`SKU 规格 ${index + 1}`} value={sku.name} onChange={(value) => update(index, 'name', value)} />
                    {nameDuplicate ? <Typography variant="caption" color="warning.main">规格重复</Typography> : null}
                  </TableCell>
                  <TableCell sx={{ px: 0.5 }}>
                    <CompactInput label={`SKU ID ${index + 1}`} value={sku.id} onChange={(value) => update(index, 'id', value)} />
                    {idDuplicate ? <Typography variant="caption" color="warning.main">ID 重复</Typography> : null}
                  </TableCell>
                  <TableCell sx={{ px: 0.5 }}><CompactInput label={`SKU 价格 ${index + 1}`} value={sku.price} onChange={(value) => update(index, 'price', value)} /></TableCell>
                  <TableCell sx={{ px: 0.5 }}><CompactInput label={`SKU 重量 ${index + 1}`} value={sku.weightG} onChange={(value) => update(index, 'weightG', value)} /></TableCell>
                  <TableCell sx={{ px: 0.5 }}><CompactInput label={`SKU 长 ${index + 1}`} value={sku.packageLengthCm} onChange={(value) => update(index, 'packageLengthCm', value)} /></TableCell>
                  <TableCell sx={{ px: 0.5 }}><CompactInput label={`SKU 宽 ${index + 1}`} value={sku.packageWidthCm} onChange={(value) => update(index, 'packageWidthCm', value)} /></TableCell>
                  <TableCell sx={{ px: 0.5 }}><CompactInput label={`SKU 高 ${index + 1}`} value={sku.packageHeightCm} onChange={(value) => update(index, 'packageHeightCm', value)} /></TableCell>
                  <TableCell sx={{ px: 0.5 }}>
                    <Stack direction="row" spacing={0.5} alignItems="center"><SkuImage sku={sku} /><CompactInput label={`SKU 图片 ${index + 1}`} value={sku.imageUrl} onChange={(value) => update(index, 'imageUrl', value)} /></Stack>
                  </TableCell>
                  <TableCell sx={{ px: 0.25 }}>
                    <IconButton size="small" aria-label={`删除 SKU ${index + 1}`} disabled={skus.length <= 1} onClick={() => onChange(skus.filter((_, rowIndex) => rowIndex !== index))}>
                      <DeleteOutlineRounded fontSize="small" />
                    </IconButton>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
      <TablePagination
        component="div" count={filtered.length} page={page} onPageChange={(_event, value) => setPage(value)}
        rowsPerPage={rowsPerPage} onRowsPerPageChange={(event) => { setRowsPerPage(Number(event.target.value)); setPage(0); }}
        rowsPerPageOptions={[25, 50, 100]} labelRowsPerPage="每页" labelDisplayedRows={({ from, to, count }) => `${from}-${to} / ${count}`}
        sx={{ borderTop: '1px solid', borderColor: 'divider', flex: '0 0 auto' }}
      />
    </Stack>
  );
}
