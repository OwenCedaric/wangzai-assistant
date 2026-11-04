import {
  getPlatformIntegrationPreset,
  getPlatformIntegrationType,
  mergePerformanceAccountsIntoStructuredRecords,
} from './platformIntegrationRecords.js';
import { normalizeStructuredRecord } from './structuredSettingsRecords.js';

function toIntegrationProfileSavePayload(record) {
  const values = record?.values ?? {};
  const payload = {
    id: record?.id,
    integrationType: getPlatformIntegrationType(record) || 'custom',
    platformName: String(values.platformName || record?.title || '').trim(),
    shopId: String(values.shopId ?? '').trim(),
    apiType: String(values.apiType ?? '').trim(),
    authMode: String(values.authMode ?? '').trim(),
    configStatus: String(values.configStatus ?? '').trim(),
    tokenStatus: String(values.tokenStatus ?? '').trim(),
    readScope: String(values.readScope ?? '').trim(),
    writeScope: String(values.writeScope ?? '').trim(),
    note: String(values.remark ?? '').trim(),
  };
  const integrationType = getPlatformIntegrationType(record);
  if (['seerfar-open-api', 'linkfox-agent', 'wecom-group-bot'].includes(integrationType)) {
    const credentials = {
      baseUrl:
        integrationType === 'wecom-group-bot'
          ? 'https://qyapi.weixin.qq.com'
          : String(values.baseUrl ?? '').trim(),
      loginAccount: String(values.loginAccount ?? '').trim(),
    };
    const loginPassword = String(values.loginPassword ?? '').trim();
    const apiKey =
      integrationType === 'wecom-group-bot'
        ? String(values.wecomWebhook ?? '').trim()
        : String(values.apiKey ?? '').trim();
    if (loginPassword) credentials.loginPassword = loginPassword;
    if (apiKey) credentials.apiKey = apiKey;
    payload.credentials = credentials;
  }
  return payload;
}

function getIntegrationConnectionState(profile = {}, existingValues = {}) {
  const integrationType = profile.integrationType || existingValues.integrationType || '';
  if (integrationType === 'ozon-browser-session') {
    const configStatus = profile.configStatus || existingValues.configStatus || '';
    const tokenStatus = profile.tokenStatus || existingValues.tokenStatus || '';
    const identityStatus = profile.identityStatus || existingValues.identityStatus || '';
    if (configStatus === '连接成功' && tokenStatus === 'Cookie 已保存' && identityStatus === 'verified') {
      return { status: '已连接', statusColor: 'success', configStatus, tokenStatus };
    }
    return {
      status: '待登录',
      statusColor: 'default',
      configStatus: configStatus || '待登录',
      tokenStatus: tokenStatus || 'Cookie 未保存',
    };
  }
  const lastTestStatus = profile.lastTestStatus || existingValues.lastTestStatus || '';
  const hasApiKey = Boolean(profile.hasApiKey || existingValues.hasApiKey);
  if (lastTestStatus === 'connected') {
    return { status: '连接成功', statusColor: 'success', configStatus: '连接成功', tokenStatus: '有效' };
  }
  if (lastTestStatus === 'limited') {
    return { status: '额度不足', statusColor: 'warning', configStatus: '凭证有效', tokenStatus: '额度不足' };
  }
  if (lastTestStatus === 'error') {
    return { status: '连接失败', statusColor: 'error', configStatus: '连接失败', tokenStatus: '测试失败' };
  }
  if (hasApiKey) {
    return { status: '已保存', statusColor: 'primary', configStatus: '已加密保存', tokenStatus: '待测试' };
  }
  return { status: '待配置', statusColor: 'default', configStatus: '待配置', tokenStatus: '未填写' };
}

function toIntegrationStructuredRecord(config, profile = {}, index = 0, existingRecord = null) {
  const existingValues = existingRecord?.values ?? {};
  const integrationType = profile.integrationType || existingValues.integrationType || 'custom';
  const preset = getPlatformIntegrationPreset(integrationType);
  const connectionState = getIntegrationConnectionState(profile, existingValues);
  const values = {
    ...preset.values,
    ...existingValues,
    integrationType,
    platformName: profile.platformName || existingValues.platformName || preset.title,
    shopId: profile.shopId || existingValues.shopId || preset.values.shopId || '',
    apiType: profile.apiType || preset.values.apiType || '',
    authMode: profile.authMode || preset.values.authMode || '',
    configStatus: connectionState.configStatus || profile.configStatus || preset.values.configStatus || '',
    tokenStatus: connectionState.tokenStatus || profile.tokenStatus || preset.values.tokenStatus || '',
    readScope: profile.readScope || preset.values.readScope || '',
    writeScope: profile.writeScope || preset.values.writeScope || '',
    browserCompanyId: profile.browserCompanyId || existingValues.browserCompanyId || '',
    browserCompanyName: profile.browserCompanyName || existingValues.browserCompanyName || '',
    apiIdentityId: profile.apiIdentityId || existingValues.apiIdentityId || '',
    identityStatus: profile.identityStatus || existingValues.identityStatus || '',
    identitySource: profile.identitySource || existingValues.identitySource || '',
    identityVerifiedAt: profile.identityVerifiedAt || existingValues.identityVerifiedAt || '',
    remark: profile.note || '',
    baseUrl: profile.baseUrl || existingValues.baseUrl || preset.values.baseUrl || '',
    loginAccount: profile.loginAccount || existingValues.loginAccount || '',
    loginPassword: '',
    hasLoginPassword: Boolean(profile.hasLoginPassword || existingValues.hasLoginPassword),
    loginPasswordHint: profile.loginPasswordHint || existingValues.loginPasswordHint || '',
    apiKey: '',
    hasApiKey: Boolean(profile.hasApiKey || existingValues.hasApiKey),
    apiKeyHint: profile.apiKeyHint || existingValues.apiKeyHint || '',
    lastTestStatus: profile.lastTestStatus || existingValues.lastTestStatus || '',
    lastTestAt:
      profile.lastTestAt ||
      (integrationType === 'ozon-browser-session' ? profile.updatedAt : '') ||
      existingValues.lastTestAt ||
      '',
    lastTestMessage: profile.lastTestMessage || existingValues.lastTestMessage || '',
    lastTestMetadata: profile.lastTestMetadata || existingValues.lastTestMetadata || null,
    performanceClientSecret: '',
    hasPerformanceClientSecret: Boolean(existingValues.hasPerformanceClientSecret),
    wecomWebhook: '',
    hasWecomWebhook: Boolean(profile.hasApiKey || existingValues.hasWecomWebhook),
  };
  const status =
    integrationType === 'ozon-performance'
      ? values.configStatus === '连接成功'
        ? '连接成功'
        : values.configStatus
          ? '已保存'
          : '待配置'
      : connectionState.status;
  return normalizeStructuredRecord(
    config,
    {
      ...existingRecord,
      id: profile.id || existingRecord?.id,
      isTransientDraft: false,
      isPlaceholderDraft: false,
      title: values.platformName || existingRecord?.title,
      meta: values.apiType || values.authMode || existingRecord?.meta,
      status,
      statusColor:
        integrationType === 'ozon-performance'
          ? status === '连接成功'
            ? 'success'
            : status === '已保存'
              ? 'primary'
              : 'default'
          : connectionState.statusColor,
      values,
    },
    index,
  );
}

function mergeIntegrationProfilesIntoStructuredRecords(config, records = [], profiles = []) {
  if (config.id !== 'platformApi' || !Array.isArray(profiles) || profiles.length === 0) return records;
  const nextRecords = records
    .filter((record) => record?.isPlaceholderDraft !== true)
    .map((record, index) => normalizeStructuredRecord(config, record, index));
  const indexById = new Map(nextRecords.map((record, index) => [record.id, index]));
  profiles.forEach((profile, profileIndex) => {
    let existingIndex = indexById.get(profile.id);
    if (existingIndex === undefined) {
      existingIndex = nextRecords.findIndex((record) => {
        const values = record.values ?? {};
        return (
          record?.isTransientDraft !== true &&
          getPlatformIntegrationType(record) === profile.integrationType &&
          String(values.platformName || '').trim() === String(profile.platformName || '').trim()
        );
      });
    }
    const existingRecord = existingIndex >= 0 ? nextRecords[existingIndex] : null;
    const merged = toIntegrationStructuredRecord(
      config,
      profile,
      existingIndex >= 0 ? existingIndex : nextRecords.length + profileIndex,
      existingRecord,
    );
    if (existingIndex >= 0) {
      nextRecords[existingIndex] = merged;
      indexById.set(merged.id, existingIndex);
    } else {
      indexById.set(merged.id, nextRecords.length);
      nextRecords.push(merged);
    }
  });
  return nextRecords;
}

function reconcilePlatformApiSourceRecords(
  config,
  records = [],
  {
    profiles = [],
    performanceAccounts = [],
    previousProfileIds = new Set(),
    previousPerformanceIds = new Set(),
  } = {},
) {
  const nextProfileIds = new Set(profiles.map((profile) => profile?.id).filter(Boolean));
  const nextPerformanceIds = new Set(performanceAccounts.map((account) => account?.id).filter(Boolean));
  const persistedIds = new Set([
    ...previousProfileIds,
    ...previousPerformanceIds,
    ...nextProfileIds,
    ...nextPerformanceIds,
  ]);
  const localDrafts = records.filter(
    (record) => record?.isTransientDraft === true || !persistedIds.has(record?.id),
  );
  const withProfiles = mergeIntegrationProfilesIntoStructuredRecords(config, localDrafts, profiles);
  return mergePerformanceAccountsIntoStructuredRecords(config, withProfiles, performanceAccounts);
}

export {
  getIntegrationConnectionState,
  mergeIntegrationProfilesIntoStructuredRecords,
  reconcilePlatformApiSourceRecords,
  toIntegrationProfileSavePayload,
  toIntegrationStructuredRecord,
};
