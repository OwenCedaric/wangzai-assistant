import { resolvePurchaseAccountPreset } from '../../../shared/config/purchaseAccountPresets.js';

function cloneStructuredRecord(record) {
  return {
    ...record,
    values: { ...(record?.values ?? {}) },
  };
}

function getStructuredFieldIds(config) {
  const fields = config.sections?.flatMap((section) => section.fields ?? []) ?? config.fields ?? [];
  return fields.map((field) => field.id).filter(Boolean);
}

function getStructuredRecordCountLabel(config, count) {
  const unitMap = {
    crossBorderBus: '授权',
    purchaseAccount: '账号',
    platformApi: '接口',
  };
  return `共 ${count} 个${unitMap[config.id] || '配置'}`;
}

function buildStructuredEmptyValues(config) {
  return Object.fromEntries(getStructuredFieldIds(config).map((fieldId) => [fieldId, '']));
}

function getDefaultStructuredRecordTitle(config, index = 1) {
  const nameMap = {
    purchaseAccount: `拍单账号 ${index}`,
    platformApi: `平台接口 ${index}`,
  };
  return nameMap[config.id] || `${config.mainTitle || config.listTitle || '配置'} ${index}`;
}

function createBlankStructuredRecord(config, index = 1) {
  return {
    id: `${config.id}-local-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    title: getDefaultStructuredRecordTitle(config, index),
    meta: '本地草稿待填写',
    status: '待配置',
    statusColor: 'default',
    values: buildStructuredEmptyValues(config),
  };
}

function normalizeStructuredRecord(config, record, index = 0) {
  const source = cloneStructuredRecord(record);
  let values = {
    ...buildStructuredEmptyValues(config),
    ...(source.values ?? {}),
  };
  if (config.id === 'purchaseAccount') {
    const preset = resolvePurchaseAccountPreset(values);
    if (preset) {
      values = {
        ...values,
        accountAlias: preset.accountAlias,
        platformName: preset.platformName,
        platformUrl: preset.platformUrl,
      };
    }
  }
  const title =
    String(values.accountAlias || values.platformName || values.apiAlias || source.title || '').trim() ||
    getDefaultStructuredRecordTitle(config, index + 1);
  const meta =
    String(
      source.meta || values.loginAccount || values.apiType || values.authMode || values.configStatus || ''
    ).trim() || '本地草稿待填写';
  return {
    id: String(source.id || `${config.id}-local-${index + 1}`),
    isTransientDraft: source.isTransientDraft === true,
    isPlaceholderDraft: source.isPlaceholderDraft === true,
    title,
    meta,
    status: String(source.status || '待配置'),
    statusColor: String(source.statusColor || 'default'),
    values,
  };
}

function toPurchaseAccountSavePayload(record, options = {}) {
  const values = record?.values ?? {};
  const preset = resolvePurchaseAccountPreset(values);
  const name = String(preset?.accountAlias || values.accountAlias || record?.title || '拍单账号').trim();
  const payload = {
    name,
    platformName: String(preset?.platformName || values.platformName || '').trim(),
    platformUrl: String(preset?.platformUrl || values.platformUrl || '').trim(),
    loginAccount: String(values.loginAccount ?? '').trim(),
    recipientNickname: String(values.recipientNickname ?? '').trim(),
    recipientPhone: String(values.recipientPhone ?? '').trim(),
    recipientAddress: String(values.recipientAddress ?? '').trim(),
  };
  if (options.keepId && record?.id) payload.id = record.id;
  if (options.isDefault !== undefined) payload.isDefault = options.isDefault;
  const loginPassword = String(values.loginPassword ?? '').trim();
  if (loginPassword) payload.loginPassword = loginPassword;
  return payload;
}

function toPurchaseStructuredRecord(config, account = {}, index = 0) {
  const isDefault = Boolean(account.isDefault);
  const hasLoginPassword = Boolean(account.hasLoginPassword);
  const cookieSaved = account.cookieStatus === 'Cookie 已保存';
  const hasSavedData = Boolean(
    account.loginAccount
      || account.platformName
      || account.recipientNickname
      || account.recipientPhone
      || account.recipientAddress
      || hasLoginPassword
  );
  const preset = resolvePurchaseAccountPreset({
    accountAlias: account.name,
    platformName: account.platformName,
  });
  return normalizeStructuredRecord(
    config,
    {
      id: account.id,
      title: account.name,
      meta: cookieSaved
        ? (isDefault ? '默认账号 · Cookie 已保存' : 'Cookie 已保存')
        : (isDefault ? '默认账号 · local-api 加密保存' : 'local-api 加密保存'),
      status: cookieSaved ? '登录已保存' : hasSavedData ? '已加密保存' : '待配置',
      statusColor: cookieSaved ? 'success' : hasSavedData ? 'primary' : 'default',
      values: {
        accountAlias: preset?.accountAlias || account.name || '',
        platformName: preset?.platformName || account.platformName || '',
        platformUrl: preset?.platformUrl || account.platformUrl || '',
        loginAccount: account.loginAccount || '',
        loginPassword: '',
        hasLoginPassword,
        loginPasswordHint: account.loginPasswordHint || '',
        recipientNickname: account.recipientNickname || '',
        recipientPhone: account.recipientPhone || '',
        recipientAddress: account.recipientAddress || '',
        browserLoginStatus: account.browserLoginStatus || '未验证',
        cookieStatus: account.cookieStatus || 'Cookie 未保存',
        lastLoginVerifiedAt: account.lastLoginVerifiedAt || '',
        isDefault,
      },
    },
    index
  );
}

function buildPurchaseStructuredRecords(config, accounts = []) {
  return accounts.map((account, index) => toPurchaseStructuredRecord(config, account, index));
}

function buildStructuredProfileItems(config, record) {
  const fields = config.sections?.flatMap((section) => section.fields ?? []) ?? config.fields ?? [];
  const values = record?.values ?? {};
  const visibleFields = config.id === 'purchaseAccount' ? fields : fields.slice(0, 6);
  const items = visibleFields.map((field) => ({
    label: field.label,
    value:
      config.id === 'purchaseAccount' && field.id === 'loginPassword' && values.hasLoginPassword
        ? values.loginPasswordHint || '••••••••••'
        : String(values[field.id] ?? '').trim() || '未填写',
  }));
  if (config.id === 'purchaseAccount') {
    const preset = resolvePurchaseAccountPreset(values);
    items.splice(2, 0, {
      label: '平台入口',
      value: preset?.platformUrl || String(values.platformUrl || '').trim() || '未选择',
    });
  }
  return items;
}

export {
  cloneStructuredRecord,
  getStructuredFieldIds,
  getStructuredRecordCountLabel,
  buildStructuredEmptyValues,
  getDefaultStructuredRecordTitle,
  createBlankStructuredRecord,
  normalizeStructuredRecord,
  toPurchaseAccountSavePayload,
  toPurchaseStructuredRecord,
  buildPurchaseStructuredRecords,
  buildStructuredProfileItems,
};
