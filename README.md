# Grace Catalogue Studio

An internal tool for Grace Wood Industry, Nagercoil. It turns a customer requirement into a finished, print ready document: an order confirmation voucher with the specification, the proposed finishes and the company's own photography.

One codebase. It runs as a phone app and as a website, built with React Native and Expo.

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
| Order voucher | Any order, Design gallery | 4 | 30 designs, ten families, model-written body |
| Info kit | Any order, Info kit | 5 | Company brochure: workshop, materials, process |
| Trade rate card | Materials, Print rate card | 1 to 2 | Rates from the material list, three layouts |

![Info kit](docs/screenshots/info-kit.png)

![Rate card](docs/screenshots/rate-card.png)

The rate card prints stored rates only. Nothing is calculated at render time, and GST is stated separately. `GET /api/catalogue/templates` lists the three layouts, `POST /api/catalogue/render` produces the PDF.

## Screens

![Orders](docs/screenshots/orders.png)

The order book. Every order carries its number, customer, title and dimensions.

![Order detail](docs/screenshots/order-detail.png)

The full specification, then the rendered voucher with page by page preview, open PDF and share.

![New order](docs/screenshots/new-order.png)

One form, prefilled with the house standard. A person can create an order in under a minute.

![Materials](docs/screenshots/materials.png)

The swatch library that feeds the finishes page of the voucher.

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
| GET | `/api/materials` | materials with `priceAmount`, `priceUnit` and `sku` |
| PATCH | `/api/materials/:id` | update a material, including its trade rate |
| GET | `/api/catalogue/templates` | the three trade rate card variants |
| POST | `/api/catalogue/render` | render the rate card with an optional `templateId` |
| GET | `/files/:name` | the PDF |
| GET | `/pages/:renderId/:n.png` | a page image for the in app preview |

A voucher has 30 selectable designs: ten complete document families with their
own cover, specification, finishes and inside pages, each offered in three
palettes. The catalogue is data in `templates/variants.json`; every family is a
full four page HTML document in `templates/voucher/families/`, and the palette
arrives as CSS variables. The app sends `templateId` with a render; missing
means the first template (`atelier-copper`). Thumbnails are cached in
`data/previews/` and generated once per template.

The trade rate card is separate from the voucher. It prints every material from
the materials table with its SKU, unit and stored rate, plus a GST note, on one
to two A4 pages. `templates/catalogue/rate-card.html` holds three layouts, picked
with `templateId`: `rate-card-ledger`, `rate-card-grid` or `rate-card-tags`.
`GET /api/catalogue/templates` lists them and
`POST /api/catalogue/render` returns a render with `kind: "catalogue"`.

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
| paper | `#FFFFFF` |
| ink | `#14100C` |
| muted | `#6E6259` |
| faint | `#A2938A` |
| copper | `#A65E22` |
| hairline | `#E6DED2` |

Display type is a serif, set large and tight. Body type is a neutral sans. Section labels are small, tracked, uppercase. No shadows, no gradients, no decoration.

House rules for copy: short sentences, no em dashes or en dashes, a middot for separators. Say what the person should do next, not what the system did.

## Tests

```bash
npm test          # 66 server tests, api, rendering, the model and the rate card
npm run verify    # black box: create, render, check the pdf with pdfinfo
npm run e2e       # drives the real web app in Chrome like a person
npm run typecheck
npm run lint
```

`npm run e2e` starts the API, the web build and a mock model provider, then walks the product like a person: order book, new order, create, detail, render, open PDF, share, re-render, choose a different design, test the model connection, draft a customer note, write the brochure body, confirm the body inside the generated PDF, render the info kit, print the rate card, materials, settings, deep link, mobile viewport, and the sad path when the API is down. 70 checks. Screenshots land in `docs/screenshots/e2e/`. The run fails on console errors.

## Design templates

![All designs](docs/screenshots/all-designs.png)

Thirty designs, built as **ten complete document families**, not permutations of one layout. Each family has its own cover, its own specification page, its own finishes page and its own inside page. Each family ships in three palettes, so the gallery stays at thirty.

| Family | Cover idea | Specification page | Finishes page |
|---|---|---|---|
| Atelier | serif on paper, photo below | labelled tables, signature rules | four square swatches, wide detail |
| Swiss | strict grid, side photo | numbered, two hairline columns | full width band of four |
| Gallery | tiny centred photo, huge margins | one centred list, no rules | one large photo, small swatch row |
| Index | photo band and contents list | three dense columns | grid over a detail photo |
| Dark | black band, reversed type | white on black | black divider, paper swatches |
| Blueprint | framed drawing feel | REF / ITEM / SPEC / UNIT table | annotated strips |
| Lookbook | full bleed photograph | overlay three column spec | swatches on the photo |
| Poster | enormous title | six ruled lines | full width material strips |
| Card | bordered card on paper | two by three labelled boxes | bordered chips |
| Folio | classical, centred, double rules | one long elegant list | numbered swatch list |

Palettes: copper `#A65E22`, ink `#1C1A17`, olive `#5C6B3C`, indigo `#2F3E6B`, sand `#B08A63`.

`GET /api/templates` lists them with preview images. A render accepts `templateId`. The app shows the gallery from the order screen under Design. Every design shares the same placeholders and the same data, so switching design never changes what the document says.

## Desktop app for Windows and Mac

![Desktop](docs/screenshots/desktop.png)

`desktop/` wraps the web build in Electron and packages it for both platforms. The wrapper starts an embedded server on loopback that serves the app and reverse proxies `/api`, `/files`, `/pages`, `/previews`, `/media`, `/health` and `/ready` to the API, so the window sees one origin and no rebuild or CORS setup is needed.

```bash
npm run setup
npm run desktop                      # run the wrapper in development
npm run build:mac                    # dmg and zip in desktop/release
npm run build:win                    # nsis and portable exe, best run on Windows
```

Point it at a deployed API with `CATALOG_API_URL`, or with `desktop-config.json` in the app data directory (the menu item Open server settings reveals it). Defaults to `http://localhost:8787`.

`.github/workflows/desktop.yml` builds both platforms on a tag `v*` or on demand: mac on a macOS runner, Windows on a Windows runner, with the artifacts uploaded. The mac build has been produced and launched on this machine and the packaged app was verified against a live API. Windows is built only by CI.

Builds are unsigned. Gatekeeper will warn on first open on a Mac, and SmartScreen will warn on Windows. Signing needs an Apple Developer ID and a Windows code signing certificate; both are deliberately out of scope for now.

## Language model

The studio can point itself at any OpenAI compatible model. Open Settings, Language model, and set the endpoint, the model id and the key. Save, then Test connection. The key is stored on the server and never sent back to the app, and the test shows the provider's own error text when a call fails.

![Model settings](docs/screenshots/e2e/06b-model-settings.png)

Once configured, the model writes the brochure body. Paste what the customer said into the brief, press Write the brochure copy, and the studio returns a headline, a body paragraph and a closing line built only from the order facts and that brief. The copy is stored on the order and printed into every design, then regenerated with the voucher.

![Brochure copy](docs/screenshots/e2e/06d-brochure-copy.png)

An order screen can also draft a short customer note for WhatsApp from the same data. Nothing is invented: the prompt carries the order fields, and the result is shown for review before anyone copies or prints it.

![Customer note](docs/screenshots/e2e/06c-customer-note.png)

Verified live against OpenCode Go:

| Setting | Value |
|---|---|
| Endpoint | `https://opencode.ai/zen/go/v1` |
| Model | `deepseek-v4.1-flash` |

The Go endpoint requires an `x-opencode-session` header, which the server adds automatically for OpenCode hosts. It is also a reasoning model: left alone it can spend the whole token budget thinking and return nothing, so for OpenCode hosts the request asks for a direct answer with `reasoning_effort: none`. Other providers get a plain OpenAI compatible request, so no unknown field can break them.

A real generation on this machine produced a 133 word body in 4.7 seconds, using only the order facts and the brief, and the text printed into the voucher:

![AI written body in the voucher](docs/screenshots/ai-brochure-body.png)

The standalone `https://opencode.ai/zen/v1` endpoint behaves differently: this account gets `402 Insufficient balance` on paid models there and `429 Free usage limit reached` on free ones. The studio surfaces those messages unchanged, which is what the test button is for. The offline success path also works against the bundled mock provider:

```bash
node scripts/mock-llm.mjs 8793   # then point Settings at http://127.0.0.1:8793/v1
```

Environment fallbacks are `LLM_ENDPOINT`, `LLM_MODEL` and `LLM_API_KEY`; settings saved in the studio win.

## Copy quality

The model's brochure copy is measured, not eyeballed. `scripts/ai-quality.mjs` runs six realistic orders through the live provider and scores every reply against a rubric: body between 90 and 150 words, headline and closing caps, numbers that exist in the order, no money, date or festival leaks from the brief, no talk of the order, brief or specification, no durability or cleanliness claims, no parts the order does not include, no repeated verbs, no reused example phrasing, and no walking through the materials list.

```bash
# measure the prompt directly
LLM_ENDPOINT=https://opencode.ai/zen/go/v1 LLM_MODEL=deepseek-v4.1-flash LLM_API_KEY=... \
  node scripts/ai-quality.mjs

# or measure the running product, repair pass included
node scripts/ai-quality.mjs --api http://localhost:8787
```

Final result measured through the API across six orders: **102 of 102 checks, average body 117 words, zero repair passes needed**.

The generator also protects itself in production. `copyQualityIssues` rejects a thin body, internal paperwork talk, repeated verbs, a material walk through, and any mention of the carcass or back panel. When it finds a problem it runs one corrective retry naming the exact issues, so a weak first reply does not reach the customer.

Two bodies from the final run:

> **Lighter oak for a small bedroom**
> The master bedroom carries the wardrobe across one wall, 2400 mm wide and 2100 mm high, so the floor stays clear. Warm oak laminate on the outside lifts the room, and white laminate inside keeps the shelves bright when the shutters open. Three shutters and four drawers sort daily clothes from the rest, and two of those drawers lock for papers and valuables. A loft above takes the suitcases and spare bedding out of the way.

> **Where the suitcases will live**
> Suitcases take up more room than guests do. The lower section of this wardrobe is sized for them, with two drawers beside the space for folded bedding above. At 1800 mm wide and 2100 mm high, the frame sits flush against the guest room wall without crowding the bed.

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
