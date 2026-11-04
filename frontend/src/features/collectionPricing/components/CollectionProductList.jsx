import OpenInNewRounded from '@mui/icons-material/OpenInNewRounded';
import EditRounded from '@mui/icons-material/EditRounded';
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded';
import Inventory2Rounded from '@mui/icons-material/Inventory2Rounded';
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import React from 'react';

import { collectionSourcePlatformOptions } from '../constants/collectionPricingRules.js';
import { getCollectionProductThumbnailUrls } from '../lib/collectionProductImageUrl.js';
import { getCollectionProductPublicationSummary } from '../lib/collectionProductPublication.js';
import { CollectionProductEditDialog } from './CollectionProductEditDialog.jsx';

const ALL_PLATFORM = 'all';
const platformLabels = new Map(collectionSourcePlatformOptions.map((item) => [item.value, item.label]));

function capturedTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function ImageCounts({ item }) {
  return (
    <Stack direction="row" spacing={0.45} useFlexGap flexWrap="wrap" sx={{ color: 'text.secondary' }}>
      <Typography variant="caption">主图 {item.mainImages?.length || 0}</Typography>
      <Typography variant="caption">SKU 图 {item.skuImages?.length || 0}</Typography>
      <Typography variant="caption">详情图 {item.detailImages?.length || 0}</Typography>
    </Stack>
  );
}

function PublicationStatus({ item, shops }) {
  const summary = React.useMemo(
    () => getCollectionProductPublicationSummary(item, shops),
    [item, shops],
  );
  const colors = summary.state === 'uploaded'
    ? { color: '#067647', backgroundColor: '#ecfdf3' }
    : summary.state === 'pending' || summary.state === 'partial'
      ? { color: '#b54708', backgroundColor: '#fff7ed' }
      : { color: '#667085', backgroundColor: '#f2f4f7' };
  const visibleShops = summary.shopLabels.slice(0, 2);
  const remaining = Math.max(0, summary.shopLabels.length - visibleShops.length);
  return (
    <Stack spacing={0.3} title={summary.detail} sx={{ minWidth: 0 }}>
      <Box
        component="span"
        sx={{
          ...colors,
          alignSelf: 'flex-start',
          px: 0.75,
          py: 0.25,
          borderRadius: 0.5,
          fontSize: 12,
          lineHeight: 1.45,
          fontWeight: 750,
          whiteSpace: 'nowrap',
        }}
      >
        {summary.label}
      </Box>
      {visibleShops.length ? (
        <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block', maxWidth: '100%' }}>
          {visibleShops.join('、')}{remaining ? ` +${remaining}` : ''}
        </Typography>
      ) : null}
    </Stack>
  );
}

function ProductThumbnail({ item }) {
  const urls = React.useMemo(() => getCollectionProductThumbnailUrls(item), [item]);
  const [sourceIndex, setSourceIndex] = React.useState(0);

  React.useEffect(() => setSourceIndex(0), [urls]);

  const source = urls[sourceIndex] || '';
  return (
    <Box
      sx={{
        width: 48, height: 48, borderRadius: 0.75, bgcolor: '#f2f4f7', flex: '0 0 auto',
        display: 'grid', placeItems: 'center', overflow: 'hidden', color: '#98a2b3',
      }}
    >
      {source ? (
        <Box
          component="img"
          src={source}
          alt={item.title || '商品缩略图'}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setSourceIndex((index) => index + 1)}
          sx={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
      ) : <Inventory2Rounded fontSize="small" />}
    </Box>
  );
}

function PlatformFilters({ items, value, onChange }) {
  const counts = React.useMemo(() => {
    const next = new Map([[ALL_PLATFORM, items.length]]);
    items.forEach((item) => next.set(item.platformCode, (next.get(item.platformCode) || 0) + 1));
    return next;
  }, [items]);
  const options = [
    { value: ALL_PLATFORM, label: '全部' },
    ...collectionSourcePlatformOptions,
  ];

  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.25 }} aria-label="采集平台筛选">
      {options.map((option) => (
        <ButtonBase
          key={option.value}
          aria-label={`${option.label} ${counts.get(option.value) || 0}`}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          sx={{
            minHeight: 32,
            px: 1.1,
            borderRadius: 0.5,
            color: value === option.value ? '#25324a' : 'text.secondary',
            bgcolor: value === option.value ? '#edf1f6' : 'transparent',
            fontSize: 13,
            fontWeight: value === option.value ? 700 : 600,
            '&:hover': { bgcolor: '#f2f4f7', color: 'text.primary' },
            '&:focus-visible': { outline: '2px solid #98a2b3', outlineOffset: -2 },
          }}
        >
          {option.label}
          <Box component="span" sx={{ ml: 0.6, color: '#8a94a6', fontWeight: 600 }}>{counts.get(option.value) || 0}</Box>
        </ButtonBase>
      ))}
    </Box>
  );
}

export function CollectionProductList({
  items = [], shops = [], activeShopId = '', selectedId = '', onSelect, onOpenSource, onEdit, onDelete,
}) {
  const [platform, setPlatform] = React.useState(ALL_PLATFORM);
  const [editingId, setEditingId] = React.useState('');
  const filteredItems = React.useMemo(
    () => platform === ALL_PLATFORM ? items : items.filter((item) => item.platformCode === platform),
    [items, platform]
  );
  const editingProduct = React.useMemo(
    () => items.find((item) => item.id === editingId) || null,
    [editingId, items]
  );

  React.useEffect(() => {
    if (platform !== ALL_PLATFORM && !items.some((item) => item.platformCode === platform)) setPlatform(ALL_PLATFORM);
  }, [items, platform]);

  return (
    <Paper variant="outlined" sx={{ borderRadius: 0.75, overflow: 'hidden', borderColor: '#dfe5ee', boxShadow: 'none' }}>
      <Box sx={{ p: 2, pb: 1.25 }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" spacing={0.5} mb={1.15}>
          <Box>
            <Typography variant="h6" fontWeight={750}>采集列表</Typography>
            <Typography variant="body2" color="text.secondary">
              按来源平台查看本次采集的商品资料。
            </Typography>
          </Box>
          <Typography variant="body2" color="text.secondary" sx={{ alignSelf: { xs: 'flex-start', sm: 'center' } }}>
            本次 <Box component="span" sx={{ color: 'text.primary', fontWeight: 750 }}>{items.length}</Box> 件
          </Typography>
        </Stack>
        <PlatformFilters items={items} value={platform} onChange={setPlatform} />
      </Box>

      {!filteredItems.length ? (
        <Box sx={{ minHeight: 126, display: 'grid', placeItems: 'center', px: 2, borderTop: '1px solid #edf0f4', color: 'text.secondary', bgcolor: '#fcfcfd' }}>
          <Stack alignItems="center" spacing={0.35}>
            <Typography variant="body2" fontWeight={700} color="text.primary">暂无采集商品</Typography>
            <Typography variant="caption" color="text.secondary">
              {items.length ? '当前平台还没有采集商品' : '还没有采集商品，请从上方两种方式开始'}
            </Typography>
          </Stack>
        </Box>
      ) : (
        <TableContainer
          sx={{
            borderTop: '1px solid',
            borderColor: 'divider',
            overflowX: 'hidden',
            '@media (max-width: 1439px)': {
              '& .collection-list-source-id, & .collection-list-captured-time, & .collection-list-completeness': { display: 'none' },
            },
            '@media (max-width: 1199px)': {
              '& .collection-list-platform, & .collection-list-images': { display: 'none' },
            },
            '@media (max-width: 959px)': {
              '& .collection-list-price': { display: 'none' },
            },
          }}
        >
          <Table
            size="small"
            aria-label="商品采集列表"
            sx={{
              width: '100%',
              tableLayout: 'fixed',
              '& .MuiTableCell-root': { px: 0.75, py: 0.9, verticalAlign: 'middle' },
              '& .MuiTableCell-head': { whiteSpace: 'nowrap' },
            }}
          >
            <TableHead>
              <TableRow>
                <TableCell sx={{ width: '24%' }}>商品</TableCell>
                <TableCell className="collection-list-platform" sx={{ width: '6%' }}>平台</TableCell>
                <TableCell className="collection-list-price" sx={{ width: '8%' }}>来源价格</TableCell>
                <TableCell sx={{ width: '4%' }}>SKU</TableCell>
                <TableCell className="collection-list-images" sx={{ width: '11%' }}>图片</TableCell>
                <TableCell className="collection-list-source-id" sx={{ width: '9%' }}>来源商品 ID</TableCell>
                <TableCell className="collection-list-captured-time" sx={{ width: '8%' }}>采集时间</TableCell>
                <TableCell className="collection-list-completeness" sx={{ width: '6%' }}>完整度</TableCell>
                <TableCell sx={{ width: '13%' }}>Ozon 状态</TableCell>
                <TableCell align="center" sx={{ width: '11%' }}>操作</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {filteredItems.map((item) => (
                <TableRow
                  key={item.id}
                  hover
                  selected={item.id === selectedId}
                  onClick={() => onSelect?.(item.id)}
                  sx={{ cursor: 'default' }}
                >
                  <TableCell>
                    <Stack direction="row" spacing={0.75} alignItems="center">
                      <ProductThumbnail item={item} />
                      <Box sx={{ minWidth: 0 }}>
                        <Typography variant="body2" fontWeight={700} noWrap title={item.title}>
                          {item.title || '未识别标题'}
                        </Typography>
                        <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>
                          {item.category || item.variant || '商品详情页采集'}
                        </Typography>
                      </Box>
                    </Stack>
                  </TableCell>
                  <TableCell className="collection-list-platform" sx={{ whiteSpace: 'nowrap' }}>
                    <Box component="span" sx={{ display: 'inline-block', px: 0.75, py: 0.25, borderRadius: 0.5, bgcolor: '#f2f4f7', color: '#475467', fontSize: 12, fontWeight: 700 }}>
                      {platformLabels.get(item.platformCode) || item.platform || '其它'}
                    </Box>
                  </TableCell>
                  <TableCell className="collection-list-price" sx={{ whiteSpace: 'nowrap' }}>
                    <Typography variant="body2" fontWeight={700}>
                      {item.purchasePrice ? `${item.purchasePrice} ${item.currency || ''}` : '-'}
                    </Typography>
                  </TableCell>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>{item.skus?.length || 0}</TableCell>
                  <TableCell className="collection-list-images"><ImageCounts item={item} /></TableCell>
                  <TableCell className="collection-list-source-id">
                    <Typography variant="caption" noWrap title={item.sourceProductId || item.sourceUrl} sx={{ display: 'block' }}>
                      {item.sourceProductId || '从链接识别'}
                    </Typography>
                  </TableCell>
                  <TableCell className="collection-list-captured-time" sx={{ whiteSpace: 'nowrap' }}>{capturedTime(item.capturedAt)}</TableCell>
                  <TableCell className="collection-list-completeness">
                    <Box
                      component="span"
                      title={item.completeness?.missing?.length ? `缺少：${item.completeness.missing.join('、')}` : '核心采集字段完整'}
                      sx={{
                        display: 'inline-block',
                        px: 0.75,
                        py: 0.25,
                        borderRadius: 0.5,
                        bgcolor: item.completeness?.status === 'complete' ? '#ecfdf3' : '#fff7ed',
                        color: item.completeness?.status === 'complete' ? '#027a48' : '#b54708',
                        fontSize: 12,
                        fontWeight: 700,
                      }}
                    >
                      {item.completeness?.label || '待补充'}
                    </Box>
                  </TableCell>
                  <TableCell>
                    <PublicationStatus item={item} shops={shops} />
                  </TableCell>
                  <TableCell align="center">
                    <Stack direction="row" spacing={0.2} justifyContent="center" sx={{ whiteSpace: 'nowrap' }}>
                      <ButtonBase
                        aria-label={`编辑：${item.title || item.sourceProductId}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          onSelect?.(item.id);
                          setEditingId(item.id);
                        }}
                        sx={{ px: 0.55, py: 0.35, borderRadius: 0.5, color: '#475467', fontSize: 12, fontWeight: 700, gap: 0.25, '&:hover': { bgcolor: '#f2f4f7' } }}
                      >
                        <EditRounded sx={{ fontSize: 15 }} />编辑
                      </ButtonBase>
                      {item.sourceUrl ? (
                        <ButtonBase
                          aria-label={`打开来源：${item.title || item.sourceProductId}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            onOpenSource?.(item.id);
                          }}
                          sx={{ px: 0.55, py: 0.35, borderRadius: 0.5, color: '#475467', fontSize: 12, fontWeight: 700, gap: 0.25, '&:hover': { bgcolor: '#f2f4f7' } }}
                        >
                          <OpenInNewRounded sx={{ fontSize: 15 }} />来源
                        </ButtonBase>
                      ) : null}
                      <ButtonBase
                        aria-label={`删除：${item.title || item.sourceProductId}`}
                        title="删除采集商品"
                        onClick={(event) => {
                          event.stopPropagation();
                          if (window.confirm(`确定删除“${item.title || item.sourceProductId || '该商品'}”吗？`)) {
                            onDelete?.(item.id);
                          }
                        }}
                        sx={{ px: 0.55, py: 0.35, borderRadius: 0.5, color: '#d92d20', fontSize: 12, fontWeight: 700, gap: 0.25, '&:hover': { bgcolor: '#fef3f2' } }}
                      >
                        <DeleteOutlineRounded sx={{ fontSize: 15 }} />删除
                      </ButtonBase>
                    </Stack>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
      <CollectionProductEditDialog
        product={editingProduct}
        shops={shops}
        activeShopId={activeShopId}
        onClose={() => setEditingId('')}
        onSaveDraft={(id, changes) => onEdit?.(id, changes)}
        onDelete={(id) => {
          onDelete?.(id);
          setEditingId('');
        }}
      />
    </Paper>
  );
}
