import LinkRounded from '@mui/icons-material/LinkRounded';
import SaveRounded from '@mui/icons-material/SaveRounded';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import FormControl from '@mui/material/FormControl';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import { calculateSkuPriceDifference } from '../lib/purchaseSkuNameBinding.js';
import { usePurchaseSkuBinding } from '../model/usePurchaseSkuBinding.js';

function CatalogCard({
  label,
  inputLabel,
  role,
  url,
  catalog,
  loading,
  onUrlChange,
  onRead,
}) {
  return (
    <Card variant="outlined" sx={{ borderRadius: '6px', minWidth: 0, height: '100%', overflow: 'hidden' }}>
      <CardContent sx={{ p: 2, '&:last-child': { pb: 2 } }}>
        <Stack spacing={1.5}>
          <Stack direction="row" justifyContent="space-between" alignItems="center">
            <Typography variant="h6">{label}</Typography>
            {catalog ? <Chip size="small" color="success" label={`${catalog.skus.length} 个 SKU`} sx={{ borderRadius: '6px' }} /> : null}
          </Stack>
          <TextField
            fullWidth
            label={inputLabel}
            value={url}
            placeholder={role === 'ozon' ? 'https://www.ozon.ru/product/...' : '粘贴任一支持平台的商品详情链接'}
            onChange={(event) => onUrlChange(event.target.value)}
            disabled={loading}
          />
          <Button
            variant="contained"
            startIcon={<LinkRounded />}
            disabled={loading || !String(url || '').trim()}
            onClick={onRead}
          >
            {loading ? '正在读取全部SKU…' : '读取链接商品和全部SKU'}
          </Button>
          {catalog ? (
            <Stack spacing={0.5}>
              <Typography
                fontWeight={700}
                sx={{ display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2, overflow: 'hidden' }}
              >
                {catalog.title}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                平台：{catalog.platform} · 币种：{catalog.currency || '未确认'}
              </Typography>
              <Typography
                variant="caption"
                color="text.secondary"
                title={catalog.url}
                sx={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              >
                {catalog.url}
              </Typography>
            </Stack>
          ) : null}
        </Stack>
      </CardContent>
    </Card>
  );
}

function CatalogSkuTable({ title, catalog, fitViewport = false }) {
  if (!catalog) return null;
  return (
    <Card variant="outlined" sx={{ borderRadius: '6px', minWidth: 0, minHeight: 0, height: '100%', overflow: 'hidden' }}>
      <CardContent sx={{ p: 2, pb: '16px !important', height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <Typography variant="subtitle1" fontWeight={800} sx={{ mb: 1 }}>{title}完整SKU字段</Typography>
        <TableContainer sx={{ maxHeight: fitViewport ? '100%' : 360, flex: 1, minHeight: 0, overflowY: 'auto' }}>
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow>
                <TableCell width={62}>SKU图</TableCell>
                <TableCell width={150}>SKU ID</TableCell>
                <TableCell>SKU名称</TableCell>
                <TableCell width={120}>价格</TableCell>
                <TableCell width={88}>状态</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {catalog.skus.map((sku) => (
                <TableRow key={sku.id}>
                  <TableCell>
                    {sku.imageUrl ? (
                      <Box component="img" src={sku.imageUrl} alt="" sx={{ width: 42, height: 42, objectFit: 'cover', borderRadius: 1 }} />
                    ) : '—'}
                  </TableCell>
                  <TableCell sx={{ fontFamily: 'monospace' }}>{sku.id}</TableCell>
                  <TableCell>{sku.name}</TableCell>
                  <TableCell>{sku.price ? `${sku.price} ${sku.currency}` : '未返回'}</TableCell>
                  <TableCell>{sku.enabled ? '可选择' : '不可选择'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </CardContent>
    </Card>
  );
}

function priceDifferenceText(ozonSku, sourceSku, rubToCnyRate) {
  if (!sourceSku) return '—';
  const result = calculateSkuPriceDifference(ozonSku, sourceSku, rubToCnyRate);
  if (result.status === 'ready') return `¥${result.differenceCny.toFixed(2)}`;
  if (result.status === 'exchange-rate-required') return '等待汇率';
  return '价格未返回';
}

function BindingTable({ ozonCatalog, sourceCatalog, selections, rubToCnyRate, onSelect, fitViewport = false }) {
  if (!ozonCatalog || !sourceCatalog) return null;
  const selectedIds = new Set(Object.values(selections).filter(Boolean));
  const sourceById = new Map(sourceCatalog.skus.map((sku) => [sku.id, sku]));
  return (
    <Card variant="outlined" sx={{ borderRadius: '6px', minHeight: 0, overflow: 'hidden' }}>
      <CardContent sx={{ p: 2, pb: '16px !important', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <Typography variant="h6" fontWeight={800}>Ozon SKU与货源SKU精确绑定</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, mb: 1.5 }}>
          每个 Ozon SKU 必须选择一个真实货源 SKU ID；订单进入后只按ID命中，不按名称猜测。
        </Typography>
        <TableContainer sx={{ maxHeight: fitViewport ? 230 : 520, minHeight: 0, overflowY: 'auto' }}>
          <Table stickyHeader>
            <TableHead>
              <TableRow>
                <TableCell width="32%">Ozon SKU</TableCell>
                <TableCell width="43%">对应货源 SKU</TableCell>
                <TableCell width="12%">Ozon售价</TableCell>
                <TableCell width="13%">销售-采购差价</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {ozonCatalog.skus.map((ozonSku) => {
                const selectedSource = sourceById.get(selections[ozonSku.id]);
                return (
                <TableRow key={ozonSku.id}>
                  <TableCell>
                    <Typography fontWeight={700}>{ozonSku.name}</Typography>
                    <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>{ozonSku.id}</Typography>
                  </TableCell>
                  <TableCell>
                    <FormControl fullWidth size="small">
                      <Select
                        displayEmpty
                        value={selections[ozonSku.id] || ''}
                        onChange={(event) => onSelect(ozonSku.id, event.target.value)}
                        sx={{ borderRadius: '6px' }}
                        MenuProps={{ PaperProps: { sx: { borderRadius: '6px' } } }}
                      >
                        <MenuItem value=""><em>请选择货源SKU名称</em></MenuItem>
                        {sourceCatalog.skus.map((sourceSku) => (
                          <MenuItem
                            key={sourceSku.id}
                            value={sourceSku.id}
                            disabled={!sourceSku.enabled || (selectedIds.has(sourceSku.id) && selections[ozonSku.id] !== sourceSku.id)}
                          >
                            {sourceSku.name} · ID {sourceSku.id}{sourceSku.price ? ` · ${sourceSku.price} ${sourceSku.currency}` : ''}
                          </MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                  </TableCell>
                  <TableCell>{ozonSku.price ? `${ozonSku.price} ${ozonSku.currency}` : '未返回'}</TableCell>
                  <TableCell>{priceDifferenceText(ozonSku, selectedSource, rubToCnyRate)}</TableCell>
                </TableRow>
              )})}
            </TableBody>
          </Table>
        </TableContainer>
      </CardContent>
    </Card>
  );
}

function SavedBindings({ bindings }) {
  if (!bindings.length) return null;
  return (
    <Card variant="outlined" sx={{ borderRadius: '6px' }}>
      <CardContent>
        <Typography variant="h6" fontWeight={800} sx={{ mb: 1 }}>已保存的SKU精确绑定</Typography>
        <Stack spacing={1}>
          {bindings.map((binding) => (
            <Box key={`${binding.ozonUrl}|${binding.sourceUrl}`} sx={{ p: 1.25, border: '1px solid', borderColor: 'divider', borderRadius: '6px' }}>
              <Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" gap={0.5}>
                <Typography fontWeight={700}>{binding.ozonTitle} ↔ {binding.sourceTitle}</Typography>
                <Chip size="small" label={`${binding.pairs.length} 组SKU`} sx={{ borderRadius: '6px' }} />
              </Stack>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                {binding.pairs.map((pair) => `${pair.ozonSkuName}（${pair.ozonSkuId || '旧绑定'}）→ ${pair.sourceSkuName}（${pair.sourceSkuId || '旧绑定'}）`).join('；')}
              </Typography>
            </Box>
          ))}
        </Stack>
      </CardContent>
    </Card>
  );
}

export function PurchaseSkuBindingPanel({
  initialOzonUrl = '',
  initialSourceUrl = '',
  scope = {},
  isActive = true,
  onSaved,
  showSavedBindings = true,
  fitViewport = false,
}) {
  const binding = usePurchaseSkuBinding({ initialOzonUrl, initialSourceUrl, scope, isActive });
  const canSave = binding.ozonCatalog && binding.sourceCatalog
    && binding.ozonCatalog.skus.every((sku) => binding.selections[sku.id])
    && !binding.saving;

  return (
    <Stack
      spacing={1.5}
      sx={{
        height: fitViewport ? '100%' : 'auto',
        minHeight: 0,
        overflow: fitViewport ? 'hidden' : 'visible',
        '& .MuiOutlinedInput-root, & .MuiButton-root, & .MuiChip-root, & .MuiAlert-root': { borderRadius: '6px' },
      }}
    >
      {binding.errorMessage ? <Alert severity="warning">{binding.errorMessage}</Alert> : null}

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', xl: 'repeat(2, minmax(0, 1fr))' }, gap: 1.5, flex: '0 0 auto' }}>
        <CatalogCard
          label="自己的Ozon商品"
          inputLabel="Ozon商品主链接"
          role="ozon"
          url={binding.ozonUrl}
          catalog={binding.ozonCatalog}
          loading={binding.loadingRole === 'ozon'}
          onUrlChange={binding.setOzonUrl}
          onRead={() => binding.readCatalog('ozon')}
        />
        <CatalogCard
          label="货源商品"
          inputLabel="采购链接"
          role="source"
          url={binding.sourceUrl}
          catalog={binding.sourceCatalog}
          loading={binding.loadingRole === 'source'}
          onUrlChange={binding.setSourceUrl}
          onRead={() => binding.readCatalog('source')}
        />
      </Box>

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', xl: 'repeat(2, minmax(0, 1fr))' }, gap: 1.5, flex: fitViewport ? '1 1 280px' : '0 0 auto', minHeight: 0 }}>
        <CatalogSkuTable title="Ozon商品" catalog={binding.ozonCatalog} fitViewport={fitViewport} />
        <CatalogSkuTable title="货源商品" catalog={binding.sourceCatalog} fitViewport={fitViewport} />
      </Box>

      <Box sx={{ flex: '0 1 auto', minHeight: 0 }}>
        <BindingTable
          ozonCatalog={binding.ozonCatalog}
          sourceCatalog={binding.sourceCatalog}
          selections={binding.selections}
          rubToCnyRate={binding.rubToCnyRate}
          onSelect={binding.selectSourceSku}
          fitViewport={fitViewport}
        />
      </Box>
      {canSave ? (
        <Button
          variant="contained"
          size="large"
          startIcon={<SaveRounded />}
          disabled={binding.saving}
          onClick={async () => {
            const result = await binding.saveBinding();
            if (result) onSaved?.(result);
          }}
          sx={{ alignSelf: 'flex-end' }}
        >
          {binding.saving ? '正在保存…' : '保存SKU精确绑定'}
        </Button>
      ) : null}
      {showSavedBindings ? <SavedBindings bindings={binding.bindings} /> : null}
    </Stack>
  );
}
