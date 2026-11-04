import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDeploymentReadinessPayload,
  resolveDeploymentMode,
} from '../src/security/deploymentReadiness.js';
import { createHealthPayload } from '../src/routes/health.js';

const baseConfig = {
  server: { host: '127.0.0.1', port: 3790 },
  database: { path: 'local-api.sqlite' },
  security: { allowOrigins: [], logSecrets: false },
};
const databaseStatus = {
  ok: true,
  journalMode: 'wal',
  userVersion: 31,
  tables: ['shops'],
};

test('deployment mode defaults to local unless explicitly set', () => {
  assert.equal(resolveDeploymentMode({ env: {} }), 'local');
  assert.equal(resolveDeploymentMode({ env: { LOCAL_API_DEPLOYMENT_MODE: 'server' } }), 'server');
  assert.equal(resolveDeploymentMode({ env: { LOCAL_API_DEPLOYMENT_MODE: 'production' } }), 'server');
  assert.equal(resolveDeploymentMode({ env: { LOCAL_API_DEPLOYMENT_MODE: 'desktop' } }), 'local');
});

test('local deployment readiness keeps current desktop mode compatible', () => {
  const payload = createDeploymentReadinessPayload(baseConfig, { env: {} });

  assert.equal(payload.mode, 'local');
  assert.equal(payload.ok, true);
  assert.equal(payload.warningCount, 0);
  assert.equal(JSON.stringify(payload).includes('LOCAL_API_SECRET_VALUE'), false);
});

test('server deployment readiness reports missing mandatory hardening without leaking secret', () => {
  const payload = createDeploymentReadinessPayload(baseConfig, {
    env: { LOCAL_API_DEPLOYMENT_MODE: 'server', LOCAL_API_SECRET: 'short' },
  });

  assert.equal(payload.mode, 'server');
  assert.equal(payload.ok, false);
  assert.match(payload.warnings.join('\n'), /LOCAL_API_SECRET/u);
  assert.match(payload.warnings.join('\n'), /LOCAL_API_ALLOWED_ORIGINS/u);
  assert.match(payload.warnings.join('\n'), /服务器模式建议绑定/u);
  assert.equal(JSON.stringify(payload).includes('short'), false);
});

test('server deployment readiness passes with explicit secret origin and server host', () => {
  const payload = createDeploymentReadinessPayload(
    {
      ...baseConfig,
      server: { host: '0.0.0.0', port: 3790 },
      security: { allowOrigins: ['https://erp.example.com'], logSecrets: false },
    },
    {
      env: {
        LOCAL_API_DEPLOYMENT_MODE: 'server',
        LOCAL_API_SECRET: '0123456789abcdef0123456789abcdef',
      },
    },
  );

  assert.equal(payload.ok, true);
  assert.equal(payload.warningCount, 0);
});

test('health payload exposes request context and deployment readiness without secrets', () => {
  const payload = createHealthPayload({ config: baseConfig, databaseStatus, migrationsApplied: [] });

  assert.equal(payload.ok, true);
  assert.equal(payload.requestContext.tenantId, 'tenant_local_default');
  assert.equal(payload.deployment.mode, 'local');
  assert.equal(payload.deployment.publicResponse.includes('不返回任何密钥值'), true);
  assert.equal(JSON.stringify(payload).includes('api_key'), false);
  assert.equal(JSON.stringify(payload).includes('client_secret'), false);
});
