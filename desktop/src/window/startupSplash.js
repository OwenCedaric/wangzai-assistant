import fs from "node:fs";

const DEFAULT_TITLE = "旺崽助手";
const DEFAULT_MESSAGE = "正在启动工作台";

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function readIconDataUrl(iconPath) {
  if (!iconPath || !fs.existsSync(iconPath)) return "";
  try {
    return `data:image/png;base64,${fs.readFileSync(iconPath).toString("base64")}`;
  } catch {
    return "";
  }
}

export function buildStartupSplashHtml({
  iconPath,
  title = DEFAULT_TITLE,
  message = DEFAULT_MESSAGE,
} = {}) {
  const iconDataUrl = readIconDataUrl(iconPath);
  const iconMarkup = iconDataUrl
    ? `<img class="brand-icon" src="${iconDataUrl}" alt="" />`
    : '<div class="brand-fallback" aria-hidden="true">W</div>';
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      * { box-sizing: border-box; }
      html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
      body {
        display: grid;
        place-items: center;
        color: #18243a;
        font-family: "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif;
        background:
          radial-gradient(circle at 16% 12%, rgba(255,255,255,.96), transparent 34%),
          linear-gradient(145deg, #f4f8ff 0%, #eaf1ff 100%);
        user-select: none;
      }
      .shell {
        width: 100%;
        height: 100%;
        display: grid;
        grid-template-columns: 88px 1fr;
        align-items: center;
        gap: 20px;
        padding: 34px 42px;
      }
      .brand-icon, .brand-fallback {
        width: 76px;
        height: 76px;
        border-radius: 16px;
        box-shadow: 0 14px 34px rgba(56, 88, 164, .17);
      }
      .brand-fallback {
        display: grid;
        place-items: center;
        color: #fff;
        font-size: 32px;
        font-weight: 800;
        background: #315bd6;
      }
      h1 { margin: 0; font-size: 24px; font-weight: 760; letter-spacing: -.03em; }
      p { margin: 8px 0 0; color: #6e7d99; font-size: 13px; }
      .progress { display: flex; gap: 6px; margin-top: 20px; }
      .progress i {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: #315bd6;
        animation: pulse 1.15s ease-in-out infinite;
      }
      .progress i:nth-child(2) { animation-delay: .16s; }
      .progress i:nth-child(3) { animation-delay: .32s; }
      @keyframes pulse {
        0%, 70%, 100% { opacity: .25; transform: translateY(0); }
        35% { opacity: 1; transform: translateY(-4px); }
      }
      @media (prefers-reduced-motion: reduce) {
        .progress i { animation: none; opacity: .65; }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      ${iconMarkup}
      <section>
        <h1>${escapeHtml(title)}</h1>
        <p>${escapeHtml(message)}</p>
        <div class="progress" aria-label="正在启动"><i></i><i></i><i></i></div>
      </section>
    </main>
  </body>
</html>`;
}

export function createStartupSplashWindow({
  BrowserWindow,
  iconPath,
  title = DEFAULT_TITLE,
  message = DEFAULT_MESSAGE,
  onError = () => undefined,
} = {}) {
  if (typeof BrowserWindow !== "function") {
    throw new TypeError("STARTUP_SPLASH_BROWSER_WINDOW_REQUIRED");
  }

  const splash = new BrowserWindow({
    width: 430,
    height: 210,
    center: true,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    roundedCorners: true,
    backgroundColor: "#f4f8ff",
    ...(iconPath ? { icon: iconPath } : {}),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });

  const reveal = () => {
    if (splash.isDestroyed() || splash.isVisible()) return;
    splash.show();
    splash.focus();
  };
  splash.once("ready-to-show", reveal);
  splash.webContents.once("did-finish-load", reveal);

  const html = buildStartupSplashHtml({ iconPath, title, message });
  const splashUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
  Promise.resolve(splash.loadURL(splashUrl)).catch(onError);
  return splash;
}

export function focusStartupSplashWindow(splash) {
  if (!splash || splash.isDestroyed()) return false;
  if (!splash.isVisible()) splash.show();
  splash.focus();
  return true;
}

export function closeStartupSplashWindow(splash) {
  if (!splash || splash.isDestroyed()) return false;
  splash.close();
  return true;
}
