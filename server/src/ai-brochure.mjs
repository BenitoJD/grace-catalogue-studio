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
import { resolvePrompt } from './prompts.mjs';
import { brandPlateTokens } from './brand-lockup.mjs';
import { contrastIssues as pageContrastIssues } from './contrast.mjs';

// Quality first: a generous explicit cap. Omitting max_tokens lets some
// providers fall back to a small default and truncate the HTML.
export const DESIGNER_MAX_TOKENS = 32000;
export const DESIGNER_TEMPERATURE = 0.85;
export const DESIGNER_TRIES = 6;
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

export const DESIGNER_SYSTEM = [
  'You are the art director, typographer and print designer for Jacob Design Studio, a wardrobe and furniture workshop in Nagercoil, Tamil Nadu.',
  'You design and typeset one printed brochure for one order. Reply with one complete HTML document and nothing else.',
  '',
    'THE DOCUMENT',
  'GRID. The page is 216 by 303 mm with a 3 mm bleed. Live area: 174 mm wide, from x = 21 mm to x = 195 mm, and 255 mm tall, from y = 24 mm to y = 279 mm. Use a 12 column grid: column 10.83 mm, gutter 4 mm. Start every column at x = 21 + n * 14.83 mm. Align every photograph, text block, rule and caption to a column edge, never to an arbitrary position.',
  'BASELINE. A 4.5 mm baseline grid. Every block starts on a baseline step: 24, 28.5, 33, 37.5 and so on. Body copy is 9 to 10 pt on 15 pt leading, exactly the baseline. Captions 7 to 7.5 pt on 10.5 pt. Labels 6.5 pt tracked 0.16 em. Display 40 to 44 pt on 42 pt leading. Headline 24 to 28 pt on 30 pt. Never mix more than one body size per page.',
  'ALIGNMENT LAW. All body text and captions flush left, ragged right. Never centre a paragraph. Centre only a short plate caption or a cover mark. Captions align flush left with the left edge of their photograph. Folios sit at the right edge of the last column, 9 mm above the trim. Rules run from column 1 to column 12 or from column 1 to column 6, never to an eyeballed width. If two blocks share a page, they share a column edge; no floating blocks in the middle of a margin.',
  'PREMIUM SIGNALS. One family, two weights maximum. One accent colour only. Photography at full column width, never a small floating picture with a big empty field. Headline and picture share a common edge. Every page carries header, main block, secondary block and folio in the same grid position. The book reads as one system across pages: same margins, same folio, same caption behaviour.',
  'Fortune 500 standard is restraint, not decoration: fewer elements, perfectly aligned, one clear idea per page, confident scale, no empty filler.',

  'An A4 brochure printed on warm cream uncoated paper. The page box is 216 mm wide by 303 mm tall and includes a 3 mm bleed on every side, so the trim is 210 by 297 mm.',
  'It is picture led, quiet, warm and confident, the kind of book a customer keeps on the table. Indian taste: generous margins, large type, deep colour and muted gold against cream, Tamil and English together, ornament used like jewellery, never a poster and never a website.',
  'This brochure is about COLOUR, not measurements. There is no size, no dimension and no technical schedule in it. The photographs and their colour palettes are the subject. The model never prints a width, height, depth, shutter count or hardware list.',
  'The pamphlet has no fixed length. It is exactly as long as the input needs: at least a cover and a closing side, then one or more sides per picture and its story. More photographs, more palettes and more details earn more pages. Never pad, never squeeze a picture to fit a page count.',
  '',
  'THE PAGES, IN ORDER',
  'Every page must be full of real content. Do not leave a large empty band: pair a small picture with the reading, the palette, material notes or a second picture. Empty space is the most common failure.',
  '1. Cover. One commanding photograph, the brand, the piece title, the customer and the room. Almost nothing else. The photograph does the work.',
  '2 to 7. Story pages. The written copy set like an editorial spread: the headline as the one large line, the body in calm columns, the closing line small and quiet, with one or two photographs. Extra photographs earn extra pages, and every photograph must appear. The studio prints the palette, the material callouts and the colour plates itself on each picture plate page, so designer pages stay free of swatches and clean.',
  'Give one spread the premium brand treatment: a single photograph at full page, its colour name and code set quietly on paper, and almost nothing else on the page.',
  'Last. A composed back cover for the client file: one contact plate (it already carries the logo and name), the closing line set as a quiet large type moment, the Tamil studio line, one motif or hairline rule, the order number and date small. No second brand plate, no form, no large empty band. Compose it like a colophon, on a deep band or a cream field.',
  '',
  'HOW TO REPLY',
  '- Reply with the HTML document only: no prose, no markdown, no code fences, no explanation.',
  '- The <head> may hold one <style> block. Inline style attributes are welcome.',
  '- The <body> holds at least two page elements in order: <div class="page"> ... </div>, a cover and a closing side, then as many sides as the pictures and the story need. The studio adds one material callout page per picture with details after the design. There is no page count to hit and no page count to avoid; the pictures decide the length. Nothing else beside the pages.',
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
  'No loupe, ring, dot, leader line, arrow or colour caption is drawn by the designer. The studio adds the material callouts itself after the design. Keep every photograph clean.',
  'Assets: {{logo}} is the brand mark for light backgrounds and {{logoWhite}} is the same mark in white for dark backgrounds. {{brandPlateLight}} and {{brandPlateDark}} are ready made brand panels: the mark and the brand name on their own solid ground, light and dark. {{contactPlateLight}} and {{contactPlateDark}} add the phone, email and address. Because each plate carries its own background, it stays legible on any page. {{jaali}}, {{paisley}}, {{lotus}}, {{rangoli}} and {{arch}} are the house motifs.',
  'The brand and the contact details must always read clearly. Put a brand plate on the cover and one contact plate on the closing page. The contact plate already carries the brand, so never add a second brand plate to the closing page. Use the light plate on cream pages and the dark plate on dark, colour or photographic pages. Never set the contact lines straight over a photograph.',
  '',
  'REQUIRED',
  '- Page 1, the cover: at least one photograph, {{title}}, {{customer}}, a brand plate {{brandPlateDark}} or {{brandPlateLight}}, and {{brandTamil}} or {{roomTamil}}.',
  '- The brand is always legible: {{logoWhite}} on a dark, colour or photographic field, {{logo}} on cream or a light field. Never set either mark straight on a busy photograph without a solid panel or scrim behind it, and never tint or recolour a mark.',
  '- The closing page carries one contact plate {{contactPlateLight}} or {{contactPlateDark}}, which already contains the company name. Do not add a separate brand plate or a second logo to the closing page.',
  '- {{headline}}, {{body}} and {{closing}} each exactly once, anywhere in the story pages.',
  '- Every photograph token from {{photo1}} to the last available must appear at least once.',
  '- Every photograph is a hero: wherever it is used, print it whole and uncropped, never a cropped background. The studio also prints each picture whole on its own material callout page. No contact sheet, no thumbnail appendix, no keyword page.',
  '- The last page: a large brand plate and a contact plate. Never print an order number.',
  '- Somewhere in the document: at least one house motif token.',
  '- No dimension, size, shutter count or specification value may appear. Those tokens do not exist and naming them rejects the document.',
  '- The photographs are the design source. Mirror their colours, light and warmth. The pages must look like they belong to the same project as the pictures.',
  '- No callouts on photographs. Never draw a loupe, crop, ring, dot, leader, arrow or colour label over or beside a photograph. The studio prints one clean callout plate for every picture. Design the picture side as a finished photographic page, with its colour named in the page copy only.',
  '',
  'THE QUALITY BAR',
  'This is a small printed pamphlet the salesperson hands to the customer, art directed by one of the best print designers alive: image led, quiet, confident, with one clear idea for this project and no trace of a template. If a side could have come from Canva, a restaurant menu, a website or an AI image, it is wrong.',
  'Use a real editorial grid: one 12 column grid with a consistent 18 mm outer margin and an 8 mm gutter, and align every element to it. Set a type scale and keep it: cover display 44 to 64 pt, section titles 20 to 26 pt, body 8.4 to 9.5 pt with 1.55 line height, captions 6.4 to 7 pt with 0.2 em tracking, folio 6.4 pt.',
  'Give every page a clear job and a different composition. Vary full bleed photograph pages, a two thirds split page, a quiet type page, a colour plate page and the annotated photograph spread. Never repeat the same arrangement twice in one document.',
  'The cover brand plate is a hero: at least 55 mm wide, preferably 60 to 100 mm, set with real space around it. A tiny corner plate is wrong.',
  'Colour names may appear in the copy of a page, never as a mark drawn on a photograph.',
  'The cover is a designed photograph, not a template: full bleed image or a strong 2:3 split, an oversized title reacting to the image, the brand plate placed with intent, and nothing centered by default. Use a kicker, a hairline and one line of quiet information. No logo, title, photo and footer stack.',
  'Treat typography like a brand book: one display face, one text face, real hierarchy, generous leading, ragged right body, small caps labels with wide tracking, oversized folio numbers, and no more than three type sizes on a page.',
  'Compose with negative space, hairlines and the picture palette, through the theme variables. Only three colour families on a page. The accent is a one point rule, a numeral or a motif, never a fill. No gradients, no drop shadows, no rounded cards, no badges, no clip art icons, no emoji, no chevrons, no buttons.',
  'Photographs are the hero: crop with intent, let them bleed, and use a solid scrim or band for any words that sit on them. Never make a photograph small and polite unless the page is deliberately quiet.',
  'The studio adds the material callout pages itself, with ring, dotted leader, arrow and colour code printed on paper. The designer never draws any of it.',
  'Frame photographs so a calm strip of paper remains at the outer edge of the page for the annotations. On a full bleed photograph, bring the leader line to the nearest margin and set the text there, never over the picture.',
  'The closing page is a composed back cover, not a form: one contact plate, one closing line, the Tamil line, one motif and a hairline grid. No second logo, no empty middle band.',
  '',
  'PAMPHLET OR BROCHURE, CHOSEN BY THE STUDIO',
  'Pamphlet is a small take home piece: one dominant whole picture per side, a short line of type, and generous but purposeful margins. Minimal copy does not mean an empty page; the photograph, headline, palette and one detail note fill the side.',
  'Brochure is a larger art directed book: an editorial cover, story spreads with real copy, one or more picture sides, colour plates and detail callouts, then a closing spread. It still has no fixed length; more pictures and more story earn more sides.',
  'Never pad either format and never squeeze a picture to fit a page count. The cover is one picture and one title. The closing side carries one contact plate only.',
  '',
  'DESIGN RULES',
  '- Print design, not web design. No cards, rounded corners, drop shadows, buttons, icons, badges, glass, or gradients except a soft photograph scrim.',
  '- One dominant ground, one ink, one accent. Gold is a line, a number or a motif, never a large fill. A deep colour may carry a band or a whole page. Never set body text in gold on cream.',
  '- Contrast is absolute: dark text on a light ground, light text on a dark ground. A pale page never gets pale text and a dark band never gets dark text.',
  '- Any text over a photograph or a dark picture must sit inside a band, panel or scrim that carries its own near-opaque background colour inline, with the opposite text colour on it. Never set light words straight on a photo.',
  '- Put the background colour inline on the element or on an ancestor element, not only in a class, so the contrast check can verify it. It is checked before printing and low contrast is rejected.',
  '- Build a real typographic hierarchy: one display line, small caps labels with wide tracking, hairline rules, captions, folio numbers. Use white space as a material.',
  '- NEVER set text inside a black or dark filled rectangle. No black caption bars, no dark text boxes, no dark colour-callout panels. Text sits directly on the paper, or on the full-page dark ground. The only dark fills allowed are a full-page ground and the brand or contact plate.',
  '- NEVER print a palette strip, swatch row, colour chip or paint card on a designer page. The studio prints the palette on the plate for each picture. Designer pages hold photographs, headlines, copy, rules, folios and the brand only.',
  '- NEVER run text under a photograph. Copy and pictures occupy separate columns or separate bands.',
  '- NO OVERLAPPING TEXT. Two text blocks may never share the same area. Use separate grid columns with a visible gutter, never columns that run into each other. If a paragraph is longer than its column, move it to the next column or the next page; never let it cross another block.',
  '- LAYOUT LAW. Every page is a full composition, edge to edge within the margins, with no unused area larger than a business card. Compose in normal flow or CSS grid. Never place one block over another. Text, palette strips, captions and notes must never overlap, touch or be clipped. A palette strip belongs in the flow below the copy, never absolutely positioned over it. Text blocks have natural height; never fix a text block height or hide its overflow. If a block does not fit, shorten the copy or move it to the next page, never overlap it.\n- Compose each page. Vary alignment, scale and the position of the photograph. The cover should not be the generic centred logo, title, framed photo and footer stack; react to the photograph instead. Try type across the image low, a tall split, a masthead, an arch, an asymmetric page with a deep quiet margin.',
  '- Never set light text straight on a photograph unless it sits on a dark scrim, a solid band or a genuinely quiet dark area of the picture. The renderer can not see how bright the photograph is, so assume it is pale.',
  '- Colour strips are images, not pale samples: frame each one with a hairline rule or a keyline so it reads as a colour plate.',
  '- Tamil is set tight and whole: never letter-space, uppercase or small-cap a Tamil line, and never set it below 7.5 pt. Keep Tamil in a line of its own.',
  '- The mark in the body is a small quiet sign, 8 to 14 mm wide, set in a corner or a footer, never a large graphic, never a watermark and never behind or over a title. Large marks belong only on the cover and closing plates.',
  '- Ornament once or twice in the whole document, at a corner or a rule: a jaali strip along one edge, a lotus under a title, an arch around a photograph. Never all motifs on one page.',
  '- The cover is the loudest page, the story is the warmest, and the colour pages are a quiet chromatic study.',
  '- NO EMPTY SPACE. Free space is a failure, not a style. Every page must be full from the top of the safe area to the bottom, with content, picture, colour and type. No unused region may be larger than a business card. A page with one small photograph must also carry the headline, reading, material notes, colour study or a second picture so it fills the page. White space is only the measured margin around content, never a design idea and never a hole in the page. Keep the last line at least 18 mm above the trim. Never pad a page count; instead make every page full.',
  '- This brochure is one of many. Do not repeat a stock arrangement; the photographs, their colours and the room decide the composition.',
  '- Tamil lines are set in Noto Sans Tamil, never forced into an English serif.',
  '',
  'AVAILABLE TYPE',
  "'Instrument Serif' for display and headline, 'Barlow' for labels, captions and small text, 'Noto Sans Tamil' for Tamil.",
  'Colours come as CSS variables already set from the picture palettes: --paper, --ink, --deep, --accent, --gold, --hair, --muted, --on-dark. Use these, and if you refine them keep them inside the same family, so the printed book carries the colour of the actual project rather than a house style. Keep the paper light and the ink dark.',
  '',
  'VOICE OF THE PAGES',
  'Words are very few. The cover says almost nothing. The story carries the copy. The studio plates carry the paints and the details. A reader should feel the room and its colours before reading a sentence. This is a showroom book, not a catalogue and not a specification sheet.',
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

function designContext({ order, brief, direction, format = 'pamphlet', copy, photos, photoShapes, photoPalettes, pictureReading, pictureAnalysis, annotations = [], previousHtml, editNote }) {
  const photoLines = photos.map((_, index) => {
    const shape = photoShapes[index] ? ` (${photoShapes[index]})` : '';
    return `photo${index + 1}${shape}`;
  });
  const parts = [
    'ORDER',
    `Output format: ${format === 'brochure' ? 'Brochure, a larger art directed book' : 'Pamphlet, a small take home piece'}`,
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
    'YOUR ART DIRECTION FOR THIS BOOK',
    (() => {
      const direction = artDirectionFor({ photoPalettes, pictureAnalysis });
      return direction.text;
    })(),
    '',
    'This direction is invented fresh for this order from these pictures. Do not reuse a house layout. Do not make it look like the last book. The photographs decide the taste: their palette, their light, their materials and the details seen in them.',
    '',
    'STYLE READ FROM THE PICTURES (follow these decisions exactly)',
    styleProfileFor(photoPalettes, pictureAnalysis).directives.join(' '),
    '',
    'CLIENT WORDS HAVE THE FINAL WORD',
    'If the client or the order words ask for a colour, a mood, a motif, a layout or a detail, that request overrides the picture defaults for that part of the book. Where the client says nothing, the pictures decide everything.',
    '',
    'VISUAL TASTE READ FROM THE PICTURES',
    (() => {
      const taste = pictureTaste(photoPalettes);
      const paletteLine = taste.colours
        .slice(0, 6)
        .map((colour) => `${colour.name} ${colour.hex} (${colour.share}%)`)
        .join(', ');
      return `${taste.warmth}, ${taste.contrast} contrast, ${taste.tone}. Palette by share: ${paletteLine || 'from the supplied palettes'}.`;
    })(),
    '',
    'The whole book inherits this taste. The page ground, the ink, the deep label tone and one accent all come from this palette through var(--paper), var(--ink), var(--deep), var(--accent), var(--gold) and var(--hair). Never apply a fixed house beige, teal or gold look that is not in the pictures.',
    '',
    'IMAGE STYLE NOTES',
    (() => {
      const notes = (Array.isArray(pictureAnalysis) ? pictureAnalysis : [])
        .filter((picture) => picture && picture.style)
        .map((picture) => {
          const style = picture.style;
          const parts = [
            style.mood ? `mood: ${style.mood}` : '',
            style.materials?.length ? `materials: ${style.materials.join(', ')}` : '',
            style.light ? `light: ${style.light}` : '',
            style.composition ? `composition: ${style.composition}` : '',
            style.styling?.length ? `styling: ${style.styling.join(', ')}` : '',
          ].filter(Boolean);
          return `${picture.photo}: ${parts.join('; ')}.`;
        });
      return notes.length > 0
        ? notes.join('\n')
        : 'No separate style notes; take the aesthetic from the pictures and the art direction above.';
    })(),
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
    'Use this reading: choose the cover photograph and the spreads from what each picture shows. The studio names the callout captions itself, so never draw a caption on a photograph.',
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

// The world class gate. Every candidate is scored by an art director; below
// the threshold it goes back for another design round with concrete fixes.
export const QUALITY_THRESHOLD = 8;

export const QUALITY_SYSTEM = [
  'You are the creative director of a premium print studio, judging a take home pamphlet before it is sent to a client.',
  'Score it from 1 to 10 against this rubric, strictly:',
  '10 is world class, the best printed pamphlet a design studio could hand over.',
  '9 is excellent, distinctive and print ready.',
  '8 is strong professional work, safe to send to a client.',
  '7 and below is not ready: generic, crowded, weak hierarchy, template feel, timid photography, poor typography, or a layout that does not come from the pictures.',
  'Judge: is the photograph the hero and printed whole; is the composition fresh for this picture set; is there one clear idea; is the type hierarchy confident and quiet; is every page completely full of real content with no unused region larger than a business card; does the palette come from the photographs; does the design feel inspired by the light, materials and mood of these specific pictures; does it feel hand art directed rather than generated; does anything look like a template, a website or an AI image.',
  'Reply with strict JSON only: {"score": 8, "fixes": ["one concrete instruction", "another"]}.',
  'The fixes must be concrete art direction that the designer can apply to the document, not general praise.',
].join(' ');

export const PAGE_QA_SYSTEM = [
  'You are the pre-press layout inspector of a premium print studio.',
  'You receive the complete HTML of a designed pamphlet or brochure. Inspect EVERY page one by one, as if it were already printed.',
  'A page fails if any of these are true: a text block overlaps another text block, a palette strip, a caption, an image or a rule; text is clipped, cut off or hidden behind a block; a colour strip sits on top of copy; the content covers less than 80 percent of the page, or any empty band is taller than 40 mm; a block looks half placed; a page reads like an unfinished draft. Free space is not taste here, it is a failure.',
  'Also judge alignment: every block must sit on a column edge; captions must align with their photograph; folios must keep the same position on every page; nothing may float mid margin or centre without reason.',
  'Do not judge taste, wording or colour. Only layout integrity, alignment and page completion.',
  'Reply with strict JSON only: {"pages":[{"page":1,"issues":["short concrete problem"]}]}. Include only pages that have issues. If every page is clean reply {"pages":[]}.',
].join(' ');

export function buildPageQaMessages({ html, pageCount = 0 }) {
  return [
    { role: 'system', content: PAGE_QA_SYSTEM },
    {
      role: 'user',
      content: `Inspect all ${pageCount} pages of this document and reply with the JSON only.\n\n${html}`,
    },
  ];
}

export function parsePageQa(content) {
  const text = String(content ?? '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || !Array.isArray(parsed.pages)) return null;
  return parsed.pages
    .map((entry) => ({
      page: Number.isFinite(entry?.page) ? Number(entry.page) : 0,
      issues: Array.isArray(entry?.issues)
        ? entry.issues.map((issue) => String(issue).replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 4)
        : [],
    }))
    .filter((entry) => entry.issues.length > 0);
}

export function buildQualityMessages({ html, round = 1, styleNotes = '' }) {
  const inspiration = String(styleNotes ?? '').trim();
  return [
    { role: 'system', content: resolvePrompt('quality', QUALITY_SYSTEM) },
    {
      role: 'user',
      content:
        `Round ${round}. Judge this pamphlet and reply with the JSON only.` +
        (inspiration === ''
          ? ''
          : ` The design must feel inspired by these picture notes: ${inspiration.slice(0, 1200)}. Lower the score if it looks generic instead.`) +
        `\n\n${html}`,
    },
  ];
}

export function parseQualityReview(content) {
  const text = String(content ?? '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const score = Number(parsed?.score);
  if (!Number.isFinite(score)) return null;
  const fixes = Array.isArray(parsed?.fixes)
    ? parsed.fixes
        .filter((fix) => typeof fix === 'string')
        .map((fix) => fix.replace(/\s+/g, ' ').trim().slice(0, 220))
        .filter(Boolean)
        .slice(0, 8)
    : [];
  return { score: Math.min(10, Math.max(1, score)), fixes };
}

export const POLISH_SYSTEM = [
  'You are an award winning print art director for luxury automotive and interiors brand books. You do not add content. You art direct.',
  'You receive one printed pamphlet as complete HTML authored by a designer. Raise it to the standard of the best small printed pamphlet: one clear idea, a stronger cover, a real grid, one hierarchy, image led sides, more confident whitespace, no dead empty bands, photographs treated as heroes, refined captions and folios, and quieter, more precise detail.',
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
      content: `Art direct this pamphlet to the best printed pamphlet quality. Keep all tokens and constraints. Return the complete revised HTML only.\n\n${html}`,
    },
  ];
}

export function buildDesignerMessages({ order, brief = '', direction = '', format = 'pamphlet', copy, photos = [], photoShapes = [], photoPalettes = {}, pictureReading = '', pictureAnalysis = [], annotations = [], previousHtml = '', editNote = '' }) {
  const user = designContext({ order, brief, direction, format, copy, photos, photoShapes, photoPalettes, pictureReading, pictureAnalysis, annotations, previousHtml, editNote });
  const messages = [
    { role: 'system', content: resolvePrompt('designer', DESIGNER_SYSTEM) },
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
      'The body still needs at least a cover and a closing <div class="page">, the required tokens, and no external references.',
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

// The pamphlet grows with its content: a quiet order is a cover and a close, a full one
// up to eight. The first page is always the cover and the last always the
// specification; everything between is story and materials.
export const MIN_DESIGN_PAGES = 2;
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
export function parseDesignerReply(content, photoCount = 4, palettePhotos = [], theme = PALETTE, markedDetails = [], calloutCount = 0, format = 'pamphlet') {
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
  // Length follows the input: no target, no cap, only a safety ceiling and a
  // format minimum (a pamphlet needs a cover and a close; a brochure has body).
  const minPages = format === 'brochure' ? 6 : MIN_DESIGN_PAGES;
  if (pages.length < minPages) {
    issues.push(
      `it has ${pages.length} page${pages.length === 1 ? '' : 's'}; a ${format} needs at least ${minPages} sides`,
    );
  }
  if (pages.length > MAX_DESIGN_PAGES) {
    issues.push(`it has ${pages.length} pages, beyond the technical safety ceiling of ${MAX_DESIGN_PAGES}`);
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
    // Mechanical emptiness: measure where the real content stops on the page.
    // A page whose lower third is bare paper is rejected, whatever the model
    // says about its own composition.
    if (index > 0 && index < pages.length - 1) {
      const tops = [];
      for (const match of page.matchAll(/<[a-z][^>]*style="([^"]*)"[^>]*>/gi)) {
        const style = match[1];
        if (!/position\s*:\s*absolute/i.test(style)) continue;
        const top = /(?:^|;)\s*top\s*:\s*([0-9.]+)mm/i.exec(style);
        const height = /(?:^|;)\s*height\s*:\s*([0-9.]+)mm/i.exec(style);
        if (!top) continue;
        const start = Number(top[1]);
        if (!Number.isFinite(start) || start > 280) continue;
        const size = height ? Number(height[1]) : 8;
        if (start + size < 18) continue;
        tops.push(start + Math.min(size, 120));
      }
      if (tops.length >= 5) {
        const lowest = Math.max(...tops);
        if (lowest < 170) {
          issues.push(`page ${index + 1} leaves the lower part of the page empty; fill it with relevant content`);
        }
      }
      // Mechanical text overlap: approximate each absolutely positioned text
      // block as a box and reject any two that share a real area.
      const boxes = [];
      for (const match of page.matchAll(/<div[^>]*style="([^"]*)"[^>]*>([\s\S]{0,1200}?)<\/div>/gi)) {
        const style = match[1];
        if (!/position\s*:\s*absolute/i.test(style)) continue;
        const left = /(?:^|;)\s*left\s*:\s*([0-9.]+)mm/i.exec(style);
        const top = /(?:^|;)\s*top\s*:\s*([0-9.]+)mm/i.exec(style);
        const width = /(?:^|;)\s*width\s*:\s*([0-9.]+)mm/i.exec(style);
        const fontSize = /font-size\s*:\s*([0-9.]+)pt/i.exec(style);
        if (!left || !top || !width) continue;
        const text = match[2].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
        if (text.length < 25) continue;
        const widthMm = Number(width[1]);
        const fontPt = fontSize ? Number(fontSize[1]) : 9;
        const fontMm = Math.max(2.2, fontPt * 0.3528);
        const charsPerLine = Math.max(8, Math.floor(widthMm / (fontMm * 0.52)));
        const lines = Math.max(1, Math.ceil(text.length / charsPerLine));
        const heightMm = lines * fontMm * 1.5;
        boxes.push({ x: Number(left[1]), y: Number(top[1]), w: widthMm, h: heightMm });
      }
      for (let a = 0; a < boxes.length; a += 1) {
        for (let b = a + 1; b < boxes.length; b += 1) {
          const one = boxes[a];
          const two = boxes[b];
          const ox = Math.min(one.x + one.w, two.x + two.w) - Math.max(one.x, two.x);
          const oy = Math.min(one.y + one.h, two.y + two.h) - Math.max(one.y, two.y);
          if (ox > 4 && oy > 4 && ox * oy > Math.min(one.w * one.h, two.w * two.h) * 0.25) {
            issues.push(`page ${index + 1}: two text blocks overlap; separate them onto the grid columns`);
            a = boxes.length;
            break;
          }
        }
      }
      // Type must never run under a picture. Measure image boxes and reject any
      // overlap with a text block.
      const imageBoxes = [];
      for (const match of page.matchAll(/<img[^>]*style="([^"]*)"[^>]*>/gi)) {
        const style = match[1];
        if (!/position\s*:\s*absolute/i.test(style)) continue;
        const left = /(?:^|;)\s*left\s*:\s*([0-9.]+)mm/i.exec(style);
        const top = /(?:^|;)\s*top\s*:\s*([0-9.]+)mm/i.exec(style);
        const width = /(?:^|;)\s*width\s*:\s*([0-9.]+)mm/i.exec(style);
        const height = /(?:^|;)\s*height\s*:\s*([0-9.]+)mm/i.exec(style);
        if (!left || !top || !width || !height) continue;
        if (Number(width[1]) > 200 || Number(height[1]) > 200) continue;
        imageBoxes.push({ x: Number(left[1]), y: Number(top[1]), w: Number(width[1]), h: Number(height[1]) });
      }
      for (const box of boxes) {
        for (const imageBox of imageBoxes) {
          const ox = Math.min(box.x + box.w, imageBox.x + imageBox.w) - Math.max(box.x, imageBox.x);
          const oy = Math.min(box.y + box.h, imageBox.y + imageBox.h) - Math.max(box.y, imageBox.y);
          if (ox > 3 && oy > 3 && ox * oy > box.w * box.h * 0.15) {
            issues.push(`page ${index + 1}: text runs under a picture; give the copy its own column`);
            return issues;
          }
        }
      }
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
          tokensForPhoto.push(`photo${n}detail${detail}X`);
          tokensForPhoto.push(`photo${n}detail${detail}Y`);
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
      continue;
    }
    // A photo token must sit in an img src. Printed as text it leaks the
    // local file path into the PDF.
    const placed = new RegExp(`<img[^>]*src="\\{\\{\\s*photo${index}\\s*\\}\\}"`, 'i').test(whole);
    if (!placed) {
      issues.push(`{{photo${index}}} must be placed as an image, not printed as text`);
    }
  }

  // The hero magnifier: a real enlarged crop of a picture, with the colour it
  // holds named beside it. Premium brand treatment, always present.
  // The studio draws the material callout pages itself, deterministically.
  // The model must leave the photographs clean: no loupe, no drawn annotation.
  // A magnifier is no longer part of this book. Only a small ring, a dashed
  // leader and a label outside the photograph are allowed.
  pages.forEach((page, index) => {
    if (/<img[^>]*src="\{\{\s*photo\d+detail\d+\s*\}\}"/i.test(page)) {
      issues.push(`page ${index + 1}: remove the magnifier plate; annotate the point with a ring and a dashed leader instead`);
    }
    const styles = [...String(page).matchAll(/style="([^"]*)"/gi)].map((match) => match[1]);
    for (const style of styles) {
      if (!/border-radius\s*:\s*50%/i.test(style)) continue;
      const width = /width\s*:\s*([0-9.]+)mm/i.exec(style);
      if (width && Number.parseFloat(width[1]) >= 20) {
        issues.push(`page ${index + 1}: a large circular magnifier is not allowed; use a small ring and a dashed leader`);
        break;
      }
    }
  });

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
      if (!/photo\d+/.test(page)) {
        issues.push(`page ${offset + 2} shows no photograph`);
      }
    }
  }
  if (pages.length > 0) {
    for (const token of COPY_TOKENS) {
      if (countToken(pages[0], token) > 0) issues.push(`{{${token}}} belongs in the story, not on the cover`);
    }
    const lastHtml = pages[last];
    const contactPlates =
      countToken(lastHtml, 'contactPlateDark') + countToken(lastHtml, 'contactPlateLight');
    const brandPlates =
      countToken(lastHtml, 'brandPlateDark') + countToken(lastHtml, 'brandPlateLight');
    if (contactPlates === 0) {
      issues.push('the closing page is missing a contact plate; company details must stay readable');
    }
    if (brandPlates > 0) {
      issues.push('the closing page carries a second brand plate; use one contact plate, which already holds the brand');
    }
    for (const token of COPY_TOKENS) {
      if (countToken(lastHtml, token) > 0) issues.push(`{{${token}}} belongs in the story, not the closing page`);
    }
  }

  pages.forEach((page, index) => {
    if (/{{\s*photo\d+detail\d+Color/i.test(page) && !/color\s*:\s*(?:#|rgba?\(|var\()/i.test(page)) {
      issues.push(`page ${index + 1}: the annotation label needs an explicit contrasting text colour`);
    }
  });

  // The studio draws the only callouts. A model drawn circle, ring or dashed
  // leader is rejected so it can never print as a stray mark or invisible text.
  pages.forEach((page, index) => {
    if (/border[^;{}]*(dashed|dotted)/i.test(page)) {
      issues.push(`page ${index + 1}: do not draw leaders or callouts; the studio adds them after the design`);
    }
    if (/border-radius/i.test(page)) {
      issues.push(`page ${index + 1}: do not draw circles, rings or rounded cards; the studio adds the material callouts`);
    }
    if (/transform\s*:\s*rotate/i.test(page)) {
      issues.push(`page ${index + 1}: do not draw diagonal leaders or rotated annotation lines over a picture`);
    }
  });

  // Black caption bars and dark text panels look cheap on paper. Only a full
  // page ground or a brand plate may be dark.
  for (const match of whole.matchAll(/<div[^>]*style="[^"]*background\s*:\s*#(?:0[0-9a-f]|1[0-9a-f]|2[0-9a-f])[0-9a-f]{3}[^"]*"[^>]*>([\s\S]{0,400}?)<\/div>/gi)) {
    const text = match[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (text.length >= 3) {
      issues.push('do not set text inside a black or dark filled box; set it on the paper');
      break;
    }
  }

  // Palette strips are drawn by the studio on each picture plate. A designer
  // page that carries palette tokens is putting colours on the wrong page.
  if (/\{\{\s*photo\d+Palette\s*\}\}/i.test(whole)) {
    issues.push('do not print palette strips on a page; the studio prints each picture palette on its plate');
  }

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
      tokens[`${key}detail${detail.index}X`] = String(Number(detail.x ?? 50).toFixed(1));
      tokens[`${key}detail${detail.index}Y`] = String(Number(detail.y ?? 50).toFixed(1));
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
/**
 * Read the visual taste of the supplied pictures: the palette itself, its
 * shares, the overall tone, the warmth and the contrast. The book style must
 * inherit this, never a fixed house beige or teal.
 */
/**
 * The art direction for one book, computed only from the supplied pictures.
 * This is what makes every brochure feel made for its own photographs: the
 * tone words, the palette shares and the focal details are read from the set.
 */
export function artDirectionFor({ photoPalettes = {}, pictureAnalysis = [] } = {}) {
  const taste = pictureTaste(photoPalettes);
  const palette = taste.colours
    .slice(0, 6)
    .map((colour) => `${colour.name} ${colour.hex}`)
    .join(', ');
  const details = (Array.isArray(pictureAnalysis) ? pictureAnalysis : [])
    .flatMap((picture) => (picture?.details ?? []).slice(0, 2))
    .filter(Boolean)
    .slice(0, 6);
  const concept =
    taste.tone === 'deep and low lit'
      ? 'a dark, cinematic volume where the photographs carry the light and the type stays quiet and precise'
      : taste.tone === 'light and airy'
        ? 'a light, architectural volume with generous air, full bleed daylight photographs and fine typographic lines'
        : 'a calm, material led volume with measured rhythm, close photographs and restrained typography';
  return {
    taste,
    palette,
    details,
    concept,
    text: `${concept}. Tone ${taste.tone}, ${taste.warmth}, ${taste.contrast} contrast. Palette read from the pictures: ${palette || 'derived from the supplied palettes'}. Focal details seen: ${details.length > 0 ? details.join(', ') : 'handles, edges, grain'}.`,
  };
}

export function pictureTaste(photoPalettes = {}) {
  const entries = Object.entries(photoPalettes)
    .filter(([key, palette]) => /^photo\d+$/.test(key) && Array.isArray(palette) && palette.length > 0)
    .flatMap(([, palette]) => palette.filter((hex) => hexRgb(hex)));
  if (entries.length === 0) {
    return { tone: 'warm neutral', warmth: 'neutral', contrast: 'balanced', colours: [] };
  }
  const counts = new Map();
  for (const hex of entries) {
    const key = hex.toUpperCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const total = entries.length;
  const colours = [...counts.entries()]
    .map(([hex, count]) => ({ hex, name: colourName(hex), share: Math.round((count / total) * 100) }))
    .sort((left, right) => luminanceOf(right.hex) - luminanceOf(left.hex));
  const averageLuminance =
    colours.reduce((sum, colour) => sum + luminanceOf(colour.hex), 0) / colours.length;
  const lightness = colours.reduce(
    (sum, colour) => sum + (colour.share / 100) * luminanceOf(colour.hex),
    0,
  );
  const lu = averageLuminance;
  const tone = lu < 0.3 ? 'deep and low lit' : lu > 0.55 ? 'light and airy' : 'mid toned and calm';
  const [ar, ag, ab] = colours
    .map((colour) => hexRgb(colour.hex))
    .reduce(([r, g, b], [cr, cg, cb]) => [r + cr, g + cg, b + cb], [0, 0, 0])
    .map((value) => value / colours.length);
  const warmthValue = ar - ab;
  const warmth = warmthValue > 14 ? 'warm' : warmthValue < -14 ? 'cool' : 'neutral';
  const darkest = Math.min(...colours.map((colour) => luminanceOf(colour.hex)));
  const lightest = Math.max(...colours.map((colour) => luminanceOf(colour.hex)));
  const contrast = lightest - darkest > 0.55 ? 'high' : 'soft';
  return { tone, warmth, contrast, colours, lightness: Number((lightness * lightness).toFixed(2)) };
}

/**
 * Make the pictures the law of the palette. Any literal colour the model
 * invented that is not in the picture theme is remapped to the nearest theme
 * colour, so a book can never drift into a house beige or a random accent.
 */
export function applyPictureTheme(html, theme) {
  const source = String(html ?? '');
  if (!theme) return source;
  const allowed = [
    theme.paper,
    theme.ink,
    theme.deep,
    theme.accent,
    theme.gold,
    theme.hair,
    theme.muted,
    theme.onDark,
  ].filter((hex) => hexRgb(hex));
  const neutral = (hex) => {
    const [r, g, b] = hexRgb(hex);
    const max = Math.max(r, g, b) / 255;
    const min = Math.min(r, g, b) / 255;
    const light = (max + min) / 2;
    return light > 0.9 || light < 0.08 || Math.max(r, g, b) - Math.min(r, g, b) < 26;
  };
  const distance = (left, right) => {
    const [ar, ag, ab] = hexRgb(left);
    const [br, bg, bb] = hexRgb(right);
    return Math.hypot(ar - br, ag - bg, ab - bb);
  };
  const map = new Map();
  return source.replace(/#[0-9a-fA-F]{6}\b/g, (match) => {
    const hex = match.toUpperCase();
    if (map.has(hex)) return map.get(hex);
    if (neutral(hex) || allowed.some((colour) => distance(hex, colour) <= 40)) {
      map.set(hex, match);
      return match;
    }
    const nearest = [...allowed].sort((left, right) => distance(hex, left) - distance(hex, right))[0];
    const replacement = nearest ?? match;
    map.set(hex, replacement);
    return replacement;
  });
}

/** True when the client themselves named a colour or a hex code. */
export function clientNamedColour(text) {
  const value = String(text ?? '');
  if (/#[0-9a-fA-F]{6}\b/.test(value)) return true;
  const COLOUR_WORDS =
    /\b(red|blue|green|black|white|cream|ivory|beige|brown|walnut|oak|teak|grey|gray|charcoal|gold|brass|copper|silver|sage|olive|navy|pink|rose|terracotta|mustard|teal|maroon|burgundy|lavender|peach|sand|stone|oat|taupe|espresso|cherry|maple|birch|ash|mint|emerald|sapphire)\b/i;
  return COLOUR_WORDS.test(value);
}

/**
 * The whole visual signature, read from the pictures: ground, display type,
 * margin, image scale, rule weight and the way type behaves. Palette alone is
 * not taste; this is what makes two picture sets produce two different books.
 */
export function styleProfileFor(photoPalettes = {}, pictureAnalysis = []) {
  const taste = pictureTaste(photoPalettes);
  const deep = taste.tone === 'deep and low lit';
  const airy = taste.tone === 'light and airy';
  const warm = taste.warmth === 'warm';
  const details = (Array.isArray(pictureAnalysis) ? pictureAnalysis : []).flatMap(
    (picture) => picture?.details ?? [],
  );
  const styleEntries = (Array.isArray(pictureAnalysis) ? pictureAnalysis : [])
    .map((picture) => picture?.style)
    .filter((style) => style && typeof style === 'object');
  const styleMood = styleEntries.map((style) => style.mood ?? '').filter(Boolean).join(' ');
  const styleMaterials = [...new Set(styleEntries.flatMap((style) => style.materials ?? []))];
  const styleLight = styleEntries.map((style) => style.light ?? '').filter(Boolean).join(' ');
  const styleComposition = styleEntries.map((style) => style.composition ?? '').filter(Boolean).join(' ');
  const modern =
    /minimal|modern|architectural|contemporary|sharp|graphic|cool/i.test(styleMood) ||
    styleMaterials.some((material) => /metal|glass|stone|concrete|steel|aluminium/i.test(material));
  const classic =
    /warm|traditional|classic|heritage|rich|cosy|cozy|rustic/i.test(styleMood) ||
    styleMaterials.some((material) => /oak|teak|walnut|wood|brass|rattan|linen/i.test(material));
  const serif = classic || (warm && !modern) || !deep;
  const marginMm = airy ? 22 : deep ? 18 : 20;
  const displayFont = serif
    ? "'Instrument Serif', Georgia, serif"
    : "'Barlow', Helvetica, Arial, sans-serif";
  const directives = [
    `The book reads ${taste.tone}, ${taste.warmth}, ${taste.contrast} contrast, so the design must look like that and not like a neutral template.`,
    `Page ground: ${deep ? 'let the deep picture tones and dark grounds lead the quiet sides, with light type' : airy ? 'paper light grounds, generous air, daylight pages' : 'calm mid tone grounds with measured contrast'}.`,
    `Display type: ${serif ? 'the serif voice, because the pictures are warm and material' : 'the sans voice, stripped and architectural, because the pictures are cool and high contrast'}.`,
    `Outer margin: ${marginMm} mm; keep that discipline on every side.`,
    `Photographs: ${details.length >= 3 ? 'one dominant whole picture per side, close and generous, with the callouts doing the small detail work' : 'large whole pictures with real air around them'}.`,
    `Rules and labels: hairline weight, wide tracked small caps, quiet and precise. ${deep ? 'Light type over dark grounds, never a mid tone mush.' : 'Dark type over paper, never a heavy black slab unless the picture needs it.'}`,
    styleEntries.length > 0
      ? `Take the aesthetic from the pictures themselves: mood ${styleMood || taste.tone}; materials ${styleMaterials.join(', ') || 'as seen'}; light ${styleLight || 'as photographed'}; composition ${styleComposition || 'as framed'}. The type, framing, caption style and page ground must feel related to these, not borrowed from another project.`
      : 'Take the aesthetic from the pictures themselves: their light, materials and composition, not from a house style.',
  ];
  return { taste, deep, airy, warm, serif, displayFont, marginMm, directives };
}

export function themeFromPalettes(photoPalettes = {}) {
  const colours = Object.values(photoPalettes).flat().filter((hex) => hexRgb(hex));
  if (colours.length === 0) return { ...PALETTE };
  const sorted = [...colours].sort((a, b) => luminanceOf(b) - luminanceOf(a));
  const paperCandidate = sorted[0];
  const inkCandidate = sorted[sorted.length - 1];
  // Paper comes from the pictures too. A dark or saturated set gets a tinted
  // paper mixed from its own lightest tone, not the house cream.
  let paper =
    luminanceOf(paperCandidate) > 0.55
      ? paperCandidate
      : mix(paperCandidate, '#FFFFFF', 0.78);
  // A printed page needs a light enough ground for dark type.
  for (let step = 0; step < 8 && luminanceOf(paper) < 0.84; step += 1) {
    paper = mix(paper, '#FFFFFF', 0.14);
  }
  if (luminanceOf(paper) < 0.8) paper = PALETTE.paper;
  const ink = luminanceOf(inkCandidate) < 0.3 ? inkCandidate : PALETTE.ink;
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

function pageCss(theme, profile) {
  const palette = theme ?? PALETTE;
  const displayFont = profile?.displayFont ?? "'Instrument Serif', Georgia, serif";
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
  --display: ${displayFont};
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
/** Natural size of a data URI picture, so callout marks sit on the photo, not its letterbox. */
function pictureSizeFromDataUri(source) {
  const value = String(source ?? '');
  let buffer = null;
  const match = /^data:image\/[a-zA-Z0-9.+-]+;base64,(.*)$/s.exec(value);
  if (match) {
    try {
      buffer = Buffer.from(match[1], 'base64');
    } catch {
      return null;
    }
  } else if (value.startsWith('file://')) {
    try {
      buffer = readFileSync(fileURLToPath(value));
    } catch {
      return null;
    }
  } else {
    return null;
  }
  if (buffer.length > 24 && buffer[0] === 0x89 && buffer[1] === 0x50) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let index = 2;
    while (index + 9 < buffer.length) {
      if (buffer[index] !== 0xff) { index += 1; continue; }
      const marker = buffer[index + 1];
      const length = buffer.readUInt16BE(index + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: buffer.readUInt16BE(index + 7), height: buffer.readUInt16BE(index + 5) };
      }
      index += 2 + length;
    }
  }
  return null;
}

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

  // Material callout pages, drawn by the server so the annotation is always
  // visible and always matches the paint card reference.
  // Material callouts, drawn by the studio. Marks use the real photograph
  // geometry, so a ring always lands on the picture and never in the letterbox.
  // Every line has a white halo under the black mark so it reads on any
  // background: white joinery, dark walnut, marble or a photograph.
  const PLATE = { left: 33, top: 44, width: 160, maxHeight: 165 };
  const showsWholePicture = (pageHtml, number) => {
    const pattern = new RegExp(`<img[^>]*src="\\{\\{\\s*photo${number}\\s*\\}\\}"[^>]*>`, 'gi');
    for (const match of String(pageHtml).matchAll(pattern)) {
      const style = /style="([^"]*)"/i.exec(match[0])?.[1] ?? '';
      const widthMm = Number(/width\s*:\s*([0-9.]+)mm/i.exec(style)?.[1] ?? 0);
      if (/background-size\s*:\s*contain/i.test(style) && widthMm >= 120) return true;
    }
    return false;
  };
  const annotationPages = [];
  for (let index = 0; index < photoTokens.length; index += 1) {
    const uri = photoTokens[index];
    if (!uri) continue;
    const key = `photo${index + 1}`;
    const details = Array.isArray(photoDetails[key]) ? photoDetails[key] : [];
    if (details.length === 0 && pages.some((page) => showsWholePicture(page, index + 1))) continue;
    const natural = pictureSizeFromDataUri(uri) ?? { width: 3, height: 2 };
    const scale = Math.min(PLATE.width / natural.width, PLATE.maxHeight / natural.height);
    const displayWidth = Math.max(30, natural.width * scale);
    const displayHeight = Math.max(30, natural.height * scale);
    const photoLeft = PLATE.left + (PLATE.width - displayWidth) / 2;
    const photoTop = PLATE.top;
    const photoRight = photoLeft + displayWidth;
    const photoBottom = photoTop + displayHeight;
    const placements = details.slice(0, 3).map((detail) => {
      const x = Math.min(94, Math.max(6, Number(detail.x ?? 50)));
      const y = Math.min(92, Math.max(8, Number(detail.y ?? 50)));
      const px = photoLeft + (x / 100) * displayWidth;
      const py = photoTop + (y / 100) * displayHeight;
      const distances = [
        { side: 'left', d: px - photoLeft },
        { side: 'right', d: photoRight - px },
        { side: 'top', d: py - photoTop },
        { side: 'bottom', d: photoBottom - py },
      ].sort((left, right) => left.d - right.d);
      return { detail, px, py, side: distances[0].side };
    });
    const marks = placements
      .map(({ px, py }) => {
        const x = px.toFixed(1);
        const y = py.toFixed(1);
        return (
          `<div style="position:absolute;left:${x}mm;top:${y}mm;width:2.9mm;height:2.9mm;margin:-1.45mm 0 0 -1.45mm;border:0.22mm solid #FFFFFF;border-radius:50%;"></div>` +
          `<div style="position:absolute;left:${x}mm;top:${y}mm;width:2.1mm;height:2.1mm;margin:-1.05mm 0 0 -1.05mm;border:0.22mm solid #000;border-radius:50%;"></div>`
        );
      })
      .join('');
    const labels = placements
      .map(({ detail, px, py, side }, placementIndex) => {
        const number = String(placementIndex + 1).padStart(2, '0');
        const code = `${escapeHtml(detail.name ?? 'Colour')} ${escapeHtml(detail.colour ?? '')}`;
        const caption = escapeHtml(String(detail.label ?? 'Material detail')).slice(0, 30);
        const text = `<span style="font-weight:600;letter-spacing:0.14em;">${number} · ${code}</span><br><span style="font-size:5.3pt;letter-spacing:0.12em;color:#5A5A5A;">${caption}</span>`;
        const style = `color:#000;font-family:var(--body);font-size:5.8pt;line-height:1.5;letter-spacing:0.05em;`;
        if (side === 'right') {
          return `<div style="position:absolute;left:${(photoRight + 8).toFixed(1)}mm;top:${(py - 2.2).toFixed(1)}mm;width:${Math.max(18, Math.min(26, 212 - photoRight - 8)).toFixed(1)}mm;${style}text-align:left;">${text}</div>`;
        }
        if (side === 'left') {
          const width = Math.max(18, Math.min(26, photoLeft - 8));
          return `<div style="position:absolute;left:${Math.max(2, photoLeft - 8 - width).toFixed(1)}mm;top:${(py - 2.2).toFixed(1)}mm;width:${width.toFixed(1)}mm;${style}text-align:right;">${text}</div>`;
        }
        if (side === 'top') {
          return `<div style="position:absolute;left:${px.toFixed(1)}mm;top:${Math.max(40, photoTop - 18).toFixed(1)}mm;transform:translateX(-50%);white-space:nowrap;${style}text-align:center;">${text}</div>`;
        }
        return `<div style="position:absolute;left:${px.toFixed(1)}mm;top:${Math.min(215, photoBottom + 9).toFixed(1)}mm;transform:translateX(-50%);white-space:nowrap;${style}text-align:center;">${text}</div>`;
      })
      .join('');
    const leaders = placements
      .map(({ px, py, side }) => {
        const x = px.toFixed(1);
        const y = py.toFixed(1);
        const dot = (attrs) => `<div style="position:absolute;${attrs};border:0;"> </div>`;
        const hLine = (left, width) =>
          `<div style="position:absolute;left:${left.toFixed(1)}mm;top:${y}mm;width:${Math.max(1.2, width).toFixed(1)}mm;border-top:0.18mm solid #FFFFFF;"></div>` +
          `<div style="position:absolute;left:${left.toFixed(1)}mm;top:${y}mm;width:${Math.max(1.2, width).toFixed(1)}mm;border-top:0.2mm dotted #000;"></div>`;
        const vLine = (left, top, height) =>
          `<div style="position:absolute;left:${left}mm;top:${top.toFixed(1)}mm;height:${Math.max(1.2, height).toFixed(1)}mm;border-left:0.18mm solid #FFFFFF;"></div>` +
          `<div style="position:absolute;left:${left}mm;top:${top.toFixed(1)}mm;height:${Math.max(1.2, height).toFixed(1)}mm;border-left:0.2mm dotted #000;"></div>`;
        const arrow = (kind, edge) => {
          if (kind === 'right') {
            return `<div style="position:absolute;left:${(edge - 3).toFixed(1)}mm;top:${(py - 1.9).toFixed(1)}mm;width:0;height:0;border-top:1.9mm solid transparent;border-bottom:1.9mm solid transparent;border-left:3.2mm solid #FFFFFF;"></div>` +
              `<div style="position:absolute;left:${(edge - 2.4).toFixed(1)}mm;top:${(py - 1.4).toFixed(1)}mm;width:0;height:0;border-top:1.4mm solid transparent;border-bottom:1.4mm solid transparent;border-left:2.4mm solid #000;"></div>`;
          }
          if (kind === 'left') {
            return `<div style="position:absolute;left:${(edge - 0.4).toFixed(1)}mm;top:${(py - 1.9).toFixed(1)}mm;width:0;height:0;border-top:1.9mm solid transparent;border-bottom:1.9mm solid transparent;border-right:3.2mm solid #FFFFFF;"></div>` +
              `<div style="position:absolute;left:${edge.toFixed(1)}mm;top:${(py - 1.4).toFixed(1)}mm;width:0;height:0;border-top:1.4mm solid transparent;border-bottom:1.4mm solid transparent;border-right:2.4mm solid #000;"></div>`;
          }
          if (kind === 'top') {
            return `<div style="position:absolute;left:${(px - 1.9).toFixed(1)}mm;top:${(edge - 0.4).toFixed(1)}mm;width:0;height:0;border-left:1.9mm solid transparent;border-right:1.9mm solid transparent;border-bottom:3.2mm solid #FFFFFF;"></div>` +
              `<div style="position:absolute;left:${(px - 1.4).toFixed(1)}mm;top:${edge.toFixed(1)}mm;width:0;height:0;border-left:1.4mm solid transparent;border-right:1.4mm solid transparent;border-bottom:2.4mm solid #000;"></div>`;
          }
          return `<div style="position:absolute;left:${(px - 1.9).toFixed(1)}mm;top:${(edge - 2.8).toFixed(1)}mm;width:0;height:0;border-left:1.9mm solid transparent;border-right:1.9mm solid transparent;border-top:3.2mm solid #FFFFFF;"></div>` +
            `<div style="position:absolute;left:${(px - 1.4).toFixed(1)}mm;top:${(edge - 2.4).toFixed(1)}mm;width:0;height:0;border-left:1.4mm solid transparent;border-right:1.4mm solid transparent;border-top:2.4mm solid #000;"></div>`;
        };
        if (side === 'right') {
          return hLine(px + 2.1, photoRight + 4 - (px + 2.1)) + arrow('right', photoRight + 4);
        }
        if (side === 'left') {
          return hLine(photoLeft - 4, px - 2.1 - (photoLeft - 4)) + arrow('left', photoLeft - 4);
        }
        if (side === 'top') {
          return vLine(x, photoTop - 10, py - (photoTop - 10)) + arrow('top', photoTop - 10);
        }
        return vLine(x, py + 2.1, photoBottom + 8 - (py + 2.1)) + arrow('bottom', photoBottom + 8);
      })
      .join('');
    const palette = Array.isArray(photoPalettes[key]) ? photoPalettes[key].slice(0, 4) : [];
    const chips = palette
      .map(
        (hex) =>
          `<div style="width:33mm;"><div style="height:20mm;background:${hex};border:0.2mm solid #D9D0C1;"></div>` +
          `<div style="margin-top:1.6mm;font-size:5.6pt;line-height:1.3;letter-spacing:0.08em;color:#000;">${escapeHtml(colourName(hex))}<br><span style="color:#6E6E73;">${hex}</span></div></div>`,
      )
      .join('');
    const hasBottomLabel = placements.some((entry) => entry.side === 'bottom');
    const paletteTop = Math.min(244, photoBottom + (hasBottomLabel ? 26 : 10));
    const materialLine = details
      .map((detail) => String(detail.label ?? '').trim())
      .filter(Boolean)
      .slice(0, 3)
      .join(' · ');
    annotationPages.push(
      `<div style="position:absolute;inset:0;background:#F7F2E9;color:#000;font-family:var(--body);">` +
        `<div style="position:absolute;left:33mm;top:20mm;font-size:6.4pt;letter-spacing:0.24em;text-transform:uppercase;color:#8A7A66;">Colour and material</div>` +
        `<img src="${uri}" style="position:absolute;left:${photoLeft.toFixed(1)}mm;top:${photoTop.toFixed(1)}mm;width:${displayWidth.toFixed(1)}mm;height:${displayHeight.toFixed(1)}mm;object-fit:cover;">` +
        marks + leaders + labels +
        (chips === ''
          ? ''
          : `<div style="position:absolute;left:33mm;top:${paletteTop.toFixed(0)}mm;width:150mm;display:flex;gap:4mm;">${chips}</div>`) +
        `<div style="position:absolute;left:33mm;right:33mm;top:${Math.min(238, paletteTop + 38).toFixed(0)}mm;height:0.25mm;background:#D9D0C1;"></div>` +
        `<div style="position:absolute;left:33mm;right:33mm;top:${Math.min(246, paletteTop + 46).toFixed(0)}mm;text-align:center;font-family:var(--display);font-size:15pt;line-height:1.2;color:#201F1C;">The room, in the colours it already holds.</div>` +
        `<div style="position:absolute;left:33mm;right:33mm;bottom:10mm;text-align:center;font-size:6.2pt;letter-spacing:0.2em;text-transform:uppercase;color:#8A7A66;">JACOB DESIGN STUDIO · NAGERCOIL</div>` +
        `</div>`,
    );
  }
  // Every page carries the studio mark. It is stamped by the server, so the
  // model can not omit it, and it sits on a small cream plate so it reads on
  // cream, dark or photographic grounds without becoming a watermark.
  let pageMark = '';
  try {
    const logoData = readFileSync(path.join(templatesDir, 'assets', 'jacob-mark.png')).toString('base64');
    pageMark =
      `<div class="page-brand" style="position:absolute;left:14mm;bottom:8mm;z-index:90;background:#F7F2E9;padding:1mm 1.8mm;">` +
      `<img src="data:image/png;base64,${logoData}" style="display:block;width:8mm;height:auto;">` +
      `</div>`;
  } catch {
    pageMark = '';
  }
  const withPageMark = (page) => (pageMark === '' ? page : page + pageMark);
  const allPages = [...docPages.map(withPageMark), ...annotationPages.map(noDashes).map(withPageMark)];
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(values.title)}</title>
<link rel="stylesheet" href="../fonts/brand.css">
<style>${pageCss(themeFromPalettes(photoPalettes), styleProfileFor(photoPalettes))}</style>
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
