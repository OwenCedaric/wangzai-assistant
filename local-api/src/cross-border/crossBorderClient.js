import { safeLogPayload } from '../security/safeLog.js';
import { assertCrossBorderReadEndpoint, assertCrossBorderWriteEndpoint } from './crossBorderEndpointRegistry.js';

const DEFAULT_BASE_URL = 'https://api.service.kuajing84.com';

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function normalizeBodyValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return normalizeText(value);
}

function buildRequestBody(body = {}, bodyFormat = 'form') {
  if (bodyFormat === 'json') {
    return { body: JSON.stringify(body || {}), contentType: 'application/json' };
  }
  const params = new URLSearchParams();
  Object.entries(body || {}).forEach(([key, value]) => {
    const text = normalizeBodyValue(value);
    if (text) params.set(key, text);
  });
  return { body: params.toString(), contentType: 'application/x-www-form-urlencoded;charset=UTF-8' };
}

function assertCredentials(credentials = {}) {
  if (!normalizeText(credentials.companySecret) || !normalizeText(credentials.accessToken) || !normalizeText(credentials.appUid)) {
    const error = new Error('Cross-border account credentials are required.');
    error.code = 'CROSS_BORDER_CREDENTIALS_REQUIRED';
    throw error;
  }
}

function assertAuthorizationCredentials(credentials = {}) {
  if (
    !normalizeText(credentials.companySecret)
    || !normalizeText(credentials.userName)
    || !normalizeText(credentials.password)
  ) {
    const error = new Error('跨境巴士账号缺少用户名、密码或企业 API。');
    error.code = 'CROSS_BORDER_AUTHORIZATION_CREDENTIALS_REQUIRED';
    throw error;
  }
}

function readResponseValue(data, key) {
  if (!data || typeof data !== 'object') return '';
  return normalizeText(data[key] ?? data.data?.[key]);
}

function readApiErrorMessage(error) {
  return normalizeText(
    error?.response?.message
    ?? error?.response?.msg
    ?? (error instanceof Error ? error.message : error),
  );
}

function isAlreadyGeneratedTokenError(error) {
  const message = readApiErrorMessage(error);
  return message.includes('已经生成Token') || message.includes('expires_token');
}

function isAlreadyAuthorizedUserError(error) {
  const message = readApiErrorMessage(error);
  return message.includes('用户已授权') || message.includes('已授权该用户');
}

function canResetExpiredToken(error) {
  return Number(error?.status) === 401
    || Number(error?.status) === 403
    || error?.code === 'CROSS_BORDER_API_ERROR';
}

function toFriendlyTokenError(error) {
  const message = readApiErrorMessage(error);
  if (message.includes('每天') || message.includes('每日') || message.includes('一天') || message.includes('24')) {
    const resetError = new Error('跨境巴士企业 Token 今日重置次数已用完，请明日再试。');
    resetError.code = 'CROSS_BORDER_TOKEN_RESET_DAILY_LIMIT';
    resetError.response = error?.response;
    return resetError;
  }
  return error;
}

export function createCrossBorderClient({ baseUrl = DEFAULT_BASE_URL, transport = globalThis.fetch } = {}) {
  async function requestJson({ path, endpointKey, headers = {}, body = {}, timeoutMs = 15000 }) {
    if (typeof transport !== 'function') {
      const error = new Error('Cross-border transport is not available.');
      error.code = 'CROSS_BORDER_TRANSPORT_NOT_AVAILABLE';
      throw error;
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await transport(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...headers,
        },
        body: JSON.stringify(body || {}),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        const timeoutError = new Error('跨境巴士授权接口请求超时。');
        timeoutError.code = 'CROSS_BORDER_AUTHORIZATION_TIMEOUT';
        timeoutError.endpointKey = endpointKey;
        throw timeoutError;
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!response.ok) {
      const error = new Error(`Cross-border HTTP ${response.status}`);
      error.code = 'CROSS_BORDER_HTTP_ERROR';
      error.status = response.status;
      error.endpointKey = endpointKey;
      error.response = safeLogPayload(data);
      throw error;
    }
    if (data && typeof data === 'object' && 'code' in data && Number(data.code) !== 1) {
      const error = new Error(data.message || data.msg || 'Cross-border API returned failed code.');
      error.code = 'CROSS_BORDER_API_ERROR';
      error.endpointKey = endpointKey;
      error.response = safeLogPayload(data);
      throw error;
    }
    return { ok: true, endpointKey, data };
  }

  async function requestEnterpriseToken({ companySecret, expiresToken, allowReset = false, timeoutMs } = {}) {
    const normalizedCompanySecret = normalizeText(companySecret);
    if (!normalizedCompanySecret) {
      const error = new Error('请先填写跨境巴士企业 API。');
      error.code = 'CROSS_BORDER_COMPANY_SECRET_REQUIRED';
      throw error;
    }

    const readTokenResult = (result, source) => {
      const accessToken = readResponseValue(result.data, 'access_token');
      const nextExpiresToken = readResponseValue(result.data, 'expires_token');
      const expiresIn = readResponseValue(result.data, 'expires_in');
      if (!accessToken) {
        const error = new Error('跨境巴士没有返回企业 Token。');
        error.code = 'CROSS_BORDER_ACCESS_TOKEN_MISSING';
        error.response = safeLogPayload(result.data);
        throw error;
      }
      return {
        ...result,
        accessToken,
        expiresToken: nextExpiresToken || normalizeText(expiresToken),
        expiresIn,
        tokenSource: source,
      };
    };

    const requestToken = async ({ path, endpointKey, body, source }) => readTokenResult(await requestJson({
      path,
      endpointKey,
      body,
      timeoutMs,
    }), source);

    const requestResetToken = () => requestToken({
      path: '/erpapi/token/resettoken',
      endpointKey: 'auth.resetEnterpriseToken',
      body: { client_secret: normalizedCompanySecret },
      source: 'reset',
    });

    const normalizedExpiresToken = normalizeText(expiresToken);
    try {
      if (normalizedExpiresToken) {
        return await requestToken({
          path: '/erpapi/token/refresh',
          endpointKey: 'auth.refreshEnterpriseToken',
          body: {
            client_secret: normalizedCompanySecret,
            expires_token: normalizedExpiresToken,
          },
          source: 'refresh',
        });
      }
      return await requestToken({
        path: '/erpapi/token/index',
        endpointKey: 'auth.enterpriseToken',
        body: { client_secret: normalizedCompanySecret },
        source: 'initial',
      });
    } catch (error) {
      const shouldReset = allowReset && (
        (!normalizedExpiresToken && isAlreadyGeneratedTokenError(error))
        || (normalizedExpiresToken && canResetExpiredToken(error))
      );
      if (!shouldReset) throw toFriendlyTokenError(error);
      try {
        return await requestResetToken();
      } catch (resetError) {
        throw toFriendlyTokenError(resetError);
      }
    }
  }

  async function authorizeUser({ credentials = {}, timeoutMs } = {}) {
    assertAuthorizationCredentials(credentials);
    let accessToken = normalizeText(credentials.accessToken);
    let tokenResult = null;
    if (!accessToken) {
      tokenResult = await requestEnterpriseToken({
        companySecret: credentials.companySecret,
        expiresToken: credentials.expiresToken,
        allowReset: true,
        timeoutMs,
      });
      accessToken = tokenResult.accessToken;
    }
    const requestAuthorization = (token) => requestJson({
      path: '/erpapi/user/authorization',
      endpointKey: 'auth.authorizeUser',
      headers: {
        'k-client-secret': normalizeText(credentials.companySecret),
        authorization: token,
      },
      body: {
        user_name: normalizeText(credentials.userName),
        password: normalizeText(credentials.password),
      },
      timeoutMs,
    });
    const requestAuthorizationIdempotently = async (token) => {
      try {
        return await requestAuthorization(token);
      } catch (error) {
        const savedAppUid = normalizeText(credentials.appUid);
        if (!savedAppUid || !isAlreadyAuthorizedUserError(error)) throw error;
        return {
          ok: true,
          endpointKey: 'auth.authorizeUser',
          data: {
            code: 1,
            message: '用户已授权',
            data: { app_uid: savedAppUid },
          },
          idempotent: true,
        };
      }
    };
    let result;
    try {
      result = await requestAuthorizationIdempotently(accessToken);
    } catch (firstError) {
      if (!normalizeText(credentials.accessToken)) throw firstError;
      tokenResult = await requestEnterpriseToken({
        companySecret: credentials.companySecret,
        expiresToken: credentials.expiresToken,
        allowReset: true,
        timeoutMs,
      });
      accessToken = tokenResult.accessToken;
      result = await requestAuthorizationIdempotently(accessToken);
    }
    const appUid = readResponseValue(result.data, 'app_uid');
    if (!appUid) {
      const error = new Error('跨境巴士授权成功响应缺少用户授权标识。');
      error.code = 'CROSS_BORDER_APP_UID_MISSING';
      error.response = safeLogPayload(result.data);
      throw error;
    }
    return {
      ...result,
      accessToken,
      expiresToken: tokenResult?.expiresToken || normalizeText(credentials.expiresToken),
      expiresIn: tokenResult?.expiresIn || '',
      appUid,
    };
  }

  async function requestEndpoint(endpoint, credentials = {}, body = {}, timeoutMs) {
    assertCredentials(credentials);
    if (typeof transport !== 'function') {
      const error = new Error('Cross-border transport is not available.');
      error.code = 'CROSS_BORDER_TRANSPORT_NOT_AVAILABLE';
      throw error;
    }
    const request = buildRequestBody(body, endpoint.bodyFormat);
    const response = await transport(`${baseUrl}${endpoint.path}`, {
      method: endpoint.method,
      headers: {
        Accept: 'application/json',
        'Content-Type': request.contentType,
        'k-client-secret': credentials.companySecret,
        authorization: credentials.accessToken,
        'k-app-uid': credentials.appUid,
      },
      body: request.body,
      signal: undefined,
      timeoutMs: timeoutMs || endpoint.timeoutMs,
    });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!response.ok) {
      const error = new Error(`Cross-border HTTP ${response.status}`);
      error.code = 'CROSS_BORDER_HTTP_ERROR';
      error.status = response.status;
      error.endpointKey = endpoint.key;
      error.response = safeLogPayload(data);
      throw error;
    }
    if (data && typeof data === 'object' && 'code' in data && Number(data.code) !== 1) {
      const error = new Error(data.message || data.msg || 'Cross-border API returned failed code.');
      error.code = 'CROSS_BORDER_API_ERROR';
      error.endpointKey = endpoint.key;
      error.response = safeLogPayload(data);
      throw error;
    }
    return { ok: true, endpointKey: endpoint.key, data };
  }

  function requestReadOnly({ endpointKey, credentials = {}, body = {}, timeoutMs } = {}) {
    return requestEndpoint(assertCrossBorderReadEndpoint(endpointKey), credentials, body, timeoutMs);
  }

  function requestWrite({ endpointKey, credentials = {}, body = {}, timeoutMs } = {}) {
    return requestEndpoint(assertCrossBorderWriteEndpoint(endpointKey), credentials, body, timeoutMs);
  }

  return { requestReadOnly, requestWrite, requestEnterpriseToken, authorizeUser };
}
