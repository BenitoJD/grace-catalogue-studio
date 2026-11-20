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
  createdAt: string;
}

Material { id: string; name: string; kind: string; hex: string; imageUrl: string | null; createdAt: string }

Template {
  id: string;               // copper-full-bleed
  name: string;             // Copper Full Bleed
  palette: "copper" | "ink" | "olive" | "indigo" | "sand";
  cover: "fullBleed" | "splitRight" | "splitLeft" | "bandTop" | "typeOnly" | "centred";
  paletteName: string;      // Copper
  coverName: string;        // Full Bleed
  accent: string;           // #A65E22
  previewUrl: string;       // /previews/copper-full-bleed.png
  pageCount: 4;
}

Render {
  id: string;
  orderId: string;
  kind: "voucher" | "kit";
  templateId: string | null; // brochure template used for a voucher, null for a kit
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
| GET | `/api/templates` | | `Template[]` (30 brochure templates) |
| GET | `/previews/:templateId.png` | | `image/png` (template thumbnail) |
| GET | `/api/renders` | | `Render[]` |
| GET | `/api/renders/:id` | | `Render` |
| GET | `/files/:name` | | `application/pdf` |
| GET | `/pages/:renderId/:n.png` | | `image/png` |
| GET | `/media/:name` | | static image |
| POST | `/api/materials` | `{ name, kind, hex }` | `Material` (201) |

`orderNo` is generated server side as `GWI-<year>-<sequence>`, zero padded to three digits.

`templateId` on `POST /api/orders/:id/render` is optional. When it is missing the
first template in the catalogue is used, so existing clients keep working. An
unknown id returns `400` and must not create a render. The field is ignored for
`kind: "kit"` and the resulting render has `templateId: null`.

## Template placeholders

Server fills `templates/voucher/index.html` and `templates/kit/index.html` with `{{key}}` replacement. Every placeholder in the file must be provided; an unfilled placeholder is a bug and the render must fail with a 500 and a clear message.

Voucher keys: `orderNo, title, date, customerName, width, height, depth, shutters, room, carcass, backPanel, shuttersMat, drawers, exterior, interior, hinges, channels, layoutLeft, layoutMiddle, layoutRight, edgeShutter, edgeCarcass, edgeNote, handle, handleNote, finishExt, finishInt, shopLine, coverImage, detailImage, insideImage, insideImage2, mat1Name, mat2Name, mat3Name, mat4Name, mat1Image, mat2Image, mat3Image, mat4Image`.

Variant tokens `paletteCss`, `coverBlock` and `typeScaleCss` are supplied
automatically by the server for every voucher render. They are not order data.

Kit keys: `addressLine1, addressLine2, cityLine, phone, email`.

Image paths are relative to the template directory, i.e. `../assets/company/tex-walnut.jpg`. The built HTML must sit in that same directory for these to resolve.

## Brochure templates

The voucher has 30 selectable designs: six cover layouts crossed with five
palettes. They are data, not files. `templates/variants.json` lists the
palettes, the cover layouts and the 30 variants; the single base template
`templates/voucher/index.html` renders all of them from CSS variables and a
generated cover block (`{{paletteCss}}`, `{{typeScaleCss}}`, `{{coverBlock}}`).

Cover layouts: `fullBleed`, `splitRight`, `splitLeft`, `bandTop`, `typeOnly`,
`centred`.
Palettes: `copper` (`#A65E22`), `ink` (`#1C1A17`), `olive` (`#5C6B3C`),
`indigo` (`#2F3E6B`), `sand` (`#B08A63`).

Every variant is a real four page voucher: cover, specification, finishes,
inside. Only page one changes with the cover layout, palette and type scale;
pages two to four are the same document with the palette accent colour.

The cover title is the order `title`, split at word boundaries into at most
three lines and sized to fit, so long titles shrink instead of clipping. The
cover and the signature line show the customer name in sentence case.

Thumbnails are page one at 96 dpi, cached at `data/previews/<templateId>.png`
and served from `/previews/<templateId>.png`. They are generated once per
template from a fixed sample order: in the background on boot, lazily when a
missing preview is requested, or eagerly with
`npm --prefix server run previews` (add `-- --force` to rebuild all 30).

## Rendering

Generated HTML is written directly into the template directory (for example `templates/voucher/built-<renderId>.html`) so the `../assets/` and `../fonts/` paths in the template resolve. Do not write it into a sub directory, the relative paths would break. Then:

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
