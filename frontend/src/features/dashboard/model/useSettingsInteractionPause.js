import React from 'react';
import { isSettingsInteractionPaused } from '../../../shared/lib/settingsInteractionRuntime.js';

const DEFAULT_RESUME_DELAY_MS = 500;

/** Pauses background chart work while the settings surface owns the interaction. */
export function useSettingsInteractionPause(resumeDelayMs = DEFAULT_RESUME_DELAY_MS) {
  const [paused, setPaused] = React.useState(() => isSettingsInteractionPaused());
  const resumeTimerRef = React.useRef(null);

  React.useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const clearResumeTimer = () => {
      if (resumeTimerRef.current !== null) {
        globalThis.clearTimeout(resumeTimerRef.current);
        resumeTimerRef.current = null;
      }
    };
    const handleSettingsOpen = () => {
      clearResumeTimer();
      setPaused(true);
    };
    const handleSettingsClosed = () => {
      clearResumeTimer();
      resumeTimerRef.current = globalThis.setTimeout(() => {
        resumeTimerRef.current = null;
        React.startTransition(() => setPaused(false));
      }, resumeDelayMs);
    };
    window.addEventListener('wangzai-settings-open', handleSettingsOpen);
    window.addEventListener('wangzai-settings-closed', handleSettingsClosed);
    return () => {
      clearResumeTimer();
      window.removeEventListener('wangzai-settings-open', handleSettingsOpen);
      window.removeEventListener('wangzai-settings-closed', handleSettingsClosed);
    };
  }, [resumeDelayMs]);

  return paused;
}
