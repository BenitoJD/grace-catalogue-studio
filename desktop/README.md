# Grace Studio desktop (Electron)

A standalone desktop application for Windows and macOS. It contains the Expo web
studio, the catalogue server and the print engine, so the person who installs it
needs nothing else: no Node.js, no Python, no WeasyPrint, no separate server.

On first launch they open **Settings → Language model**, paste the endpoint, model
id and key, and work. Everything else starts and stops with the app.

The installers are built in CI: every `v*` tag produces a Windows `setup.exe` and
a portable `exe`, plus macOS `dmg`/`zip`, attached to the GitHub release.

`desktop/package.json` uses the npm-safe package name `grace-studio-desktop`
(npm and electron-builder reject spaces and capitals in `name`); the app name
Electron and the installers show comes from `productName`, which is
`Grace Studio`.

```
┌──────────────────────────── Electron main process ────────────────────────────┐
│  BrowserWindow ──> http://grace-studio.localhost:<free port>                   │
│                       │                                                        │
│                       ▼                                                        │
│  static server + reverse proxy (127.0.0.1, free port)                          │
│    • serves app/dist statically, SPA fallback to index.html                    │
│    • proxies /api /files /pages /previews /media /health /ready                │
│                       │                                                        │
│                       ▼                                                        │
│  embedded catalogue server (127.0.0.1, OS-assigned port)                       │
│    • SQLite database in the app's userData folder                              │
│    • model calls, intake, design compilation                                   │
│    • PDF and page images through the Electron print engine (pdf-engine.js)     │
└────────────────────────────────────────────────────────────────────────────────┘
```

## How it works

On launch `main.js`:

1. Starts the catalogue server from a bundled single-file build of `server/`
   (`build/server-bundle.mjs`), with data in Electron's userData folder and the
   templates from the app resources. A `CATALOG_API_URL` environment variable
   switches the wrapper to an external API for development instead.
2. Starts an HTTP server on `127.0.0.1` with an OS-assigned free port. It serves
   the exported Expo SPA from `app/dist` with an SPA fallback (`/orders` gets
   `index.html`) and reverse proxies the API path prefixes to the backend,
   streaming request and response bodies. `/api`, `/files`, `/pages`,
   `/previews`, `/media`, `/health` and `/ready` are proxied to the embedded
   server. Printing runs inside this same Electron process, so a render needs no
   external binaries.
3. Opens a BrowserWindow (1280×860, minimum 900×700) at that server, restores
   the previous window bounds from the userData directory, and keeps a single
   instance running (a second launch focuses the existing window).
4. Adds a native menu: **Reload**, **Open data folder**, **Open server settings**
   and **Quit**. The language model settings live in the app and are edited on
   the Settings screen, not in a file.

Because the SPA and the proxy are the same origin, the app needs no CORS
configuration and no rebuild with `EXPO_PUBLIC_API_URL`: requests such as
`fetch('/api/bootstrap')` reach the embedded proxy and are forwarded to the
configured API.

### Why the window is on `grace-studio.localhost`

`app/lib/api.ts` treats the hostnames `localhost`, `127.0.0.1` and `0.0.0.0` as
the local development setup and hardcodes `http://localhost:8787` for them.
If the window were loaded from `http://127.0.0.1:<port>` the SPA would call
port 8787 directly and bypass the proxy. Loading from
`http://grace-studio.localhost:<port>` (a name that always resolves to
loopback) is not one of those three hostnames, so the app uses
`window.location.origin` and therefore calls the embedded proxy — still with no
rebuild and no CORS. Electron is told to map the name to 127.0.0.1 with
`--host-resolver-rules`, and if the alias cannot be resolved the window falls
back to `127.0.0.1` (in that fallback the UI still loads, but the app talks to
`localhost:8787` directly, so run the API there).

### First run / web build

The wrapper serves whatever is in `app/dist`. Build it first:

```bash
cd app
npx expo export --platform web --output-dir dist
```

If `app/dist/index.html` is missing the window shows an inline page that
explains how to build the SPA instead of staying blank. The app works the same
in a checkout (`../app/dist`) and when packaged (`Contents/Resources/app/dist`
on macOS, `resources/app/dist` on Windows).

## Run from source

Requires Node.js 24+ and a local copy of the repository. The desktop app now
starts the server itself, so `npm run dev` in the repository root is not needed.

```bash
cd app && npm ci && npx expo export --platform web --output-dir dist && cd ..
cd desktop && npm ci
npm start
```

`npm start` runs `electron .`. `--print-port` additionally prints the chosen
port, which is handy for smoke tests:

```bash
env -u ELECTRON_RUN_AS_NODE npm start -- --print-port
# [grace-studio] Serving .../app/dist at http://grace-studio.localhost:51234/ ...
# GRACE_STUDIO_PORT=51234
# GRACE_STUDIO_URL=http://127.0.0.1:51234/
```

Every launch also writes `desktop-server.json` (`port`, `url`, `loopbackUrl`,
`apiUrl`, `webRoot`, `spaReady`) to the userData directory, so the embedded
server can be checked with `curl` even without the terminal output.

## External API (development only)

Either set the environment variable:

```bash
CATALOG_API_URL=https://catalogue.example.com npm start
```

or edit the config file (this is what **Open server settings** reveals):

| OS      | Path                                                                  |
| ------- | --------------------------------------------------------------------- |
| macOS   | `~/Library/Application Support/Grace Studio/desktop-config.json`       |
| Windows | `%APPDATA%\Grace Studio\desktop-config.json`                           |
| Linux   | `~/.config/Grace Studio/desktop-config.json`                           |

```json
{
  "apiUrl": "https://catalogue.example.com"
}
```

The file is created with the default on first launch. The value is read at
startup, so restart the app after changing it. `CATALOG_API_URL` wins over the
file. The backend must be reachable from the desktop machine; no CORS setup is
needed because the proxy calls it server-side.

## Windows installer wizard

`installer/GraceStudio.nsi` is a custom NSIS installer, modelled on the
Attendance Report Studio installer. It is a normal four step wizard: Welcome,
options, install, Finish with a Launch checkbox. It installs per-user into
`%LOCALAPPDATA%\Programs\Grace Studio`, so Windows never asks for an
administrator password, writes a Start Menu shortcut, offers an optional desktop
shortcut, registers the app in Apps and Features and uninstall removes it
cleanly. The app data folder is left alone, so reinstalling or upgrading keeps
the orders and the language model settings.

Build it from a Windows machine with NSIS 3.x installed:

```powershell
npm run build:win:all      # win-unpacked payload + portable exe
npm run build:win:setup    # the wizard: release\GraceStudio-Setup-1.0.2.exe
```

The setup script finds `makensis.exe` on PATH or in the standard Program Files
locations. CI installs NSIS, builds the wizard, then silently installs it on the
runner, checks the executable exists at the expected path and uninstalls it.

## Build the installers

```bash
cd desktop
npm ci
npm run build:mac   # macOS: dmg + zip, arm64 and x64
npm run build:win   # Windows: nsis installer + portable exe, x64
npm run build       # whatever the current platform is
```

Artifacts land in `desktop/release/`:

- macOS arm64/x64: `Grace Studio-1.0.0-arm64.dmg`,
  `Grace Studio-1.0.0-x64.dmg`, `Grace Studio-1.0.0-arm64-mac.zip`,
  `Grace Studio-1.0.0-mac.zip` and the unpacked
  `release/mac-arm64/Grace Studio.app` / `release/mac/Grace Studio.app`.
- Windows x64: `Grace Studio-1.0.0-setup-x64.exe` and
  `Grace Studio-1.0.0-portable-x64.exe`.

`electron-builder` downloads the matching Electron binaries on the first build,
so the build machine needs network access to the npm registry and GitHub
releases.

### Icons

`app/assets/images/icon.png` (1024×1024) was converted once and the results are
committed, because electron-builder wants `.icns` for macOS and `.ico` for
Windows:

- `build/icon.icns` — generated with `sips` + `iconutil` (macOS).
- `build/icon.ico` — generated with Pillow (sizes 16–256).
- `build/icon.png` — untouched copy of the Expo icon.

To regenerate after changing the icon:

```bash
# macOS
rm -rf desktop/build/icon.iconset && mkdir -p desktop/build/icon.iconset
for s in 16 32 64 128 256 512 1024; do ...; done   # see git history / sips
iconutil -c icns desktop/build/icon.iconset -o desktop/build/icon.icns

# Windows
python3 -c "from PIL import Image; Image.open('app/assets/images/icon.png').convert('RGBA').save('desktop/build/icon.ico', format='ICO', sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])"
```

## CI

`.github/workflows/desktop.yml` builds both platforms on GitHub Actions:

- triggers: `workflow_dispatch` and pushed tags matching `v*`;
- matrix: `macos-latest` → `npm run build:mac`, `windows-latest` → `npm run build:win`;
- each job installs `app` dependencies, exports the web build with
  `npx expo export --platform web --output-dir dist` **before** packaging, then
  installs `desktop` dependencies and builds;
- artifacts: `grace-studio-macos` (dmgs + zips) and `grace-studio-windows`
  (exe files) via `actions/upload-artifact`.

## Troubleshooting

- **Nothing happens when starting from a terminal, or only a Node error
  appears.** Some Electron-based tools export `ELECTRON_RUN_AS_NODE=1` to their
  child processes; Electron then runs `main.js` as plain Node and exits. Run
  with `env -u ELECTRON_RUN_AS_NODE npm start`, or launch the packaged app from
  Finder/Explorer as usual.
- **The UI loads but lists nothing / "could not be reached".** The wrapper
  could not reach the API. Check `apiUrl` in
  `desktop-server.json` and in `desktop-config.json`, make sure `server/` is
  running (or the deployed URL is correct) and hit
  `curl http://127.0.0.1:<port>/health`. Proxy errors answer `502` with the
  backend URL and error code in the JSON body.
- **The window is blank.** Check the terminal/log output for a
  `Could not load ...` line; the window normally falls back from
  `grace-studio.localhost` to `127.0.0.1` automatically. A missing SPA shows the
  inline "missing its web build" page instead of a blank window.

## Limits

- **Unsigned builds.** There is no Apple Developer ID or Windows code-signing
  certificate in the repo or in CI (`mac.identity: null`,
  `CSC_IDENTITY_AUTO_DISCOVERY=false`), so the installers are unsigned and not
  notarized. macOS Gatekeeper will refuse a downloaded build until the user
  right-clicks → Open (or runs
  `xattr -dr com.apple.quarantine "/Applications/Grace Studio.app"`); Windows
  SmartScreen will show "Unknown publisher". Add signing identities and
  notarization (for example `electron-builder`'s `notarize` option plus a
  Developer ID certificate) before distributing widely.
- **Windows builds are produced by CI only.** They were not built or run on the
  macOS development machine that wrote this wrapper; treat the first
  `windows-latest` run in Actions as the verification. The Electron code is
  cross-platform, but the Windows installer/portable exe and icon should be
  smoke-tested on Windows.
- **The API is not bundled.** The desktop app is a UI + proxy; it still needs a
  reachable catalogue API (`server/`, Docker image) for data, renders and
  files.
- **The SPA is a snapshot.** Packaging copies `app/dist` as it exists at build
  time; rebuild the web app (or let CI do it) before packaging after app
  changes.
- **Local builds need network access** on first run for the Electron binaries.
- `--host-resolver-rules` is Chromium-specific and only used for the loopback
  alias described above.
