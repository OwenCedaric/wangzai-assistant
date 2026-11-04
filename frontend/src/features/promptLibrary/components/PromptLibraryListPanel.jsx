import AutoFixHighRounded from '@mui/icons-material/AutoFixHighRounded';
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded';
import EditRounded from '@mui/icons-material/EditRounded';
import SearchRounded from '@mui/icons-material/SearchRounded';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import FormControl from '@mui/material/FormControl';
import InputAdornment from '@mui/material/InputAdornment';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import {
  formatSmartToolModelDisplayName,
  resolveSmartToolModelSelection,
  SMART_TOOL_AUTO_MODEL_ID,
  SMART_TOOL_IMAGE_MODEL_CAPABILITY,
} from '../services/smartToolModelService.js';
import { isUserInstalledSmartTool } from '../lib/smartToolInstalledSkill.js';

function getPromptModelOptions(prompt, modelOptions = [], imageModelOptions = []) {
  return prompt?.skillProfile?.modelCapability === SMART_TOOL_IMAGE_MODEL_CAPABILITY ? imageModelOptions : modelOptions;
}

function getPromptModelSelection(prompt, modelOptions = [], imageModelOptions = [], role = 'default') {
  const compatibleOptions = getPromptModelOptions(prompt, modelOptions, imageModelOptions);
  const configuredModelId =
    role === 'planner'
      ? prompt.promptConfig?.plannerModelId
      : role === 'image'
        ? prompt.promptConfig?.imageModelId
        : prompt.promptConfig?.defaultModelId;
  return resolveSmartToolModelSelection(
    configuredModelId || SMART_TOOL_AUTO_MODEL_ID,
    role === 'planner' ? modelOptions : compatibleOptions
  );
}

function getPromptModelLabel(prompt, modelOptions, imageModelOptions, role = 'default') {
  const selection = getPromptModelSelection(prompt, modelOptions, imageModelOptions, role);
  return formatSmartToolModelDisplayName(selection.model);
}

export function PromptLibraryListPanel({
  prompts,
  keyword,
  scene,
  scenes,
  modelOptions = [],
  imageModelOptions = [],
  onKeywordChange,
  onSceneChange,
  onRunPrompt,
  onEditPrompt,
  onDeletePrompt = () => {},
}) {
  return (
    <Card className="prompt-library-list-card prompt-library-catalog-card">
      <CardContent>
        <Stack
          direction={{ xs: 'column', lg: 'row' }}
          alignItems={{ xs: 'stretch', lg: 'center' }}
          justifyContent="space-between"
          spacing={1.5}
          className="prompt-library-table-head"
        >
          <Box>
            <Typography variant="h6">工具列表</Typography>
            <Typography variant="body2" color="text.secondary">
              已适配的 Skill 可以直接运行；未适配的会明确显示等待接入。
            </Typography>
          </Box>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} className="prompt-library-toolbar">
            <TextField
              className="prompt-library-search-field"
              size="small"
              placeholder="搜索工具、用途、模型"
              value={keyword}
              onChange={(event) => onKeywordChange(event.target.value)}
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchRounded />
                  </InputAdornment>
                ),
              }}
            />
            <FormControl size="small" className="prompt-library-filter-select">
              <Select value={scene} onChange={(event) => onSceneChange(event.target.value)}>
                {scenes.map((item) => (
                  <MenuItem key={item.value} value={item.value}>
                    {item.label}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Stack>
        </Stack>

        <Box className="prompt-library-list">
          {prompts.length ? (
            prompts.map((item) => {
              const modelLabel = getPromptModelLabel(item, modelOptions, imageModelOptions);
              const modelSelection = getPromptModelSelection(item, modelOptions, imageModelOptions);
              const isImageSkill = item?.skillProfile?.modelCapability === SMART_TOOL_IMAGE_MODEL_CAPABILITY;
              const plannerModelLabel = isImageSkill
                ? getPromptModelLabel(item, modelOptions, imageModelOptions, 'planner')
                : '';
              const plannerModelSelection = isImageSkill
                ? getPromptModelSelection(item, modelOptions, imageModelOptions, 'planner')
                : null;
              const imageModelLabel = isImageSkill
                ? getPromptModelLabel(item, modelOptions, imageModelOptions, 'image')
                : modelLabel;
              const imageModelSelection = isImageSkill
                ? getPromptModelSelection(item, modelOptions, imageModelOptions, 'image')
                : modelSelection;
              const canDelete = isUserInstalledSmartTool(item);

              return (
                <Box
                  key={item.id}
                  component="article"
                  className="prompt-library-row prompt-library-tool-card"
                  data-skill-scene={item.scene}
                >
                  <Stack direction="row" alignItems="flex-start" justifyContent="space-between" spacing={1.25}>
                    <Box className="prompt-library-tool-card-heading">
                      <Typography variant="subtitle1" title={item.title}>
                        {item.title}
                      </Typography>
                      <Typography variant="body2" color="text.secondary" title={item.goal}>
                        {item.goal}
                      </Typography>
                    </Box>
                    <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap>
                      {canDelete && item.toolMeta.apiCapabilityMatch?.executionPlan?.totalCount ? (
                        <Chip
                          size="small"
                          color={
                            item.toolMeta.apiCapabilityMatch.executionPlan.unsupportedCount
                              ? 'error'
                              : item.toolMeta.apiCapabilityMatch.executionPlan.missingConfigurationCount
                                ? 'warning'
                                : 'success'
                          }
                          label={`执行 ${item.toolMeta.apiCapabilityMatch.executionPlan.executableCount}/${item.toolMeta.apiCapabilityMatch.executionPlan.totalCount}`}
                          variant="outlined"
                        />
                      ) : null}
                      <Chip
                        size="small"
                        color={item.toolMeta.availabilityTone}
                        label={item.toolMeta.availabilityLabel}
                        variant="outlined"
                      />
                    </Stack>
                  </Stack>

                  <Box className="prompt-library-tool-card-models">
                    {isImageSkill ? (
                      <>
                        <Chip
                          size="small"
                          className="prompt-library-tool-model-chip"
                          color={plannerModelSelection?.ready ? 'primary' : 'default'}
                          variant="outlined"
                          label={plannerModelLabel}
                        />
                        <Chip
                          size="small"
                          className="prompt-library-tool-model-chip"
                          color={imageModelSelection?.ready ? 'primary' : 'default'}
                          variant="outlined"
                          label={imageModelLabel}
                        />
                      </>
                    ) : (
                      <Chip
                        size="small"
                        className="prompt-library-tool-model-chip"
                        color={modelSelection.ready ? 'primary' : 'default'}
                        variant="outlined"
                        label={modelLabel}
                      />
                    )}
                    {item.promptConfig?.modelPurpose ? (
                      <Chip
                        size="small"
                        className="prompt-library-tool-purpose-chip"
                        variant="outlined"
                        label={item.promptConfig.modelPurpose}
                      />
                    ) : null}
                  </Box>

                  <Stack
                    direction={{ xs: 'column', sm: 'row' }}
                    spacing={1}
                    className="prompt-library-tool-card-actions"
                  >
                    <Button
                      size="small"
                      variant="contained"
                      startIcon={<AutoFixHighRounded />}
                      onClick={() => {
                        onRunPrompt(item);
                      }}
                    >
                      {item.toolMeta.primaryActionLabel || '使用功能'}
                    </Button>
                    <Button
                      size="small"
                      variant="outlined"
                      startIcon={<EditRounded />}
                      onClick={() => {
                        onEditPrompt(item);
                      }}
                    >
                      编辑 Skill
                    </Button>
                    {canDelete ? (
                      <Button
                        size="small"
                        variant="outlined"
                        color="error"
                        startIcon={<DeleteOutlineRounded />}
                        onClick={() => {
                          onDeletePrompt(item);
                        }}
                      >
                        删除
                      </Button>
                    ) : null}
                  </Stack>
                </Box>
              );
            })
          ) : (
            <Box className="prompt-library-empty">
              <Typography variant="subtitle1">没有匹配的工具</Typography>
              <Typography variant="body2" color="text.secondary">
                换个关键词或分类再试，也可以安装一个本地 Skill。
              </Typography>
            </Box>
          )}
        </Box>
      </CardContent>
    </Card>
  );
}
