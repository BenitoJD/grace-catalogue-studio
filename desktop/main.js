'use strict';

/**
 * Grace Studio desktop wrapper.
 *
 * The Expo web build in app/dist is a static SPA that talks to the catalogue
 * API. It has no knowledge of Electron: it is loaded over HTTP, so fetch(),
 * cookies and the file/image URLs all behave exactly like they do in a browser.
 *
 * At startup this process:
 *   1. resolves the backend API base URL (env CATALOG_API_URL, then
 *      <userData>/desktop-config.json, then http://localhost:8787),
 *   2. starts an HTTP server on a free loopback port that serves app/dist with
 *      an SPA fallback and reverse proxies the API path prefixes to the
 *      backend, and
 *   3. opens a BrowserWindow on that server.
 *
 * Because the SPA is served by the same server that proxies the API, the API
 * looks same-origin to the renderer: no CORS setup and no rebuild with
 * EXPO_PUBLIC_API_URL are needed.
 *
 * One wrinkle: app/lib/api.ts treats the hostnames "localhost", "127.0.0.1"
 * and "0.0.0.0" as the development setup and hardcodes http://localhost:8787
 * for them. The window is therefore loaded from the loopback alias
 * "grace-studio.localhost" (localhost.* always resolves to loopback). That is
 * not one of the development hostnames, so the app uses window.location.origin
 * and goes through the proxy below. If the alias cannot be resolved the
 * wrapper falls back to 127.0.0.1, where the window still loads but the app's
 * API calls go straight to localhost:8787 (see desktop/README.md).
 */

const { app, BrowserWindow, Menu, screen, shell } = require('electron');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { URL, pathToFileURL } = require('node:url');

const APP_NAME = 'Grace Studio';
const DEFAULT_API_URL = 'http://localhost:8787';
const WINDOW_HOSTNAME = 'grace-studio.localhost';
const LOCAL_HOST = '127.0.0.1';
const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 860;
const MIN_WIDTH = 900;
const MIN_HEIGHT = 700;
const PROXY_TIMEOUT_MS = 5 * 60 * 1000;

// Any path starting with one of these is sent to the catalogue API.
const PROXY_PREFIXES = Object.freeze([
  '/api',
  '/files',
  '/pages',
  '/previews',
  '/media',
  '/health',
  '/ready',
]);

// Hop-by-hop headers must not be forwarded by a proxy (RFC 9110, section 7.6.1).
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.gif', 'image/gif'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.mp4', 'video/mp4'],
  ['.otf', 'font/otf'],
  ['.pdf', 'application/pdf'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.ttf', 'font/ttf'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

// Lets Chromium resolve the loopback alias itself instead of relying on the
// operating system to special-case *.localhost. Set before app ready.
app.commandLine.appendSwitch('host-resolver-rules', `MAP ${WINDOW_HOSTNAME} ${LOCAL_HOST}`);

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {import('node:http').Server | null} */
let localServer = null;
let serverPort = null;
/** URL the BrowserWindow loads. Same-origin for the app's API calls. */
let appUrl = null;
/** Loopback URL, useful for curl and the --print-port output. */
let loopbackUrl = null;
let apiBaseUrl = DEFAULT_API_URL;
let webRoot = null;
let spaReady = false;
/** Embedded catalogue server when the app runs standalone. */
let embeddedServer = null;
let embeddedDataDir = null;

const printPort = process.argv.includes('--print-port');

function log(message) {
  console.log(`[grace-studio] ${message}`);
}

function configFile() {
  return path.join(app.getPath('userData'), 'desktop-config.json');
}

function windowStateFile() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function serverInfoFile() {
  return path.join(app.getPath('userData'), 'desktop-server.json');
}

/**
 * Trim a configured API URL and reject anything that is not http(s).
 * Returns null when the value cannot be used.
 */
function normaliseBaseUrl(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return trimmed;
  } catch {
    return null;
  }
}

/** Write the default config file on first run so the menu item has something to reveal. */
function ensureConfigFile() {
  const file = configFile();
  if (fs.existsSync(file)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ apiUrl: DEFAULT_API_URL }, null, 2)}\n`, 'utf8');
}

/**
 * Where the API code and the templates live. In a checkout they sit next to
 * the desktop folder; in an installed app electron-builder copies them into
 * Resources.
 */
function apiPaths() {
  if (app.isPackaged) {
    const resources = process.resourcesPath;
    return {
      boot: path.join(resources, 'server', 'boot.mjs'),
      templates: path.join(resources, 'templates'),
    };
  }
  return {
    boot: path.resolve(__dirname, '..', 'server', 'src', 'boot.mjs'),
    templates: path.resolve(__dirname, '..', 'templates'),
  };
}

/**
 * Start the catalogue server inside the app. There is no separate server to
 * install: its data lives in the app's user data folder and the print engine
 * is Electron itself.
 */
async function startEmbeddedApi() {
  const dataDir = path.join(app.getPath('userData'), 'data');
  const templatesDir = apiPaths().templates;
  embeddedDataDir = dataDir;

  if (!fs.existsSync(apiPaths().boot)) {
    throw new Error(`The catalogue server is missing at ${apiPaths().boot}.`);
  }
  if (!fs.existsSync(templatesDir)) {
    throw new Error(`The brochure templates are missing at ${templatesDir}.`);
  }

  fs.mkdirSync(dataDir, { recursive: true });
  process.env.CATALOG_DATA_DIR = dataDir;
  process.env.CATALOG_DB = path.join(dataDir, 'catalog.db');
  process.env.CATALOG_TEMPLATES_DIR = templatesDir;
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'info';

  const { createPdfEngine } = require('./pdf-engine');
  const pdfEngine = createPdfEngine();
  const { startCatalogServer } = await import(pathToFileURL(apiPaths().boot).href);
  embeddedServer = await startCatalogServer({
    port: 0,
    host: LOCAL_HOST,
    dataDir,
    templatesDir,
    pdfEngine,
  });
  log(`Embedded catalogue server at ${embeddedServer.url}`);
  return embeddedServer.url;
}

/** env CATALOG_API_URL -> <userData>/desktop-config.json -> http://localhost:8787 */
function resolveApiBaseUrl() {
  const fromEnv = normaliseBaseUrl(process.env.CATALOG_API_URL);
  if (process.env.CATALOG_API_URL && !fromEnv) {
    log(`Ignoring CATALOG_API_URL: ${process.env.CATALOG_API_URL} is not an http(s) URL.`);
  }
  if (fromEnv) {
    log(`API base URL from CATALOG_API_URL: ${fromEnv}`);
    return fromEnv;
  }
  try {
    const raw = fs.readFileSync(configFile(), 'utf8');
    const parsed = JSON.parse(raw);
    const fromFile = normaliseBaseUrl(parsed?.apiUrl);
    if (fromFile) {
      log(`API base URL from ${configFile()}: ${fromFile}`);
      return fromFile;
    }
    if (parsed?.apiUrl !== undefined) {
      log(`Ignoring apiUrl in ${configFile()}: expected an http(s) URL.`);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      log(`Could not read ${configFile()}: ${error.message}`);
    }
  }
  log(`API base URL from built-in default: ${DEFAULT_API_URL}`);
  return DEFAULT_API_URL;
}

/**
 * The exported SPA lives in app/dist in a checkout and in
 * Contents/Resources/app/dist (or resources/app/dist) in a packaged app.
 */
function resolveWebRoot() {
  const fromEnv = process.env.GRACE_STUDIO_WEB_ROOT;
  if (fromEnv) return path.resolve(fromEnv);
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app', 'dist');
  }
  return path.resolve(__dirname, '..', 'app', 'dist');
}

function missingBuildPage() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${APP_NAME}: web build missing</title>
    <style>
      :root { color-scheme: light; }
      body {
        margin: 0;
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        background: #f7f3ed;
        color: #2c241b;
        font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      }
      main { max-width: 660px; padding: 40px; }
      h1 { margin: 0 0 12px; font-size: 26px; color: #6a4425; }
      p { margin: 0 0 14px; }
      code, pre {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 13px;
        background: #efe6da;
        border-radius: 6px;
      }
      code { padding: 2px 5px; }
      pre { padding: 14px 16px; overflow-x: auto; }
      .path { word-break: break-all; }
    </style>
  </head>
  <body>
    <main>
      <h1>${APP_NAME} is missing its web build</h1>
      <p>
        The desktop wrapper could not find the exported Expo web app, so there is
        nothing to show yet. Build the SPA first, then restart ${APP_NAME}.
      </p>
      <p>Expected file: <code class="path">${escapeHtml(path.join(webRoot, 'index.html'))}</code></p>
      <pre>cd app
npx expo export --platform web --output-dir dist</pre>
      <p>
        Then restart ${APP_NAME}. A development build is produced the same way:
        <code>npm --prefix app run build:web</code>.
      </p>
    </main>
  </body>
</html>`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

/** Human readable detail for network errors (AggregateError has no message). */
function describeError(error) {
  if (!error) return 'unknown error';
  const parts = [];
  if (error.code) parts.push(error.code);
  if (error.message) parts.push(error.message);
  if (Array.isArray(error.errors)) {
    for (const inner of error.errors) {
      if (inner?.code) parts.push(inner.code);
      else if (inner?.message) parts.push(inner.message);
    }
  }
  return [...new Set(parts)].join(': ') || String(error);
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function isProxyPath(pathname) {
  return PROXY_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/** Resolve a URL pathname to a file under webRoot, or null when it escapes. */
function staticPath(pathname, root) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const base = path.resolve(root);
  const candidate = path.resolve(base, decoded.replace(/^\/+/, '') || 'index.html');
  if (candidate !== base && !candidate.startsWith(`${base}${path.sep}`)) return null;
  return candidate;
}

function statOrNull(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

function serveStaticFile(req, res, file) {
  const stats = statOrNull(file);
  if (!stats || !stats.isFile()) return false;
  const type = MIME_TYPES.get(path.extname(file).toLowerCase()) ?? 'application/octet-stream';
  const headers = {
    'Content-Type': type,
    'Content-Length': String(stats.size),
    'Cache-Control': 'no-cache',
  };
  if (req.method === 'HEAD') {
    res.writeHead(200, headers);
    res.end();
    return true;
  }
  res.writeHead(200, headers);
  const stream = fs.createReadStream(file);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
  return true;
}

async function serveWebContent(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end('Method not allowed');
    return;
  }

  let file = staticPath(pathname, webRoot);
  if (file) {
    const stats = statOrNull(file);
    if (stats?.isDirectory()) file = path.join(file, 'index.html');
  }
  if (file && serveStaticFile(req, res, file)) return;

  // Unknown path: SPA fallback for routes, 404 for missing assets.
  if (path.extname(pathname) !== '' && pathname !== '/') {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  if (!serveStaticFile(req, res, path.join(webRoot, 'index.html'))) {
    sendHtml(res, 200, missingBuildPage());
  }
}

/**
 * Reverse proxy one request to the catalogue API. The response (including
 * status, headers and streamed body) is passed through unchanged.
 */
function proxyRequest(req, res, pathname, search) {
  let target;
  try {
    const base = apiBaseUrl.replace(/\/+$/, '');
    target = new URL(`${base}${pathname}${search}`);
  } catch (error) {
    sendJson(res, 502, {
      error: `The catalogue API URL is not valid: ${apiBaseUrl}`,
      detail: error.message,
    });
    return;
  }

  const headers = { ...req.headers };
  for (const name of HOP_BY_HOP_HEADERS) delete headers[name];
  headers.host = target.host;

  const transport = target.protocol === 'https:' ? https : http;
  const upstream = transport.request(
    target,
    { method: req.method, headers, timeout: PROXY_TIMEOUT_MS },
    (upstreamRes) => {
      const responseHeaders = { ...upstreamRes.headers };
      for (const name of HOP_BY_HOP_HEADERS) delete responseHeaders[name];
      res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
      upstreamRes.pipe(res);
    },
  );

  upstream.on('timeout', () => {
    upstream.destroy(new Error(`The catalogue API did not answer within ${PROXY_TIMEOUT_MS / 1000}s.`));
  });

  upstream.on('error', (error) => {
    const detail = describeError(error);
    log(`${req.method} ${pathname} -> ${target.href} failed: ${detail}`);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    sendJson(res, 502, {
      error: `The catalogue API at ${apiBaseUrl} could not be reached.`,
      detail,
      apiUrl: apiBaseUrl,
    });
  });

  req.on('aborted', () => upstream.destroy());
  req.pipe(upstream);
}

function handleRequest(req, res) {
  let pathname;
  let search;
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? LOCAL_HOST}`);
    pathname = url.pathname;
    search = url.search;
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad request');
    return;
  }

  if (!spaReady) {
    // Never show a blank window: explain what to build instead.
    sendHtml(res, 200, missingBuildPage());
    return;
  }

  if (isProxyPath(pathname)) {
    proxyRequest(req, res, pathname, search);
    return;
  }

  serveWebContent(req, res, pathname).catch((error) => {
    log(`Static request ${pathname} failed: ${error.message}`);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Internal server error');
    } else {
      res.destroy();
    }
  });
}

function createLocalServer() {
  const server = http.createServer((req, res) => {
    try {
      handleRequest(req, res);
    } catch (error) {
      log(`Unhandled request error: ${error.stack ?? error.message}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Internal server error');
      } else {
        res.destroy();
      }
    }
  });
  // Long renders are proxied; keep sockets from timing out on their own.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  return server;
}

function listenOnFreePort(server) {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(0, LOCAL_HOST, () => {
      server.off('error', onError);
      resolve(server.address().port);
    });
  });
}

function loadWindowState() {
  try {
    const state = JSON.parse(fs.readFileSync(windowStateFile(), 'utf8'));
    const width = Number(state.width);
    const height = Number(state.height);
    const x = Number(state.x);
    const y = Number(state.y);
    if (!Number.isFinite(width) || !Number.isFinite(height)) return null;

    const bounds = {
      width: Math.max(MIN_WIDTH, Math.round(width)),
      height: Math.max(MIN_HEIGHT, Math.round(height)),
      maximized: state.maximized === true,
    };
    if (Number.isFinite(x) && Number.isFinite(y)) {
      const candidate = { x: Math.round(x), y: Math.round(y), width: bounds.width, height: bounds.height };
      const visible = screen.getAllDisplays().some((display) => {
        const area = display.workArea;
        return (
          candidate.x < area.x + area.width &&
          candidate.x + candidate.width > area.x &&
          candidate.y < area.y + area.height &&
          candidate.y + candidate.height > area.y
        );
      });
      if (visible) {
        bounds.x = Math.round(x);
        bounds.y = Math.round(y);
      }
    }
    return bounds;
  } catch {
    return null;
  }
}

function saveWindowState(window) {
  if (!window || window.isDestroyed()) return;
  try {
    const bounds = window.getNormalBounds();
    const state = {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      maximized: window.isMaximized(),
    };
    fs.mkdirSync(path.dirname(windowStateFile()), { recursive: true });
    fs.writeFileSync(windowStateFile(), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  } catch (error) {
    log(`Could not save the window bounds: ${error.message}`);
  }
}

function isLocalUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.hostname === WINDOW_HOSTNAME ||
      url.hostname === LOCAL_HOST ||
      url.hostname === 'localhost'
    );
  } catch {
    return false;
  }
}

function showExternal(url) {
  if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {});
}

function loadApp(window) {
  let fellBack = false;
  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
    if (!isMainFrame || fellBack) return;
    if (errorCode === -3) return; // ERR_ABORTED, usually a reload or redirect
    if (!appUrl || !loopbackUrl) return;
    fellBack = true;
    log(`Could not load ${appUrl} (${errorDescription}); falling back to ${loopbackUrl}.`);
    window.loadURL(loopbackUrl).catch((error) => log(`Fallback load failed: ${error.message}`));
  });
  window.loadURL(appUrl).catch((error) => log(`Could not load ${appUrl}: ${error.message}`));
}

function createWindow() {
  const state = loadWindowState();
  /** @type {Electron.BrowserWindowConstructorOptions} */
  const options = {
    width: state?.width ?? DEFAULT_WIDTH,
    height: state?.height ?? DEFAULT_HEIGHT,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    title: APP_NAME,
    backgroundColor: '#FFFFFF',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  };
  if (state && Number.isFinite(state.x) && Number.isFinite(state.y)) {
    options.x = state.x;
    options.y = state.y;
  }

  const window = new BrowserWindow(options);
  mainWindow = window;

  window.once('ready-to-show', () => {
    window.show();
    if (state?.maximized) window.maximize();
  });

  // The SPA is the only thing this window should display; links to the wider
  // web belong in the user's browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    showExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!isLocalUrl(url)) {
      event.preventDefault();
      showExternal(url);
    }
  });

  let saveTimer = null;
  const scheduleSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveWindowState(window), 400);
  };
  window.on('resize', scheduleSave);
  window.on('move', scheduleSave);
  window.on('close', () => {
    clearTimeout(saveTimer);
    saveWindowState(window);
  });
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });

  loadApp(window);
  return window;
}

function openServerSettings() {
  try {
    ensureConfigFile();
    shell.showItemInFolder(configFile());
  } catch (error) {
    log(`Could not reveal ${configFile()}: ${error.message}`);
  }
}

function installMenu() {
  const template = [
    {
      label: APP_NAME,
      submenu: [
        {
          label: 'Reload',
          accelerator: 'CmdOrCtrl+R',
          click: () => {
            const window = BrowserWindow.getFocusedWindow() ?? mainWindow;
            window?.reload();
          },
        },
        {
          label: 'Open data folder',
          click: () => {
            try {
              shell.showItemInFolder(path.join(app.getPath('userData'), 'data', 'catalog.db'));
            } catch (error) {
              log(`Could not reveal the data folder: ${error.message}`);
            }
          },
        },
        {
          label: 'Open server settings',
          click: openServerSettings,
        },
        { type: 'separator' },
        {
          label: 'Quit',
          accelerator: 'CmdOrCtrl+Q',
          click: () => app.quit(),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function writeServerInfo() {
  const info = {
    port: serverPort,
    url: appUrl,
    loopbackUrl,
    apiUrl: apiBaseUrl,
    webRoot,
    spaReady,
    packaged: app.isPackaged,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  try {
    fs.mkdirSync(path.dirname(serverInfoFile()), { recursive: true });
    fs.writeFileSync(serverInfoFile(), `${JSON.stringify(info, null, 2)}\n`, 'utf8');
  } catch (error) {
    log(`Could not write ${serverInfoFile()}: ${error.message}`);
  }
  return info;
}

async function start() {
  ensureConfigFile();

  // Standalone by default: the app carries the API and the print engine. The
  // external URL path stays for development against a running dev server.
  const externalApi = normaliseBaseUrl(process.env.CATALOG_API_URL);
  if (externalApi) {
    apiBaseUrl = externalApi;
    log(`Using external API ${apiBaseUrl}`);
  } else {
    apiBaseUrl = await startEmbeddedApi();
  }

  webRoot = resolveWebRoot();
  spaReady = fs.existsSync(path.join(webRoot, 'index.html'));
  if (!spaReady) {
    log(`No web build at ${webRoot}. The window will explain how to build it.`);
  }

  localServer = createLocalServer();
  serverPort = await listenOnFreePort(localServer);
  appUrl = `http://${WINDOW_HOSTNAME}:${serverPort}/`;
  loopbackUrl = `http://${LOCAL_HOST}:${serverPort}/`;

  const info = writeServerInfo();
  log(`Serving ${webRoot} at ${appUrl} (loopback ${loopbackUrl}); API proxy -> ${apiBaseUrl}`);
  if (printPort) {
    // Parseable one-liner for scripts and smoke tests.
    console.log(`GRACE_STUDIO_PORT=${serverPort}`);
    console.log(`GRACE_STUDIO_URL=${loopbackUrl}`);
  }

  installMenu();
  createWindow();

  if (printPort) log(`Server info written to ${serverInfoFile()}`);
  return info;
}

async function stopEmbeddedApi() {
  if (!embeddedServer) return;
  const server = embeddedServer;
  embeddedServer = null;
  try {
    await server.close();
  } catch (error) {
    log(`Embedded server shutdown failed: ${error.message}`);
  }
}

function stopServer() {
  if (!localServer) return;
  try {
    localServer.close();
  } catch {
    // The server is already closed.
  }
  localServer = null;
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.on('window-all-closed', () => {
    // This is a single-window tool: closing it means quitting.
    app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && appUrl) createWindow();
  });

  let embeddedCloseStarted = false;
  app.on('before-quit', (event) => {
    if (!embeddedServer || embeddedCloseStarted) return;
    event.preventDefault();
    embeddedCloseStarted = true;
    stopServer();
    stopEmbeddedApi()
      .catch((error) => log(`Embedded server shutdown failed: ${error.message}`))
      .finally(() => app.quit());
  });

  app
    .whenReady()
    .then(start)
    .catch((error) => {
      log(`Startup failed: ${error.stack ?? error.message}`);
      app.quit();
    });
}
