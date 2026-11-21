# Authoring a voucher family

A family is one complete four page A4 brochure, in one fixed palette. The studio
ships thirty families and every one must look like a different document, not a
recolour of another. This file is the contract for making a new one.

## Where things live

| What | Where |
|---|---|
| Family html | `templates/voucher/families/<family-id>.html` |
| Shared assets | `templates/assets/` referenced as `../assets/...` |
| Fonts | `templates/fonts/brand.css` |
| Palette variables | `{{paletteCss}}` injected into `:root` |
| Fitted cover title markup | `{{title}}` injected as a sized block |

## Page geometry

Every page is A4 with 3 mm bleed: `.page` is `216mm x 303mm`, `.sheet` is the
`210mm x 297mm` trim area at `left:3mm; top:3mm`. Four `.page` divs exactly.
`@page { size: 216mm 303mm; margin: 0; }` and the last page has no page break.

## The four pages

1. **Cover**: logo (`../assets/grace-logo.png`), title (`{{title}}`), `{{orderNo}}`,
   `{{date}}`, `{{room}}`, `{{customerName}}`, a photograph from `{{coverImage}}`.
2. **Specification**: every order fact, laid out in this family's own structure:
   `room, width, height, depth, shutters, carcass, backPanel, shuttersMat, drawers,
   exterior, interior, hinges, channels, layoutLeft, layoutMiddle, layoutRight,
   edgeShutter, edgeCarcass, edgeNote, handle, handleNote, finishExt, finishInt,
   customerName, orderNo`.
3. **Finishes**: `mat1Name, mat1Image, mat2Name, mat2Image, mat3Name, mat3Image,
   mat4Name, mat4Image`, one photograph `{{detailImage}}`, and `finishExt`,
   `finishInt`.
4. **Inside**: two photographs `{{insideImage}}` and `{{insideImage2}}`, a
   statement line of the family's own, `{{shopLine}}`, `{{orderNo}}`.

Use only these placeholders, the palette variables and the fonts. No external
URLs, no JavaScript, no new font files.

## Palette variables

`var(--accent)`, `--accent-on-dark`, `--accent-soft`, `--paper`, `--cover-paper`,
`--ink`, `--muted`, `--faint`, `--hair`, `--on-dark`, `--dark`. Never hardcode a
brand colour; take every colour from these variables so a palette change is one
line.

Fonts: `font-family:'Instrument Serif', Georgia, serif` for display,
`'Barlow', Helvetica, Arial, sans-serif` for text, `"Noto Sans Tamil"` is in the
stack for names. Print sizes are small: body text 5.5 to 8pt, micro labels 4.5 to
6pt, cover title is injected at its fitted size.

## The model written copy

The server fills three optional blocks. Each placeholder must sit inside its own
element carrying the class, and the family must include this rule so a voucher
without copy is identical to one with it:

```css
.copy-headline:empty, .copy-body:empty, .copy-closing:empty { display: none; }
```

```html
<div class="copy copy-headline">{{noteHeadline}}</div>
<div class="copy copy-body">{{noteBody}}</div>
<div class="copy copy-closing">{{noteClosing}}</div>
```

Place them where they help this family: headline near the cover title, body on
the finishes or inside page, closing near the inside statement. Keep the boxes
wide enough for 150 words of body copy at 6 to 6.5pt.

## Check it

```bash
node scripts/check-family.mjs --file templates/voucher/families/<id>.html \
  --palette copper --title '{"widthMm":174,"availableHeightMm":46,"maxSizePt":46,"lineHeight":0.98}'
```

It fills the family with a fixture order, renders with WeasyPrint, fails on any
leftover placeholder or page count other than four, and writes page images to
`/tmp/family-check/<id>/page-1.png` to `page-4.png`. Open them and look. Text
that overlaps, runs off the trim, or repeats the same layout as another family is
a bug. Adjust and run again until it passes and reads well.

Choose the title box like this: `widthMm` is the cover title column width,
`availableHeightMm` the height it may use, `maxSizePt` the largest display size.
A huge poster title gets `maxSizePt` 60 to 80, a small editorial title 30 to 40.

## Rules

- One family, one palette, one variant. Never place the same layout in two
  palettes and call it two designs.
- Every family must be structurally different from the other families: different
  cover composition, different specification layout, different finishes treatment,
  different inside page. A different accent colour is not a different design.
- The specification must be readable, not decorative: the customer has to find
  width, material and handle quickly.
- Never let text overflow its page or collide with an image.
- Keep the family self contained: one html file, shared assets only.
