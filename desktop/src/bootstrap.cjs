const { app, protocol } = require('electron');
if (!app.isPackaged && process.env.WANGZAI_SELFHOST_CA_FILE) {
  require('./runtime/selfHostedTls.cjs');
}

// Electron requires privileged schemes to be registered synchronously before
// app.ready.  The main process is ESM and its static dependency graph can
// finish after ready in a fast packaged launch, so this tiny CommonJS entry is
// deliberately the package entry point.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

void import('./main.js').catch((error) => {
  console.error('[bootstrap] main module failed', error);
  process.exitCode = 1;
  if (app.isReady()) app.quit();
  else app.once('ready', () => app.quit());
});
