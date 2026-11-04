import React from 'react';
import { createRoot } from 'react-dom/client';
import CssBaseline from '@mui/material/CssBaseline';
import { ThemeProvider } from '@mui/material/styles';
import { readRecoveryStartupMode } from './app/bootstrap/recoveryStartupMode.js';
import { AppErrorBoundary } from './app/shell/AppErrorBoundary.jsx';
import { DesktopAccessGate } from './features/licensing/components/DesktopAccessGate.jsx';
import { RecoveryStartupPage } from './features/recovery/components/RecoveryStartupPage.jsx';
import { appTheme } from './theme.js';
import './styles.css';

const WorkspaceApp = React.lazy(() => import('./App.jsx'));

function renderApp({ recoveryOnly = false } = {}) {
  createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      <ThemeProvider theme={appTheme}>
        <CssBaseline />
        <AppErrorBoundary>
          {recoveryOnly ? (
            <RecoveryStartupPage />
          ) : (
            <DesktopAccessGate>
              <React.Suspense fallback={<div className="desktop-workspace-loading">正在进入工作台…</div>}>
                <WorkspaceApp />
              </React.Suspense>
            </DesktopAccessGate>
          )}
        </AppErrorBoundary>
      </ThemeProvider>
    </React.StrictMode>
  );
}

readRecoveryStartupMode()
  .catch(() => false)
  .then((recoveryOnly) => renderApp({ recoveryOnly }));
