const SETTINGS_INTERACTION_ATTRIBUTE = 'wangzaiSettingsInteraction';
const DEFAULT_RESUME_DELAY_MS = 500;

let paused = false;
let resumeTimer = null;

function reflectState() {
  if (typeof document === 'undefined') return;
  if (paused) document.documentElement.dataset[SETTINGS_INTERACTION_ATTRIBUTE] = 'paused';
  else delete document.documentElement.dataset[SETTINGS_INTERACTION_ATTRIBUTE];
}

export function markSettingsInteractionOpen() {
  if (resumeTimer !== null) {
    globalThis.clearTimeout(resumeTimer);
    resumeTimer = null;
  }
  paused = true;
  reflectState();
}

export function markSettingsInteractionClosed(resumeDelayMs = DEFAULT_RESUME_DELAY_MS) {
  if (resumeTimer !== null) globalThis.clearTimeout(resumeTimer);
  resumeTimer = globalThis.setTimeout(() => {
    resumeTimer = null;
    paused = false;
    reflectState();
  }, resumeDelayMs);
}

export function isSettingsInteractionPaused() {
  if (paused) return true;
  return typeof document !== 'undefined'
    && document.documentElement.dataset[SETTINGS_INTERACTION_ATTRIBUTE] === 'paused';
}
