import AddRounded from '@mui/icons-material/AddRounded';
import CloseRounded from '@mui/icons-material/CloseRounded';
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded';
import SearchRounded from '@mui/icons-material/SearchRounded';
import SendRounded from '@mui/icons-material/SendRounded';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

export function CustomerQuickRepliesPanel({
  phrases = [],
  searchText = '',
  newPhraseText = '',
  onSearchChange,
  onNewPhraseChange,
  onAddPhrase,
  onRemovePhrase,
  onUsePhrase,
  onClose,
}) {
  const handleNewPhraseKeyDown = (event) => {
    if (event.key !== 'Enter' || event.nativeEvent?.isComposing) return;
    event.preventDefault();
    onAddPhrase();
  };

  return (
    <Box component="aside" className="customer-chat-context-panel customer-quick-replies-panel">
      <Stack direction="row" alignItems="flex-start" justifyContent="space-between" spacing={1}>
        <Box minWidth={0}>
          <Typography variant="subtitle2" className="customer-chat-context-title">
            快捷短语
          </Typography>
          <Typography variant="caption" color="text.secondary">
            点击短语后直接进入发送预览
          </Typography>
        </Box>
        <IconButton size="small" aria-label="关闭快捷短语" onClick={onClose}>
          <CloseRounded fontSize="small" />
        </IconButton>
      </Stack>

      <TextField
        size="small"
        fullWidth
        value={searchText}
        placeholder="搜索快捷短语"
        onChange={(event) => onSearchChange(event.target.value)}
        InputProps={{
          startAdornment: (
            <InputAdornment position="start">
              <SearchRounded fontSize="small" />
            </InputAdornment>
          ),
        }}
      />

      <Box className="customer-quick-reply-list" aria-label="快捷短语列表">
        {phrases.length ? (
          phrases.map((phrase) => (
            <Box key={phrase.id} className="customer-quick-reply-row">
              <ButtonBase
                component="button"
                type="button"
                className="customer-quick-reply-item"
                onClick={() => onUsePhrase(phrase)}
              >
                <Box minWidth={0}>
                  <Typography variant="subtitle2" noWrap>
                    {phrase.title}
                  </Typography>
                  <Typography variant="body2">{phrase.text}</Typography>
                </Box>
                <SendRounded className="customer-quick-reply-send-icon" fontSize="small" />
              </ButtonBase>
              {phrase.custom ? (
                <IconButton
                  size="small"
                  className="customer-quick-reply-delete"
                  aria-label={`删除快捷短语 ${phrase.title}`}
                  onClick={() => onRemovePhrase(phrase.id)}
                >
                  <DeleteOutlineRounded fontSize="small" />
                </IconButton>
              ) : null}
            </Box>
          ))
        ) : (
          <Box className="customer-quick-reply-empty">
            <Typography variant="body2" color="text.secondary">
              没有匹配的快捷短语
            </Typography>
          </Box>
        )}
      </Box>

      <Box className="customer-quick-reply-create">
        <Typography variant="subtitle2">新增预设</Typography>
        <TextField
          size="small"
          fullWidth
          multiline
          minRows={2}
          maxRows={3}
          value={newPhraseText}
          placeholder="输入短语，按 Enter 保存"
          onChange={(event) => onNewPhraseChange(event.target.value)}
          onKeyDown={handleNewPhraseKeyDown}
        />
        <Button
          size="small"
          variant="outlined"
          startIcon={<AddRounded />}
          disabled={!newPhraseText.trim()}
          onClick={onAddPhrase}
        >
          保存为快捷短语
        </Button>
      </Box>
    </Box>
  );
}
