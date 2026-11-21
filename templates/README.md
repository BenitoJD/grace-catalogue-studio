# Voucher template families

The voucher has ten complete document families, each a full four page document
(cover, specification, finishes, inside) under `voucher/families/`. The thirty
catalogue entries are those families crossed with three palettes each. Palette
tokens arrive through `{{paletteCss}}`; the family file is never duplicated.

## Optional brochure copy

Three placeholders carry the generated brochure copy. They arrive as plain text
and are empty strings when no copy has been generated.

| Placeholder | Content | Limits | Pages |
|---|---|---|---|
| `{{noteHeadline}}` | one line near the document title | 80 characters | cover |
| `{{noteBody}}` | short paragraph in the family body style | 1200 characters, 1000 tested | cover or specification or finishes, see below |
| `{{noteClosing}}` | single line at the foot of the last page | 140 characters | inside (page 4) |

The names must not change and each file uses each token exactly once. The
server replaces them as escaped text and supplies empty strings by default.

Empty blocks collapse with `:empty { display: none }`, so a voucher without copy
renders pixel identical to the same voucher before this feature existed. Do not
attach always visible borders, rules or labels to a copy block: they would
survive the empty state and show as stray marks. Copy blocks are absolutely
positioned, so a filled block never reflows the existing composition.

## Where the blocks sit

| Family | Headline | Body | Closing |
|---|---|---|---|
| atelier | cover, above the title, left aligned | specification page, right of the heading | page 4 foot, right aligned |
| swiss | cover, under the title block, full width | cover, lower half above the footer rule | page 4 foot |
| gallery | cover, above the centered title | cover, centered under the title above the photo | page 4 foot, centered |
| index | cover, between the title and the meta row | specification page, full width band under the columns | page 4 foot |
| dark | cover, above the title on the ink field | specification page, full width band under the columns | page 4 foot |
| blueprint | cover, under the title above the elevation label | specification page, full width band under the table | page 4 foot |
| lookbook | cover, lower third over the photograph | cover, top right corner panel over the photograph | page 4 foot |
| poster | cover, between the rule and the name | cover, lower band above the photo strip | page 4 foot, centered |
| card | cover, above the photograph | finishes page, full width band under the detail card | page 4 foot |
| folio | cover, between the title and the accent rule | finishes page, full width band above the double rules | page 4 foot, centered |

## Checking copy placement

The server test suite covers empty and supplied copy, the four page count and the
maximum 1000 character body. Previews are page one thumbnails generated with no
copy, so they only need regenerating when the visible design changes. The copy
blocks are invisible in the empty state, so adding copy support alone does not
require a preview refresh.

## Catalogue rate card

`catalogue/rate-card.html` is the trade rate card, a fourth document separate
from the voucher families. It lists every material from the materials table with
its SKU, name, finish or kind, unit and stored rate in INR, and adds a GST note.

The file holds three complete layouts, switched on with a body class. The server
picks one variant and passes the palette variables with `{{paletteCss}}`, so the
same palette tokens as the vouchers drive the card.

| Template id | Layout | Palette |
|---|---|---|
| `rate-card-ledger` | ledger table on warm paper, serif masthead | copper |
| `rate-card-grid` | numbered grid with a dark rate header band | ink |
| `rate-card-tags` | boxed SKU tags with large serif rates | olive |

Tokens used by this template: `paletteCss`, `rateCardLayout`, `rateCardRows`,
`rateCardRowsMore`, `rateCardContinuation`, `rateCardCount`, `date`,
`addressLine1`, `addressLine2`, `cityLine`, `phone`, `email`, `shopLine`.

The card is one A4 page for up to 8 priced materials and two pages for up to 22.
Rows beyond the second page capacity are not printed, so keep the priced
material catalogue at 22 items or fewer. Rates are printed exactly as stored;
nothing is calculated at render time. The GST line is a static note.
