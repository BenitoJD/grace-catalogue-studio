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
| paper | `#FFFFFF` | page background |
| ink | `#14100C` | primary text |
| muted | `#6E6259` | secondary text |
| faint | `#A2938A` | captions, footer |
| copper | `#A65E22` | accents, section labels |
| hair | `#E6DED2` | hairlines |

Type: display serif (`Georgia` on iOS and web, `serif` on Android), body sans (system).
Spacing scale: 4, 8, 12, 16, 24, 32, 48.
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
| POST | `/api/orders/:id/render` | `{ kind: "voucher" \| "kit", templateId? }` | `Render` (201) |
| POST | `/api/orders/:id/copy` | `{ brief?, regenerate? }` | `{ copy: { headline, body, closing }, model, latencyMs }` |
| POST | `/api/orders/:id/note` | `{}` | `{ note, model, latencyMs }` |
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

The voucher has 30 selectable designs: ten complete document families, each with
its own cover, specification, finishes and inside pages, crossed with three
palettes per family. Families are not permutations of one layout: each one has
its own page structure, typography treatment and page furniture.

- `atelier`: editorial paper cover, labelled specification tables, four up finish grid, large inside photograph.
- `swiss`: grotesque grid with numbered sections 01 02 03, hairline key value lists, a full width swatch band, full bleed inside page.
- `gallery`: near empty pages with huge margins, small centred text, one photograph per page, a single centred specification column and no rules.
- `index`: dense trade catalogue, small type, a three column specification, a coded finishes grid, cover with a photo band and a printed contents list.
- `dark`: ink black cover and black section dividers, a reversed white on black specification page, light hairlines.
- `blueprint`: technical drawing furniture, grid paper, tick marks, dimension lines, a specification table with a units column, annotated finish strips.
- `lookbook`: full bleed photography on every page, text in corners over the images, a compressed overlay specification.
- `poster`: one enormous title with almost nothing else, a six line specification, finishes as plain strips.
- `card`: modular bordered cards, specification split into labelled boxes, finishes as bordered chips, cover built as one card on paper.
- `folio`: classical folio with wide margins, centred title, small caps, thin double rules, one elegant specification list, numbered swatches.

Palettes: `copper` (`#A65E22`), `ink` (`#1C1A17`), `olive` (`#5C6B3C`),
`indigo` (`#2F3E6B`), `sand` (`#B08A63`).

Canonical assignment: atelier copper, ink, sand; swiss ink, indigo, olive;
gallery copper, olive, indigo; index copper, olive, sand; dark ink, indigo,
sand; blueprint ink, indigo, olive; lookbook copper, sand, indigo; poster ink,
sand, olive; card copper, indigo, olive; folio copper, ink, sand. The first
catalogue entry, `atelier-copper`, is the default when no `templateId` is sent.

The catalogue is data, not files: `templates/variants.json` lists the palettes,
the families and the 30 variants. One HTML file per family lives in
`templates/voucher/families/<family>.html` and contains all four pages. The
palette arrives through CSS variables; it is never a duplicated document.

The cover title is the order `title`, split at word boundaries into at most
three lines and sized to fit, so long titles shrink instead of clipping. The
cover and the signature line show the customer name in sentence case.

Thumbnails are page one at 96 dpi, cached at `data/previews/<templateId>.png`
and served from `/previews/<templateId>.png`. They are generated once per
template from a fixed sample order: in the background on boot, lazily when a
missing preview is requested, or eagerly with
`npm --prefix server run previews` (add `-- --force` to rebuild all 30).

## Language model

The model is configured at runtime and stored in the `settings` table as `llm_endpoint`, `llm_model` and `llm_api_key`. Environment fallbacks are `LLM_ENDPOINT`, `LLM_MODEL` and `LLM_API_KEY`; stored values win. The key is never returned by the API and never logged.

`POST /api/orders/:id/copy` builds a prompt from the order plus the customer brief and asks for strict JSON `{ headline, body, closing }`. The reply is parsed defensively, capped, stored in `orders.copy_json`, and passed to the templates as `noteHeadline`, `noteBody` and `noteClosing`. When an order has no copy the three placeholders are empty strings and every template hides the block.


## Catalogue rate card

The trade rate card is a fourth document, separate from the ten voucher families.
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
