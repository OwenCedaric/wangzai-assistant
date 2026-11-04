import BoltRounded from '@mui/icons-material/BoltRounded';
import NotificationsNoneRounded from '@mui/icons-material/NotificationsNoneRounded';
import SendRounded from '@mui/icons-material/SendRounded';
import AttachFileRounded from '@mui/icons-material/AttachFileRounded';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';

function getClipboardImage(clipboardData) {
  const files = Array.from(clipboardData?.files || []);
  const directImage = files.find((file) =>
    String(file?.type || '')
      .toLowerCase()
      .startsWith('image/')
  );
  if (directImage) return directImage;
  for (const item of Array.from(clipboardData?.items || [])) {
    if (
      item?.kind !== 'file' ||
      !String(item.type || '')
        .toLowerCase()
        .startsWith('image/')
    )
      continue;
    const file = item.getAsFile?.();
    if (file) return file;
  }
  return null;
}

function ensureClipboardImageName(file) {
  if (String(file?.name || '').trim()) return file;
  const extension = String(file?.type || '')
    .toLowerCase()
    .includes('jpeg')
    ? 'jpg'
    : 'png';
  return new File([file], `clipboard-image-${Date.now()}.${extension}`, {
    type: file?.type || `image/${extension}`,
    lastModified: file?.lastModified || Date.now(),
  });
}

export const CustomerMessageComposer = React.memo(function CustomerMessageComposer({
  conversationId,
  replyEnabled = true,
  replyUnavailableReason = '',
  draftText = '',
  sending = false,
  onChangeDraft,
  onOpenQuickReplies,
  onRequestSend,
  onRequestFile,
}) {
  const fileInputRef = React.useRef(null);
  const disabled = !conversationId || !replyEnabled || sending;
  const placeholder = !conversationId
    ? '请先选择会话'
    : replyEnabled
      ? '输入回复内容，Enter 发送，Shift + Enter 换行'
      : replyUnavailableReason || 'Ozon 信息推送为只读，无需回复';

  const handleKeyDown = (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent?.isComposing) return;
    event.preventDefault();
    if (!disabled && draftText.trim()) onRequestSend(draftText);
  };
  const handleFileChange = (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) onRequestFile?.(file);
  };
  const handlePaste = (event) => {
    if (disabled || !onRequestFile) return;
    const image = getClipboardImage(event.clipboardData);
    if (!image) return;
    event.preventDefault();
    onRequestFile(ensureClipboardImageName(image));
  };

  if (conversationId && !replyEnabled) {
    return (
      <Box className="customer-message-composer-readonly">
        <NotificationsNoneRounded fontSize="small" />
        <Box minWidth={0}>
          <Typography variant="body2">Ozon 信息推送为只读</Typography>
          <Typography variant="caption" color="text.secondary">
            {replyUnavailableReason || '订单、物流和售后变化仅供查看，无需回复'}
          </Typography>
        </Box>
      </Box>
    );
  }

  return (
    <Box className="customer-message-composer">
      <Box className="customer-message-editor">
        <TextField
          value={draftText}
          disabled={disabled}
          onChange={(event) => onChangeDraft(event.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={placeholder}
          multiline
          minRows={4}
          maxRows={6}
          fullWidth
        />
        <Stack
          direction="row"
          alignItems="center"
          justifyContent="space-between"
          className="customer-message-editor-toolbar"
        >
          <Stack direction="row" spacing={0.5}>
            <Button
              size="small"
              color="inherit"
              aria-label="快捷回复"
              startIcon={<BoltRounded />}
              onClick={onOpenQuickReplies}
              disabled={disabled}
            >
              快捷回复
            </Button>
            <Button
              size="small"
              color="inherit"
              aria-label="发送附件"
              startIcon={<AttachFileRounded />}
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled || !onRequestFile}
            >
              附件
            </Button>
            <input ref={fileInputRef} type="file" hidden onChange={handleFileChange} />
          </Stack>
          <Button
            size="small"
            variant="contained"
            endIcon={<SendRounded />}
            onClick={() => onRequestSend(draftText)}
            disabled={disabled || !draftText.trim()}
          >
            发送
          </Button>
        </Stack>
      </Box>
    </Box>
  );
});
