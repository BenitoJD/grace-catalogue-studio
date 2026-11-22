# Grace Catalogue Studio

An internal tool for Grace Wood Industry, Nagercoil. It turns a customer requirement into a finished, print ready document: an order confirmation voucher with the specification, the proposed finishes and the company's own photography.

One codebase. It runs as a phone app and as a website, built with React Native and Expo.

## One standalone app

The product is a single desktop application. The studio, the catalogue engine, the SQLite database, the brochure templates and the print engine are all inside the installer. There is no external server to run, no Python, no WeasyPrint and no browser. A separate `npm run server` exists only for development from a checkout; the customer never sees it.

The only external service is the language model chosen in Settings. Everything else works on the machine, and the server's egress guard enforces that.

## What it does

1. A sales person picks a customer and enters the wardrobe specification.
2. The app asks the server to render the voucher.
3. The server fills the house templates with that data and prints them to PDF.
4. The PDF is previewed in the app, page by page, and can be shared or printed.

The design is fixed. The words are few. The photography carries the page.

## Documents

Three documents come out of the same data.

| Document | Where it starts | Pages | Notes |
|---|---|---|---|
| Order voucher | Any order, Design gallery | 4 | 30 designs, one per family, model-written body |
| Info kit | Any order, Info kit | 5 | Company brochure: workshop, materials, process |

![Info kit](docs/screenshots/info-kit.png)

## Design direction and editing

The studio is not stuck with what the model chose. On the order screen, under AI design:

- **Direction.** Type how the brochure should feel in plain words, for example "warmer and more festive, maroon and gold, big Tamil title, like a coffee table book". The model reads it before it designs, and the order remembers it for later generations.
- **Choices.** Every decision is on screen as a chip: palette, type, cover, story, materials and specification. Change any of them.
- **Re-render without the model.** Ask the model to redesign with the direction, or re-render immediately with the choices on screen. The direct re-render takes about a second and makes no model call.
- **Words.** The story line, headline, body and closing are editable fields. Change a word and re-render.
- **Template instead.** A template option sits beside the AI design. The thirty hand-built designs remain available from Use a template instead and from Change design, and they use the same copy.

![Design direction and editing](docs/screenshots/design-editor.png)

## Chat first

One chat is one order. It opens like a premium assistant: brand avatar, timestamps, copy on every reply, starter cards for the common jobs, and a composer that takes typing, dragging or pasting.

- **Starter cards**: paste a WhatsApp message, add photos or a plan, or pick a cover.
- **Files**: attach with +, drag files onto the window, or paste an image. Any type, up to 50 MB each. Attachments wait in a tray with a thumbnail, size and remove button before sending.
- **Brief progress**: after the first reply the composer shows a progress bar, the details still missing as chips, and a Ready to build state.
- **Skipping what is not known**: press **I don't know** on the missing details, or type it in the chat. Those details are marked to be confirmed, never guessed. The order is still made, the specification prints To be measured, and the measured drawing says it will follow after the site measurement.
- **Keyboard**: Enter sends, Shift+Enter writes a new line, IME composition never sends early. A scroll to latest button appears when you are reading back.
- **Nothing is lost on failure**: a failed send puts the message and attachments back in the composer and explains how to fix it.
- **Model status**: a Model ready pill when the language model is configured, and an Add model banner that links straight to Settings when it is not.
- **Typing indicator** shows whether the model is Reading or Creating the order.
- **Cover strip**: the thirty printed covers with No design as the last card. It folds away after the first message and stays one tap away as a cover summary above the composer.

![The studio chat](docs/screenshots/chat-premium.png)

![Brief progress and attachments in the composer](docs/screenshots/chat-composer.png)

The first thing the chat asks is the cover: pick one of the thirty printed designs and that cover is printed with the model written copy, or pick **No design** and the model designs the whole brochure for the order.

![Choosing a cover in the chat](docs/screenshots/chat-design.png)

Then paste everything the customer told you. A WhatsApp forward, a list, a rough note, all of it. The model pulls out the order, asks only for what is missing, and creates the order and the brochure when it has enough.

## Editing by conversation

After a brochure exists the chat stays on that order. Every plain sentence is treated as a change request: the model maps it to order fields, brochure copy, a design choice or a photo slot, the server saves it on that order, the same brochure re-renders, and the assistant replies in a normal sentence saying what changed. Examples: "make the shutters dark walnut", "use the second photo on the cover", "shorten the headline", "the height is 2150". An order only change like a new height re-renders the existing design with the corrected specification. New order is the only way to start a different customer.

## Generated design

The brochure is not chosen from a library. When the chat finalises an order, the model acts as art director: one call returns the palette, the type pairing, the composition of all four pages and the headline, body and closing for this order. Every order gets a different document.

The design is strict JSON with allowed values only, validated, then compiled to print safe HTML and CSS by the server. The model never emits markup, so nothing unsafe or unprintable can reach the press. `POST /api/orders/:id/ai-brochure` returns the render, the design and the copy, and the design is stored with the document so the studio can explain how each brochure was made.

It is built as an Indian workshop brochure, not a report:

1. **Cover.** One strong photograph, a deep maroon brand band, the piece in large type and the customer. Almost nothing else.
2. **Story.** A full bleed photograph, the statement as a large line, and the copy set in a magazine column.
3. **Materials.** A maroon header and the four finish textures at size with their names. A colour page, not a table.
4. **Specification.** Dimensions, materials and hardware, set quietly at the back for the workshop and the client file.

Warm cream stock, deep maroon, metallic gold rules and Indian ornament: a jaali border across the head of the page, paisley and lotus motifs, a rangoli mark and a temple arch behind the framed photograph. The brand appears in English and Tamil (கிரேஸ் வூட் இண்டஸ்ட்ரி) on the cover, the room name appears in Tamil under the English title, the contact strip is bilingual, and the tones are Indian: maroon, teal, copper, sandal and peacock. Display type runs 30 to 46 point and body text 8 point.

Finishing details: the cover carries a Made in Nagercoil line, the story page opens with a display drop cap, the four finishes are numbered and framed in gold on the materials page, and the specification page closes with a measured front elevation and plan drawn from the confirmed order, with width, height and depth marked in millimetres.

The studio app carries the same Tamil brand line under its headers.

The thirty hand-built designs remain available under Change design for a manual override, but the default path is generated per order.


The extraction rules matter as much as the conversation. Bare dimensions become millimetres, counts become digits, unknown fields are dropped, and a reply without usable JSON is rejected with a readable error. A field is only ready when the customer actually said it, never guessed.

## Screens

![History](docs/screenshots/orders.png)

History. Orders are only ever created by the chat, so this screen is read only: every order carries its number, customer, dimensions and the brochure it produced, with the cover thumbnail and a direct Open PDF.

![Order detail](docs/screenshots/order-detail.png)

The full specification, then the rendered voucher with page by page preview, open PDF and share.

![Designs](docs/screenshots/e2e/06-designs.png)

Thirty cover designs. The specification and finish pages stay identical, so picking a design is safe. Choose one from the order screen and the next render uses it.


## Architecture

```
app/          Expo SDK 58, expo-router, React Native and web
server/       Node 24, Hono, node:sqlite, WeasyPrint via child process
templates/    HTML and CSS for the voucher and the info kit
data/         SQLite database, generated PDFs and page images (git ignored)
```

The app never renders a document. It sends data and receives a PDF, so what a customer sees is always the same file, whether it was generated on a phone or on the office desktop.

```
React Native app  ──HTTP──▶  Hono API  ──SQLite──▶  orders
      ▲                         │
      │                         └── templates + WeasyPrint ──▶ PDF
      └──────── page images and PDF download ────────────────┘
```

## Quick start

Requirements: Node 24, Python 3 with WeasyPrint, and `pdftoppm` from Poppler.

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

```bash
npm run setup      # installs server and app dependencies
npm run seed       # creates data/catalog.db with demo data
npm run dev        # API on :8787 and the web app on :8081
```

Open http://localhost:8081 for the web app. For the phone, run `npm --prefix app start` and scan the QR code with Expo Go.

Useful single commands:

```bash
npm run server     # API only
npm run app        # web app only
npm --prefix server run previews   # build the 30 template thumbnails
npm test           # server test suite
npm run verify     # end to end check: create an order, render, verify the PDF
npm run build:web  # static web build in app/dist
node scripts/serve-web.mjs 8081   # serve that build with SPA deep link fallback
```

The web build is a single page app because of the dynamic order route. Any static host must rewrite unknown paths to `index.html`. `scripts/serve-web.mjs` does that for local review. Do not open the files with a file:// URL.

## The API

Full contract in [CONTRACT.md](CONTRACT.md). The essentials:

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/bootstrap` | customers, orders and materials in one call |
| POST | `/api/orders` | create an order |
| POST | `/api/orders/:id/render` | render a voucher with an optional `templateId`, returns page URLs |
| GET | `/api/templates` | the 30 brochure templates and their thumbnail URLs |
| GET | `/previews/:templateId.png` | a template thumbnail |
| GET | `/api/materials` | internal workshop finishes used by the brochure (no app screen) |
| PATCH | `/api/materials/:id` | update a material, including its trade rate |
| GET | `/files/:name` | the PDF |
| GET | `/pages/:renderId/:n.png` | a page image for the in app preview |

A voucher has 30 selectable designs: ten complete document families with their
own cover, specification, finishes and inside pages, each offered in three
palettes. The catalogue is data in `templates/variants.json`; every family is a
full four page HTML document in `templates/voucher/families/`, and the palette
arrives as CSS variables. The app sends `templateId` with a render; missing
means the first template (`atelier-copper`). Thumbnails are cached in
`data/previews/` and generated once per template.

## Rendering

Templates live in `templates/`. The server replaces `{{key}}` tokens with order data, writes the built HTML into `templates/voucher/` (or `templates/kit/`) so relative asset paths resolve, then calls:

```
weasyprint <html> data/renders/<id>.pdf
pdftoppm -png -r 96 <pdf> data/renders/<id>
```

If a placeholder is left unfilled the render fails with a clear message rather than printing `{{customerName}}` on a customer's document.

Rendering is queued per process so two requests cannot write into the same build directory.

## Design system

| Token | Value |
|---|---|
| background | `#F2F2F7` |
| surface | `#FFFFFF` |
| fill | `#EFEFF4` |
| ink | `#1C1C1E` |
| muted | `#6E6E73` |
| faint | `#8E8E93` |
| copper | `#A65E22` |
| hairline | `#DCDCE2` |

The navigation is a floating dock on a wide window and a full width bar on a phone: line icons, an active tinted tab, hover states on desktop and Alt+1, 2, 3 shortcuts between Chat, History and Settings.

![The navigation dock](docs/screenshots/tab-bar.png) The rest of the application follows Apple's grouped interface: the system font at native sizes, white cards on a grouped grey background, one brand tint, 14 point rounded cards, pill buttons and an iOS style tab bar. Printed brochures keep their own editorial typography; only the app is Apple styled.

House rules for copy: short sentences, no em dashes or en dashes, a middot for separators. Say what the person should do next, not what the system did.

## Tests

```bash
npm test          # 87 server tests, api, rendering, the model and uploads
npm run verify    # black box: create, render, check the pdf with pdfinfo
npm run e2e       # drives the real web app in Chrome like a person
npm run typecheck
npm run lint
```

`npm run e2e` starts the API, the web build and a mock model provider, then walks the product like a person: history, an order created the way the chat does, detail, render, open PDF, share, re-render, choose a different design, tests the AI design editor and its re-render, test the model connection, draft a customer note, write the brochure body, confirm the body inside the generated PDF, render the info kit, the chat creating its own order and brochure, settings, deep link, mobile viewport, and the sad path when the API is down. 104 checks. Screenshots land in `docs/screenshots/e2e/`. The run fails on console errors.

## Design templates

![All designs](docs/screenshots/all-designs.png)

Thirty designs, and every one is a **different document**, not a recolor. Each design is a complete four page family with its own cover, specification page, finishes page and inside page, in one fixed palette. The gallery refuses to show two arrangements of the same page.

| Design | What makes it different |
|---|---|
| Copper Atelier | Editorial paper cover, labelled specification tables, four up finish grid and a large inside photograph |
| Ink Swiss | Grotesque grid with numbered sections, hairline key value lists and a full width swatch band |
| Sand Gallery | Huge margins and small centred text, one photograph per page, a single centred specification column |
| Indigo Index | Dense trade catalogue with small type, a three column specification and a coded finishes grid |
| Ink Dark | Ink black cover and section dividers, a reversed white on black specification and light hairlines |
| Indigo Blueprint | Technical drawing furniture, a specification table with a units column and annotated finish strips |
| Sand Lookbook | Full bleed photography on every page, text in corners over photographs, a compressed overlay specification |
| Olive Poster | One enormous title with almost nothing else, a six line specification and plain finish strips |
| Copper Card | Modular bordered cards, a specification split into labelled boxes and a cover built as one card |
| Ink Folio | Classical centred folio with small caps, thin double rules, one elegant specification list and numbered swatches |
| Indigo Timeline | Horizontal stage rail and numbered markers, vertical four-stage specification with facts attached to cut, band, assemble and finish, perforated film-strip finishes, two stage frames joined by a drawn line |
| Indigo Blue Paper | Knocked-out outlined title with a data plate, annotated elevation with dimension lines and numbered callouts, chips on leader lines, photo plates with registration brackets |
| Olive Magazine | Grace Wood masthead with cover lines and issue line, two-column spread with a pull quote and small caps entries, four-frame photo essay finishes with a full width detail, drop cap article inside |
| Sand Frame | A single matted photograph with the title as a wall label, wall-label specification panel with generous white space, four framed swatches with plaques, two framed works at different sizes inside |
| Copper Ticket | Perforated stub with serial and tear-off counterfoil, receipt style dockets with dashed separators and totals rows, four tear-off swatch stubs, stamp circle and ticket window photographs |
| Indigo Axonometric | Faint 30 degree grid cover with an orientation key and gridded photo plate, three ascending axonometric specification panels with numbered edges, finish blocks with visible top faces, surveyed photographs with corner coordinates |
| Sand Swatchbook | Overlapping rounded swatch cards fanned over the cover with the title on the top card, tabbed ruled index card specification, stacked finish cards with shadows, paper photo card with a swatch strip footer |
| Ink Broadsheet | Masthead and edition line above a huge stacked headline, photograph in a rectangular cut with a contents rail, four column classified specification with a display advert, framed finish plate, lead story with pull quote and captions |
| Sand Redline | Annotated cover photograph with accent circles and an arrow over a revision strip, a revision log table holding every order fact with a change column, ticked and underlined samples, marked up inside photos and a sign off block |
| Copper Collage | Three overlapping rotated frames with paper tape, title on the top photo, order number on a paper tag, facts on a rotated file card over scraps, pinned swatch chips, two collaged photos with a torn paper strip |
| Copper Ledger | Account header cover with a received stamp and a contents ledger, double entry specification across two ruled leaves with control totals, posted swatch entries with amount columns, continuation ledger with framed photographs |
| Olive Geometric | A huge accent circle and ink bars crossed by the grotesque title, a square index, specification rows under oversized numerals and thick accent blocks, bold swatch panels, photographs in heavy bar frames |
| Olive Sketchbook | Graph paper, dashed annotations with leader lines, italic title, taped photograph and measurement slip, circled number specification sketches with dashed leaders and a drawn elevation, taped swatch cards, callout sketch page |
| Copper Sleeve | Circular cut out label photograph and catalogue corner, back cover tracklist in two sides with a barcode, liner notes beside square swatch tiles, inside vinyl whose label is a photograph with text around it |
| Ink Envelope | Folded flap, address block, accent stamp box with date and order number, photo window, letterhead specification letter with indented fact lines and signature, enclosed four window swatch card, closing letter clipped over two photographs |
| Ink Accordion | Dotted fold creases on every page, two panel title, vertical panel headers on the specification, swatch names running up the folds, two photo panorama inside with a fold register |
| Sand Split | Vertical paper and photo cover, reversed band above a two column specification, solid diagonal finish field, inside spread with one photograph crossing the seam |
| Copper Specimen | Giant Aa and alphabet proof on the cover, a glyph grid holding every specification fact, type sample finish rows, proof sheet with specimen paragraphs inside |
| Sand Contact | Film strips with punched sprocket holes, grease pencil circle, title written across a strip, camera notes specification pad, hand marked swatch strip, enlarged signed frame inside |
| Olive Atlas | Contour fields, compass rose, legend block with order and date, symbol legend with scale bar, terrain swatch keys, inside map detail with landmarks and an elevation trace |

Palettes: copper `#A65E22`, ink `#1C1A17`, olive `#5C6B3C`, indigo `#2F3E6B`, sand `#B08A63`.

`GET /api/templates` lists them with preview images. A render accepts `templateId`. The app shows the gallery from the order screen under Design. Every design shares the same placeholders and the same data, so switching design never changes what the document says.

Measured, not asserted: `node scripts/design-uniqueness.mjs` renders all thirty with one order and compares them as images. The closest pair of covers differs by 12 of 64 perceptual bits, the average pair by 29.5, and no pair of full documents comes close to matching. The check fails loudly if two designs become near duplicates.

## Desktop app for Windows and Mac

The product ships as a standalone desktop app. It contains the studio UI, the catalogue API, the SQLite database and the print engine, so the person installing it needs nothing else: no Node.js, no Python, no WeasyPrint, no separate server. On first launch they open **Settings → Language model**, paste the endpoint, model id and key, and work.

PDFs are printed by Electron's own Chromium through `desktop/pdf-engine.js`. The server asks the engine for the PDF and the page images, so the rendering that used to need WeasyPrint and poppler now runs inside the app.

Data lives in the app data folder: `%APPDATA%\Grace Studio\data` on Windows and `~/Library/Application Support/Grace Studio/data` on macOS. The menu item **Open data folder** reveals it.

```bash
npm run setup
npm run desktop                      # run the desktop app in development
npm run build:mac                    # dmg and zip in desktop/release
npm run build:win                    # nsis and portable exe, best run on Windows
```

The desktop process starts the server itself through `server/src/boot.mjs`. The command line server still works the same way with `npm run server`, and `CATALOG_API_URL` switches the desktop wrapper to an external API for development.

The Windows installer is a custom NSIS wizard in `desktop/installer/GraceStudio.nsi`, built the same way as the Attendance Report Studio installer: Welcome, options, install, Finish with a Launch checkbox. It installs for the current Windows user into `%LOCALAPPDATA%\Programs\Grace Studio`, so there is no administrator prompt, creates a Start Menu shortcut and optionally a desktop shortcut, registers a proper Apps and Features uninstall entry, and upgrades cleanly. Data in the app data folder is never touched.

`.github/workflows/desktop.yml` builds both installers on every `v*` tag and attaches them to the GitHub release: `Grace.Studio.Setup.1.0.12.exe` and a portable exe for Windows, dmg and zip for macOS. The Windows job also installs the wizard silently on the runner, checks that the app landed at the expected path, then uninstalls it to prove both directions work. Builds are unsigned for now: SmartScreen and Gatekeeper will warn on first open.

The standalone app was built and launched on this machine: the packaged build started its embedded server, designed a brochure with the live model, and printed all four pages through the Electron engine in 1.5 seconds.

## Language model

The studio ships with presets for the providers people actually use, all through one OpenAI compatible layer: DeepSeek, OpenCode Zen Go, Command Code Provider, OpenAI, OpenRouter, Groq, Together, Mistral, Google Gemini, xAI Grok, Ollama and LM Studio, plus Custom for anything else. Pick one on the Settings screen, paste the key, choose a suggested model or type your own.

![Provider presets in Settings](docs/screenshots/provider-settings.png)

- Each preset fills its endpoint and suggests its models; the endpoint stays editable.
- OpenCode Go adds its session header automatically and asks reasoning models for a direct answer.
- Command Code uses its Provider API endpoint, `https://api.commandcode.ai/provider/v1`, with the same key as the CLI.
- Ollama and LM Studio run on the office machine and need no key.
- Switching provider drops a stale endpoint so the new defaults apply instead of an old URL.
- The catalog is available at `GET /api/llm/providers`; the key is stored on the server, never returned to the app and never logged.
- Server environment variables still work for deployments: `LLM_PROVIDER`, `LLM_ENDPOINT`, `LLM_MODEL`, `LLM_API_KEY`.

No API key ships with the app. A fresh install has none; the studio adds one on the Settings screen, and Forget saved key removes it from the computer.

## Model caching

Every generated reply is cached locally, keyed by a hash of the provider, the model and the full prompt. A repeated request returns the stored words with `cached: true` and `latencyMs: 0`, and does not call the provider at all. `regenerate: true` bypasses the cache and replaces the entry, so a fresh copy is never shadowed by an older one.

Measured live against OpenCode Go:

| Request | Result |
|---|---|
| First copy | 4,259 ms, `cached: false` |
| Identical second copy | 0 ms, `cached: true` |
| Regenerate | 4,568 ms, fresh copy stored |

The same applies to the customer note. `GET /api/llm/cache/stats` reports entries and hits, `POST /api/llm/cache/purge` clears it, and `LLM_CACHE_TTL_HOURS` sets the window (default 168, 0 disables). Expiry is enforced on read and expired rows are pruned at boot.

The system prompt is also a stable prefix at the start of every request, which is what provider side prompt caching keys on. The provider's cached token count already appears in the usage figures, so the two layers stack.

## Copy quality

The model's brochure copy is measured, not eyeballed. `scripts/ai-quality.mjs` runs six realistic orders through the live provider and scores every reply against a rubric: body between 95 and 145 words, headline and closing caps, numbers that exist in the order, no money, date or festival leaks, no talk of the order or brief, no durability or cleanliness claims, no parts the order does not include, no repeated verbs, no reused example phrasing, and no walking through the materials list.

The voice itself is checked: no marketing clichés (premium, luxurious, bespoke, stunning, perfect, elegant and friends), no second person selling ("you", "your", "we"), at least one long sentence balanced by short ones, no colon in the headline, and a limit on crutch words like quiet, calm and plane.

```bash
# measure the prompt directly
LLM_ENDPOINT=https://opencode.ai/zen/go/v1 LLM_MODEL=deepseek-v4.1-flash LLM_API_KEY=... \
  node scripts/ai-quality.mjs

# or measure the running product, repair pass included
node scripts/ai-quality.mjs --api http://localhost:8787
```

Final result across six orders: **118 of 120 checks, average body 114 words, zero repair passes needed** on the measured run.

The generator protects itself in production. `copyQualityIssues` rejects a thin body, internal paperwork talk, repeated verbs, a material walk through, any mention of the carcass or back panel, a marketing cliché, and second person selling. A single corrective retry names the exact problems, so a weak reply does not reach the customer.

Two bodies from the final runs:

> **Loft above for the winter bedding**
> Anitha's bedroom has little floor to spare, so the wardrobe runs 2400 mm across one wall and stops at 2100 mm, with a loft added on top for the bedding that used to sit in bags. Four drawers sit below the hanging space, and two of them lock, which keeps documents and jewellery out of the everyday shuffle. Warm oak laminate on the shutters lightens the room, and the white interior means a shelf is easy to read at a glance.

> **Three shutters for the guest room wall**
> The guest room holds its light on the long wall, and the wardrobe takes that wall from end to end. Three shutters divide the width into equal parts, each one hinged to close softly rather than snap, so the proportions read before the handles do. Matte black aluminium runs vertically down the face, one set to each shutter, and the edge banding follows the same colour as the laminate so the outline stays unbroken. Inside, white laminate keeps the interior bright when the doors are open.

## Offline by design

The only external service the studio uses is the language model you configure. Everything else runs on the machine:

- The app, its fonts, images, templates and brochure assets are bundled. No CDN, no Google Fonts, no analytics and no update checks.
- The database is local SQLite, attachments and PDFs live in the app data folder, and the desktop print engine is the Electron build itself.
- The server installs a network egress guard at boot. Only the configured model provider and loopback may receive a request. A stray future fetch to any other host throws instead of leaving the machine, and redirects are never followed off the allowlist.
- The desktop print windows additionally block every HTTP and HTTPS request, so a brochure from a local file can never pull a remote font or image.
- A test audits the templates for remote URLs, and the egress guard has its own test.
- The connection test and every model call go to the provider chosen in Settings. External links open only when a person clicks a PDF or a file link.
- There is no auto-update service. A new version is installed with the setup wizard.

If a future integration genuinely needs another origin, `CATALOG_ALLOWED_EGRESS_ORIGINS` adds that exact origin and nothing else.

## Production

The API ships as a container. Full runbook in [docs/DEPLOY.md](docs/DEPLOY.md), the config template in [.env.example](.env.example).

```bash
cp .env.example .env      # set CORS_ORIGINS and the domain
mkdir -p data && sudo chown 1000:1000 data
docker compose up -d --build
curl -fsS localhost:8787/health
curl -fsS localhost:8787/ready
```

The image installs WeasyPrint and Poppler, runs as a non root user, and keeps everything stateful in `/app/data`, which is bind mounted to `./data`. The web build is static, served by the same reverse proxy at the apex path, so the app and the API share an origin and `EXPO_PUBLIC_API_URL` can stay unset.

**Operational behaviour**

| Concern | How it behaves |
|---|---|
| Liveness | `GET /health`, cheap, always 200 while the process runs |
| Readiness | `GET /ready`, 200 only when the database answers and the WeasyPrint binary is executable, 503 with a reason otherwise |
| Logs | one JSON line per request to stdout: time, level, requestId, method, path, status, durationMs. No request bodies |
| Tracing | every response carries `X-Request-Id`, and every error JSON repeats it |
| Errors | JSON `{ error, requestId }`, never a stack trace to the client |
| Limits | 120 requests per minute per IP, 12 renders per minute per IP, 64 KB body cap, configurable by env |
| CORS | explicit allowlist, `*` only for testing |
| Storage | WAL mode, foreign keys on, schema versioned through PRAGMA user_version |
| Renders | concurrent identical requests share one render, files older than `RENDER_RETENTION_DAYS` are swept daily |
| Shutdown | SIGTERM drains in flight renders for up to 20 seconds, then closes the database |
| Backup | `sqlite3 data/catalog.db ".backup data/backup.db"` plus a copy of `data/renders` and `data/previews` |

Behind a proxy, keep the API on loopback and let Caddy hold TLS. The container reads the first `X-Forwarded-For` entry for rate limiting, which is only trustworthy behind that proxy. The Caddyfile in DEPLOY.md handles `/api`, `/files`, `/pages`, `/previews`, `/media`, `/health` and `/ready`, and falls back to `index.html` for the single page web app.

**Native builds.** `app/eas.json` defines development, preview and production profiles. Set `EXPO_PUBLIC_API_URL` for the target API before building. On the Android emulator use `http://10.0.2.2:8787`; on a real phone use the machine's LAN address or the deployed domain.

**Before a customer sees a document.** Fonts in the PDF must all be embedded (they are, as CID TrueType subsets), and images must be at least 200 dpi at their printed size. The cover render is the weakest file at roughly 150 dpi; a larger export from the original render would fix it.
