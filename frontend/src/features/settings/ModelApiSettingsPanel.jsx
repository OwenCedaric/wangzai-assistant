import { safeWarn } from '../../services/safeLog';
import { listModelApiAccounts, saveModelApiAccount } from '../../api/localApiClient.js';
import { filterImageGenerationModels } from '../../shared/lib/modelCapabilityRules.js';
import {
  APPROVED_IMAGE_MODEL_ID,
  isApprovedImageModel,
  isApprovedImageModelAccount,
} from '../../shared/lib/imageGenerationProviderPolicy.js';
import { selectCredentialMaskOnFocus, toCredentialMaskValue, toStoredCredentialValue } from './lib/credentialMask.js';
import {
  createBlankModelApiSettings,
  emptyModelApiSettings,
  getDefaultModelApiState,
  getModelApiOptionGroups,
  normalizeModelApiState,
  setModelApiStateMemory,
  toModelApiAccountPayload,
  toModelApiSettingsFromAccount,
  toModelApiStateFromAccounts,
} from './lib/modelApiSettings.jsx';
import ImageRounded from '@mui/icons-material/ImageRounded';
import Avatar from '@mui/material/Avatar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import { AccountRemovalPreviewDialog } from './accountRemoval/components/AccountRemovalPreviewDialog.jsx';
import { useAccountRemovalFlow } from './accountRemoval/model/useAccountRemovalFlow.js';
import { useAccountRemovalCompletionView } from './accountRemoval/model/useAccountRemovalCompletionView.js';
import { STABLE_SELECT_MENU_PROPS } from './ui/stableSelectMenuProps.js';

function hasSavedSecret(value, flag) {
  return Boolean(String(value || '').trim()) || flag === true;
}

function modelCount(item) {
  return selectableModels(item).length;
}

function imageModels(item) {
  if (!isApprovedImageModelAccount(item)) return [];
  return filterImageGenerationModels(item?.availableModels)
    .filter((model) => isApprovedImageModel(model?.id || model?.model));
}

function selectableModels(item) {
  const availableModels = Array.isArray(item?.availableModels) ? item.availableModels : [];
  const discoveredImageModels = filterImageGenerationModels(availableModels);
  const availableImageModels = imageModels(item);
  if (discoveredImageModels.length > 0) return availableImageModels;
  return availableModels;
}

function isReady(item) {
  return Boolean(
    String(item?.websiteUrl || '').trim() &&
    hasSavedSecret(item?.apiKey, item?.hasApiKey) &&
    item?.discoveryVerified &&
    modelCount(item) > 0
  );
}

function discoveryText(item) {
  if (!item) return '填写接口地址和 API Key 后保存，后台会自动识别接口。';
  if (item.discoveryVerified) {
    const discoveredImageModels = filterImageGenerationModels(item?.availableModels);
    const imageModelCount = imageModels(item).length;
    if (discoveredImageModels.length > 0 && imageModelCount === 0) {
      return `该接口不符合固定生图策略。生图只允许 已配置的图片服务 的 ${APPROVED_IMAGE_MODEL_ID}。`;
    }
    return imageModelCount > 0
      ? '已自动识别 ' + imageModelCount + ' 个生图模型，可在图片编辑中选择。'
      : '已自动识别 ' + modelCount(item) + ' 个模型，可在智能工具中选择。';
  }
  return item.detectionStatus || '尚未识别到可用接口，可检查网址和 API Key 后重新保存。';
}

function savedResultText(item) {
  const message = discoveryText(item);
  if (item?.discoveryVerified || /^已保存配置/u.test(message)) return message;
  return '已保存配置。' + message;
}

function errorText(error) {
  const code = String(error?.code || error?.payload?.error?.code || '').trim();
  if (code === 'ACCOUNT_REMOVAL_OWNER_LOCKED') {
    return '旧配置还有删除清理任务未完成，请点击“新增”后重新保存。';
  }
  if (code === 'ACCOUNT_REMOVAL_OWNER_REBIND_REQUIRED') {
    return '这个旧配置已经删除，请点击“新增”后重新保存。';
  }
  const backendMessage = error?.payload?.error?.message;
  if (backendMessage) return String(backendMessage);
  return error instanceof Error ? error.message : String(error);
}

function blockModelApiClipboard(event) {
  event.preventDefault();
}

function blockModelApiClipboardShortcut(event) {
  if ((event.ctrlKey || event.metaKey) && ['c', 'x'].includes(String(event.key || '').toLowerCase())) {
    event.preventDefault();
  }
}

function genericConfigLabel(index) {
  return '配置 ' + (index + 1);
}

function ModelApiSettingsPanel({ onAction, saveRequestId = 0 }) {
  const accountRemoval = useAccountRemovalFlow();
  const [modelApiState, setModelApiState] = React.useState(getDefaultModelApiState);
  const [modelApiLoading, setModelApiLoading] = React.useState(false);
  const persistedAccountIdsRef = React.useRef(new Set());
  useAccountRemovalCompletionView({ rows: modelApiState.interfaces, ownerTypes: ['model_api_account'], apply: (filter, event) => {
    setModelApiState(current => {
      const remaining = filter(current.interfaces);
      if (remaining === current.interfaces) return current;
      persistedAccountIdsRef.current.delete(event.owner.ownerId);
      const interfaces = remaining.length ? remaining : [createBlankModelApiSettings(1)];
      const next = { ...current, interfaces, activeId: interfaces.some(item => item.id === current.activeId) ? current.activeId : interfaces[0].id };
      setModelApiStateMemory(next);
      return next;
    });
  } });
  const activeInterface =
    modelApiState.interfaces.find((item) => item.id === modelApiState.activeId) ||
    modelApiState.interfaces[0] ||
    emptyModelApiSettings;
  const [statusMessage, setStatusMessage] = React.useState(
    '填写接口地址和 API Key 后保存，后台自动识别可用模型和能力。'
  );
  const availableModelCount = modelCount(activeInterface);
  const imageModelOptions = imageModels(activeInterface);
  const selectableModelOptions = imageModelOptions.length > 0 ? imageModelOptions : activeInterface.availableModels;
  const discoveredOptionGroups = getModelApiOptionGroups(activeInterface);
  const discoveredChoiceFields = [
    {
      id: 'defaultModel',
      label: imageModelOptions.length > 0 ? '生图模型' : '模型',
      options: selectableModelOptions,
    },
    { id: 'quality', label: '质量', options: discoveredOptionGroups.quality },
    { id: 'style', label: '风格', options: discoveredOptionGroups.style },
    { id: 'upscale', label: '放大', options: discoveredOptionGroups.upscale },
  ].filter((item) => Array.isArray(item.options) && item.options.length > 0);
  const apiKeySaved = hasSavedSecret(activeInterface.apiKey, activeInterface.hasApiKey);
  const interfaceReady = isReady(activeInterface);
  const profileChip = interfaceReady ? { label: '已识别', color: 'success' } : { label: '待识别', color: 'default' };
  const profileItems = [
    { label: '识别状态', value: interfaceReady ? '已识别' : '待识别' },
    {
      label: imageModelOptions.length > 0 ? '可用生图模型' : '可用模型',
      value: availableModelCount > 0 ? availableModelCount + ' 个' : '未识别',
    },
    { label: '可用能力', value: activeInterface.capabilities?.length ? '已返回' : '待识别' },
    { label: '配置状态', value: apiKeySaved ? '本地已保存' : '待保存' },
  ];
  React.useEffect(() => {
    let cancelled = false;
    setModelApiLoading(true);
    listModelApiAccounts({ timeoutMs: 30000 })
      .then((accountPayload) => {
        const accounts = Array.isArray(accountPayload?.accounts)
          ? accountPayload.accounts
          : Array.isArray(accountPayload?.rows)
            ? accountPayload.rows
            : [];
        if (cancelled) return;
        persistedAccountIdsRef.current = new Set(accounts.map((account) => account.id));
        const state = toModelApiStateFromAccounts(accounts);
        setModelApiState(state);
        setModelApiStateMemory(state);
        const nextInterface = state.interfaces.find((item) => item.id === state.activeId) || state.interfaces[0];
        setStatusMessage(discoveryText(nextInterface));
      })
      .catch((error) => {
        safeWarn('[模型接口] 本机账号库读取失败', error);
        if (!cancelled) setStatusMessage('本机账号库读取失败，请重试。');
      })
      .finally(() => {
        if (!cancelled) setModelApiLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const updateActiveInterface = (updater) => {
    setModelApiState((current) =>
      normalizeModelApiState({
        ...current,
        interfaces: current.interfaces.map((item) =>
          item.id === current.activeId
            ? typeof updater === 'function'
              ? updater(item)
              : { ...item, ...updater }
            : item
        ),
      })
    );
  };

  const updateField = (field) => (event) => {
    const value = field === 'apiKey' ? toStoredCredentialValue(event.target.value) : event.target.value;
    updateActiveInterface((current) => ({ ...current, [field]: value }));
  };

  const selectInterface = (id) => {
    const nextInterface = modelApiState.interfaces.find((item) => item.id === id);
    const nextState = normalizeModelApiState({ ...modelApiState, activeId: id });
    setModelApiState(nextState);
    setModelApiStateMemory(nextState);
    setStatusMessage(discoveryText(nextInterface));
  };

  const addInterface = () => {
    const nextInterface = createBlankModelApiSettings(modelApiState.interfaces.length + 1);
    const nextState = normalizeModelApiState({
      activeId: nextInterface.id,
      interfaces: [...modelApiState.interfaces, nextInterface],
    });
    setModelApiState(nextState);
    setModelApiStateMemory(nextState);
    setStatusMessage('请填写接口地址和 API Key 后保存，后台会自动识别。');
    onAction('新增接口配置');
  };

  const removeInterfaceFromView = (interfaceId) => {
    const currentIndex = modelApiState.interfaces.findIndex((item) => item.id === interfaceId);
    const nextInterfaces = modelApiState.interfaces.filter((item) => item.id !== interfaceId);
    const safeInterfaces = nextInterfaces.length > 0 ? nextInterfaces : [createBlankModelApiSettings(1)];
    const nextActiveInterface = nextInterfaces[Math.max(0, currentIndex - 1)] || safeInterfaces[0];
    const nextState = normalizeModelApiState({
      activeId: nextActiveInterface.id,
      interfaces: safeInterfaces,
    });
    setModelApiState(nextState);
    setModelApiStateMemory(nextState);
    setStatusMessage(nextInterfaces.length > 0 ? '已删除当前配置。' : '已删除当前配置，请重新填写。');
    onAction('删除接口配置');
  };

  const removeActiveInterface = () => {
    const interfaceId = activeInterface.id;
    if (!persistedAccountIdsRef.current.has(interfaceId)) {
      removeInterfaceFromView(interfaceId);
      return;
    }
    setStatusMessage('请在删除预览中核对当前配置。');
    const applyModelApiAccountRemoval = () => {
      persistedAccountIdsRef.current.delete(interfaceId);
      removeInterfaceFromView(interfaceId);
      setStatusMessage('当前配置已完成删除和回读。');
    };
    accountRemoval.openAccountRemoval(
      { ownerType: 'model_api_account', ownerId: interfaceId },
      {
        onCompleted: applyModelApiAccountRemoval,
        onMissing: applyModelApiAccountRemoval,
      }
    );
  };

  const saveSettings = async () => {
    const hasApiKey = hasSavedSecret(activeInterface.apiKey, activeInterface.hasApiKey);
    const missingFields = [!activeInterface.websiteUrl.trim() ? '接口地址' : '', !hasApiKey ? 'API Key' : ''].filter(
      Boolean
    );
    if (missingFields.length > 0) {
      setStatusMessage('请先填写：' + missingFields.join('、') + '。');
      return;
    }

    setModelApiLoading(true);
    setStatusMessage('正在加密保存，并由后台自动识别可用能力...');
    try {
      const saved = await saveModelApiAccount(toModelApiAccountPayload(activeInterface, { isDefault: true }), {
        timeoutMs: 30000,
      });
      if (!saved?.account?.id) throw new Error('后台没有返回接口配置。');
      persistedAccountIdsRef.current.add(saved.account.id);
      const savedInterface = toModelApiSettingsFromAccount(saved.account);
      setModelApiState((current) => {
        const nextState = normalizeModelApiState({
          activeId: saved.account.id,
          interfaces: current.interfaces.map((item) =>
            item.id === activeInterface.id ? savedInterface : { ...item, isDefault: false }
          ),
        });
        setModelApiStateMemory(nextState);
        return nextState;
      });
      setStatusMessage(savedResultText(savedInterface));
      onAction('保存并自动识别接口');
    } catch (error) {
      setStatusMessage('保存失败：' + errorText(error));
    } finally {
      setModelApiLoading(false);
    }
  };

  const saveSelectedOptions = async () => {
    if (!activeInterface.id || !persistedAccountIdsRef.current.has(activeInterface.id)) {
      setStatusMessage('请先保存账号信息，再保存功能选项。');
      return;
    }
    setModelApiLoading(true);
    setStatusMessage('正在保存已选择的功能选项...');
    try {
      const saved = await saveModelApiAccount(
        {
          id: activeInterface.id,
          defaultModel: activeInterface.defaultModel,
          quality: activeInterface.quality,
          style: activeInterface.style,
          upscale: activeInterface.upscale,
          isDefault: Boolean(activeInterface.isDefault),
        },
        { timeoutMs: 30000 }
      );
      if (!saved?.account?.id) throw new Error('后台没有返回保存结果。');
      const savedInterface = toModelApiSettingsFromAccount(saved.account);
      setModelApiState((current) => {
        const nextState = normalizeModelApiState({
          activeId: savedInterface.id,
          interfaces: current.interfaces.map((item) => (item.id === savedInterface.id ? savedInterface : item)),
        });
        setModelApiStateMemory(nextState);
        return nextState;
      });
      setStatusMessage('功能选项已保存。');
      onAction('保存接口功能选项');
    } catch (error) {
      setStatusMessage('选项保存失败：' + errorText(error));
    } finally {
      setModelApiLoading(false);
    }
  };

  const resetSettings = () => {
    const nextState = getDefaultModelApiState();
    setModelApiState(nextState);
    setModelApiStateMemory(nextState);
    setStatusMessage('已清空当前输入，尚未保存。');
    onAction('清空接口配置输入');
  };

  const saveSettingsRef = React.useRef(saveSettings);
  saveSettingsRef.current = saveSettings;
  const handledSaveRequestIdRef = React.useRef(saveRequestId);
  React.useEffect(() => {
    if (saveRequestId === handledSaveRequestIdRef.current) return;
    handledSaveRequestIdRef.current = saveRequestId;
    void saveSettingsRef.current();
  }, [saveRequestId]);

  return (
    <Box
      className="shop-settings-layout model-api-layout"
      onCopy={blockModelApiClipboard}
      onCut={blockModelApiClipboard}
      onContextMenu={blockModelApiClipboard}
      onDragStart={blockModelApiClipboard}
      onKeyDown={blockModelApiClipboardShortcut}
    >
      <Box className="shop-list-card">
        <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1} mb={1.5}>
          <Box>
            <Typography variant="h6">配置列表</Typography>
            <Typography variant="body2" color="text.secondary">
              共 {modelApiState.interfaces.length} 个
            </Typography>
          </Box>
          <Button size="small" variant="contained" onClick={addInterface} disabled={modelApiLoading}>
            新增
          </Button>
        </Stack>
        <Stack spacing={1} className="shop-list">
          {modelApiState.interfaces.map((item, index) => {
            const ready = isReady(item);
            return (
              <Box
                key={item.id}
                component="button"
                type="button"
                className={'shop-list-item' + (item.id === modelApiState.activeId ? ' active' : '')}
                onClick={() => selectInterface(item.id)}
              >
                <Box>
                  <Typography variant="subtitle1">{genericConfigLabel(index)}</Typography>
                  <Typography variant="caption" color="text.secondary" noWrap>
                    {ready
                      ? '已识别 ' + modelCount(item) + (imageModels(item).length > 0 ? ' 个生图模型' : ' 个模型')
                      : '等待自动识别'}
                  </Typography>
                </Box>
                <Chip
                  size="small"
                  color={ready ? 'primary' : 'default'}
                  label={ready ? '可用' : '待配置'}
                  variant="outlined"
                />
              </Box>
            );
          })}
        </Stack>
        <Button
          className="shop-remove-button"
          size="small"
          color="error"
          variant="outlined"
          onClick={removeActiveInterface}
          disabled={modelApiLoading}
        >
          删除当前配置
        </Button>
      </Box>

      <Box className="shop-settings-detail">
        <Box className="shop-settings-main">
          <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1.5} mb={2}>
            <Box>
              <Typography variant="h6">接口配置</Typography>
              <Typography variant="body2" color="text.secondary">
                只填写接口地址和 API Key，后台自动识别可用模型和功能选项。
              </Typography>
            </Box>
            <Chip color="primary" label="本机加密" variant="outlined" />
          </Stack>

          <Box className="structured-form-sections">
            <Box className="structured-form-section">
              <Typography variant="h6">接口信息</Typography>
              <Typography variant="body2" color="text.secondary">
                默认模型和其他技术参数不需要手填。
              </Typography>
              <Box className="structured-form-row">
                <Box className="structured-form-fields">
                  <TextField
                    size="small"
                    label="接口地址"
                    value={activeInterface.websiteUrl}
                    onChange={updateField('websiteUrl')}
                    inputProps={{ 'aria-label': '接口地址' }}
                  />
                  <TextField
                    size="small"
                    label="API Key"
                    type="password"
                    value={toCredentialMaskValue(activeInterface.apiKey, activeInterface.hasApiKey)}
                    onChange={updateField('apiKey')}
                    onFocus={selectCredentialMaskOnFocus}
                    inputProps={{ 'aria-label': 'API Key' }}
                  />
                </Box>
                <Box className="structured-form-actions">
                  <Button variant="contained" onClick={saveSettings} disabled={modelApiLoading}>
                    {modelApiLoading ? '处理中...' : '保存并自动识别'}
                  </Button>
                </Box>
              </Box>
            </Box>
          </Box>

          <Box className="shop-test-result">
            <Typography variant="caption" color="text.secondary">
              识别结果
            </Typography>
            <Typography variant="body2">{statusMessage}</Typography>
            {activeInterface.capabilities?.length > 0 ? (
              <Stack direction="row" spacing={0.75} flexWrap="wrap" mt={1}>
                {activeInterface.capabilities.map((capability) => (
                  <Chip key={capability} size="small" label={capability} variant="outlined" />
                ))}
              </Stack>
            ) : null}
            {discoveredChoiceFields.length > 0 ? (
              <Box className="model-api-discovered-options" mt={1.25}>
                <Typography variant="caption" color="text.secondary">
                  可用选项（按接口返回）
                </Typography>
                <Box className="model-api-option-grid" mt={0.75}>
                  {discoveredChoiceFields.map((field) => (
                    <TextField
                      key={field.id}
                      select
                      size="small"
                      label={field.label}
                      value={activeInterface[field.id] || ''}
                      onChange={(event) => updateActiveInterface({ [field.id]: event.target.value })}
                      inputProps={{ 'aria-label': field.label }}
                      SelectProps={{ displayEmpty: true, MenuProps: STABLE_SELECT_MENU_PROPS }}
                    >
                      <MenuItem value="">
                        <em>未选择</em>
                      </MenuItem>
                      {field.options.map((option) => (
                        <MenuItem key={option.id || option.value} value={option.id || option.value}>
                          {option.label || option.id || option.value}
                        </MenuItem>
                      ))}
                    </TextField>
                  ))}
                </Box>
                <Button
                  size="small"
                  variant="outlined"
                  sx={{ mt: 1 }}
                  onClick={saveSelectedOptions}
                  disabled={modelApiLoading || !persistedAccountIdsRef.current.has(activeInterface.id)}
                >
                  保存选择
                </Button>
              </Box>
            ) : null}
          </Box>

          <Box className="settings-module-actions">
            <Button size="small" variant="outlined" onClick={resetSettings} disabled={modelApiLoading}>
              清空输入
            </Button>
          </Box>
        </Box>
        <Box className="shop-settings-side">
          <Box className="shop-profile-card">
            <Stack direction="row" alignItems="center" spacing={1.5}>
              <Avatar className="store-avatar store-primary">
                <ImageRounded />
              </Avatar>
              <Box>
                <Typography variant="subtitle1">当前配置</Typography>
                <Typography variant="caption" color="text.secondary">
                  仅显示功能状态
                </Typography>
              </Box>
            </Stack>
            <Divider sx={{ my: 1.5 }} />
            <Box className="shop-profile-grid">
              {profileItems.map((item) => (
                <Box key={item.label}>
                  <Typography variant="caption" color="text.secondary">
                    {item.label}
                  </Typography>
                  <Typography variant="subtitle1" noWrap>
                    {item.value}
                  </Typography>
                </Box>
              ))}
              <Box>
                <Typography variant="caption" color="text.secondary">
                  状态
                </Typography>
                <Chip size="small" color={profileChip.color} label={profileChip.label} variant="outlined" />
              </Box>
            </Box>
            <Box className="shop-test-result">
              <Typography variant="caption" color="text.secondary">
                当前状态
              </Typography>
              <Typography variant="body2">{statusMessage}</Typography>
            </Box>
          </Box>
        </Box>
      </Box>

      <AccountRemovalPreviewDialog
        flow={accountRemoval.flow}
        busy={accountRemoval.busy}
        onConfirm={accountRemoval.confirmRemoval}
        onExportBackup={accountRemoval.exportBackupBeforeRemoval}
        onUseRecentBackup={accountRemoval.useRecentBackupBeforeRemoval}
        onSkipBackup={accountRemoval.skipBackupBeforeRemoval}
        onRefresh={accountRemoval.refreshPreview}
        onClose={accountRemoval.closeAccountRemoval}
      />
    </Box>
  );
}

export { ModelApiSettingsPanel };
export default ModelApiSettingsPanel;
