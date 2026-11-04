import AddRounded from '@mui/icons-material/AddRounded';
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

export function CollectionProductAttributeWorkspace({ draft, onChangeDescription, onChangeAttributes }) {
  const update = (index, field, value) => {
    onChangeAttributes(draft.attributes.map((item, rowIndex) => rowIndex === index ? { ...item, [field]: value } : item));
  };
  return (
    <Stack sx={{ height: '100%', minHeight: 0 }}>
      <Box sx={{ px: 1.75, py: 1.25, borderBottom: '1px solid', borderColor: 'divider' }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center">
          <Box>
            <Typography variant="subtitle1" fontWeight={850}>商品属性</Typography>
            <Typography variant="caption" color="text.secondary">描述与来源属性集中填写，保存后仍保留原商品和 SKU 关系。</Typography>
          </Box>
          <Button
            size="small" variant="outlined" startIcon={<AddRounded />}
            onClick={() => onChangeAttributes([...draft.attributes, { name: '', value: '' }])}
          >
            增加属性
          </Button>
        </Stack>
      </Box>
      <Box sx={{ p: 1.5, overflowY: 'auto', minHeight: 0, flex: 1 }}>
        <Stack spacing={1.25}>
          <TextField
            size="small" label="商品描述" value={draft.description}
            onChange={(event) => onChangeDescription(event.target.value)}
            multiline minRows={4} maxRows={7} fullWidth
          />
          <Box>
            <Stack direction="row" justifyContent="space-between" mb={0.75}>
              <Typography variant="subtitle2" fontWeight={800}>来源属性</Typography>
              <Typography variant="caption" color="text.secondary">共 {draft.attributes.length} 项</Typography>
            </Stack>
            {draft.attributes.length ? (
              <Stack spacing={0.65}>
                {draft.attributes.map((item, index) => (
                  <Box
                    key={index}
                    sx={{ display: 'grid', gridTemplateColumns: 'minmax(150px, 0.75fr) minmax(280px, 2fr) 36px', gap: 0.65, alignItems: 'center' }}
                  >
                    <TextField
                      size="small" aria-label={`属性名称 ${index + 1}`} placeholder="属性名称"
                      value={item.name} onChange={(event) => update(index, 'name', event.target.value)}
                    />
                    <TextField
                      size="small" aria-label={`属性值 ${index + 1}`} placeholder="属性值"
                      value={item.value} onChange={(event) => update(index, 'value', event.target.value)}
                    />
                    <IconButton
                      size="small" aria-label={`删除属性 ${index + 1}`}
                      onClick={() => onChangeAttributes(draft.attributes.filter((_, rowIndex) => rowIndex !== index))}
                    >
                      <DeleteOutlineRounded fontSize="small" />
                    </IconButton>
                  </Box>
                ))}
              </Stack>
            ) : (
              <Box sx={{ py: 7, display: 'grid', placeItems: 'center', border: '1px dashed', borderColor: 'divider', borderRadius: 1 }}>
                <Typography variant="body2" color="text.secondary">没有采集到商品属性，可以点击“增加属性”补充。</Typography>
              </Box>
            )}
          </Box>
        </Stack>
      </Box>
    </Stack>
  );
}
