# Grace Catalogue Studio, build contract

Single source of truth for the API and the data the app may rely on.

## Stack

- `server/` Node 24, ESM, Hono, `node:sqlite`, renders PDFs by shelling out to `specimen/.venv/bin/weasyprint`. No build step.
- `app/` Expo SDK 58, expo-router, TypeScript, runs on iOS, Android and web (`react-native-web`).
- `templates/` HTML templates filled by the server, then printed to PDF.
- `data/` SQLite file and generated PDFs. Created at runtime, git ignored.

## Ports

- API: `http://localhost:8787`
- Web app (Expo): `http://localhost:8081`

## Design tokens (app and templates share these)

| Token | Value | Use |
|---|---|---|
| background | `#F2F2F7` | grouped screen background |
| surface | `#FFFFFF` | cards and sheets |
| fill | `#EFEFF4` | fields and secondary buttons |
| ink | `#1C1C1E` | primary text |
| muted | `#6E6E73` | secondary text |
| faint | `#8E8E93` | captions |
| copper | `#A65E22` | tint, primary actions |
| hair | `#DCDCE2` | inset separators |

The app follows Apple's grouped interface: system font at native sizes, white
cards on a grouped grey background, one brand tint, rounded controls, no
decoration. Printed brochures keep their own editorial typography and palette;
only the application is Apple styled.
Spacing scale: 4, 8, 12, 16, 20, 28, 44.
Never use em dashes or en dashes in user facing strings. Use a comma, a colon or a middot.

## Data model

```ts
Customer { id: string; name: string; phone: string; address: string; createdAt: string }

Order {
  id: string;
  orderNo: string;          // GWI-2026-001
  customerId: string;
  customerName: string;     // joined for convenience
  title: string;            // Master Bedroom Wardrobe
  room: string;             // Master bedroom
  width: string;            // "2400 mm"
  height: string;
  depth: string;
  shutters: string;         // "3 · 800 mm"
  carcass: string;
  backPanel: string;
  shuttersMat: string;
  drawers: string;
  exterior: string;
  interior: string;
  hinges: string;
  channels: string;
  edgeShutter: string;
  edgeCarcass: string;
  edgeNote: string;
  handle: string;
  handleNote: string;
  finishExt: string;
  finishInt: string;
  status: "draft" | "approved";
  brief?: string;            // what the customer said, free text, max 2000 chars
  copy?: {                   // written by the model, null until generated
    headline: string;
    body: string;
    closing: string;
  } | null;
  createdAt: string;
}

Material {
  id: string;
  name: string;
  kind: string;
  hex: string;
  imageUrl: string | null;
  priceAmount: number;      // trade rate, 0 until set, never negative
  priceUnit: string;        // sheet, metre, panel, empty until set
  sku: string;              // GW-WAL-06, empty until set
  createdAt: string;
}

Template {
  id: string;               // atelier-copper
  name: string;             // Copper Atelier
  palette: "copper" | "ink" | "olive" | "indigo" | "sand";
  family: "atelier" | "swiss" | "gallery" | "index" | "dark"
        | "blueprint" | "lookbook" | "poster" | "card" | "folio";
  cover: string;            // cover treatment: editorial, grid, void, contents,
                            // reversed, technical, photoFirst, display, card, centred
  paletteName: string;      // Copper
  familyName: string;       // Atelier
  accent: string;           // #A65E22
  previewUrl: string;       // /previews/atelier-copper.png
  pageCount: 4;
}

Render {
  // kind is "voucher" | "kit" | "catalogue"; catalogue renders have orderId null
  id: string;
  orderId: string | null;   // null for a catalogue document such as the rate card
  kind: "voucher" | "kit" | "catalogue";
  templateId: string | null; // brochure template for a voucher, rate card id for a catalogue render
  pageCount: number;
  pdfUrl: string;           // /files/<id>.pdf
  pageUrls: string[];       // /pages/<id>/1.png ...
  createdAt: string;
}
```

## Endpoints

All responses JSON unless noted. Errors: `{ "error": "message" }` with 4xx/5xx.

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/health` | | `{ ok: true, version: "1.0.0" }` |
| GET | `/api/bootstrap` | | `{ customers, orders, materials }` |
| POST | `/api/customers` | `{ name, phone?, address? }` | `Customer` (201) |
| GET | `/api/customers` | | `Customer[]` |
| POST | `/api/orders` | order fields (see above, minus id, orderNo, status, createdAt) | `Order` (201) |
| GET | `/api/orders` | | `Order[]` |
| GET | `/api/orders/:id` | | `Order` |
| PATCH | `/api/orders/:id` | partial order fields | `Order` |
| DELETE | `/api/orders/:id` | | `{ ok: true }` |
| POST | `/api/orders/:id/ai-brochure` | `{ brief? }` | `{ render, design, copy, model, latencyMs }` (kinds `ai`) |
| POST | `/api/orders/:id/render` | `{ kind: "voucher" \| "kit", templateId? }` | `Render` (201) |
| POST | `/api/intake` | `{ messages: [{ role, content }], draft? }` | `{ reply, draft, missing, ready, model, latencyMs }` |
| POST | `/api/orders/:id/copy` | `{ brief?, regenerate? }` | `{ copy: { headline, body, closing }, model, latencyMs, cached }` |
| GET | `/api/llm/cache/stats` | | `{ enabled, ttlHours, entries, hits, oldest }` |
| POST | `/api/llm/cache/purge` | | `{ deleted }` |
| POST | `/api/orders/:id/note` | `{}` | `{ note, model, latencyMs, cached }` |
| GET | `/api/llm/settings` | | `{ endpoint, model, hasKey, source, updatedAt }` |
| PUT | `/api/llm/settings` | `{ endpoint?, model?, apiKey? }` | same shape as GET |
| POST | `/api/llm/test` | `{}` | `{ ok: true, latencyMs, model, sample }` or 502 with the provider message |
| GET | `/api/templates` | | `Template[]` (30 brochure templates) |
| GET | `/previews/:templateId.png` | | `image/png` (template thumbnail) |
| GET | `/api/renders` | | `Render[]` |
| GET | `/api/renders/:id` | | `Render` |
| GET | `/files/:name` | | `application/pdf` |
| GET | `/pages/:renderId/:n.png` | | `image/png` |
| GET | `/media/:name` | | static image |
| POST | `/api/materials` | `{ name, kind, hex, priceAmount?, priceUnit?, sku?, imageUrl? }` | `Material` (201) |
| GET | `/api/materials` | | `Material[]` |
| GET | `/api/materials/:id` | | `Material` |
| PATCH | `/api/materials/:id` | partial material fields | `Material` |
| GET | `/api/catalogue/templates` | | `{ id, name, palette, description }[]` (3 rate card variants) |
| POST | `/api/catalogue/render` | `{ templateId? }` | `Render` (201), kind `catalogue` |

`orderNo` is generated server side as `GWI-<year>-<sequence>`, zero padded to three digits.

Material trade fields are validated on write: `priceAmount` must be a finite number
greater than or equal to zero, `priceUnit` is at most 20 characters and `sku` is
at most 40 characters. The API speaks the camelCase names above; the snake_case
column names (`price_amount`, `price_unit`) are accepted too. Bootstrap and
`GET /api/materials` return the camelCase names.

`POST /api/catalogue/render` renders the trade rate card and stores the result as
a normal `Render` row with `kind: "catalogue"` and `orderId: null`. Rendering is
queued and concurrent identical rate card requests share one build, like voucher
renders.

`templateId` on `POST /api/orders/:id/render` is optional. When it is missing the
first template in the catalogue is used, so existing clients keep working. An
unknown id returns `400` and must not create a render. The field is ignored for
`kind: "kit"` and the resulting render has `templateId: null`.

## Template placeholders

Server fills one of the family documents in `templates/voucher/families/` and `templates/kit/index.html` with `{{key}}` replacement. Every placeholder in the file must be provided; an unfilled placeholder is a bug and the render must fail with a 500 and a clear message.

Voucher keys: `orderNo, title, noteHeadline, noteBody, noteClosing, date, customerName, width, height, depth, shutters, room, carcass, backPanel, shuttersMat, drawers, exterior, interior, hinges, channels, layoutLeft, layoutMiddle, layoutRight, edgeShutter, edgeCarcass, edgeNote, handle, handleNote, finishExt, finishInt, shopLine, coverImage, detailImage, insideImage, insideImage2, mat1Name, mat2Name, mat3Name, mat4Name, mat1Image, mat2Image, mat3Image, mat4Image`.

Two tokens are supplied automatically by the server for every voucher render and
are not order data: `{{paletteCss}}` (the palette CSS variables for the family
document) and `{{title}}` (the cover title, already split into at most three
fitted lines). The blueprint family also receives `widthValue`, `widthUnit`,
`heightValue`, `heightUnit`, `depthValue` and `depthUnit`: the dimension strings
split into a number and a unit for its specification table.

Catalogue tokens (rate card template only): `paletteCss, rateCardLayout,
rateCardRows, rateCardRowsMore, rateCardContinuation, rateCardCount, date,
addressLine1, addressLine2, cityLine, phone, email, shopLine`. They are supplied
automatically by the server; none of them is order data.

Kit keys: `addressLine1, addressLine2, cityLine, phone, email`.

Image paths are relative to the template directory, i.e. `../assets/company/tex-walnut.jpg`. The built HTML must sit in that same directory for these to resolve.

## Brochure templates

The voucher has 30 selectable designs: thirty complete document families, one
palette each. Every family is a different document with its own cover,
specification, finishes and inside pages; no two families share a page
structure, and a palette swap can never create a second design.

The families are: `atelier`, `swiss`, `gallery`, `index`, `dark`, `blueprint`, `lookbook`, `poster`, `card`, `folio`, `timeline`, `bluepaper`, `magazine`, `frame`, `ticket`, `axonometric`, `swatchbook`, `broadsheet`, `redline`, `collage`, `ledger`, `geometric`, `sketchbook`, `sleeve`, `envelope`, `accordion`, `split`, `specimen`, `contact`, `atlas`.

Each family is one HTML file under `templates/voucher/families/<family>.html`
with four pages. `templates/variants.json` lists the families, their palettes
and their fitted cover title boxes; a variant id is `<family>-<palette>`.

## Language model

The model is configured at runtime and stored in the `settings` table as `llm_endpoint`, `llm_model` and `llm_api_key`. Environment fallbacks are `LLM_ENDPOINT`, `LLM_MODEL` and `LLM_API_KEY`; stored values win. The key is never returned by the API and never logged.

`POST /api/orders/:id/copy` builds a prompt from the order plus the customer brief and asks for strict JSON `{ headline, body, closing }`. The reply is parsed defensively, capped, stored in `orders.copy_json`, and passed to the templates as `noteHeadline`, `noteBody` and `noteClosing`. When an order has no copy the three placeholders are empty strings and every template hides the block.


## Catalogue rate card (not exposed in the studio)

The studio app does not show the rate card while trade rates are unpublished.
The endpoint stays in the API for when they are, and the server tests keep it
working.

The trade rate card is a separate document from the thirty voucher families.
It lists every material from the materials table: SKU, material name, finish or
kind, unit and rate in INR, with a GST note. No price is calculated at render
time; each row prints the stored `priceAmount`, `priceUnit` and `sku`.

One template, `templates/catalogue/rate-card.html`, carries three complete
layouts that are switched on with a CSS class. The app picks a variant:

| Template id | Name | Palette | Layout |
|---|---|---|---|
| `rate-card-ledger` | Rate Card Ledger | copper | ledger table on warm paper, serif masthead |
| `rate-card-grid` | Rate Card Grid | ink | numbered grid with a dark header band |
| `rate-card-tags` | Rate Card Tags | olive | boxed SKU tags with large serif rates |

The first variant is the default when `templateId` is missing. A card is one A4
page with 3mm bleed for up to 8 priced materials and becomes two pages for up to
22; more materials than that are not printed. The palette tokens come from the
same tone sets used by the voucher templates.

## Conversational intake

`POST /api/intake` takes the chat transcript and the order captured so far. The reply is strict JSON `{ reply, order, ready }`; only known order fields are kept, dimensions get their unit, counts become digits, and `ready` is only true when the server sees every essential field in the merged draft. Failures are 400 for bad input, 400 when no model is configured, and 502 when the reply cannot be read.

## Uploads and attachments

`POST /api/media` takes `{ data, name?, contentType? }` with base64 data and has no
type restriction: any file is stored under `data/media` with a sidecar JSON that
keeps its original name and content type. The default body limit for other routes
does not apply to this one; the upload limit is 70 MB of JSON.

`GET /media/<name>` serves the file with its stored type. Images, PDFs and text
still open inline; everything else downloads with its original filename.

An order accepts an `attachments` array of `{ url, name, contentType, bytes }`
(max 20), and returns it on the detail endpoint. `POST /api/intake` also accepts
that array: PDF text (`pdftotext`) and text file contents are added to the prompt,
other types are named only.

Image attachments are used by the voucher: the first becomes `coverImage`, the
next two `insideImage` and `insideImage2`, and the fourth `detailImage`. Missing
slots keep the house photography. The renderer resolves these as local file URLs
so WeasyPrint embeds them in the PDF.

## Model cache

Copy and notes are cached in the `llm_cache` table, keyed by a SHA-256 of the provider endpoint, the model and every prompt message. A repeated request returns the stored reply with `cached: true` and `latencyMs: 0`, and never calls the provider. `regenerate: true` bypasses the lookup and replaces the cached entry with the new copy.

Entries expire after `LLM_CACHE_TTL_HOURS` (default 168, 0 disables). Expiry is enforced on read and expired rows are also pruned at boot. Because the prompt text is part of the key, a prompt change or a new brief can never serve stale words.

## Generated brochures

`POST /api/orders/:id/ai-brochure` accepts:

```json
{"brief":"...", "direction":"warmer and more festive", "overrides":{"tone":"teal","type":"classic","cover":"framed","story":"collage","materials":"band","spec":"cards","statement":"..."}, "copy":{"headline":"...","body":"...","closing":"..."}}
```

With no `overrides` the model returns a complete design and its copy in one
reply. With `overrides` the server keeps the latest AI design, applies only the
fields sent, and re-renders without calling the provider; `copy` is required
then. `direction` is stored on the order as `designDirection` (schema v8) and
passed to the model on later generations. The design reply shape is:

```json
{"design":{"tone":"...","type":"...","cover":"...","story":"hero|editorial|diptych|collage","materials":"grid4|filmstrip|band|museum|stacked","spec":"twoColumn|threeColumn|ledger|cards|stacked","coverPhoto":0,"storyPhoto":1,"detailPhoto":2,"statement":"..."},"copy":{"headline":"...","body":"...","closing":"..."}}
```

Allowed values are checked, photo indexes are clamped, and the copy passes the
same quality gate as the classic path. The tone selects one of five Indian
palettes (maroon, teal, copper, sandal, peacock) over warm cream stock with gold
rules, a Tamil brand line and Indian ornament (jaali border, paisley, lotus,
rangoli, temple arch). The specification page also carries a measured front elevation and plan generated from the order dimensions; the story page opens with a drop cap and the covers carry the room name in Tamil. The server compiles the design to HTML
and CSS from print safe primitives; the provider never writes markup. The
resulting render has `kind: "ai"`, `templateId: null` and a `design` object with
the composition and a human label. Designs are cached by prompt like other model
replies.

## Rendering

The family documents live in `templates/voucher/families/`, but the generated
HTML is written into `templates/voucher/` (for example
`templates/voucher/built-<renderId>.html`) so the `../assets/` and `../fonts/`
paths resolve. Do not write the built file next to the family document, the
relative paths would break. Then:

```
specimen/.venv/bin/weasyprint <html> data/renders/<renderId>.pdf
```

Page images for the app preview come from:

```
pdftoppm -png -r 96 <pdf> data/renders/<renderId>
```

Store the resulting files and return their URLs. Rendering must be serialised per
process (a simple in memory queue) so two requests cannot clash on the same
build directory. Template previews use the same queue.
