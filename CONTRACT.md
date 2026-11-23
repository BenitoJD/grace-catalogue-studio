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
| GET | `/api/llm/providers` | | `{ providers }` catalog of OpenAI compatible presets |
| POST | `/api/customers` | `{ name, phone?, address? }` | `Customer` (201) |
| GET | `/api/customers` | | `Customer[]` |
| POST | `/api/orders` | order fields (see above, minus id, orderNo, status, createdAt) | `Order` (201) |
| GET | `/api/orders` | | `Order[]` |
| GET | `/api/orders/:id` | | `Order` |
| PATCH | `/api/orders/:id` | partial order fields | `Order` |
| DELETE | `/api/orders/:id` | | `{ ok: true }` |
| POST | `/api/orders/:id/ai-brochure` | `{ brief?, direction?, reference?, edit?, copy? }` | `{ render, design, copy, direction, model, latencyMs }` (kind `ai`) |
| POST | `/api/orders/:id/edit` | `{ message?, attachments? }` | `{ reply, order, copy, attachmentsAdded, rerender, changedOrder }` |
| GET | `/api/designs` | | `{ designs, expected, building, ready, previewsReady, previewsTotal, previewsBuilding }` (100 model written references, each with `previewUrl` and `previewPdfUrl` when printed) |
| GET | `/design-previews/:id.(png|pdf)` | | `image/png` or `application/pdf` (printed proof of one reference) |
| POST | `/api/orders/:id/render` | `{ kind: "voucher" \| "kit", templateId? }` | `Render` (201) |
| POST | `/api/intake` | `{ messages: [{ role, content }], draft? }` | `{ reply, draft, missing, ready, model, latencyMs }` |
| POST | `/api/orders/:id/copy` | `{ brief?, regenerate? }` | `{ copy: { headline, body, closing }, model, latencyMs, cached }` |
| GET | `/api/llm/cache/stats` | | `{ enabled, ttlHours, entries, hits, oldest }` |
| POST | `/api/llm/cache/purge` | | `{ deleted }` |
| POST | `/api/orders/:id/note` | `{}` | `{ note, model, latencyMs, cached }` |
| GET | `/api/llm/settings` | | `{ endpoint, model, hasKey, source, updatedAt }` |
| PUT | `/api/llm/settings` | `{ endpoint?, model?, apiKey? }` | same shape as GET |
| POST | `/api/llm/test` | `{}` | `{ ok: true, latencyMs, model, sample }` or 502 with the provider message |
| GET | `/api/templates` | | `Template[]` (classic house layouts) |
| GET | `/previews/:templateId.png` | | `image/png` (classic layout thumbnail) |
| GET | `/api/renders` | | `Render[]` |
| GET | `/api/renders/:id` | | `Render` |
| GET | `/files/:name` | | `application/pdf` |
| GET | `/pages/:renderId/:n.png` | | `image/png` |
| GET | `/media/:name` | | static image |
| POST | `/api/materials` | `{ name, kind, hex, priceAmount?, priceUnit?, sku?, imageUrl? }` | `Material` (201) |
| GET | `/api/materials` | | `Material[]` (internal finishes catalogue, no app screen) |
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

The brochure has no fixed template. The template system is a library of one
hundred design references, and the model writes every one of them: each
reference is an id, a name, a family, a mood, a summary, a full eight colour
palette, a display face, a cover idea and a house ornament. The gallery and the
chat strip read them from `GET /api/designs`; the brochure designer takes the
chosen reference as words and mood and composes fresh pages for the order, so a
reference is never printed itself.

The library is generated in four volumes of twenty five and stored in the
`design_catalog` table (schema v10) after every volume, so the first request
starts a background build and returns whatever is ready with
`{ designs, expected: 100, building, ready }`. A later request with a complete
library never calls the provider again.

Once the library is complete the same request starts the preview engine, which
prints a real four page brochure per reference from one fixed sample order and
serves its cover at `/design-previews/<id>.png` with the full proof at
`/design-previews/<id>.pdf`. One shared sample copy is written once and kept in
the catalog row (schema v11); each preview runs the designer prompt with its
reference, must pass the same print checks as a customer brochure, and is
recorded with `previewReady` on success. Only finished previews are served.

The classic house layouts remain underneath for the voucher and kit paths: ten
complete document families with their own cover, specification, finishes and
inside pages live in `templates/voucher/families/`, catalogued in
`templates/variants.json` with three palettes each. They are not shown in the
studio brochure flow.

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
{"brief":"...", "direction":"warmer and more festive", "reference":"temple-quiet", "edit":"make the cover calmer", "copy":{"headline":"...","body":"...","closing":"..."}}
```

All fields are optional. `brief` replaces the stored brief, `direction` is kept
on the order as `designDirection` (schema v8), `reference` must be an id from
`GET /api/designs`, `edit` carries a studio sentence to the designer with the
previous document attached, and a hand edited `copy` wins over generated words.
When the order has no stored copy the server writes one first through the usual
copy route with its repair pass.

The model authors the four pages itself as one HTML document: exactly four
`<div class="page">` elements, the required tokens, no external URL, no script,
no fixed positioning, and the page box left to the server. The reply is
checked: page count, word limits per page, every specification and material
token printed, the measured drawing on the specification page, the brand and a
Tamil line on the cover, a house motif somewhere, photographs used, and no
unknown token. A failure is asked for again with the exact problems listed;
two failures return 502 `invalid_reply` and print nothing. Filled tokens are
escaped except raw asset and image paths; em dashes and en dashes are
normalised to hyphens before print. The document is stored on the render as
`html` (schema v9) so the next edit keeps the design. The resulting render has
`kind: "ai"`, `templateId: null` and a `design` object with
`{ label, designed, direction, reference, referenceName }`.

`POST /api/orders/:id/edit` maps a plain sentence to changed order fields and
copy with `rerender` and `changedOrder` flags. It also accepts an `attachments`
array in the same validated shape as order creation: new files are appended to
the order by URL with duplicates ignored, the merged list past twenty files
rejects the edit with 400, and any addition forces a re-render so the next
brochure prints the new images. Either a sentence or at least one file is
required. Design sentences leave order and
copy empty and set `rerender` true; the same sentence then reaches the designer
through the `edit` field, which replays the stored document and changes only
what was asked.

## Network egress

The server installs a guard at boot: outbound fetch is limited to the configured
model provider origin and loopback. `CATALOG_ALLOWED_EGRESS_ORIGINS` is a comma
separated allowlist for any future integration. The desktop print windows block
HTTP(S) requests entirely. Templates must not reference remote assets; a test
enforces that.

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
