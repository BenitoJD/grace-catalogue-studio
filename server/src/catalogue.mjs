import { buildKitValues, escapeHtml, formatOrderDate } from './render.mjs';
import { paletteVariables } from './variants.mjs';

// The trade rate card is one template file with three complete layouts. The
// layouts are switched on with a body class, so the app can pick a variant
// while the print design stays in templates/catalogue/rate-card.html.
export const RATE_CARD_TEMPLATE = 'catalogue/rate-card.html';

// Rows on the first page and on the continuation page. A catalogue with more
// materials than both limits keeps only the first page and a half; the office
// catalogue is small, and the card stays inside two pages.
export const RATE_CARD_ROWS = 8;
export const RATE_CARD_CONTINUATION_ROWS = 14;

export const RATE_CARD_VARIANTS = Object.freeze([
  Object.freeze({
    id: 'rate-card-ledger',
    name: 'Rate Card Ledger',
    palette: 'copper',
    layout: 'ledger',
    description: 'Ledger table on warm paper with a serif masthead',
  }),
  Object.freeze({
    id: 'rate-card-grid',
    name: 'Rate Card Grid',
    palette: 'ink',
    layout: 'grid',
    description: 'Strict grid with a numbered rate table and a dark header band',
  }),
  Object.freeze({
    id: 'rate-card-tags',
    name: 'Rate Card Tags',
    palette: 'olive',
    layout: 'tags',
    description: 'Boxed SKU tags with large serif rates on a warm ground',
  }),
]);

const RATE_CARD_VARIANTS_BY_ID = new Map(RATE_CARD_VARIANTS.map((variant) => [variant.id, variant]));

export function rateCardCatalog() {
  return RATE_CARD_VARIANTS.map((variant) => ({
    id: variant.id,
    name: variant.name,
    palette: variant.palette,
    description: variant.description,
  }));
}

/** Resolve a requested id, or the first variant when the id is missing. */
export function resolveRateCardVariant(templateId) {
  const raw = templateId === undefined || templateId === null ? '' : String(templateId).trim();
  const id = raw === '' ? RATE_CARD_VARIANTS[0].id : raw;
  return RATE_CARD_VARIANTS_BY_ID.get(id) ?? null;
}

const RATE_FORMAT = new Intl.NumberFormat('en-IN', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

// Rates are always the stored number from the materials table, only grouped
// for reading. Nothing is calculated from a palette or an order here.
export function formatRate(amount) {
  const number = Number(amount);
  if (!Number.isFinite(number) || number < 0) return '0';
  return RATE_FORMAT.format(number);
}

function text(value) {
  return String(value ?? '').trim();
}

function rowForMaterial(material) {
  const sku = text(material?.sku) || '-';
  const name = text(material?.name) || '-';
  const kind = text(material?.kind) || '-';
  const unit = text(material?.priceUnit) || '-';
  const rate = formatRate(material?.priceAmount);
  return (
    '<tr class="rate-row">' +
    `<td class="c-sku">${escapeHtml(sku)}</td>` +
    `<td class="c-name">${escapeHtml(name)}</td>` +
    `<td class="c-kind">${escapeHtml(kind)}</td>` +
    `<td class="c-unit">${escapeHtml(unit)}</td>` +
    `<td class="c-rate">${escapeHtml(rate)}</td>` +
    '</tr>'
  );
}

function rowsMarkup(materials) {
  if (materials.length === 0) {
    return '<tr class="rate-row is-empty"><td class="c-sku">-</td>' +
      '<td class="c-name">No materials have been priced yet.</td>' +
      '<td class="c-kind">-</td><td class="c-unit">-</td><td class="c-rate">-</td></tr>';
  }
  return materials.map(rowForMaterial).join('\n');
}

/**
 * Values for one rate card render: the palette CSS, the selected layout, the
 * data rows for both pages and the shared company details.
 */
export function buildRateCardValues({ materials = [], variants, variant }) {
  const palette = variants.palettesById.get(variant.palette);
  if (!palette) throw new Error(`Unknown palette "${variant.palette}" for ${variant.id}.`);

  const primary = materials.slice(0, RATE_CARD_ROWS);
  const continuation = materials.slice(RATE_CARD_ROWS, RATE_CARD_ROWS + RATE_CARD_CONTINUATION_ROWS);
  const company = buildKitValues();

  return {
    ...company,
    paletteCss: { raw: paletteVariables(palette) },
    rateCardLayout: variant.layout,
    rateCardRows: { raw: rowsMarkup(primary) },
    rateCardRowsMore: { raw: rowsMarkup(continuation) },
    rateCardContinuation: continuation.length > 0 ? 'has-more' : 'no-more',
    rateCardCount: String(materials.length),
    date: formatOrderDate(),
  };
}
