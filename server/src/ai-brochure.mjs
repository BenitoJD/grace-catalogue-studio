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

export const DESIGNER_MAX_TOKENS = 12000;
export const DESIGNER_TEMPERATURE = 0.85;
export const DESIGNER_TRIES = 2;
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
  'The brochure is as long as its content: at least four pages, at most eight. More photographs and their palettes earn more pages. Fill every page completely.',
  '',
  'THE PAGES, IN ORDER',
  '1. Cover. One commanding photograph, the brand, the piece title, the customer and the room. Almost nothing else. The photograph does the work.',
  '2 to 7. Story and colour. The written copy set like an editorial spread: the headline as the one large line, the body in calm columns, the closing line small and quiet, with one or two photographs. At least one page is the palette study: each photograph\'s colour strip shown at size with its hex values and a short name for the mood it creates. Extra photographs earn extra pages, and every photograph must appear.',
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
  'Identity: {{brand}}, {{brandTamil}}, {{placeTamil}}, {{orderNo}}, {{date}}, {{title}}, {{room}}, {{roomTamil}}, {{customer}}, {{phone}}, {{email}}, {{address}}.',
  'Photographs: {{photo1}} and upward are ready to use as a CSS background-image or an <img> source. Crop with cover. Choose the strongest photograph for the cover.',
  'Colour: every photograph has a palette strip {{photo1Palette}}, {{photo2Palette}} and so on, a ready made image of its colours. It also has single colours {{photo1Color1}} to {{photo1Color4}}, {{photo2Color1}} to {{photo2Color4}}, and so on, ready to use as text colour or background colour.',
  'Assets: {{logo}} is the brand mark. {{jaali}}, {{paisley}}, {{lotus}}, {{rangoli}} and {{arch}} are the house motifs, usable in an <img> or as a background-image.',
  '',
  'REQUIRED',
  '- Page 1, the cover: at least one photograph, {{title}}, {{customer}}, {{brand}} or {{logo}}, and {{brandTamil}} or {{roomTamil}}.',
  '- {{headline}}, {{body}} and {{closing}} each exactly once, anywhere in the story pages.',
  '- Every photograph token from {{photo1}} to the last available must appear at least once.',
  '- Every palette strip token must appear at least once, on the colour pages. Next to each strip print its four colours as small chips or as hex values using that photograph\'s colour tokens, with a short name for the mood.',
  '- The last page: {{brand}} or {{logo}}, {{orderNo}} and {{phone}}.',
  '- Somewhere in the document: at least one house motif token.',
  '- No dimension, size, shutter count or specification value may appear. Those tokens do not exist and naming them rejects the document.',
  '- The photographs are the design source. Mirror their colours, light and warmth. The pages must look like they belong to the same project as the pictures.',
  '- Magnifier callouts: when the studio asks to magnify a detail (a handle, a grain, a colour palette, an edge), draw a circular loupe on the page. Use the same photograph enlarged: background-size 300% to 420%, background-position set to the detail, a thin ring, a short leader line and a small label naming the detail. Show one loupe per named detail and never a loupe without a label.',
  '- When the studio asks for a colour palette callout, print the palette strip or its four chips beside a loupe of the pictured detail, with the mood name underneath.',
  '',
  'DESIGN RULES',
  '- Print design, not web design. No cards, rounded corners, drop shadows, buttons, icons, badges, glass, or gradients except a soft photograph scrim.',
  '- One dominant ground, one ink, one accent. Gold is a line, a number or a motif, never a large fill. A deep colour may carry a band or a whole page. Never set body text in gold on cream.',
  '- Build a real typographic hierarchy: one display line, small caps labels with wide tracking, hairline rules, captions, folio numbers. Use white space as a material.',
  '- Compose each page. Vary alignment, scale and the position of the photograph. The cover should not be the generic centred logo, title, framed photo and footer stack; react to the photograph instead. Try type across the image low, a tall split, a masthead, an arch, an asymmetric page with a deep quiet margin.',
  '- Never set light text straight on a photograph unless it sits on a dark scrim, a solid band or a genuinely quiet dark area of the picture. The renderer can not see how bright the photograph is, so assume it is pale.',
  '- Colour strips are images, not pale samples: frame each one with a hairline rule or a keyline so it reads as a colour plate.',
  '- Tamil is set tight and whole: never letter-space, uppercase or small-cap a Tamil line, and never set it below 7.5 pt. Keep Tamil in a line of its own.',
  '- Ornament once or twice in the whole document, at a corner or a rule: a jaali strip along one edge, a lotus under a title, an arch around a photograph. Never all motifs on one page.',
  '- The cover is the loudest page, the story is the warmest, and the colour pages are a quiet chromatic study.',
  '- Use the whole safe area. Every page must feel complete: fill it with photograph, type and colour at full size rather than leaving a quarter of it empty. If the content does not fill the pages, use fewer pages; if it overflows, add a page up to the limit of eight. Keep the last line of a page at least 18 mm above the trim.',
  '- This brochure is one of many. Do not repeat a stock arrangement; the photographs, their colours and the room decide the composition.',
  '- Tamil lines are set in Noto Sans Tamil, never forced into an English serif.',
  '',
  'AVAILABLE TYPE',
  "'Instrument Serif' for display and headline, 'Barlow' for labels, captions and small text, 'Noto Sans Tamil' for Tamil.",
  'Colours come as CSS variables that you may refine at the top of your style block: --paper, --ink, --deep, --accent, --gold, --hair, --muted, --on-dark. Keep the paper light and the ink dark, and take the accent from the picture palettes supplied.',
  '',
  'VOICE OF THE PAGES',
  'Words are very few. The cover says almost nothing. The story carries the copy. The colour pages show the palette that the project is built from. A reader should feel the room and its colours before reading a sentence.',
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

function designContext({ order, brief, direction, copy, photos, photoShapes, photoPalettes, previousHtml, editNote }) {
  const photoLines = photos.map((_, index) => {
    const shape = photoShapes[index] ? ` (${photoShapes[index]})` : '';
    return `photo${index + 1}${shape}`;
  });
  const parts = [
    'ORDER',
    `Title: {{title}}`,
    `Room: {{room}}`,
    `Customer: {{customer}}`,
    `Order number: {{orderNo}}`,
    `Date: {{date}}`,
    '',
    'PHOTOGRAPHS AVAILABLE',
    photoLines.length > 0 ? photoLines.join('\n') : 'No photographs supplied.',
    '',
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

export function buildDesignerMessages({ order, brief = '', direction = '', copy, photos = [], photoShapes = [], photoPalettes = {}, previousHtml = '', editNote = '' }) {
  const user = designContext({ order, brief, direction, copy, photos, photoShapes, photoPalettes, previousHtml, editNote });
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
      'The body still needs four to eight <div class="page"> elements, the required tokens, and no external references.',
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
export const MAX_DESIGN_PAGES = 8;
const COVER_WORD_LIMIT = 60;
const MIDDLE_WORD_LIMIT = 280;
const SPEC_WORD_LIMIT = 300;

/**
 * Read the model's HTML reply. Returns the CSS and the four page bodies, or
 * throws an LlmError describing every problem that stops the document from
 * printing. The page wrappers are removed and rebuilt by the server, so the
 * body can never end up with content beside the pages.
 */
export function parseDesignerReply(content, photoCount = 4, palettePhotos = []) {
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
    issues.push(`it has ${pages.length} pages; use four to eight pages for the content`);
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
    ...[...Array(Math.max(1, photoCount)).keys()].flatMap((index) => {
      const n = index + 1;
      const tokensForPhoto = [`photo${n}`];
      if (palettePhotos.includes(n)) {
        tokensForPhoto.push(`photo${n}Palette`);
        for (let chip = 1; chip <= 4; chip += 1) tokensForPhoto.push(`photo${n}Color${chip}`);
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
  if (countToken(whole, 'orderNo') === 0) issues.push('the order number token {{orderNo}} is missing');
  if (countToken(whole, 'phone') === 0) issues.push('the contact token {{phone}} is missing');
  if (!MOTIF_TOKENS.some((token) => countToken(whole, token) > 0)) {
    issues.push('no house motif is used');
  }
  if (countToken(whole, 'title') === 0) issues.push('the title token {{title}} is missing');
  if (countToken(whole, 'customer') === 0) issues.push('the customer token {{customer}} is missing');
  if (countToken(whole, 'brandTamil') + countToken(whole, 'roomTamil') === 0) {
    issues.push('no Tamil line is used');
  }
  if (countToken(whole, 'brand') + countToken(whole, 'logo') === 0) {
    issues.push('the brand is not named');
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
    }
  }

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
    if (countToken(pages[0], 'brand') + countToken(pages[0], 'logo') === 0) {
      issues.push('the cover does not carry the brand');
    }
    if (countToken(pages[0], 'brandTamil') + countToken(pages[0], 'roomTamil') === 0) {
      issues.push('the cover has no Tamil line');
    }
  }
  if (middle.length > 0) {
    for (const token of COPY_TOKENS) {
      if (countToken(middleHtml, token) === 0) issues.push(`the story is missing {{${token}}}`);
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
    if (countToken(lastHtml, 'brand') + countToken(lastHtml, 'logo') === 0) {
      issues.push('the last page does not carry the brand');
    }
    if (countToken(lastHtml, 'orderNo') === 0) issues.push('the last page is missing {{orderNo}}');
    if (countToken(lastHtml, 'phone') === 0) issues.push('the last page is missing {{phone}}');
    for (const token of COPY_TOKENS) {
      if (countToken(lastHtml, token) > 0) issues.push(`{{${token}}} belongs in the story, not the closing page`);
    }
    for (const index of palettePhotos) {
      if (countToken(pages[last], `photo${index}Palette`) > 0) {
        issues.push('the photograph colour strip belongs on a colour page, not the closing page');
      }
    }
  }

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

function buildTokenValues({ values, photos, copy, photoPalettes = {} }) {
  const tokens = {
    brand: BRAND.name,
    brandTamil: BRAND.tamil,
    placeTamil: BRAND.placeTamil,
    phone: BRAND.phone,
    email: BRAND.email,
    address: BRAND.address,
    orderNo: valueOr(values.orderNo, 'Order number to follow'),
    date: valueOr(values.date, ''),
    title: valueOr(values.title, 'Custom wardrobe'),
    room: valueOr(values.room, 'Room to confirm'),
    roomTamil: tamilRoom(values),
    customer: valueOr(values.customerName, 'Customer'),
    headline: clean(copy?.headline),
    body: clean(copy?.body),
    closing: clean(copy?.closing),
    logo: ASSETS.logo,
    jaali: ASSETS.jaali,
    paisley: ASSETS.paisley,
    lotus: ASSETS.lotus,
    rangoli: ASSETS.rangoli,
    arch: ASSETS.arch,
  };
  photos.forEach((photo, index) => {
    tokens[`photo${index + 1}`] = photo;
  });
  for (const [key, palette] of Object.entries(photoPalettes)) {
    if (!/^photo\d+$/.test(key) || !Array.isArray(palette) || palette.length === 0) continue;
    tokens[`${key}Palette`] = paletteStripPng(palette);
    for (let chip = 1; chip <= 4; chip += 1) {
      tokens[`${key}Color${chip}`] = palette[chip - 1] ?? palette[0];
    }
  }
  return tokens;
}

function fillTokens(html, tokens) {
  return String(html).replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (match, key) => {
    if (!(key in tokens)) return match;
    const value = tokens[key];
    if (typeof value !== 'string') return match;
    const raw = RAW_TOKENS.has(key) || key.endsWith('Palette') || key.endsWith('Image');
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

const PAGE_CSS = `
@page { size: 216mm 303mm; margin: 0; }
html, body { margin: 0; padding: 0; background: #fff; }
* { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
:root {
  --paper: ${PALETTE.paper};
  --ink: ${PALETTE.ink};
  --deep: ${PALETTE.deep};
  --accent: ${PALETTE.accent};
  --gold: ${PALETTE.gold};
  --hair: ${PALETTE.hair};
  --muted: ${PALETTE.muted};
  --on-dark: ${PALETTE.onDark};
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
  const tokens = buildTokenValues({ values, photos: photoTokens, copy, photoPalettes });

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
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(values.title)} · ${escapeHtml(values.orderNo)}</title>
<link rel="stylesheet" href="../fonts/brand.css">
<style>${PAGE_CSS}</style>
${docStyles ? `<style>${docStyles}</style>` : ''}
</head><body>
${docPages.map((page) => `<div class="page">${page}</div>`).join('\n')}
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
