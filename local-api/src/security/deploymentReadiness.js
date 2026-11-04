function normalizeText(value) {
  if (value == null) return '';
  return String(value).trim();
}

function normalizeList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => normalizeText(item)).filter(Boolean);
}

function hasUnsafeWildcardOrigin(origins) {
  return origins.some((origin) => origin === '*' || origin === 'null');
}

export function resolveDeploymentMode({ env = process.env } = {}) {
  const explicitMode = normalizeText(env.LOCAL_API_DEPLOYMENT_MODE).toLowerCase();
  if (['server', 'production', 'cloud'].includes(explicitMode)) return 'server';
  if (['local', 'desktop', 'development'].includes(explicitMode)) return 'local';
  return 'local';
}

export function createDeploymentReadinessPayload(config = {}, { env = process.env } = {}) {
  const mode = resolveDeploymentMode({ env });
  const serverMode = mode === 'server';
  const warnings = [];
  const requirements = [];
  const allowOrigins = normalizeList(config.security?.allowOrigins);
  const host = normalizeText(config.server?.host);
  const secret = normalizeText(env.LOCAL_API_SECRET);

  requirements.push({
    key: 'secret',
    ok: !serverMode || secret.length >= 32,
    message: '服务器模式必须设置长度至少 32 位的 LOCAL_API_SECRET。',
  });
  requirements.push({
    key: 'origins',
    ok: !serverMode || (allowOrigins.length > 0 && !hasUnsafeWildcardOrigin(allowOrigins)),
    message: '服务器模式必须配置明确的 LOCAL_API_ALLOWED_ORIGINS，不能使用通配来源。',
  });
  requirements.push({
    key: 'logSecrets',
    ok: config.security?.logSecrets !== true,
    message: '禁止开启密钥日志输出。',
  });
  requirements.push({
    key: 'host',
    ok: !serverMode || !['127.0.0.1', 'localhost'].includes(host),
    message: '服务器模式建议绑定服务器监听地址，并由反向代理限制来源。',
  });
  requirements.push({
    key: 'database',
    ok: Boolean(config.database?.path),
    message: '必须配置 SQLite 数据库路径；服务器多用户阶段可评估 PostgreSQL。',
  });

  for (const requirement of requirements) {
    if (!requirement.ok) warnings.push(requirement.message);
  }

  return {
    mode,
    ok: warnings.length === 0,
    warningCount: warnings.length,
    warnings,
    requirements,
    publicResponse: '只返回部署状态、布尔结果和中文提示，不返回任何密钥值。',
  };
}

