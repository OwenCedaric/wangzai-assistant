const { app, protocol } = require('electron');
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const fail = error => {
  process.stderr.write(String(error?.stack || error) + '\n');
  app.exit(1);
};
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
void import('./ui-update-electron-smoke.mjs').catch(fail);
