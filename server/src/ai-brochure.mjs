// The brochure designer.
//
// There is no fixed template in this path. The model receives the order, the
// photographs, the finish samples, the approved copy and the brand kit, and it
// authors the four printed pages itself as HTML and CSS. The server only
// supplies the print box, the fonts, the assets and the data through tokens,
// then checks the document before anything is rendered.
//
// Why the strict checks: the brochure is printed by Chromium and WeasyPrint, so
// the document must stay local, printable and complete. A model reply that
// misses a fact, points at the internet, overflows the page or forgets the copy
// is rejected and asked for again with the exact problems listed.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { LlmError, clean } from './llm.mjs';
import { buildVoucherValues, escapeHtml, paletteStripPng } from './render.mjs';
import { colourName } from './image-palette.mjs';
import { brandPlateTokens } from './brand-lockup.mjs';
import { contrastIssues as pageContrastIssues } from './contrast.mjs';

// Quality first: a generous explicit cap. Omitting max_tokens lets some
// providers fall back to a small default and truncate the HTML.
export const DESIGNER_MAX_TOKENS = 32000;
export const DESIGNER_TEMPERATURE = 0.85;
export const DESIGNER_TRIES = 4;
export const DESIGNER_MAX_CHARS = 90_000;

const BRAND = {
  name: 'Jacob Design Studio',
  tamil: 'ஜேக்கப் டிசைன் ஸ்டுடியோ',
  placeTamil: 'நாகர்கோவில்',
  phone: '+91 63740 43346',
  email: 'info.jacobdesignstudio@gmail.com',
  address: '26J Rajjakamangalam Road, Chettikulam, Nagercoil 629001',
};

const PALETTE = {
  paper: '#F8F2E7',
  ink: '#1E2528',
  deep: '#173B44',
  accent: '#1AA3C8',
  gold: '#B98A55',
  hair: '#DED3C1',
  muted: '#5E6A6C',
  onDark: '#F8F2E7',
};

// Assets live beside the built HTML in templates/voucher, so relative paths are
// the safe form for both Chromium and WeasyPrint.
const ASSETS = {
  logo: '../assets/jacob-mark.png',
  logoWhite: '../assets/jacob-mark-white.png',
  jaali: '../assets/indian/jaali.svg',
  paisley: '../assets/indian/paisley.svg',
  lotus: '../assets/indian/lotus.svg',
  rangoli: '../assets/indian/rangoli.svg',
  arch: '../assets/indian/temple-arch.svg',
};

const MOTIF_TOKENS = ['jaali', 'paisley', 'lotus', 'rangoli', 'arch'];

// Every spec value the specification page must carry. Missing ones are marked
// "To be confirmed" instead of being guessed.
const FACT_TOKENS = [
  'width',
  'height',
  'depth',
  'shutters',
  'exterior',
  'interior',
  'carcass',
  'backPanel',
  'shuttersMat',
  'drawers',
  'edgeShutter',
  'edgeCarcass',
  'edgeNote',
  'finishExt',
  'finishInt',
  'handle',
  'handleNote',
  'hinges',
  'channels',
];

const COPY_TOKENS = ['headline', 'body', 'closing'];
const MATERIAL_TOKENS = [1, 2, 3, 4].flatMap((index) => [
  `material${index}Name`,
  `material${index}Image`,
]);

const IDENTITY_TOKENS = [
  'brand',
  'brandTamil',
  'placeTamil',
  'phone',
  'email',
  'address',
  'orderNo',
  'date',
  'title',
  'room',
  'roomTamil',
  'customer',
];

const RAW_TOKENS = new Set([
  'logo',
  'logoWhite',
  'brandPlateDark',
  'brandPlateLight',
  'contactPlateDark',
  'contactPlateLight',
  'jaali',
  'paisley',
  'lotus',
  'rangoli',
  'arch',
]);

const DESIGNER_SYSTEM = [
  'You are the art director, typographer and print designer for Jacob Design Studio, a wardrobe and furniture workshop in Nagercoil, Tamil Nadu.',
  'You design and typeset one printed brochure for one order. Reply with one complete HTML document and nothing else.',
  '',
  'THE DOCUMENT',
  'An A4 brochure printed on warm cream uncoated paper. The page box is 216 mm wide by 303 mm tall and includes a 3 mm bleed on every side, so the trim is 210 by 297 mm.',
  'It is picture led, quiet, warm and confident, the kind of book a customer keeps on the table. Indian taste: generous margins, large type, deep colour and muted gold against cream, Tamil and English together, ornament used like jewellery, never a poster and never a website.',
  'This brochure is about COLOUR, not measurements. There is no size, no dimension and no technical schedule in it. The photographs and their colour palettes are the subject. The model never prints a width, height, depth, shutter count or hardware list.',
  'The brochure is as long as its content: at least four pages, and as many more as the content and pictures need. More photographs and their palettes earn more pages. Fill every page completely.',
  '',
  'THE PAGES, IN ORDER',
  '1. Cover. One commanding photograph, the brand, the piece title, the customer and the room. Almost nothing else. The photograph does the work.',
  '2 to 7. Story, colour options and details. The written copy set like an editorial spread: the headline as the one large line, the body in calm columns, the closing line small and quiet, with one or two photographs. At least one page is the colour options page, laid out like a showroom paint card: for each photograph its colour strip, then four swatch chips, each with its NAME in caps, its hex value small, and one short line about the mood. Extra photographs earn extra pages, and every photograph must appear. Another page carries the feature callouts: a loupe on a named detail with a short caption, the way a car brochure points at a headlamp or a seam.',
  'Give one spread the premium brand treatment: a single photograph at full page, one real magnifier loupe on the joinery detail with its colour name and code, and almost nothing else on the page.',
  'Last. A quiet closing page for the client file: the brand mark, the order number, the telephone and one line of thanks. No dimensions and no specification table.',
  '',
  'HOW TO REPLY',
  '- Reply with the HTML document only: no prose, no markdown, no code fences, no explanation.',
  '- The <head> may hold one <style> block. Inline style attributes are welcome.',
  '- The <body> must hold between four and eight page elements in order: <div class="page"> ... </div>. Nothing else beside them.',
  '- The renderer supplies the page box, the bleed, the fonts and the colour tokens. Do not define @page, @import or @font-face, do not write html or body rules, and do not set width, height, position, margin or page-break on .page.',
  '- Position inside a page with absolute mm offsets, or with flex or grid. Keep type and decoration at least 18 mm from the left and right edges and 18 mm from the top, and keep the bottom 18 mm clear for the folio unless a photograph bleeds.',
  '- Use mm for print sizes. Never use vh or vw for type or position.',
  '- No external URLs, scripts, forms, videos, iframes, links, remote fonts or remote images. Use only the supplied tokens and assets.',
  '- One page must be exactly one printed page. Nothing may be clipped off the edge of the paper.',
  '',
  'THE TOKENS',
  'Write these tokens exactly. The renderer replaces them with the real words and files before printing. Never print a token twice, never retype its content in your own words, and never leave a token unused where the list says it is required.',
  'Copy: {{headline}}, {{body}} and {{closing}}. Set each exactly once, as given. They are the only long words in the document.',
  'The body is one piece of prose: set it in a comfortable measure, two or three columns at 8 to 9.5 pt, and let the paragraph flow. Do not cut it.',
  'Identity: {{brand}}, {{brandTamil}}, {{placeTamil}}, {{date}}, {{title}}, {{room}}, {{roomTamil}}, {{customer}}, {{phone}}, {{email}}, {{address}}. Never print an order number.',
  'Photographs: {{photo1}} and upward are ready to use as a CSS background-image or an <img> source. Crop with cover. Choose the strongest photograph for the cover.',
  'Colour: every photograph has a palette strip {{photo1Palette}}, {{photo2Palette}} and so on, a ready made image of its colours. It also has single colours {{photo1Color1}} to {{photo1Color4}}, and their showroom names {{photo1Color1Name}} to {{photo1Color4Name}}, and so on for every photograph. Use the named colours as paint card chips, with the hex value small underneath.',
  'Magnifier plates: {{photo1detail1}}, {{photo1detail2}} and {{photo1detail3}} are real enlarged crops of that photograph, taken from the joinery detail, plus the same tokens for every photograph. Each plate has its colour {{photo1detail1Color}} and its name {{photo1detail1ColorName}}. Place one on a hero photograph as a circular loupe: a thin ring, a short leader line, and the caption naming the colour and its code. These plates are already magnified, so never fake a loupe with background-size and never crop a plate again.',
  'Assets: {{logo}} is the brand mark for light backgrounds and {{logoWhite}} is the same mark in white for dark backgrounds. {{brandPlateLight}} and {{brandPlateDark}} are ready made brand panels: the mark and the brand name on their own solid ground, light and dark. {{contactPlateLight}} and {{contactPlateDark}} add the phone, email and address. Because each plate carries its own background, it stays legible on any page. {{jaali}}, {{paisley}}, {{lotus}}, {{rangoli}} and {{arch}} are the house motifs.',
  'The brand and the contact details must always read clearly. Put a brand plate on the cover and a brand plate plus a contact plate on the closing page. Use the light plate on cream pages and the dark plate on dark, colour or photographic pages. Never set the contact lines straight over a photograph.',
  '',
  'REQUIRED',
  '- Page 1, the cover: at least one photograph, {{title}}, {{customer}}, a brand plate {{brandPlateDark}} or {{brandPlateLight}}, and {{brandTamil}} or {{roomTamil}}.',
  '- The brand is always legible: {{logoWhite}} on a dark, colour or photographic field, {{logo}} on cream or a light field. Never set either mark straight on a busy photograph without a solid panel or scrim behind it, and never tint or recolour a mark.',
  '- The closing page carries a brand plate and a contact plate {{contactPlateLight}} or {{contactPlateDark}}. Those panels keep the company name, phone, email and address readable whatever the page background is.',
  '- {{headline}}, {{body}} and {{closing}} each exactly once, anywhere in the story pages.',
  '- Every photograph token from {{photo1}} to the last available must appear at least once.',
  '- Every palette strip token must appear at least once, on the colour pages. Next to each strip print its four colours as paint card chips, each using its colour token and its colour NAME token, with its hex value small. This is the colour options spread of the showroom book.',
  '- At least one magnifier plate {{photoNdetailM}}, inside a circular loupe on a hero photograph, with its {{photoNdetailMColorName}} and {{photoNdetailMColor}} in the caption.',
  '- The last page: a large brand plate and a contact plate. Never print an order number.',
  '- Somewhere in the document: at least one house motif token.',
  '- No dimension, size, shutter count or specification value may appear. Those tokens do not exist and naming them rejects the document.',
  '- The photographs are the design source. Mirror their colours, light and warmth. The pages must look like they belong to the same project as the pictures.',
  '- Feature callouts, as in a showroom brochure: magnify details (a handle, a grain, a colour palette, an edge) with a circular loupe. Use the same photograph enlarged: background-size 300% to 420%, background-position set to the detail, a thin ring, a short leader line and a small caption naming the detail. Point the loupe at the joinery: a handle, a shutter edge, a panel joint, an edge band, a shelf line, a change of finish. Never magnify the floor, the ceiling, a fan, a light fitting or a plain wall. Show one loupe per named detail and never a loupe without a caption. Every caption names the colour inside that loupe, using the photograph colour names, for example Walnut, the handle. The studio will name the details; if it has not, choose the details the photographs make obvious, and let the loupe show a named colour.',
  '- When the studio asks for a colour palette callout, print the palette strip or its four chips beside a loupe of the pictured detail, with the mood name underneath.',
  '',
  'THE QUALITY BAR',
  'This must look like the printed book a Fortune 500 automotive or luxury interiors brand hands to a customer: art directed, composed, quiet, confident. If a page could have come from a Canva template, a restaurant menu or a website, it is wrong.',
  'Use a real editorial grid: one 12 column grid with a consistent 18 mm outer margin and an 8 mm gutter, and align every element to it. Set a type scale and keep it: cover display 44 to 64 pt, section titles 20 to 26 pt, body 8.4 to 9.5 pt with 1.55 line height, captions 6.4 to 7 pt with 0.2 em tracking, folio 6.4 pt.',
  'Give every page a clear job and a different composition. Vary full bleed photograph pages, a two thirds split page, a quiet type page, a colour plate page and the magnifier spread. Never repeat the same arrangement twice in one document.',
  'The cover brand plate is a hero: at least 55 mm wide, preferably 60 to 100 mm, set with real space around it. A tiny corner plate is wrong.',
  'Colour callouts on photographs follow the paint card reference: a small ring or dot on the exact point, a thin dashed leader line, and the colour code and name set at the end of the line in small caps. Keep the callout text clear of busy detail and never cover the thing it points at.',
  'The cover is a designed photograph, not a template: full bleed image or a strong 2:3 split, an oversized title reacting to the image, the brand plate placed with intent, and nothing centered by default. Use a kicker, a hairline and one line of quiet information. No logo, title, photo and footer stack.',
  'Treat typography like a brand book: one display face, one text face, real hierarchy, generous leading, ragged right body, small caps labels with wide tracking, oversized folio numbers, and no more than three type sizes on a page.',
  'Compose with negative space, hairlines and the palette. Only three colour families on a page. Gold is a one point rule, a numeral or a motif, never a fill. No gradients, no drop shadows, no rounded cards, no badges, no clip art icons, no emoji, no chevrons, no buttons.',
  'Photographs are the hero: crop with intent, let them bleed, and use a solid scrim or band for any words that sit on them. Never make a photograph small and polite unless the page is deliberately quiet.',
  'Magnifier spread: the loupe is a designed object, not a sticker. Make it large: 55 to 75 mm across, zoomed 3.5 to 5 times, with a crisp 0.5 mm ring and a 0.2 mm inner hairline, a 45 degree leader line to the caption, and a soft solid ground behind the caption. The caption names the detail and its colour and code, in 7 to 8 pt small caps with 0.2 em tracking. It must be clearly readable: light caption on a dark ground or dark caption on a light ground, never words drifting over a busy photograph.',
  'Colour page: treat the palette like paint chips in an automotive book. Strips at full measure, chips aligned in a row on the grid, names in small caps, codes small and quiet, one line of mood copy. No card frames and no shadows.',
  'The closing page is a quiet exhale: brand plate, contact plate, one line of thanks, a motif if it belongs. Nothing else.',
  '',
  'DESIGN RULES',
  '- Print design, not web design. No cards, rounded corners, drop shadows, buttons, icons, badges, glass, or gradients except a soft photograph scrim.',
  '- One dominant ground, one ink, one accent. Gold is a line, a number or a motif, never a large fill. A deep colour may carry a band or a whole page. Never set body text in gold on cream.',
  '- Contrast is absolute: dark text on a light ground, light text on a dark ground. A pale page never gets pale text and a dark band never gets dark text.',
  '- Any text over a photograph or a dark picture must sit inside a band, panel or scrim that carries its own near-opaque background colour inline, with the opposite text colour on it. Never set light words straight on a photo.',
  '- Put the background colour inline on the element or on an ancestor element, not only in a class, so the contrast check can verify it. It is checked before printing and low contrast is rejected.',
  '- Build a real typographic hierarchy: one display line, small caps labels with wide tracking, hairline rules, captions, folio numbers. Use white space as a material.',
  '- Compose each page. Vary alignment, scale and the position of the photograph. The cover should not be the generic centred logo, title, framed photo and footer stack; react to the photograph instead. Try type across the image low, a tall split, a masthead, an arch, an asymmetric page with a deep quiet margin.',
  '- Never set light text straight on a photograph unless it sits on a dark scrim, a solid band or a genuinely quiet dark area of the picture. The renderer can not see how bright the photograph is, so assume it is pale.',
  '- Colour strips are images, not pale samples: frame each one with a hairline rule or a keyline so it reads as a colour plate.',
  '- Tamil is set tight and whole: never letter-space, uppercase or small-cap a Tamil line, and never set it below 7.5 pt. Keep Tamil in a line of its own.',
  '- The mark in the body is a small quiet sign, 8 to 14 mm wide, set in a corner or a footer, never a large graphic, never a watermark and never behind or over a title. Large marks belong only on the cover and closing plates.',
  '- Ornament once or twice in the whole document, at a corner or a rule: a jaali strip along one edge, a lotus under a title, an arch around a photograph. Never all motifs on one page.',
  '- The cover is the loudest page, the story is the warmest, and the colour pages are a quiet chromatic study.',
  '- Use the whole safe area. Every page must feel complete: fill it with photograph, type and colour at full size rather than leaving a quarter of it empty. If the content does not fill the pages, use fewer pages; if it overflows, add a page up to the limit of eight. Keep the last line of a page at least 18 mm above the trim.',
  '- This brochure is one of many. Do not repeat a stock arrangement; the photographs, their colours and the room decide the composition.',
  '- Tamil lines are set in Noto Sans Tamil, never forced into an English serif.',
  '',
  'AVAILABLE TYPE',
  "'Instrument Serif' for display and headline, 'Barlow' for labels, captions and small text, 'Noto Sans Tamil' for Tamil.",
  'Colours come as CSS variables already set from the picture palettes: --paper, --ink, --deep, --accent, --gold, --hair, --muted, --on-dark. Use these, and if you refine them keep them inside the same family, so the printed book carries the colour of the actual project rather than a house style. Keep the paper light and the ink dark.',
  '',
  'VOICE OF THE PAGES',
  'Words are very few. The cover says almost nothing. The story carries the copy. The colour options name the paints. The detail page points at what is beautifully made. A reader should feel the room and its colours before reading a sentence. This is a showroom book, not a catalogue and not a specification sheet.',
].join('\n');

const TAMIL_ROOMS = [
  ['guest', 'விருந்தினர் அறை'],
  ['master', 'முதன்மை படுக்கையறை'],
  ['bed', 'படுக்கையறை'],
  ['kitchen', 'சமையலறை'],
  ['dining', 'உணவறை'],
  ['study', 'படிப்பறை'],
  ['living', 'வரவேற்பறை'],
  ['pooja', 'பூஜை அறை'],
  ['kids', 'குழந்தைகள் அறை'],
  ['wardrobe', 'ஆடை அலமாரி'],
  ['storage', 'சேமிப்பு அலமாரி'],
];

function tamilRoom(values) {
  const haystack = `${values.room ?? ''} ${values.title ?? ''}`.toLowerCase();
  const found = TAMIL_ROOMS.find(([key]) => haystack.includes(key));
  return found ? found[1] : 'தளவாடங்கள்';
}

function priceNumber(text) {
  const match = String(text ?? '').replace(/,/g, '').match(/\d+(?:\.\d+)?/);
  return match ? Number.parseFloat(match[0]) : null;
}

/** A measured front elevation and plan for the specification page. */
function elevationSvg(values) {
  const known = ['width', 'height', 'depth'].every((key) => priceNumber(values[key]) !== null);
  if (!known) {
    const width = 700;
    const height = 240;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" fill="none">
      <rect x="8" y="8" width="${width - 16}" height="${height - 16}" stroke="#C9A26A" stroke-width="2" stroke-dasharray="8 6"/>
      <text x="${width / 2}" y="${height / 2 - 12}" text-anchor="middle" font-family="Georgia, serif" font-size="22" fill="#4A1116">Measured drawing</text>
      <text x="${width / 2}" y="${height / 2 + 22}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="15" letter-spacing="2" fill="#7C2A22">Issued after the site measurement</text>
      <text x="${width / 2}" y="${height / 2 + 50}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="12" letter-spacing="1" fill="#6B4A3E">No dimension is guessed</text>
    </svg>`;
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
  }

  const width = priceNumber(values.width);
  const height = priceNumber(values.height);
  const depth = priceNumber(values.depth);
  const shutters = Math.min(6, Math.max(1, Math.round(priceNumber(values.shutters) || 2)));
  const boxW = 118;
  const boxH = 96;
  const scale = Math.min(boxW / width, boxH / height);
  const w = width * scale;
  const h = height * scale;
  const x0 = 30;
  const y0 = 14;
  const ink = '#3A2415';
  const gold = '#B4863F';
  const lines = [];
  lines.push(`<rect x="${x0}" y="${y0}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="none" stroke="${ink}" stroke-width="1.1"/>`);
  for (let index = 1; index < shutters; index += 1) {
    const x = x0 + (w / shutters) * index;
    lines.push(`<line x1="${x.toFixed(1)}" y1="${y0}" x2="${x.toFixed(1)}" y2="${(y0 + h).toFixed(1)}" stroke="${ink}" stroke-width="0.8"/>`);
    lines.push(`<line x1="${(x - 4).toFixed(1)}" y1="${(y0 + h * 0.42).toFixed(1)}" x2="${(x - 4).toFixed(1)}" y2="${(y0 + h * 0.58).toFixed(1)}" stroke="${gold}" stroke-width="1.6"/>`);
  }
  lines.push(`<line x1="${x0}" y1="${(y0 + h + 10).toFixed(1)}" x2="${(x0 + w).toFixed(1)}" y2="${(y0 + h + 10).toFixed(1)}" stroke="${gold}" stroke-width="0.7"/>`);
  lines.push(`<line x1="${x0}" y1="${(y0 + h + 7).toFixed(1)}" x2="${x0}" y2="${(y0 + h + 13).toFixed(1)}" stroke="${gold}" stroke-width="0.7"/>`);
  lines.push(`<line x1="${(x0 + w).toFixed(1)}" y1="${(y0 + h + 7).toFixed(1)}" x2="${(x0 + w).toFixed(1)}" y2="${(y0 + h + 13).toFixed(1)}" stroke="${gold}" stroke-width="0.7"/>`);
  lines.push(`<text x="${(x0 + w / 2).toFixed(1)}" y="${(y0 + h + 19).toFixed(1)}" text-anchor="middle" font-family="Barlow" font-size="7" letter-spacing="1" fill="${ink}">${Math.round(width)}</text>`);
  lines.push(`<line x1="${x0 - 10}" y1="${y0}" x2="${x0 - 10}" y2="${(y0 + h).toFixed(1)}" stroke="${gold}" stroke-width="0.7"/>`);
  lines.push(`<line x1="${x0 - 13}" y1="${y0}" x2="${x0 - 7}" y2="${y0}" stroke="${gold}" stroke-width="0.7"/>`);
  lines.push(`<line x1="${x0 - 13}" y1="${(y0 + h).toFixed(1)}" x2="${x0 - 7}" y2="${(y0 + h).toFixed(1)}" stroke="${gold}" stroke-width="0.7"/>`);
  lines.push(`<text x="${x0 - 15}" y="${(y0 + h / 2).toFixed(1)}" text-anchor="middle" font-family="Barlow" font-size="7" letter-spacing="1" fill="${ink}" transform="rotate(-90 ${x0 - 15} ${(y0 + h / 2).toFixed(1)})">${Math.round(height)}</text>`);
  const planW = 118;
  const planD = Math.max(12, depth * scale);
  const px = x0 + w + 26;
  const py = y0 + 18;
  lines.push(`<text x="${px}" y="${(py - 8).toFixed(1)}" font-family="Barlow" font-size="6" letter-spacing="2" fill="${gold}">PLAN</text>`);
  lines.push(`<rect x="${px}" y="${py.toFixed(1)}" width="${planW}" height="${planD.toFixed(1)}" fill="none" stroke="${ink}" stroke-width="1"/>`);
  lines.push(`<line x1="${px}" y1="${(py + planD / 2).toFixed(1)}" x2="${(px + planW).toFixed(1)}" y2="${(py + planD / 2).toFixed(1)}" stroke="${ink}" stroke-width="0.5" stroke-dasharray="2 2"/>`);
  lines.push(`<text x="${(px + planW / 2).toFixed(1)}" y="${(py + planD + 9).toFixed(1)}" text-anchor="middle" font-family="Barlow" font-size="6.5" letter-spacing="1" fill="${ink}">${Math.round(depth)} deep</text>`);
  lines.push(`<text x="${px}" y="${(py + planD + 22).toFixed(1)}" font-family="Barlow" font-size="6" letter-spacing="1.5" fill="${gold}">ELEVATION</text>`);
  lines.push(`<text x="${px}" y="${(py + planD + 31).toFixed(1)}" font-family="Barlow" font-size="6" letter-spacing="1" fill="${ink}">${shutters} shutters, floor to ceiling</text>`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 260 150" fill="none">${lines.join('')}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/**
 * Neutral sample plates for the preview engine only. The product never prints
 * stock photography: customer brochures require uploaded photographs. These
 * generated plates let the preview engine exercise layout, tokens and checks
 * without depicting anybody's room.
 */
// Flat colour plates as tiny raster data URIs. Raster embeds print
// everywhere raster printing runs (WeasyPrint and Chromium alike); inline SVG
// backgrounds do not survive every print engine.
const PLATE_PNGS = [
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFUlEQVR4nGN8/+QSAzbAhFV00EoAABLhArW7x5F9AAAAAElFTkSuQmCC',
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFUlEQVR4nGN8fusIAzbAhFV00EoAAPoYApW52hX1AAAAAElFTkSuQmCC',
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFUlEQVR4nGP89PIGAzbAhFV00EoAAB2yAsNUcZoGAAAAAElFTkSuQmCC',
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFUlEQVR4nGN8cm0fAzbAhFV00EoAAPANAojqm4THAAAAAElFTkSuQmCC',
];

export function samplePhotoPlates() {
  return PLATE_PNGS.map((png) => `data:image/png;base64,${png}`);
}

// ---------------------------------------------------------------------------
// Photograph profiles
// ---------------------------------------------------------------------------

function imageSize(buffer) {
  if (buffer.length > 24 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset < buffer.length - 9) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      const length = buffer.readUInt16BE(offset + 2);
      if (length < 2) break;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
      }
      offset += 2 + length;
    }
  }
  if (buffer.length > 30 && buffer.slice(8, 12).toString('ascii') === 'WEBP') {
    const type = buffer.slice(12, 16).toString('ascii');
    if (type === 'VP8 ') {
      return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
    }
    if (type === 'VP8L') {
      const bits = buffer.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (type === 'VP8X') {
      return { width: buffer.readUIntLE(24, 3) + 1, height: buffer.readUIntLE(27, 3) + 1 };
    }
  }
  return null;
}

function localPathFor(url, templatesDir) {
  if (typeof url !== 'string' || url === '') return null;
  if (url.startsWith('data:')) return null;
  if (url.startsWith('file://')) {
    try {
      return fileURLToPath(url);
    } catch {
      return null;
    }
  }
  return path.join(templatesDir, url);
}

/**
 * Read the shape of each photograph so the model can choose a portrait for the
 * cover and a landscape for a spread. Any bytes are readable: failures are
 * ignored and the photo is described as unmeasured.
 */
export function photoProfiles(photoUrls, templatesDir) {
  return photoUrls.map((url) => {
    const filePath = localPathFor(url, templatesDir);
    if (!filePath) return '';
    try {
      const stat = readFileSync(filePath);
      const size = imageSize(stat.length > 65536 ? stat.subarray(0, 65536) : stat);
      if (!size || !size.width || !size.height) return 'shape not measured';
      const ratio = size.width / size.height;
      const orientation = ratio > 1.08 ? 'landscape' : ratio < 0.92 ? 'portrait' : 'square';
      return `${size.width} by ${size.height} px, ${orientation}`;
    } catch {
      return 'shape not measured';
    }
  });
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function copySummary(copy) {
  const headline = clean(copy?.headline);
  const body = clean(copy?.body);
  const closing = clean(copy?.closing);
  const words = body === '' ? 0 : body.split(/\s+/).filter(Boolean).length;
  return `Headline ${headline.length} characters. Body ${words} words. Closing ${closing.length} characters.`;
}

function designContext({ order, brief, direction, copy, photos, photoShapes, photoPalettes, pictureReading, pictureAnalysis, annotations = [], previousHtml, editNote }) {
  const photoLines = photos.map((_, index) => {
    const shape = photoShapes[index] ? ` (${photoShapes[index]})` : '';
    return `photo${index + 1}${shape}`;
  });
  const parts = [
    'ORDER',
    `Title: {{title}}`,
    `Room: {{room}}`,
    `Customer: {{customer}}`,
    `Order number: not printed`,
    `Date: {{date}}`,
    '',
    'PHOTOGRAPHS AVAILABLE',
    photoLines.length > 0 ? photoLines.join('\n') : 'No photographs supplied.',
    '',
    'WHAT THE PICTURES SHOW',
    pictureReading && String(pictureReading).trim() !== ''
      ? String(pictureReading).trim()
      : 'No reading supplied; take the piece, the room and the colours from the order and the palettes.',
    '',
    'STUDIO MARKED DETAILS',
    Array.isArray(annotations) && annotations.length > 0
      ? annotations
          .map(
            (mark) =>
              `${mark.photo}: focus ${mark.x}% across, ${mark.y}% down, detail "${mark.label}", colour ${mark.colourName} ${mark.colourHex}. Use exactly this name and code in the loupe caption.`,
          )
          .join('\n')
      : 'None marked; choose details yourself.',
    '',
    'PICTURE BY PICTURE',
    Array.isArray(pictureAnalysis) && pictureAnalysis.length > 0
      ? pictureAnalysis
          .map((picture) => {
            const lines = [`${picture.photo}: ${picture.summary || `${picture.piece} in the ${picture.room}`}.`];
            if (picture.colours?.length) lines.push(`colours seen: ${picture.colours.join(', ')}.`);
            if (picture.details?.length) lines.push(`details worth magnifying: ${picture.details.join(', ')}.`);
            return lines.join(' ');
          })
          .join('\n')
      : 'No picture by picture analysis supplied.',
    '',
    'Use this reading: choose the cover photograph and the spreads from what each picture shows, and name the magnifier captions after the details listed here.',
    'COLOURS FROM THE PICTURES',
    Object.entries(photoPalettes ?? {}).length > 0
      ? Object.entries(photoPalettes)
          .map(([token, palette]) => `${token} palette: ${palette.join(', ')}`)
          .join('\n')
      : 'No palette could be read; derive tones from the pictures and keep them warm.',
    '',
    'COPY TO SET',
    copySummary(copy),
    '',
    'SPECIFICATION VALUES TO PRINT ON PAGE 4',
    'Width {{width}} | Height {{height}} | Depth {{depth}} | Shutters {{shutters}}',
    'Shutter face {{exterior}} | Interior {{interior}} | Carcass {{carcass}} | Back panel {{backPanel}}',
    'Shutter material {{shuttersMat}} | Drawers {{drawers}}',
    'Edge band shutters {{edgeShutter}} | Edge band carcass {{edgeCarcass}} | Edge note {{edgeNote}}',
    'Finish exterior {{finishExt}} | Finish interior {{finishInt}}',
    'Handle {{handle}} | Handle note {{handleNote}} | Hinges {{hinges}} | Channels {{channels}}',
    '',
    'MATERIAL SAMPLES',
    'Sample 1 {{material1Image}} {{material1Name}}',
    'Sample 2 {{material2Image}} {{material2Name}}',
    'Sample 3 {{material3Image}} {{material3Name}}',
    'Sample 4 {{material4Image}} {{material4Name}}',
    '',
    `Customer brief, use only for mood: ${clean(brief) || '(none supplied)'}`,
    `Studio direction for this brochure: ${clean(direction) || '(none given; choose what suits the piece)'}`,
  ];
  if (editNote) {
    parts.push('', 'THE STUDIO IS CHANGING AN EXISTING BROCHURE', `Instruction: ${clean(editNote)}`);
    parts.push('Apply only this change. Keep the design, type, palette and every other page as they are unless the instruction asks for a new look. The current document is the assistant message above.');
  } else {
    parts.push('', 'Design this brochure now. Reply with the complete HTML document only.');
  }
  return parts.join('\n');
}

export const POLISH_SYSTEM = [
  'You are an award winning print art director for luxury automotive and interiors brand books. You do not add content. You art direct.',
  'You receive one brochure as complete HTML authored by a designer. Raise it to the standard of a Fortune 500 showroom book: stronger cover composition, a real grid, one clear hierarchy, better page rhythm, more confident whitespace, photographs treated as heroes, refined captions and folios, and quieter, more precise detail.',
  'Keep every token, every required element, the page count and all print rules exactly as they are. Change only composition, typography, spacing and colour usage inside the page. Do not add new tokens, do not remove tokens, do not add external URLs, scripts or fonts, and do not change the page box.',
  'Return the complete revised HTML document only, with no prose and no code fences. If the document is already at the standard, return it unchanged.',
].join(' ');

/** Messages for the art direction pass over the designer's own document. */
export const QA_SYSTEM = [
  'You are the print production director and art director checking one brochure before it goes to press.',
  'Check the document twice mentally: first for alignment and geometry, second for anything that feels AI generated or template made.',
  'Alignment: every element sits on one grid, the outer 18 mm margins are respected, left and right edges align across a spread, captions align to their photographs, gutters are equal, spacing follows one scale, nothing sits within 12 mm of the trim, folios sit at the same place on every page.',
  'AI tells to remove: centered generic stacks, repeated equal blocks, gradients, drop shadows, rounded cards, emoji, invented icons or inline SVG, clip art, filler motifs, uneven spacing, mixed type sizes, decorative labels with no meaning, generic marketing sentences.',
  'Fix every issue you find. Keep all tokens, the page count and every print rule exactly. Do not add tokens or external assets. Return the complete revised HTML only, no prose and no code fences.',
].join(' ');

export function buildQaMessages({ html, pass = 1 }) {
  return [
    { role: 'system', content: QA_SYSTEM },
    {
      role: 'user',
      content: `Pass ${pass}: check alignment and remove any AI generated feel. Return the complete revised HTML only.\n\n${html}`,
    },
  ];
}

export function buildPolishMessages({ html }) {
  return [
    { role: 'system', content: POLISH_SYSTEM },
    {
      role: 'user',
      content: `Art direct this brochure to Fortune 500 showroom quality. Keep all tokens and constraints. Return the complete revised HTML only.\n\n${html}`,
    },
  ];
}

export function buildDesignerMessages({ order, brief = '', direction = '', copy, photos = [], photoShapes = [], photoPalettes = {}, pictureReading = '', pictureAnalysis = [], annotations = [], previousHtml = '', editNote = '' }) {
  const user = designContext({ order, brief, direction, copy, photos, photoShapes, photoPalettes, pictureReading, pictureAnalysis, annotations, previousHtml, editNote });
  const messages = [
    { role: 'system', content: DESIGNER_SYSTEM },
    { role: 'user', content: user },
  ];
  if (editNote && clean(previousHtml) !== '') {
    messages.push({ role: 'assistant', content: previousHtml });
    messages.push({ role: 'user', content: 'Apply the instruction above and reply with the complete corrected HTML document only.' });
    return messages;
  }
  return messages;
}

export function buildDesignerRepairMessages(messages, previous, issues) {
  const problems = Array.isArray(issues)
    ? issues
    : [String(issues ?? 'the document could not be printed').replace(/^The brochure design failed the print checks: /, '')];
  const repaired = [...messages];
  if (previous) repaired.push({ role: 'assistant', content: String(previous).slice(0, 40_000) });
  repaired.push({
    role: 'user',
    content: [
      `That document was rejected by the print checks: ${problems.join('; ')}.`,
      'Reply with the complete corrected HTML document only. Keep the design and fix exactly these problems.',
      'The body still needs at least four <div class="page"> elements, as many as the content needs, the required tokens, and no external references.',
    ].join(' '),
  });
  return repaired;
}

// ---------------------------------------------------------------------------
// Parsing and validation
// ---------------------------------------------------------------------------

const FORBIDDEN_MARKUP = [
  /<script\b/i,
  /<iframe\b/i,
  /<object\b/i,
  /<embed\b/i,
  /<form\b/i,
  /<input\b/i,
  /<video\b/i,
  /<audio\b/i,
  /<link\b/i,
  /<base\b/i,
  /<a\s/i,
  /javascript:/i,
  /https?:\/\//i,
  /@import/i,
  /@font-face/i,
  /@page/i,
  /position\s*:\s*fixed/i,
  /expression\s*\(/i,
];

function countToken(text, token) {
  const pattern = new RegExp(`\\{\\{\\s*${token}\\s*\\}\\}`, 'g');
  return (text.match(pattern) ?? []).length;
}

function pageSegments(bodyHtml) {
  const starts = [
    ...bodyHtml.matchAll(/<(?:div|section)\b[^>]*\bclass\s*=\s*(["'])[^"']*\bpage\b[^"']*\1[^>]*>/gi),
  ];
  if (starts.length === 0) return [];
  const segments = [];
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    const from = start.index + start[0].length;
    const to = index + 1 < starts.length ? starts[index + 1].index : bodyHtml.length;
    let segment = bodyHtml.slice(from, to).trim();
    // Drop the closing tag of the page wrapper itself. Inner markup keeps its
    // own closing tags.
    segment = segment.replace(/<\/(?:div|section)>\s*$/i, '').trim();
    segments.push(segment);
  }
  return segments;
}

/**
 * The cover photograph must lead the page, not hide in a corner. A photo
 * counts as prominent when it is an <img> tag, or when its own tag carries at
 * least 80 mm of width or 120 mm of height in its style: full bleed, split,
 * framed and masthead covers all clear that bar, a thumbnail does not.
 */
function coverPhotoProminent(coverHtml) {
  const tags = coverHtml.match(/<\w+\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    if (!/\{\{\s*photo\d+\s*\}\}/.test(tag)) continue;
    if (/^<img\b/i.test(tag)) return true;
    const width = /(?:^|[^a-z-])width\s*:\s*([0-9]+(?:\.[0-9]+)?)\s*mm/i.exec(tag);
    if (width && Number.parseFloat(width[1]) >= 80) return true;
    const height = /(?:^|[^a-z-])height\s*:\s*([0-9]+(?:\.[0-9]+)?)\s*mm/i.exec(tag);
    if (height && Number.parseFloat(height[1]) >= 120) return true;
  }
  return false;
}

function visibleText(html) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function wordCount(text) {
  if (!text) return 0;
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Estimate the words a page will actually print. A token is not one word on
 * paper: the body fills a column, names and titles fill a line. Without this
 * a story page carrying only {{body}} looks empty to the checks while it
 * prints a full column.
 */
function printedWords(html) {
  const expanded = String(html)
    .replace(/\{\{\s*body\s*\}\}/g, ' word'.repeat(110))
    .replace(/\{\{\s*[A-Za-z0-9_]+\s*\}\}/g, 'word word word');
  return wordCount(visibleText(expanded));
}

function tokenList(html) {
  return new Set([...html.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((match) => match[1]));
}

// The brochure grows with its content: a quiet order is four pages, a full one
// up to eight. The first page is always the cover and the last always the
// specification; everything between is story and materials.
export const MIN_DESIGN_PAGES = 4;
export const MAX_DESIGN_PAGES = 64;
const COVER_WORD_LIMIT = 60;
const MIDDLE_WORD_LIMIT = 280;
const SPEC_WORD_LIMIT = 300;

/**
 * Read the model's HTML reply. Returns the CSS and the four page bodies, or
 * throws an LlmError describing every problem that stops the document from
 * printing. The page wrappers are removed and rebuilt by the server, so the
 * body can never end up with content beside the pages.
 */
export function parseDesignerReply(content, photoCount = 4, palettePhotos = [], theme = PALETTE, markedDetails = []) {
  const raw = typeof content === 'string' ? content : '';
  if (raw.trim() === '') {
    throw new LlmError('The model returned an empty brochure design.', { type: 'invalid_reply' });
  }
  if (raw.length > DESIGNER_MAX_CHARS) {
    throw new LlmError('The brochure design came back far too long to print.', { type: 'invalid_reply' });
  }
  const styleBlocks = [...raw.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((match) => match[1]);
  const styles = styleBlocks.join('\n').trim();
  const withoutStyles = raw.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
  const bodyMatch = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(withoutStyles);
  const bodyHtml = bodyMatch ? bodyMatch[1] : withoutStyles;

  if (/<head\b/i.test(bodyHtml) && !/<body\b/i.test(withoutStyles)) {
    throw new LlmError('The brochure design was not a complete HTML document.', { type: 'invalid_reply' });
  }

  const pages = pageSegments(bodyHtml);
  const issues = [];
  if (pages.length < MIN_DESIGN_PAGES || pages.length > MAX_DESIGN_PAGES) {
    issues.push(`it has ${pages.length} pages; use at least four pages, and as many as the content needs`);
  }
  const last = pages.length - 1;
  const middle = pages.slice(1, last);

  const coverWords = printedWords(pages[0] ?? '');
  if (coverWords > COVER_WORD_LIMIT) {
    issues.push(`the cover carries too many words (${coverWords}, the limit is ${COVER_WORD_LIMIT})`);
  }
  for (const [offset, page] of middle.entries()) {
    const words = printedWords(page);
    if (words > MIDDLE_WORD_LIMIT) {
      issues.push(`page ${offset + 2} carries too many words (${words}, the limit is ${MIDDLE_WORD_LIMIT})`);
    }
  }
  if (pages.length > 0) {
    const specWords = printedWords(pages[last]);
    if (specWords > SPEC_WORD_LIMIT) {
      issues.push(`the specification page carries too many words (${specWords}, the limit is ${SPEC_WORD_LIMIT})`);
    }
  }
  for (const [index, page] of pages.entries()) {
    if (printedWords(page) < 3) {
      issues.push(`page ${index + 1} is almost empty`);
    }
  }

  const whole = pages.join('\n');
  for (const pattern of FORBIDDEN_MARKUP) {
    if (pattern.test(styles) || pattern.test(whole)) {
      issues.push(`it contains something that can not be printed (${pattern.source})`);
    }
  }
  if (/\.page\s*\{[^}]*(width|height|position|margin|page-break)/i.test(styles)) {
    issues.push('the style block changes the page box');
  }
  if (/(^|\})\s*(html|body)\s*[,{]/i.test(styles)) {
    issues.push('the style block styles html or body');
  }

  const tokens = tokenList(whole);
  const known = new Set([
    ...COPY_TOKENS,
    ...IDENTITY_TOKENS,
    ...MOTIF_TOKENS,
    'logo',
    'logoWhite',
    'brandPlateDark',
    'brandPlateLight',
    'contactPlateDark',
    'contactPlateLight',
    ...[...Array(Math.max(1, photoCount)).keys()].flatMap((index) => {
      const n = index + 1;
      const tokensForPhoto = [`photo${n}`];
      if (palettePhotos.includes(n)) {
        tokensForPhoto.push(`photo${n}Palette`);
        for (let chip = 1; chip <= 4; chip += 1) {
          tokensForPhoto.push(`photo${n}Color${chip}`);
          tokensForPhoto.push(`photo${n}Color${chip}Name`);
        }
        for (let detail = 1; detail <= 3; detail += 1) {
          tokensForPhoto.push(`photo${n}detail${detail}`);
          tokensForPhoto.push(`photo${n}detail${detail}Color`);
          tokensForPhoto.push(`photo${n}detail${detail}ColorName`);
        }
      }
      return tokensForPhoto;
    }),
  ]);
  const unknown = [...tokens].filter((token) => !known.has(token));
  if (unknown.length > 0) {
    issues.push(`it uses tokens that do not exist (${unknown.join(', ')})`);
  }

  for (const token of COPY_TOKENS) {
    const uses = countToken(whole, token);
    if (uses !== 1) issues.push(`{{${token}}} must appear exactly once (it appears ${uses} times)`);
  }
  if (countToken(whole, 'phone') === 0) issues.push('the contact token {{phone}} is missing');
  if (!MOTIF_TOKENS.some((token) => countToken(whole, token) > 0)) {
    issues.push('no house motif is used');
  }
  if (countToken(whole, 'title') === 0) issues.push('the title token {{title}} is missing');
  if (countToken(whole, 'customer') === 0) issues.push('the customer token {{customer}} is missing');
  if (countToken(whole, 'brandTamil') + countToken(whole, 'roomTamil') === 0) {
    issues.push('no Tamil line is used');
  }
  const brandMarkCount =
    countToken(whole, 'logo') +
    countToken(whole, 'logoWhite') +
    countToken(whole, 'brandPlateDark') +
    countToken(whole, 'brandPlateLight');
  if (brandMarkCount === 0) {
    issues.push('the brand is missing; use a brand plate or the logo');
  }

  const photoUses = [...tokens].filter((token) => /^photo\d+$/.test(token));
  if (photoUses.length === 0) issues.push('no photograph is used');
  for (const token of photoUses) {
    const index = Number.parseInt(token.slice(5), 10);
    if (index < 1 || index > photoCount) issues.push(`{{${token}}} points at a photograph that does not exist`);
  }
  // No uploaded picture may be ignored: the client's project is the pictures.
  for (let index = 1; index <= photoCount; index += 1) {
    if (!tokens.has(`photo${index}`)) {
      issues.push(`{{photo${index}}} is supplied but never used; every photograph must appear`);
    }
  }

  // The hero magnifier: a real enlarged crop of a picture, with the colour it
  // holds named beside it. Premium brand treatment, always present.
  const detailUses = [...tokens].filter((token) => /^photo\d+detail\d+$/.test(token));
  if (detailUses.length === 0) {
    issues.push('no magnifier plate is used; print one {{photoNdetailM}} as the hero detail');
  }
  for (const detailToken of detailUses) {
    if (countToken(whole, `${detailToken}ColorName`) === 0) {
      issues.push(`{{${detailToken}ColorName}} is missing; name the colour in the magnifier caption`);
    }
    if (countToken(whole, `${detailToken}Color`) === 0) {
      issues.push(`{{${detailToken}Color}} is missing; print the colour code beside the magnifier`);
    }
  }

  // The colour study is the heart of this brochure: every decoded palette must
  // be printed, with its chips.
  for (const index of palettePhotos) {
    if (!tokens.has(`photo${index}Palette`)) {
      issues.push(`{{photo${index}Palette}} is missing; every photograph colour strip must be printed`);
    }
    for (let chip = 1; chip <= 4; chip += 1) {
      if (countToken(whole, `photo${index}Color${chip}`) === 0) {
        issues.push(`{{photo${index}Color${chip}}} is missing; print the four colours beside the strip`);
      }
      if (countToken(whole, `photo${index}Color${chip}Name`) === 0) {
        issues.push(`{{photo${index}Color${chip}Name}} is missing; name every colour like a showroom paint card`);
      }
    }
  }

  // The studio marked these areas by hand: their exact labels and colour codes
  // must appear in print, not a paraphrase.
  if (Array.isArray(markedDetails)) {
    for (const mark of markedDetails) {
      if (!mark || typeof mark !== 'object') continue;
      const hex = String(mark.colourHex ?? '').toUpperCase();
      const name = String(mark.colourName ?? '').trim();
      const label = String(mark.label ?? '').trim();
      if (hex !== '' && !whole.toUpperCase().includes(hex)) {
        issues.push(`the marked detail "${label}" must print its colour code ${hex}`);
      }
      if (name !== '' && !whole.toLowerCase().includes(name.toLowerCase())) {
        issues.push(`the marked detail "${label}" must print its colour name ${name}`);
      }
    }
  }

  if (pages.length > 0) {
    const plate = /<img[^>]*src="\{\{brandPlate(?:Dark|Light)\}\}"[^>]*>/i.exec(pages[0]);
    const plateWidth = plate ? /width\s*:\s*([0-9.]+)mm/i.exec(plate[0]) : null;
    if (plate && (!plateWidth || Number.parseFloat(plateWidth[1]) < 50)) {
      issues.push('the cover brand plate is too small; make the logo prominent at 55 to 100 mm wide');
    }
  }

  // The cover display type must stay in the brand book scale, so it can never
  // be clipped by the page box (44 to 64 pt is the brief).
  pages.forEach((page, index) => {
    for (const size of String(page).matchAll(/font-size\s*:\s*([0-9.]+)pt/gi)) {
      const points = Number.parseFloat(size[1]);
      if (Number.isFinite(points) && points > 72) {
        issues.push(
          `page ${index + 1}: text at ${points} pt is larger than the print scale; keep display type at 44 to 64 pt so nothing clips`,
        );
      }
    }
  });

  const middleHtml = middle.join('\n');
  if (pages.length > 0) {
    if (!/photo\d+/.test(pages[0]) && !/\{\{photo/i.test(pages[0])) {
      issues.push('the cover has no photograph');
    } else if (!coverPhotoProminent(pages[0])) {
      issues.push('the cover photograph is too small to lead the page; give it at least 80 mm of width');
    }
    for (const token of ['title', 'customer']) {
      if (countToken(pages[0], token) === 0) issues.push(`the cover is missing {{${token}}}`);
    }
    if (countToken(pages[0], 'brandPlateDark') + countToken(pages[0], 'brandPlateLight') === 0) {
      issues.push('the cover is missing a brand plate; the mark and name must read on any background');
    }
    if (countToken(pages[0], 'brandTamil') + countToken(pages[0], 'roomTamil') === 0) {
      issues.push('the cover has no Tamil line');
    }
  }
  if (middle.length > 0) {
    for (const token of COPY_TOKENS) {
      if (countToken(middleHtml, token) === 0) issues.push(`the story is missing {{${token}}}`);
    }
    if (
      countToken(middleHtml, 'logo') +
        countToken(middleHtml, 'logoWhite') +
        countToken(middleHtml, 'brandPlateDark') +
        countToken(middleHtml, 'brandPlateLight') ===
      0
    ) {
      issues.push('the brochure body carries no brand mark');
    }
    for (const [offset, page] of middle.entries()) {
      if (!/photo\d+/.test(page) && !/photo\d+Palette/.test(page)) {
        issues.push(`page ${offset + 2} shows neither a photograph nor a colour strip`);
      }
    }
  }
  if (pages.length > 0) {
    for (const token of COPY_TOKENS) {
      if (countToken(pages[0], token) > 0) issues.push(`{{${token}}} belongs in the story, not on the cover`);
    }
    const lastHtml = pages[last];
    if (countToken(lastHtml, 'brandPlateDark') + countToken(lastHtml, 'brandPlateLight') === 0) {
      issues.push('the closing page is missing a brand plate');
    }
    if (countToken(lastHtml, 'contactPlateDark') + countToken(lastHtml, 'contactPlateLight') === 0) {
      issues.push('the closing page is missing a contact plate; company details must stay readable');
    }
    for (const token of COPY_TOKENS) {
      if (countToken(lastHtml, token) > 0) issues.push(`{{${token}}} belongs in the story, not the closing page`);
    }
    for (const index of palettePhotos) {
      if (countToken(pages[last], `photo${index}Palette`) > 0) {
        issues.push('the photograph colour strip belongs on a colour page, not the closing page');
      }
    }
  }

  pages.forEach((page, index) => {
    if (/background-image\s*:\s*url\(\s*{{\s*photo/i.test(page) && /{{\s*photo\d+detail\d+Color/i.test(page)) {
      if (!/background\s*:\s*(?:#|rgba?\()/i.test(page)) {
        issues.push(`page ${index + 1}: the magnifier caption needs a solid ground behind it on a photographed page`);
      }
      if (!/color\s*:\s*(?:#|rgba?\()/i.test(page)) {
        issues.push(`page ${index + 1}: the magnifier caption needs an explicit contrasting text colour`);
      }
    }
  });

  // Print documents should never carry the tells of a generated web page.
  pages.forEach((page, index) => {
    if (/linear-gradient|radial-gradient/i.test(page)) {
      issues.push(`page ${index + 1}: gradients are not allowed; use a solid colour or a scrim`);
    }
    if (/box-shadow/i.test(page)) {
      issues.push(`page ${index + 1}: drop shadows are not allowed in print`);
    }
    if (/<svg[\s>]/i.test(page)) {
      issues.push(`page ${index + 1}: inline SVG is not allowed; use the supplied motif assets`);
    }
    if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(page)) {
      issues.push(`page ${index + 1}: emoji are not allowed in a printed brochure`);
    }
  });

  // Any use of the plain mark must be a small sign inside an image tag. A logo
  // stretched as decoration, a background or a class sized graphic is rejected.
  pages.forEach((page, index) => {
    const pageHtml = String(page);
    const refs = [...pageHtml.matchAll(/\{\{\s*logo(?:White)?\s*\}\}/g)];
    for (const ref of refs) {
      const open = pageHtml.lastIndexOf('<', ref.index);
      const close = pageHtml.indexOf('>', ref.index);
      const tag = open >= 0 && close > open ? pageHtml.slice(open, close + 1) : '';
      const width = /width\s*:\s*([0-9.]+)mm/i.exec(tag) ?? /width="([0-9.]+)mm"/i.exec(tag);
      if (!/^<img/i.test(tag) || !width || Number.parseFloat(width[1]) > 20) {
        issues.push(
          `page ${index + 1}: the brand logo must be a small 8 to 14 mm image sign, never a large decorative graphic`,
        );
      }
    }
  });

  // The body mark is a small quiet sign, never a giant logo behind the type.
  for (const [index, page] of pages.entries()) {
    for (const match of page.matchAll(/<img[^>]*src="\{\{logo(?:White)?\}\}"[^>]*>/gi)) {
      const tag = match[0];
      const width = /width\s*:\s*([0-9.]+)mm/i.exec(tag) ?? /width="([0-9.]+)mm"/i.exec(tag);
      if (!width || Number.parseFloat(width[1]) > 20) {
        issues.push(
          `page ${index + 1}: the brand mark in the body must be 8 to 14 mm wide, never a large graphic`,
        );
      }
    }
    if (/background(?:-image)?\s*:[^;{}]*url\(\s*['"]?\{\{\s*logo(?:White)?\s*\}\}/i.test(page)) {
      issues.push(`page ${index + 1}: the brand mark must not be used as a background or watermark`);
    }
  }

  // Light ground takes dark text and dark ground takes light text. This is
  // checked per text run against the background that actually sits behind it.
  pages.forEach((page, index) => {
    for (const issue of pageContrastIssues(page, theme)) {
      issues.push(`page ${index + 1}: ${issue}`);
    }
  });

  if (issues.length > 0) {
    throw new LlmError(`The brochure design failed the print checks: ${[...new Set(issues)].join('; ')}.`, {
      type: 'invalid_reply',
    });
  }

  return { styles, pages };
}

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

function valueOr(value, fallback) {
  const text = clean(value);
  return text === '' ? fallback : text;
}

function buildTokenValues({ values, photos, copy, photoPalettes = {}, photoDetails = {}, templatesDir }) {
  const tokens = {
    brand: BRAND.name,
    brandTamil: BRAND.tamil,
    placeTamil: BRAND.placeTamil,
    phone: BRAND.phone,
    email: BRAND.email,
    address: BRAND.address,
    orderNo: '',
    date: valueOr(values.date, ''),
    title: valueOr(values.title, 'Custom wardrobe'),
    room: valueOr(values.room, 'Room to confirm'),
    roomTamil: tamilRoom(values),
    customer: valueOr(values.customerName, 'Customer'),
    headline: clean(copy?.headline),
    body: clean(copy?.body),
    closing: clean(copy?.closing),
    logo: ASSETS.logo,
    logoWhite: ASSETS.logoWhite,
    ...brandPlateTokens(templatesDir),
    jaali: ASSETS.jaali,
    paisley: ASSETS.paisley,
    lotus: ASSETS.lotus,
    rangoli: ASSETS.rangoli,
    arch: ASSETS.arch,
  };
  photos.forEach((photo, index) => {
    tokens[`photo${index + 1}`] = photo;
  });
  for (const [key, details] of Object.entries(photoDetails)) {
    for (const detail of details ?? []) {
      tokens[`${key}detail${detail.index}`] = detail.dataUri;
      tokens[`${key}detail${detail.index}Color`] = detail.colour;
      tokens[`${key}detail${detail.index}ColorName`] = detail.name;
    }
  }
  for (const [key, palette] of Object.entries(photoPalettes)) {
    if (!/^photo\d+$/.test(key) || !Array.isArray(palette) || palette.length === 0) continue;
    tokens[`${key}Palette`] = paletteStripPng(palette);
    for (let chip = 1; chip <= 4; chip += 1) {
      const hex = palette[chip - 1] ?? palette[0];
      tokens[`${key}Color${chip}`] = hex;
      tokens[`${key}Color${chip}Name`] = colourName(hex);
    }
  }
  return tokens;
}

function fillTokens(html, tokens) {
  return String(html).replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (match, key) => {
    if (!(key in tokens)) return match;
    const value = tokens[key];
    if (typeof value !== 'string') return match;
    const raw =
      RAW_TOKENS.has(key) ||
      key.endsWith('Palette') ||
      key.endsWith('Image') ||
      /^photo\d+detail\d+$/.test(key);
    return raw ? value : escapeHtml(value);
  });
}

function parseColor(value) {
  const text = String(value ?? '').trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
  if (hex) {
    let digits = hex[1];
    if (digits.length === 3) digits = digits.split('').map((part) => part + part).join('');
    return [0, 2, 4].map((offset) => Number.parseInt(digits.slice(offset, offset + 2), 16) / 255);
  }
  const rgb = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(text);
  if (rgb) return [rgb[1], rgb[2], rgb[3]].map((part) => Number(part) / 255);
  return null;
}

function luminance(rgb) {
  const [r, g, b] = rgb.map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastIssues(styles) {
  const issues = [];
  const read = (name) => {
    const match = new RegExp(`--${name}\\s*:\\s*([^;]+);`, 'i').exec(styles);
    return match ? parseColor(match[1]) : null;
  };
  const paper = read('paper');
  const ink = read('ink');
  if (paper && ink) {
    const lighter = Math.max(luminance(paper), luminance(ink));
    const darker = Math.min(luminance(paper), luminance(ink));
    const contrast = (lighter + 0.05) / (darker + 0.05);
    if (contrast < 4.5) issues.push('the paper and ink colours do not have enough contrast to read');
  }
  return issues;
}

function hexRgb(hex) {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(String(hex ?? '').trim());
  if (!match) return null;
  const value = Number.parseInt(match[1], 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function rgbHex([r, g, b]) {
  return `#${[r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

function mix(a, b, weight) {
  const one = hexRgb(a) ?? [128, 128, 128];
  const two = hexRgb(b) ?? [128, 128, 128];
  return rgbHex(one.map((value, index) => value * (1 - weight) + two[index] * weight));
}

function luminanceOf(hex) {
  const rgb = hexRgb(hex) ?? [0, 0, 0];
  const [r, g, b] = rgb.map((value) => {
    const channel = value / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastOf(a, b) {
  const one = luminanceOf(a);
  const two = luminanceOf(b);
  return (Math.max(one, two) + 0.05) / (Math.min(one, two) + 0.05);
}

function saturationOf(hex) {
  const [r, g, b] = hexRgb(hex) ?? [0, 0, 0];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}

/**
 * The brochure theme is read from the client's own pictures: their paper, ink,
 * deep tone and accent come straight out of the photograph palettes, so the
 * pages belong to the project rather than to a house style.
 */
export function themeFromPalettes(photoPalettes = {}) {
  const colours = Object.values(photoPalettes).flat().filter((hex) => hexRgb(hex));
  if (colours.length === 0) return { ...PALETTE };
  const sorted = [...colours].sort((a, b) => luminanceOf(b) - luminanceOf(a));
  const paperCandidate = sorted[0];
  const inkCandidate = sorted[sorted.length - 1];
  const paper = luminanceOf(paperCandidate) > 0.62 ? paperCandidate : PALETTE.paper;
  const ink = luminanceOf(inkCandidate) < 0.24 ? inkCandidate : PALETTE.ink;
  const deepCandidate = sorted.find((hex) => luminanceOf(hex) < luminanceOf(ink) + 0.18) ?? ink;
  const accent = [...colours].sort((a, b) => saturationOf(b) - saturationOf(a))[0];
  const warm = [...colours].sort((a, b) => {
    const [ar, ag, ab] = hexRgb(a);
    const [br, bg, bb] = hexRgb(b);
    return br - bg - (ar - ag) + (bb - ab) * 0.2;
  })[0];
  // A deep tone is used for small labels, so it must reach readable contrast on
  // the paper. Darken the picture tone until it does, then fall back if needed.
  let deep = deepCandidate;
  for (let step = 0; step < 6 && contrastOf(deep, paper) < 4.5; step += 1) {
    deep = mix(deep, '#000000', 0.18);
  }
  if (contrastOf(deep, paper) < 4.5) deep = PALETTE.deep;
  const mutedCandidate = mix(paper, ink, 0.55);
  const theme = {
    paper,
    ink,
    deep,
    accent: contrastOf(accent, paper) > 2.4 ? accent : PALETTE.accent,
    gold: contrastOf(warm, paper) > 1.8 ? warm : PALETTE.gold,
    hair: mix(paper, ink, 0.16),
    // Muted text must stay readable on the paper; a picture palette can mix
    // into something too pale, in which case the house muted tone is used.
    muted: contrastOf(mutedCandidate, paper) >= 4.5 ? mutedCandidate : PALETTE.muted,
    onDark: paper,
  };
  if (contrastOf(theme.ink, theme.paper) < 4.5) {
    theme.ink = PALETTE.ink;
    theme.deep = PALETTE.deep;
  }
  return theme;
}

function pageCss(theme) {
  const palette = theme ?? PALETTE;
  return `
@page { size: 216mm 303mm; margin: 0; }
html, body { margin: 0; padding: 0; background: #fff; }
* { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
:root {
  --paper: ${palette.paper};
  --ink: ${palette.ink};
  --deep: ${palette.deep};
  --accent: ${palette.accent};
  --gold: ${palette.gold};
  --hair: ${palette.hair};
  --muted: ${palette.muted};
  --on-dark: ${palette.onDark};
  --display: 'Instrument Serif', Georgia, serif;
  --body: 'Barlow', Helvetica, Arial, sans-serif;
  --tamil: 'Noto Sans Tamil', 'Barlow', sans-serif;
}
.page { position: relative; width: 216mm; height: 303mm; overflow: hidden; page-break-after: always; background: var(--paper); color: var(--ink); }
.page:last-child { page-break-after: auto; }
.page img { display: block; max-width: 100%; }
.page .ph { background-size: cover; background-position: center; background-repeat: no-repeat; }
.page .abs { position: absolute; }
.page .tamil, .page [lang="ta"] { font-family: var(--tamil); letter-spacing: normal !important; text-transform: none !important; font-size: max(7.5pt, 1em); }
.page .serif { font-family: var(--display); font-weight: 400; }
.page .label { font-family: var(--body); font-size: 6.4pt; letter-spacing: 0.22em; text-transform: uppercase; color: var(--deep); }
.page .body { font-family: var(--body); font-size: 8.4pt; line-height: 1.6; color: var(--ink); }
`;
}


/**
 * Turn the checked pages into one print ready document. The wrapper owns the
 * page box, the bleed and the fonts; the model owns everything inside.
 */
export function compileGenerativeBrochure({
  order,
  materials,
  templatesDir,
  dataDir,
  attachmentImages = [],
  photoPalettes = {},
  photoDetails = {},
  copy,
  pages,
  styles = '',
}) {
  const values = buildVoucherValues({
    order,
    materials,
    templatesDir,
    dataDir,
    logger: { warn() {}, info() {}, error() {}, debug() {} },
    attachmentImages,
  });
  const photoTokens = Array.isArray(attachmentImages) ? attachmentImages.filter(Boolean) : [];
  const tokens = buildTokenValues({ values, photos: photoTokens, copy, photoPalettes, photoDetails, templatesDir });

  const filledPages = pages.map((page) => fillTokens(page, tokens));
  const filledStyles = fillTokens(styles, tokens);
  const leftover = tokenList(filledPages.join('\n') + filledStyles);
  const issues = [...contrastIssues(filledStyles)];
  if (leftover.size > 0) {
    issues.push(`tokens were left unfilled (${[...leftover].join(', ')})`);
  }
  for (const [index, page] of filledPages.entries()) {
    const visible = visibleText(page);
    if (visible.length > 6000) issues.push(`page ${index + 1} carries an unreasonable amount of text`);
  }
  if (issues.length > 0) {
    throw new LlmError(`The brochure did not pass the print checks: ${issues.join('; ')}.`, {
      type: 'invalid_reply',
    });
  }

  // The studio never wants an em dash or an en dash in print, not even one the
  // model slipped into a label. Normalise them in one place, after all the
  // tokens are filled, so the rule can not be broken by a stray caption.
  const noDashes = (value) => value.replace(/[\u2013\u2014]/g, '-');
  const docStyles = noDashes(filledStyles);
  const docPages = filledPages.map(noDashes);

  // Contract: at least one whole, uncropped copy of every supplied picture is
  // printed. These pages are added after the authored ones so the model can
  // never crop a picture out of the book.
  const wholeFrames = [];
  for (let index = 0; index < photoTokens.length; index += 6) {
    const chunk = photoTokens.slice(index, index + 6);
    wholeFrames.push(
      `<div style="position:relative;width:100%;height:100%;background:#F7F2E9;color:#2E2A24;font-family:var(--body);">` +
        `<div style="position:absolute;left:18mm;top:14mm;font-size:6.4pt;letter-spacing:0.22em;text-transform:uppercase;color:#8A7A66;">Every picture, whole frame</div>` +
        `<div style="position:absolute;left:18mm;top:22mm;width:180mm;display:grid;grid-template-columns:1fr 1fr;gap:6mm;">` +
        chunk
          .map((uri, offset) => {
            const number = index + offset + 1;
            return (
              `<div>` +
              `<div style="height:66mm;background:#EFE7D8;display:flex;align-items:center;justify-content:center;padding:2mm;">` +
              `<img src="${uri}" style="max-width:100%;max-height:62mm;width:auto;height:auto;object-fit:contain;">` +
              `</div>` +
              `<div style="margin-top:2mm;font-size:6.2pt;letter-spacing:0.16em;text-transform:uppercase;color:#6E6152;">Whole picture ${number}</div>` +
              `</div>`
            );
          })
          .join('') +
        `</div>` +
        `<div style="position:absolute;left:18mm;bottom:10mm;font-size:6.2pt;letter-spacing:0.14em;color:#8A7A66;">JACOB DESIGN STUDIO</div>` +
        `</div>`,
    );
  }
  const allPages = [...docPages, ...wholeFrames.map(noDashes)];
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(values.title)}</title>
<link rel="stylesheet" href="../fonts/brand.css">
<style>${pageCss(themeFromPalettes(photoPalettes))}</style>
${docStyles ? `<style>${docStyles}</style>` : ''}
</head><body>
${allPages.map((page) => `<div class="page">${page}</div>`).join('\n')}
</body></html>`;
}

/** Human label for a generated brochure, stored with the render. */
export function designLabel({ direction = '', designed = true } = {}) {
  if (!designed) return 'Brochure';
  const note = clean(direction);
  return note === '' ? 'Designed by the model' : `Designed by the model · ${note.slice(0, 60)}`;
}

/** Validate a copy object the studio edited by hand. */
export function readCopyOverride(copy) {
  if (!copy || typeof copy !== 'object' || Array.isArray(copy)) {
    throw new LlmError('The brochure copy could not be read.', { type: 'invalid_reply' });
  }
  const strip = (value) => value.replace(/[\u2013\u2014]/g, '-');
  const headline = typeof copy.headline === 'string' ? strip(copy.headline).trim().slice(0, 80) : '';
  const body = typeof copy.body === 'string' ? strip(copy.body).trim().slice(0, 1200) : '';
  const closing = typeof copy.closing === 'string' ? strip(copy.closing).trim().slice(0, 140) : '';
  if (!headline || body.split(/\s+/).filter(Boolean).length < 20) {
    throw new LlmError('The brochure copy needs a headline and a body.', { type: 'invalid_reply' });
  }
  return { headline, body, closing };
}
