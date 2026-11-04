import { screen } from "electron";

export const MIN_WINDOW_WIDTH = 760;

export const MIN_WINDOW_HEIGHT = 560;

export const AUTH_WINDOW_WIDTH = 980;

export const AUTH_WINDOW_HEIGHT = 620;

export const AUTH_WINDOW_MIN_WIDTH = 860;

export const AUTH_WINDOW_MIN_HEIGHT = 620;

export function getInitialWindowOptions() {
  const { width: workWidth, height: workHeight } =
    screen.getPrimaryDisplay().workAreaSize;
  const minWidth = Math.min(MIN_WINDOW_WIDTH, workWidth);
  const minHeight = Math.min(MIN_WINDOW_HEIGHT, workHeight);
  return {
    width: Math.min(1440, Math.max(minWidth, Math.floor(workWidth * 0.94))),
    height: Math.min(
      940,
      Math.max(minHeight, Math.floor(workHeight * 0.94)),
    ),
    minWidth,
    minHeight,
  };
}

export function getAuthenticationWindowOptions() {
  const { width: workWidth, height: workHeight } =
    screen.getPrimaryDisplay().workAreaSize;
  return {
    width: Math.min(AUTH_WINDOW_WIDTH, workWidth),
    height: Math.min(AUTH_WINDOW_HEIGHT, workHeight),
    minWidth: Math.min(AUTH_WINDOW_MIN_WIDTH, workWidth),
    minHeight: Math.min(AUTH_WINDOW_MIN_HEIGHT, workHeight),
    maximizable: false,
  };
}
