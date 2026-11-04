const NATIVE_ASPECT_RATIO = 16 / 10;
const NATIVE_MIN_WIDTH = 960;

/**
 * Calculate a centered outer rectangle for the real CEF top-level HWND.
 * Values returned here are logical display coordinates; the native controller
 * applies the monitor scale before sending them to the Python sidecar.
 */
export function calculatePurchaseBrowserWindowBounds({ workArea = {}, parentBounds = {} } = {}) {
  const workX = Number(workArea.x) || 0;
  const workY = Number(workArea.y) || 0;
  const workWidth = Math.max(800, Number(workArea.width) || 1440);
  const workHeight = Math.max(600, Number(workArea.height) || 900);
  let width = Math.min(workWidth, Math.max(NATIVE_MIN_WIDTH, Math.round(workWidth * 0.83)));
  let height = Math.round(width / NATIVE_ASPECT_RATIO);
  if (height > workHeight) {
    height = workHeight;
    width = Math.min(workWidth, Math.round(height * NATIVE_ASPECT_RATIO));
  }
  const centerX = (Number(parentBounds.x) || workX) + ((Number(parentBounds.width) || workWidth) / 2);
  const centerY = (Number(parentBounds.y) || workY) + ((Number(parentBounds.height) || workHeight) / 2);
  const x = Math.max(workX, Math.min(Math.round(centerX - (width / 2)), workX + workWidth - width));
  const y = Math.max(workY, Math.min(Math.round(centerY - (height / 2)), workY + workHeight - height));
  return Object.freeze({ x, y, width, height });
}

