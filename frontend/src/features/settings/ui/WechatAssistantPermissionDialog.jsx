import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import Dialog from '../../../shared/ui/minimizedTasks/GlobalMinimizableDialog.jsx';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import React from 'react';

export const WECHAT_OPERATION_PERMISSION_GROUPS = Object.freeze([
  {
    id: 'products',
    label: '商品操作',
    description: '修改商品资料、价格、库存和上下架状态',
    actions: [
      ['products:product.updateInfo', '修改商品资料（标题、描述、图片）'],
      ['products:product.updateAttributes', '修改商品属性'],
      ['products:product.updatePrice', '修改商品价格'],
      ['products:product.updateStock', '修改商品库存'],
      ['products:product.archive', '下架或归档商品'],
      ['products:product.unarchive', '恢复上架商品'],
    ],
  },
  {
    id: 'orders',
    label: '订单与发货',
    description: '取消、创建、拆单、发货、面单及商品标记码',
    actions: [
      ['orders:cancelOrder', '取消订单'],
      ['orders:createOrder', '创建订单'],
      ['orders:cancelFboPosting', '取消平台仓发货单'],
      ['orders:cancelFbsPosting', '取消卖家仓发货单'],
      ['orders:cancelFbsProduct', '取消卖家仓发货单内商品'],
      ['orders:setFbsAwaitingDelivery', '提交卖家仓等待交付'],
      ['orders:shipFbsPosting', '确认卖家仓或卖家自配送发货'],
      ['orders:shipFbsPackage', '确认多包裹发货'],
      ['orders:createFbsPackageLabel', '创建卖家仓面单任务'],
      ['orders:getFbsPackageLabel', '获取卖家仓面单文件'],
      ['orders:splitFbsPosting', '拆分卖家仓发货单'],
      ['orders:splitTraceableFbsPosting', '拆分可追溯发货单'],
      ['orders:setMultiboxQty', '设置多箱数量'],
      ['orders:updateFbsExemplar', '更新商品实例或标记码'],
      ['orders:setFbsExemplar', '保存商品实例或标记码'],
      ['orders:createOrGetFbsExemplar', '创建或读取商品实例或标记码'],
    ],
  },
  {
    id: 'marketing',
    label: '营销活动',
    description: '管理商品是否参加平台营销活动',
    actions: [
      ['marketing:marketing.products.add', '将商品加入营销活动'],
      ['marketing:marketing.products.remove', '将商品移出营销活动'],
    ],
  },
  {
    id: 'returns',
    label: '售后与退款',
    description: '退货、补偿、退款和条件取消均属于高风险操作',
    actions: [
      ['returns:setRfbsReturnAction', '提交卖家自配送退货处理动作'],
      ['returns:rejectRfbsReturn', '拒绝卖家自配送退货'],
      ['returns:compensateRfbsReturn', '执行卖家自配送部分退款或补偿'],
      ['returns:verifyRfbsReturn', '同意卖家自配送退货'],
      ['returns:receiveRfbsReturn', '确认收到并检查退货'],
      ['returns:refundRfbsReturn', '给买家退款'],
      ['returns:approveConditionalCancellation', '同意条件取消'],
      ['returns:rejectConditionalCancellation', '拒绝条件取消'],
    ],
  },
  {
    id: 'customer-service',
    label: '客服会话',
    description: '发送消息、创建会话和标记已读；不允许发送本地文件',
    actions: [
      ['customer-service:customerService.chat.sendMessage', '向买家发送客服消息'],
      ['customer-service:customerService.chat.start', '创建客服会话'],
      ['customer-service:customerService.chat.markAllRead', '将客服会话全部标记已读'],
    ],
  },
]);

export const WECHAT_OPERATION_PERMISSION_IDS = Object.freeze(
  WECHAT_OPERATION_PERMISSION_GROUPS.flatMap((group) => group.actions.map(([id]) => id)),
);
const SMALL_RADIUS = '6px';

function WechatAssistantPermissionDialog({ open, value = [], onClose, onSave }) {
  const [draft, setDraft] = React.useState([]);

  React.useEffect(() => {
    if (open) setDraft([...new Set(Array.isArray(value) ? value : [])]);
  }, [open, value]);

  const selected = React.useMemo(() => new Set(draft), [draft]);
  const toggle = (id) => {
    setDraft((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  };
  const toggleGroup = (ids) => {
    setDraft((current) => {
      const currentSet = new Set(current);
      const allSelected = ids.every((id) => currentSet.has(id));
      ids.forEach((id) => allSelected ? currentSet.delete(id) : currentSet.add(id));
      return WECHAT_OPERATION_PERMISSION_IDS.filter((id) => currentSet.has(id));
    });
  };

  return (
    <Dialog
      open={Boolean(open)}
      onClose={onClose}
      maxWidth="md"
      fullWidth
      disableScrollLock
      PaperProps={{ sx: { borderRadius: SMALL_RADIUS } }}
      sx={{
        '& .MuiChip-root, & .MuiButton-root': { borderRadius: `${SMALL_RADIUS} !important` },
      }}
    >
      <DialogTitle>
        <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
          <Box>
            <Typography variant="h6" fontWeight={900}>设置小龙虾具体权限</Typography>
            <Typography variant="caption" color="text.secondary">默认全部关闭；勾选后仅允许执行对应操作，命中规则后直接生效。</Typography>
          </Box>
          <Chip size="small" color={draft.length ? 'warning' : 'default'} label={`已选择 ${draft.length} 项`} />
        </Stack>
      </DialogTitle>
      <DialogContent dividers sx={{ maxHeight: 'min(68vh, 680px)' }}>
        <Box
          data-testid="wechat-permission-groups"
          sx={{ display: 'flex', flexDirection: 'column', gap: 1.25 }}
        >
          {WECHAT_OPERATION_PERMISSION_GROUPS.map((group) => {
            const ids = group.actions.map(([id]) => id);
            const selectedCount = ids.filter((id) => selected.has(id)).length;
            return (
              <Box key={group.id} component="section" sx={{ width: '100%', border: '1px solid #e8edf6', borderRadius: SMALL_RADIUS, p: 1.25 }}>
                <Stack direction="row" alignItems="flex-start" justifyContent="space-between" spacing={1} mb={0.5}>
                  <Box>
                    <Typography variant="subtitle2" fontWeight={900}>{group.label}</Typography>
                    <Typography variant="caption" color="text.secondary">{group.description}</Typography>
                  </Box>
                  <Button size="small" sx={{ flexShrink: 0 }} onClick={() => toggleGroup(ids)}>
                    {selectedCount === ids.length ? '取消本组' : '选择本组'}
                  </Button>
                </Stack>
                <Stack spacing={0.1}>
                  {group.actions.map(([id, label]) => (
                    <FormControlLabel
                      key={id}
                      sx={{ m: 0, minHeight: 31, '& .MuiFormControlLabel-label': { fontSize: 13 } }}
                      control={<Checkbox size="small" checked={selected.has(id)} onChange={() => toggle(id)} />}
                      label={label}
                    />
                  ))}
                </Stack>
              </Box>
            );
          })}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button color="inherit" onClick={() => setDraft([])}>全部关闭</Button>
        <Box sx={{ flex: 1 }} />
        <Button color="inherit" onClick={onClose}>取消</Button>
        <Button variant="contained" onClick={() => onSave(WECHAT_OPERATION_PERMISSION_IDS.filter((id) => selected.has(id)))}>
          保存权限
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default WechatAssistantPermissionDialog;
