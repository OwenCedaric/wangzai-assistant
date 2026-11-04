import { safeWarn } from '../../../services/safeLog';
import {
  defaultWatermarkTemplates,
  WATERMARK_IMAGE_SIZE_MAX,
  WATERMARK_IMAGE_SIZE_MIN,
  WATERMARK_TEXT_COLOR_OPTIONS,
  WATERMARK_TEXT_SIZE_MAX,
  WATERMARK_TEXT_SIZE_MIN,
} from '../../../shared/config/appConfigCore.jsx';
import {
  loadWatermarkSettingsFromLocalApi,
  normalizeWatermarkTemplate,
  readSavedActiveWatermarkTemplateId,
  readSavedWatermarkTemplates,
  saveWatermarkTemplates,
} from '../../products/lib/productEditing.jsx';
import AddRounded from '@mui/icons-material/AddRounded';
import ContentCopyRounded from '@mui/icons-material/ContentCopyRounded';
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded';
import EditRounded from '@mui/icons-material/EditRounded';
import ImageRounded from '@mui/icons-material/ImageRounded';
import RemoveRounded from '@mui/icons-material/RemoveRounded';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import FormControlLabel from '@mui/material/FormControlLabel';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import Slider from '@mui/material/Slider';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import React from 'react';
import { WatermarkPreviewCard } from './WatermarkPreviewCard.jsx';

function createBlankWatermarkTemplate(index = 1) {
  return normalizeWatermarkTemplate(
    {
      ...defaultWatermarkTemplates[0],
      id: `watermark-template-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      name: `水印模板 ${index}`,
      text: '',
      imageName: '',
      imageDataUrl: '',
      savedAt: '',
    },
    0
  );
}

export function WatermarkSettingsPanel({ onAction, saveRequestId = 0 }) {
  const initialTemplates = React.useMemo(() => readSavedWatermarkTemplates(), []);
  const [templates, setTemplates] = React.useState(initialTemplates);
  const [activeTemplateId, setActiveTemplateId] = React.useState(() =>
    readSavedActiveWatermarkTemplateId(initialTemplates)
  );
  const previewFrameRef = React.useRef(null);
  const textPreviewRef = React.useRef(null);
  const draggingWatermarkRef = React.useRef(false);
  const draggingWatermarkElementRef = React.useRef(null);
  const draggingWatermarkTargetRef = React.useRef('image');
  const dragCleanupRef = React.useRef(null);
  const activeTemplate = templates.find((template) => template.id === activeTemplateId) ?? templates[0];

  React.useEffect(() => {
    let cancelled = false;
    loadWatermarkSettingsFromLocalApi()
      .then((store) => {
        if (cancelled) return;
        setTemplates(store.templates);
        setActiveTemplateId(store.activeTemplateId);
      })
      .catch((error) => {
        safeWarn('[水印设置] 本机 SQLite 读取失败', error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => () => dragCleanupRef.current?.(), []);

  const persistTemplates = (nextTemplates, nextActiveId = activeTemplateId) => {
    setTemplates(nextTemplates);
    setActiveTemplateId(nextActiveId);
    saveWatermarkTemplates(nextTemplates, nextActiveId);
  };

  const updateActiveTemplate = React.useCallback(
    (patch) => {
      if (!activeTemplate) return;
      setTemplates((current) =>
        current.map((template) =>
          template.id === activeTemplate.id
            ? normalizeWatermarkTemplate({ ...template, ...patch, savedAt: '' }, 0, { allowEmptyName: true })
            : template
        )
      );
    },
    [activeTemplate]
  );

  const getWatermarkBounds = (
    frame,
    element,
    fallbackHalfWidthPercent = 0,
    fallbackHalfHeightPercent = fallbackHalfWidthPercent
  ) => {
    const frameRect = frame.getBoundingClientRect();
    const elementRect = element?.getBoundingClientRect();
    const halfWidthPercent = elementRect ? (elementRect.width / 2 / frameRect.width) * 100 : fallbackHalfWidthPercent;
    const halfHeightPercent = elementRect
      ? (elementRect.height / 2 / frameRect.height) * 100
      : fallbackHalfHeightPercent;
    const minX = Math.min(50, Math.max(0, halfWidthPercent));
    const minY = Math.min(50, Math.max(0, halfHeightPercent));

    return {
      minX,
      maxX: 100 - minX,
      minY,
      maxY: 100 - minY,
    };
  };

  React.useLayoutEffect(() => {
    const keepTextInsidePreview = () => {
      const frame = previewFrameRef.current;
      const textElement = textPreviewRef.current;
      if (!frame || !textElement || !activeTemplate?.text) return;

      const frameWidth = Math.max(1, frame.clientWidth);
      const frameHeight = Math.max(1, frame.clientHeight);
      const textRect = textElement.getBoundingClientRect();
      const halfWidthPercent = Math.min(50, Math.max(0, (textRect.width / 2 / frameWidth) * 100));
      const halfHeightPercent = Math.min(50, Math.max(0, (textRect.height / 2 / frameHeight) * 100));
      const boundedX = Math.min(100 - halfWidthPercent, Math.max(halfWidthPercent, activeTemplate.textX));
      const boundedY = Math.min(100 - halfHeightPercent, Math.max(halfHeightPercent, activeTemplate.textY));

      if (Math.abs(boundedX - activeTemplate.textX) > 0.1 || Math.abs(boundedY - activeTemplate.textY) > 0.1) {
        updateActiveTemplate({ textX: boundedX, textY: boundedY });
      }
    };

    keepTextInsidePreview();
    window.addEventListener('resize', keepTextInsidePreview);
    return () => window.removeEventListener('resize', keepTextInsidePreview);
  }, [
    activeTemplate?.id,
    activeTemplate?.text,
    activeTemplate?.textSize,
    activeTemplate?.textWidth,
    activeTemplate?.wrapText,
    activeTemplate?.textX,
    activeTemplate?.textY,
    updateActiveTemplate,
  ]);

  const adjustWatermarkSize = (field, delta, min, max) => {
    if (!activeTemplate) return;
    const nextValue = Math.min(max, Math.max(min, Number(activeTemplate[field]) + delta));
    updateActiveTemplate({ [field]: nextValue });
  };

  const addTemplate = () => {
    const nextTemplate = normalizeWatermarkTemplate(
      {
        ...defaultWatermarkTemplates[0],
        id: `watermark-template-${Date.now()}`,
        name: `水印模板 ${templates.length + 1}`,
        savedAt: '',
      },
      0
    );
    persistTemplates([...templates, nextTemplate], nextTemplate.id);
    onAction('新增模板');
  };

  const duplicateTemplate = (template) => {
    const nextTemplate = normalizeWatermarkTemplate(
      {
        ...template,
        id: `watermark-template-${Date.now()}`,
        name: `${template.name} 副本`,
        savedAt: '',
      },
      0
    );
    persistTemplates([...templates, nextTemplate], nextTemplate.id);
    onAction('复制模板');
  };

  const deleteTemplate = (templateId) => {
    const nextTemplates = templates.filter((template) => template.id !== templateId);
    const safeTemplates = nextTemplates.length > 0 ? nextTemplates : [createBlankWatermarkTemplate(1)];
    const nextActiveId = activeTemplateId === templateId ? safeTemplates[0].id : activeTemplateId;
    persistTemplates(safeTemplates, nextActiveId);
    onAction('删除模板');
  };

  const saveActiveTemplate = () => {
    if (!activeTemplate) return;
    const savedAt = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const nextTemplates = templates.map((template) =>
      template.id === activeTemplate.id
        ? normalizeWatermarkTemplate({ ...template, name: template.name.trim() || '未命名模板', savedAt })
        : template
    );
    persistTemplates(nextTemplates, activeTemplate.id);
    onAction('保存模板');
  };

  const saveActiveTemplateRef = React.useRef(saveActiveTemplate);
  saveActiveTemplateRef.current = saveActiveTemplate;
  const handledSaveRequestIdRef = React.useRef(saveRequestId);
  React.useEffect(() => {
    if (saveRequestId === handledSaveRequestIdRef.current) return;
    handledSaveRequestIdRef.current = saveRequestId;
    saveActiveTemplateRef.current();
  }, [saveRequestId]);

  const handleImageUpload = (event) => {
    const file = event.target.files?.[0];
    if (!file || !activeTemplate) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 1024 * 1024) {
      onAction('水印图片仅支持 PNG/JPEG/WebP，且不能超过 1MB');
      event.target.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      updateActiveTemplate({
        imageName: file.name,
        imageDataUrl: typeof reader.result === 'string' ? reader.result : '',
      });
      onAction('选择水印图');
    };
    reader.readAsDataURL(file);
    event.target.value = '';
  };

  const moveWatermarkByPointer = (event) => {
    const frame = previewFrameRef.current;
    if (!frame) return;
    const rect = frame.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const watermarkElement = draggingWatermarkElementRef.current;
    const fallbackHalfSize = draggingWatermarkTargetRef.current === 'text' ? 0 : activeTemplate.imageSize / 2;
    const { minX, maxX, minY, maxY } = getWatermarkBounds(frame, watermarkElement, fallbackHalfSize);
    const nextX = ((event.clientX - rect.left) / rect.width) * 100;
    const nextY = ((event.clientY - rect.top) / rect.height) * 100;
    const boundedX = Math.min(maxX, Math.max(minX, nextX));
    const boundedY = Math.min(maxY, Math.max(minY, nextY));

    if (draggingWatermarkTargetRef.current === 'text') {
      updateActiveTemplate({ textX: boundedX, textY: boundedY });
      return;
    }

    updateActiveTemplate({ imageX: boundedX, imageY: boundedY });
  };

  const stopWatermarkDrag = () => {
    draggingWatermarkRef.current = false;
    draggingWatermarkElementRef.current = null;
    draggingWatermarkTargetRef.current = 'image';
    dragCleanupRef.current?.();
    dragCleanupRef.current = null;
  };

  const attachWatermarkDragListeners = () => {
    dragCleanupRef.current?.();
    const handleMove = (event) => {
      if (!draggingWatermarkRef.current) return;
      moveWatermarkByPointer(event);
    };
    const handleEnd = () => stopWatermarkDrag();

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleEnd);
    window.addEventListener('pointercancel', handleEnd);
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleEnd);

    dragCleanupRef.current = () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleEnd);
      window.removeEventListener('pointercancel', handleEnd);
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleEnd);
    };
  };

  const handleWatermarkPointerDown = (event, target = 'image') => {
    event.preventDefault();
    if (draggingWatermarkRef.current) return;
    draggingWatermarkRef.current = true;
    draggingWatermarkElementRef.current = event.currentTarget;
    draggingWatermarkTargetRef.current = target;
    if (event.pointerId !== undefined) {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
    attachWatermarkDragListeners();
  };

  const handleWatermarkPointerMove = (event) => {
    if (!draggingWatermarkRef.current) return;
    moveWatermarkByPointer(event);
  };

  const handleWatermarkPointerEnd = () => {
    stopWatermarkDrag();
  };

  const scopeOptions = [
    { value: 'main', label: '主图' },
    { value: 'detail', label: '详情图' },
    { value: 'all', label: '全部' },
  ];

  if (!activeTemplate) return null;

  return (
    <Box className="watermark-settings-panel">
      <Box className="watermark-template-card">
        <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1} mb={1.5}>
          <Box>
            <Typography variant="h6">水印模板</Typography>
            <Typography variant="body2" color="text.secondary">
              共 {templates.length} 个模板
            </Typography>
          </Box>
          <Button size="small" variant="contained" onClick={addTemplate}>
            新增
          </Button>
        </Stack>
        <Stack spacing={1} className="watermark-template-list">
          {templates.map((template) => (
            <Box
              key={template.id}
              component="button"
              type="button"
              className={`watermark-template-item${template.id === activeTemplate.id ? ' active' : ''}`}
              onClick={() => {
                setActiveTemplateId(template.id);
              }}
            >
              <Box>
                <Typography variant="subtitle1" noWrap title={template.name}>
                  {template.name}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {scopeOptions.find((option) => option.value === template.scope)?.label ?? '主图'}
                </Typography>
              </Box>
              <Stack direction="row" spacing={0.5}>
                <Tooltip title="编辑名称">
                  <IconButton
                    size="small"
                    onClick={(event) => {
                      event.stopPropagation();
                      setActiveTemplateId(template.id);
                      onAction('编辑模板名称');
                    }}
                  >
                    <EditRounded fontSize="small" />
                  </IconButton>
                </Tooltip>
                <Tooltip title="复制模板">
                  <IconButton
                    size="small"
                    onClick={(event) => {
                      event.stopPropagation();
                      duplicateTemplate(template);
                    }}
                  >
                    <ContentCopyRounded fontSize="small" />
                  </IconButton>
                </Tooltip>
                <Tooltip title="删除模板">
                  <span>
                    <IconButton
                      size="small"
                      onClick={(event) => {
                        event.stopPropagation();
                        deleteTemplate(template.id);
                      }}
                    >
                      <DeleteOutlineRounded fontSize="small" />
                    </IconButton>
                  </span>
                </Tooltip>
              </Stack>
            </Box>
          ))}
        </Stack>
      </Box>

      <Box className="watermark-editor-card">
        <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1.5} mb={2}>
          <Box>
            <Typography variant="h6">水印设置</Typography>
            <Typography variant="body2" color="text.secondary">
              {activeTemplate.name}
            </Typography>
          </Box>
          <Chip
            color={activeTemplate.savedAt ? 'success' : 'primary'}
            label={activeTemplate.savedAt ? `已保存 ${activeTemplate.savedAt}` : '未保存'}
            variant="outlined"
          />
        </Stack>

        <Box className="watermark-editor-grid">
          <TextField
            className="watermark-field-full"
            size="small"
            label="模板名称"
            value={activeTemplate.name}
            onChange={(event) => updateActiveTemplate({ name: event.target.value })}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <EditRounded fontSize="small" />
                </InputAdornment>
              ),
            }}
          />

          <Box className="watermark-field-full">
            <Typography variant="subtitle2" className="watermark-control-label">
              应用范围
            </Typography>
            <Box className="watermark-scope-toggle">
              {scopeOptions.map((option) => (
                <Button
                  key={option.value}
                  size="small"
                  variant={activeTemplate.scope === option.value ? 'contained' : 'outlined'}
                  onClick={() => updateActiveTemplate({ scope: option.value })}
                >
                  {option.label}
                </Button>
              ))}
            </Box>
          </Box>

          <Box className="watermark-upload-box">
            <ImageRounded />
            <Box className="watermark-upload-info">
              <Typography
                className="watermark-upload-name"
                variant="subtitle1"
                noWrap
                title={activeTemplate.imageName || '图片水印'}
              >
                {activeTemplate.imageName || '图片水印'}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                PNG / JPG 本地预览
              </Typography>
            </Box>
            <Button size="small" variant="outlined" component="label">
              选择图片
              <input hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={handleImageUpload} />
            </Button>
          </Box>

          <TextField
            size="small"
            label="文字水印"
            value={activeTemplate.text}
            onChange={(event) => updateActiveTemplate({ text: event.target.value })}
            multiline
            minRows={3}
          />

          <Box className="watermark-slider-field">
            <Typography variant="subtitle2">透明度 {activeTemplate.opacity}%</Typography>
            <Slider
              size="small"
              value={activeTemplate.opacity}
              min={10}
              max={100}
              onChange={(_, value) => updateActiveTemplate({ opacity: value })}
            />
          </Box>
          <Box className="watermark-slider-field">
            <Typography variant="subtitle2">水印图大小 {activeTemplate.imageSize}%</Typography>
            <Box className="watermark-size-control">
              <Tooltip title="缩小图片水印">
                <IconButton
                  size="small"
                  onClick={() =>
                    adjustWatermarkSize('imageSize', -1, WATERMARK_IMAGE_SIZE_MIN, WATERMARK_IMAGE_SIZE_MAX)
                  }
                  aria-label="缩小图片水印"
                >
                  <RemoveRounded fontSize="small" />
                </IconButton>
              </Tooltip>
              <Slider
                size="small"
                value={activeTemplate.imageSize}
                min={WATERMARK_IMAGE_SIZE_MIN}
                max={WATERMARK_IMAGE_SIZE_MAX}
                onChange={(_, value) => updateActiveTemplate({ imageSize: value })}
              />
              <Tooltip title="放大图片水印">
                <IconButton
                  size="small"
                  onClick={() =>
                    adjustWatermarkSize('imageSize', 1, WATERMARK_IMAGE_SIZE_MIN, WATERMARK_IMAGE_SIZE_MAX)
                  }
                  aria-label="放大图片水印"
                >
                  <AddRounded fontSize="small" />
                </IconButton>
              </Tooltip>
            </Box>
          </Box>
          <Box className="watermark-slider-field">
            <Typography variant="subtitle2">换行宽度 {activeTemplate.textWidth}%</Typography>
            <Slider
              size="small"
              value={activeTemplate.textWidth}
              min={18}
              max={90}
              disabled={!activeTemplate.wrapText}
              onChange={(_, value) => updateActiveTemplate({ textWidth: value })}
            />
          </Box>
          <Box className="watermark-slider-field">
            <Typography variant="subtitle2">文字大小 {activeTemplate.textSize}px</Typography>
            <Box className="watermark-size-control">
              <Tooltip title="缩小文字">
                <IconButton
                  size="small"
                  onClick={() => adjustWatermarkSize('textSize', -1, WATERMARK_TEXT_SIZE_MIN, WATERMARK_TEXT_SIZE_MAX)}
                  aria-label="缩小文字"
                >
                  <RemoveRounded fontSize="small" />
                </IconButton>
              </Tooltip>
              <Slider
                size="small"
                value={activeTemplate.textSize}
                min={WATERMARK_TEXT_SIZE_MIN}
                max={WATERMARK_TEXT_SIZE_MAX}
                onChange={(_, value) => updateActiveTemplate({ textSize: value })}
              />
              <Tooltip title="放大文字">
                <IconButton
                  size="small"
                  onClick={() => adjustWatermarkSize('textSize', 1, WATERMARK_TEXT_SIZE_MIN, WATERMARK_TEXT_SIZE_MAX)}
                  aria-label="放大文字"
                >
                  <AddRounded fontSize="small" />
                </IconButton>
              </Tooltip>
            </Box>
          </Box>
          <Box className="watermark-color-field watermark-field-full">
            <Typography variant="subtitle2" className="watermark-control-label">
              文字颜色
            </Typography>
            <Box className="watermark-color-row">
              <Box className="watermark-color-swatches" aria-label="文字颜色选项">
                {WATERMARK_TEXT_COLOR_OPTIONS.map((color) => (
                  <Tooltip key={color} title={color}>
                    <Box
                      component="button"
                      type="button"
                      aria-label={`文字颜色 ${color}`}
                      className={`watermark-color-swatch${activeTemplate.textColor === color ? ' active' : ''}`}
                      onClick={() => updateActiveTemplate({ textColor: color })}
                      sx={{ backgroundColor: color }}
                    />
                  </Tooltip>
                ))}
              </Box>
              <TextField
                className="watermark-color-input"
                size="small"
                label="自定义"
                type="color"
                value={activeTemplate.textColor}
                onChange={(event) => updateActiveTemplate({ textColor: event.target.value })}
              />
            </Box>
          </Box>
          <FormControlLabel
            className="watermark-field-full watermark-switch-field"
            control={
              <Switch
                checked={activeTemplate.wrapText}
                onChange={(event) => updateActiveTemplate({ wrapText: event.target.checked })}
              />
            }
            label="文字自动换行"
          />
        </Box>

        <Stack direction="row" spacing={1} mt={2}>
          <Button variant="contained" onClick={saveActiveTemplate}>
            保存模板
          </Button>
          <Button variant="outlined" onClick={() => onAction('应用到图片')}>
            应用到图片
          </Button>
        </Stack>
      </Box>

      <WatermarkPreviewCard
        activeTemplate={activeTemplate}
        previewFrameRef={previewFrameRef}
        textPreviewRef={textPreviewRef}
        onPointerDown={handleWatermarkPointerDown}
        onPointerMove={handleWatermarkPointerMove}
        onPointerEnd={handleWatermarkPointerEnd}
      />
    </Box>
  );
}
