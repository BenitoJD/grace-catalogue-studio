// The AI art director.
//
// Instead of picking one of the fixed brochure templates, the model designs a
// document for this order: a tone, a type pairing and a composition for each of
// the four pages. It also writes the headline, body and closing in the same
// call. This module turns that design into print safe HTML and validates it
// before anything is rendered.
import { LlmError, capText, clean, parseJsonObject } from './llm.mjs';
import { buildVoucherValues, escapeHtml } from './render.mjs';

export const TONES = ['maroon', 'teal', 'copper', 'sandal', 'peacock'];
const TONE_ALIASES = { ink: 'maroon', olive: 'teal', indigo: 'peacock', sand: 'sandal', gold: 'sandal' };
const INDIAN_PALETTES = {
  maroon: { id: 'maroon', accent: '#7C2A22', accentOnDark: '#E8C27A', accentSoft: '#F0D9C4', paper: '#FBF3E4', coverPaper: '#F8EDD8', ink: '#2A1512', muted: '#6B4A3E', faint: '#9C7A62', hair: '#E3D2B8', onDark: '#FBF3E4', dark: '#4A1116' },
  teal: { id: 'teal', accent: '#1E5C5A', accentOnDark: '#D9B76A', accentSoft: '#DDE9E2', paper: '#F8F3E6', coverPaper: '#F2EAD6', ink: '#142A28', muted: '#4C615C', faint: '#8A9C93', hair: '#D9D2BC', onDark: '#F8F3E6', dark: '#123B3A' },
  copper: { id: 'copper', accent: '#A65E22', accentOnDark: '#E8C27A', accentSoft: '#F0DCC4', paper: '#FBF4E7', coverPaper: '#F7EAD4', ink: '#2B1A0F', muted: '#6B4E36', faint: '#9E7E60', hair: '#E4D3B8', onDark: '#FBF4E7', dark: '#5A2A1E' },
  sandal: { id: 'sandal', accent: '#B4863F', accentOnDark: '#F0D9A8', accentSoft: '#F3E5C8', paper: '#FCF6E9', coverPaper: '#F8EDD5', ink: '#2E2113', muted: '#6E5738', faint: '#A08862', hair: '#E7D8BA', onDark: '#FCF6E9', dark: '#5B3A1B' },
  peacock: { id: 'peacock', accent: '#16537E', accentOnDark: '#E8C27A', accentSoft: '#DCE5EC', paper: '#F8F2E3', coverPaper: '#F2E8D2', ink: '#12222E', muted: '#4A5B66', faint: '#87949C', hair: '#D8D0BC', onDark: '#F8F2E3', dark: '#0D3350' },
};
export const TYPES = ['editorial', 'modern', 'classic'];
export const COVERS = ['fullBleed', 'splitLeft', 'splitRight', 'bandTop', 'framed', 'masthead'];
export const SPECS = ['twoColumn', 'threeColumn', 'ledger', 'cards', 'stacked'];
export const FINISHES = ['grid4', 'filmstrip', 'stacked', 'band', 'museum'];
export const INSIDES = ['photoEssay', 'diptych', 'heroStatement', 'splitStory'];

const TYPE_STACKS = {
  editorial: { display: "'Instrument Serif', Georgia, serif", body: "'Barlow', Helvetica, Arial, sans-serif" },
  modern: { display: "'Barlow', Helvetica, Arial, sans-serif", body: "'Barlow', Helvetica, Arial, sans-serif" },
  classic: { display: "'Instrument Serif', Georgia, serif", body: "'Barlow', Helvetica, Arial, sans-serif" },
};

const STORY_LAYOUTS = ['hero', 'editorial', 'diptych', 'collage'];
const MATERIALS_LAYOUTS = ['grid4', 'filmstrip', 'band', 'museum', 'stacked'];
const STORY_ALIASES = {
  photoEssay: 'hero',
  heroStatement: 'hero',
  splitStory: 'editorial',
  storyLeft: 'editorial',
  storyRight: 'editorial',
};

const DESIGN_KIT = [
  'You are the art director and copywriter for one printed brochure at Grace Wood Industry, a wardrobe and furniture workshop in Nagercoil.',
  'This is a brochure, not a report: it is picture led, quiet and premium, the kind of book a client keeps. The customer photographs and the material textures carry it; words are few and well set.',
  'Design four A4 portrait pages and write their words in one reply.',
  'Reply with strict JSON only, exactly this shape:',
  '{"design":{"tone":"maroon|teal|copper|sandal|peacock","type":"editorial|modern|classic","cover":"fullBleed|splitLeft|splitRight|bandTop|framed|masthead","story":"hero|editorial|diptych|collage","materials":"grid4|filmstrip|band|museum|stacked","spec":"twoColumn|threeColumn|ledger|cards|stacked","coverPhoto":0,"storyPhoto":1,"detailPhoto":2,"statement":"one calm line, at most 80 characters"},"copy":{"headline":"...","body":"...","closing":"..."}}',
  'The four pages:',
  '1. Cover. A strong photograph, the brand, the piece and the customer. Almost nothing else.',
  '2. Story. One or two photographs and the statement as a large line. The body sits small in a column, like a caption in a magazine.',
  '3. Materials. The four finish textures at size, names in small caps. This is a colour page, not a table.',
  '4. Specification. The technical details, set quietly at the back for the workshop and the client file, not the reason to open the brochure.',
  'Design rules:',
  '- Choose the tone and type that suit the room and the piece: maroon for classic warmth, teal for calm, copper for wood, sandal for gold, peacock for depth. Vary them from order to order.',
  '- Avoid the obvious default. A split cover with editorial type is the safe answer, so use it for at most one order in three. Prefer masthead, bandTop or framed covers, and mix modern and classic type.',
  '- If the user message includes a studio direction, let it decide the mood, palette and composition. Follow it where it fits the allowed values; where it conflicts, keep the design printable and choose the closest allowed option.',
  '- Choose the cover that suits the photographs: fullBleed for one strong photo, split for two, framed for a quieter document, masthead or bandTop for a graphic one.',
  '- coverPhoto, storyPhoto and detailPhoto are indexes into the available photographs, starting at 0. They may repeat if there is only one photo.',
  '- statement is the large line on the story page: a phrase, not a sentence of sales copy.',
  'Copy rules:',
  '- Headline at most 56 characters, understated and specific. Body 95 to 145 words. Closing at most 80 characters.',
  '- Voice: quiet confidence of a design house catalogue. Precise nouns, restrained adjectives, short rhythmic sentences with one longer line.',
  '- No second person: never "you", "your", "we" or "our". The piece is described, not sold.',
  '- Use only facts in the order and the brief. Never invent claims, certifications, prices or dates.',
  '- No em dashes, en dashes, exclamation marks, questions or emojis.',
  '- Banned words: premium, luxurious, luxury, bespoke, crafted, stunning, gorgeous, beautiful, perfect, amazing, elegant, timeless, elevate, seamless, transform, dream, oasis.',
  '- Never mention the order, brief or document. Never name the carcass, back panel or a material thickness.',
  '- Do not address the customer by name at the start of a sentence.',
  'No prose, markdown or code fences around the JSON.',
].join(' ');


export function buildAiBrochureMessages(order, brief, photoCount, direction = '') {
  const facts = [
    `Order: ${order.title}`,
    `Room: ${order.room}`,
    `Customer: ${order.customerName}`,
    `Width: ${order.width}`,
    `Height: ${order.height}`,
    `Depth: ${order.depth}`,
    `Shutters: ${order.shutters}`,
    `Exterior: ${order.exterior}`,
    `Interior: ${order.interior}`,
    `Handle: ${order.handle}`,
    `Drawers: ${order.drawers}`,
    `Edge band: ${order.edgeShutter}`,
    `Finish: ${order.finishExt}`,
  ].join('\n');
  return [
    { role: 'system', content: DESIGN_KIT },
    {
      role: 'user',
      content: [
        facts,
        `Photographs available: ${photoCount}.`,
        `Customer brief, use only what is useful:\n${clean(brief) || '(none supplied)'}`,
        clean(direction)
          ? `Studio direction for this brochure, follow it:\n${clean(direction)}`
          : 'Studio direction: none given. Choose the composition that suits the piece.',
      ].join('\n\n'),
    },
  ];
}

function pickEnum(value, allowed, field, fallback) {
  const text = clean(value);
  const match = allowed.find((entry) => entry.toLowerCase() === text.toLowerCase());
  if (match) return match;
  if (fallback) return fallback;
  throw new LlmError(`The design chose an unknown ${field} ("${text}").`, { type: 'invalid_reply' });
}

function pickPhoto(value, count, fallback = 0) {
  const index = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(index) || index < 0 || index >= Math.max(1, count)) return fallback;
  return index;
}

/** Parse and validate the model's design. Anything unclear is rejected. */
export function parseAiDesign(content, photoCount = 1) {
  const parsed = parseJsonObject(content);
  if (!parsed || typeof parsed !== 'object' || !parsed.design || !parsed.copy) {
    throw new LlmError('The brochure design could not be read. Generate it again.', {
      type: 'invalid_reply',
    });
  }
  const copy = {
    headline: capText(parsed.copy.headline, 120),
    body: capText(parsed.copy.body, 2400),
    closing: capText(parsed.copy.closing, 160),
  };
  if (copy.body.split(/\s+/).filter(Boolean).length < 60) {
    throw new LlmError('The brochure copy came back too thin. Generate it again.', {
      type: 'invalid_reply',
    });
  }
  const rawStory = clean(parsed.design.story ?? parsed.design.inside);
  const story = STORY_ALIASES[rawStory] ?? pickEnum(rawStory, STORY_LAYOUTS, 'story', 'editorial');
  const rawMaterials = clean(parsed.design.materials ?? parsed.design.finishes);
  const design = {
    tone: pickEnum(TONE_ALIASES[clean(parsed.design.tone).toLowerCase()] ?? parsed.design.tone, TONES, 'tone', 'maroon'),
    type: pickEnum(parsed.design.type, TYPES, 'type', 'editorial'),
    cover: pickEnum(parsed.design.cover, COVERS, 'cover', 'fullBleed'),
    story,
    materials: pickEnum(rawMaterials, MATERIALS_LAYOUTS, 'materials', 'grid4'),
    spec: pickEnum(parsed.design.spec, SPECS, 'spec', 'twoColumn'),
    coverPhoto: pickPhoto(parsed.design.coverPhoto, photoCount, 0),
    storyPhoto: pickPhoto(parsed.design.storyPhoto ?? parsed.design.insidePhoto, photoCount, 1),
    detailPhoto: pickPhoto(parsed.design.detailPhoto, photoCount, 0),
    statement: capText(parsed.design.statement, 100) || 'Made for the room it stands in.',
  };
  return { design, copy };
}

function paletteCss(palette) {
  return [
    ['accent', palette.accent],
    ['accent-on-dark', palette.accentOnDark],
    ['accent-soft', palette.accentSoft],
    ['paper', palette.paper],
    ['cover-paper', palette.coverPaper],
    ['ink', palette.ink],
    ['muted', palette.muted],
    ['faint', palette.faint],
    ['hair', palette.hair],
    ['on-dark', palette.onDark],
    ['dark', palette.dark],
  ]
    .map(([key, value]) => `--${key}: ${value};`)
    .join('\n');
}

const BASE_CSS = `
  @page { size: 216mm 303mm; margin: 0; }
  html, body { margin:0; padding:0; background:#fff; }
  * { box-sizing:border-box; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  .page { position:relative; width:216mm; height:303mm; overflow:hidden; page-break-after:always; background:var(--cream); }
  .page:last-child { page-break-after:auto; }
  .sheet { position:absolute; left:3mm; top:3mm; width:210mm; height:297mm; }
  .abs { position:absolute; }
  .ph { background-size:cover; background-position:center; background-repeat:no-repeat; }
  .micro { font-family:var(--body); font-size:6.4pt; letter-spacing:.22em; text-transform:uppercase; color:var(--deep); }
  .label { font-family:var(--body); font-size:7pt; letter-spacing:.2em; text-transform:uppercase; color:var(--deep); }
  .value { font-family:var(--body); font-size:8.4pt; line-height:1.4; color:var(--ink); }
  .head { font-family:var(--display); font-weight:400; color:var(--deep); line-height:1.0; letter-spacing:-.015em; }
  .serif { font-family:var(--display); font-weight:400; color:var(--deep); line-height:1.02; letter-spacing:-.01em; }
  .body { font-family:var(--body); font-size:8.2pt; line-height:1.58; color:var(--ink); }
  .caption { font-family:var(--body); font-size:7pt; line-height:1.5; color:var(--deep); }
  .rule { height:0.16mm; background:var(--hair); }
  .acc { background:var(--accent); }
  .folio { position:absolute; left:18mm; right:18mm; bottom:7.5mm; display:flex; justify-content:space-between; font-family:var(--body); font-size:6pt; letter-spacing:.16em; text-transform:uppercase; color:var(--deep); }
  .folioDark { color:rgba(255,255,255,0.72); }
  .row { display:flex; justify-content:space-between; align-items:baseline; gap:6mm; border-bottom:0.14mm solid var(--hair); padding:1.9mm 0; }
  .row .k { font-family:var(--body); font-size:7pt; letter-spacing:.14em; text-transform:uppercase; color:var(--deep); }
  .row .v { font-family:var(--body); font-size:8.2pt; color:var(--ink); text-align:right; }
  .body2col { display:flex; gap:7mm; }
  .body2col > div { flex:1; font-family:var(--body); font-size:8pt; line-height:1.56; color:var(--ink); }
  .band { background:var(--deep); color:var(--cream); }
  .goldLine { height:0.4mm; background:linear-gradient(90deg,#9A6A22 0%,#D9AE62 45%,#A8792E 100%); }
  .diamond { width:1.7mm; height:1.7mm; background:var(--gold); transform:rotate(45deg); }
  .swatchName { font-family:var(--display); font-size:10.5pt; line-height:1.2; color:var(--deep); margin-top:3mm; }
  .swatchIndex { font-family:var(--body); font-size:6.5pt; letter-spacing:.18em; color:var(--gold); margin-right:2.4mm; }
  .dropcap { font-family:var(--display); font-size:20pt; line-height:.8; float:left; padding:0 1.8mm 0 0; color:var(--accent); }
  .tamil { font-family:'Noto Sans Tamil', var(--body); letter-spacing:0; text-transform:none; }
  .jaali { background-image:url(../assets/indian/jaali.svg); background-repeat:repeat-x; background-size:auto 6mm; }
  .paisley { background-image:url(../assets/indian/paisley.svg); background-repeat:no-repeat; background-size:contain; }
  .lotus { background-image:url(../assets/indian/lotus.svg); background-repeat:no-repeat; background-size:contain; }
  .rangoli { background-image:url(../assets/indian/rangoli.svg); background-repeat:no-repeat; background-size:contain; }
  .arch { background-image:url(../assets/indian/temple-arch.svg); background-repeat:no-repeat; background-size:100% 100%; }
  .ornament { border:0.4mm solid var(--gold); }
  .ornamentInner { border:0.14mm solid var(--gold); }
  .white { color:var(--on-dark); }
`;

function rowsHtml(facts) {
  return facts
    .map(
      ([label, value]) =>
        `<div class="row"><div class="k">${escapeHtml(label)}</div><div class="v">${escapeHtml(value || 'Not set')}</div></div>`,
    )
    .join('');
}

function specGroups(values) {
  return [
    {
      title: 'Dimensions',
      facts: [
        ['Width', values.width],
        ['Height', values.height],
        ['Depth', values.depth],
        ['Shutters', values.shutters],
        ['Room', values.room],
      ],
    },
    {
      title: 'Materials',
      facts: [
        ['Shutter face', values.exterior],
        ['Interior', values.interior],
        ['Drawers', values.drawers],
        ['Edge band', values.edgeShutter],
        ['Finish', values.finishExt],
      ],
    },
    {
      title: 'Hardware',
      facts: [
        ['Handle', values.handle],
        ['Handle note', values.handleNote],
        ['Hinges', values.hinges],
        ['Channels', values.channels],
        ['Layout', `${values.layoutLeft}, ${values.layoutMiddle}, ${values.layoutRight}`],
      ],
    },
  ];
}

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
  const width = priceNumber(values.width) || 2400;
  const height = priceNumber(values.height) || 2100;
  const depth = priceNumber(values.depth) || 600;
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
  // bottom dimension
  lines.push(`<line x1="${x0}" y1="${(y0 + h + 10).toFixed(1)}" x2="${(x0 + w).toFixed(1)}" y2="${(y0 + h + 10).toFixed(1)}" stroke="${gold}" stroke-width="0.7"/>`);
  lines.push(`<line x1="${x0}" y1="${(y0 + h + 7).toFixed(1)}" x2="${x0}" y2="${(y0 + h + 13).toFixed(1)}" stroke="${gold}" stroke-width="0.7"/>`);
  lines.push(`<line x1="${(x0 + w).toFixed(1)}" y1="${(y0 + h + 7).toFixed(1)}" x2="${(x0 + w).toFixed(1)}" y2="${(y0 + h + 13).toFixed(1)}" stroke="${gold}" stroke-width="0.7"/>`);
  lines.push(`<text x="${(x0 + w / 2).toFixed(1)}" y="${(y0 + h + 19).toFixed(1)}" text-anchor="middle" font-family="Barlow" font-size="7" letter-spacing="1" fill="${ink}">${Math.round(width)}</text>`);
  // left dimension
  lines.push(`<line x1="${x0 - 10}" y1="${y0}" x2="${x0 - 10}" y2="${(y0 + h).toFixed(1)}" stroke="${gold}" stroke-width="0.7"/>`);
  lines.push(`<line x1="${x0 - 13}" y1="${y0}" x2="${x0 - 7}" y2="${y0}" stroke="${gold}" stroke-width="0.7"/>`);
  lines.push(`<line x1="${x0 - 13}" y1="${(y0 + h).toFixed(1)}" x2="${x0 - 7}" y2="${(y0 + h).toFixed(1)}" stroke="${gold}" stroke-width="0.7"/>`);
  lines.push(`<text x="${x0 - 15}" y="${(y0 + h / 2).toFixed(1)}" text-anchor="middle" font-family="Barlow" font-size="7" letter-spacing="1" fill="${ink}" transform="rotate(-90 ${x0 - 15} ${(y0 + h / 2).toFixed(1)})">${Math.round(height)}</text>`);
  // plan view
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

function drawingBlock(values, top = 158) {
  return `<div class="abs" style="left:18mm; top:${top}mm; width:174mm;"><div class="goldLine" style="width:174mm;"></div>
    <div class="abs" style="left:0; top:3mm; width:174mm; display:flex; justify-content:space-between;"><span class="micro">Measured drawing</span><span class="micro">All dimensions in mm</span></div>
    <img src="${elevationSvg(values)}" style="position:absolute; left:0; top:9mm; width:136mm; height:82mm;">
    <div class="abs" style="left:142mm; top:12mm; width:32mm; font-family:var(--body); font-size:7pt; line-height:1.6; color:var(--deep);">Drawn from the confirmed order, for the workshop and the site. Checked against the wall before cutting.</div>
    <div class="abs lotus" style="left:144mm; top:42mm; width:22mm; height:13mm;"></div>
  </div>`;
}

function columnsHtml(text, columns = 2) {
  const sentences = String(text)
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  const total = sentences.join(' ').length;
  const target = total / columns;
  const chunks = [];
  let current = '';
  for (const sentence of sentences) {
    const next = current === '' ? sentence : `${current} ${sentence}`;
    if (chunks.length < columns - 1 && next.length > target && current !== '') {
      chunks.push(current);
      current = sentence;
    } else {
      current = next;
    }
  }
  if (current !== '') chunks.push(current);
  while (chunks.length < columns) chunks.push('');
  return `<div class="body2col">${chunks.slice(0, columns).map((chunk, index) => {
    const escaped = escapeHtml(chunk);
    const withCap = index === 0 ? escaped.replace(/^(\S)/, '<span class="dropcap">$1</span>') : escaped;
    return `<div>${withCap}</div>`;
  }).join('')}</div>`;
}

function folio(page, dark = false) {
  return `<div class="folio ${dark ? 'folioDark' : ''}"><span>Grace Wood Industry · Nagercoil · <span class="tamil">நாகர்கோவில்</span></span><span>0${page} / 04</span></div>`;
}

function ornamentFrame() {
  return `<div class="abs ornament" style="left:9mm; top:9mm; width:192mm; height:279mm;"></div><div class="abs ornamentInner" style="left:10.5mm; top:10.5mm; width:189mm; height:276mm;"></div>`;
}

function contactBand() {
  return `<div class="abs band" style="left:-3mm; bottom:-3mm; width:216mm; height:12mm;"></div><div class="abs" style="left:18mm; bottom:1.5mm; width:180mm; font-family:var(--body); font-size:6.4pt; letter-spacing:.16em; text-transform:uppercase; color:var(--cream);">Grace Wood Industry · Nagercoil · +91 63740 43346</div>`;
}

function motif(top) {
  return `<div class="abs" style="left:0; top:${top}mm; width:210mm; display:flex; justify-content:center; gap:2.4mm;"><div class="diamond"></div><div class="diamond"></div><div class="diamond"></div></div>`;
}

function goldRule(left, top, width) {
  return `<div class="abs goldLine" style="left:${left}mm; top:${top}mm; width:${width}mm;"></div>`;
}

function coverHtml(values, design, photos) {
  const photo = photos[design.coverPhoto] ?? photos[0] ?? values.coverImage;
  const title = escapeHtml(values.title);
  const room = escapeHtml(values.room);
  const customer = escapeHtml(values.customerName);
  const meta = `${escapeHtml(values.orderNo)} · ${escapeHtml(values.date)}`;
  const taRoom = tamilRoom(values);
  const sizes = `${escapeHtml(values.width)} · ${escapeHtml(values.height)} · ${escapeHtml(values.depth)}`;
  const logo = (width = 26, top = 15) =>
    `<img class="abs" src="../assets/grace-logo.png" style="left:${(210 - width) / 2}mm; top:${top}mm; width:${width}mm;">`;
  const wordmark = (top = 46, color = 'var(--gold)') =>
    `<div class="abs" style="left:0; top:${top}mm; width:210mm; text-align:center; font-family:var(--body); font-size:7.6pt; letter-spacing:.42em; text-transform:uppercase; color:${color};">Grace Wood Industry</div>`;

  if (design.cover === 'fullBleed') {
    return `<div class="page cover"><div class="abs ph" style="left:-3mm; top:-3mm; width:216mm; height:303mm; background-image:url(${photo});"></div>
      <div class="abs" style="left:-3mm; top:140mm; width:216mm; height:166mm; background:linear-gradient(to top, rgba(40,12,8,0.88) 0%, rgba(40,12,8,0.42) 55%, rgba(40,12,8,0) 100%);"></div>
      ${ornamentFrame()}
      <div class="abs band" style="left:-3mm; top:-3mm; width:216mm; height:15mm;"></div>
      <div class="abs" style="left:18mm; top:3mm; width:120mm; font-family:var(--body); font-size:6.8pt; letter-spacing:.28em; text-transform:uppercase; color:var(--cream);">Grace Wood Industry</div>
      <div class="abs tamil" style="left:18mm; top:7.6mm; width:120mm; font-size:6.6pt; color:var(--gold);">கிரேஸ் வூட் இண்டஸ்ட்ரி</div>
      <div class="abs" style="right:18mm; top:4mm; width:82mm; text-align:right; font-family:var(--body); font-size:6.2pt; letter-spacing:.14em; color:var(--cream);">${meta}</div>
      <div class="abs goldLine" style="left:-3mm; top:15.5mm; width:216mm;"></div>
      <div class="abs paisley" style="left:10mm; top:24mm; width:16mm; height:22mm; opacity:0.9;"></div>
      <div class="abs paisley" style="right:10mm; bottom:26mm; width:16mm; height:22mm; opacity:0.9; transform:rotate(180deg);"></div>
      <div class="abs head" style="left:18mm; top:182mm; width:174mm; font-size:44pt; color:var(--cream);">${title}</div>
      <div class="abs tamil" style="left:18mm; top:228mm; width:174mm; font-size:9pt; color:var(--gold);">${taRoom}</div>
      ${goldRule(18, 238, 26)}
      <div class="abs" style="left:18mm; top:246mm; width:174mm; font-family:var(--body); font-size:8pt; letter-spacing:.12em; text-transform:uppercase; color:var(--cream);">${customer} · ${room} · ${sizes}</div>
      ${contactBand()}
    </div>`;
  }

  if (design.cover === 'splitLeft' || design.cover === 'splitRight') {
    const photoFirst = design.cover === 'splitLeft';
    const photoStyle = photoFirst
      ? 'left:-3mm; top:-3mm; width:111mm; height:303mm;'
      : 'left:105mm; top:-3mm; width:111mm; height:303mm;';
    const textLeft = photoFirst ? 118 : 18;
    const textWidth = 74;
    return `<div class="page cover"><div class="abs ph" style="${photoStyle} background-image:url(${photo});"></div>
      <div class="abs" style="left:${photoFirst ? 112 : 104}mm; top:0; width:0.6mm; height:297mm; background:var(--gold);"></div>
      <div class="abs" style="left:${textLeft}mm; top:17mm; width:${textWidth}mm; font-family:var(--body); font-size:6.4pt; letter-spacing:.2em; text-transform:uppercase; color:var(--gold);">Grace Wood Industry</div>
      <div class="abs tamil" style="left:${textLeft}mm; top:22mm; width:${textWidth}mm; font-size:6.8pt; color:var(--deep);">கிரேஸ் வூட் இண்டஸ்ட்ரி</div>
      <div class="abs micro" style="left:${textLeft}mm; top:30mm; width:${textWidth}mm;">${meta}</div>
      <div class="abs paisley" style="left:${textLeft}mm; top:196mm; width:14mm; height:20mm;"></div>
      <div class="abs head" style="left:${textLeft}mm; top:78mm; width:${textWidth}mm; font-size:34pt;">${title}</div>
      <div class="abs tamil" style="left:${textLeft}mm; top:156mm; width:${textWidth}mm; font-size:8pt; color:var(--accent);">${taRoom}</div>
      ${goldRule(textLeft, 168, 24)}
      <div class="abs" style="left:${textLeft}mm; top:176mm; width:${textWidth}mm;"><div class="micro">${room}</div><div class="micro" style="margin-top:2mm;">${sizes}</div></div>
      <div class="abs" style="left:${textLeft}mm; top:232mm; width:${textWidth}mm; font-family:var(--display); font-size:14pt; color:var(--deep);">${customer}</div>
      <div class="abs" style="left:${textLeft}mm; top:266mm; width:${textWidth}mm; font-family:var(--body); font-size:6.2pt; line-height:1.5; color:var(--deep);">Chettikulam, Nagercoil 629001<br>+91 63740 43346</div>
      <div class="abs micro" style="right:18mm; bottom:8mm;">01 / 04</div>
    </div>`;
  }

  if (design.cover === 'masthead') {
    return `<div class="page cover"><div class="sheet">
      <div class="abs jaali" style="left:0; top:8mm; width:210mm; height:6mm; opacity:0.85;"></div>
      ${logo(28, 16)}
      ${wordmark(50)}
      <div class="abs tamil" style="left:0; top:56mm; width:210mm; text-align:center; font-size:8.4pt; color:var(--accent);">கிரேஸ் வூட் இண்டஸ்ட்ரி</div>
      <div class="abs head" style="left:18mm; top:66mm; width:174mm; text-align:center; font-size:42pt;">${title}</div>
      <div class="abs lotus" style="left:88mm; top:99mm; width:30mm; height:16mm;"></div>
      <div class="abs" style="left:18mm; top:120mm; width:174mm; text-align:center; font-family:var(--body); font-size:8pt; letter-spacing:.14em; text-transform:uppercase; color:var(--deep);">${customer} · ${room}</div>
      <div class="abs tamil" style="left:0; top:128mm; width:210mm; text-align:center; font-size:8.4pt; color:var(--accent);">${taRoom}</div>
      <div class="abs ornament" style="left:8.5mm; top:142mm; width:193mm; height:110mm;"></div>
      <div class="abs ph" style="left:10mm; top:144mm; width:190mm; height:106mm; background-image:url(${photo});"></div>
      <div class="abs micro" style="left:18mm; top:258mm; width:174mm; text-align:center;">${meta}</div>
      <div class="abs" style="left:18mm; top:278mm; width:174mm; font-family:var(--body); font-size:6.4pt; letter-spacing:.2em; text-transform:uppercase; color:var(--accent);">Made in Nagercoil · தமிழ்நாடு</div>
      ${contactBand()}
    </div></div>`;
  }

  if (design.cover === 'framed') {
    return `<div class="page cover"><div class="sheet">
      ${ornamentFrame()}
      <div class="abs jaali" style="left:0; top:7mm; width:210mm; height:6mm; opacity:0.85;"></div>
      ${logo(24, 18)}
      ${wordmark(50)}
      <div class="abs tamil" style="left:0; top:56mm; width:210mm; text-align:center; font-size:8pt; color:var(--accent);">கிரேஸ் வூட் இண்டஸ்ட்ரி</div>
      <div class="abs head" style="left:18mm; top:64mm; width:174mm; text-align:center; font-size:36pt;">${title}</div>
      <div class="abs tamil" style="left:0; top:98mm; width:210mm; text-align:center; font-size:8.4pt; color:var(--accent);">${taRoom}</div>
      <div class="abs" style="left:18mm; top:106mm; width:174mm; text-align:center; font-family:var(--body); font-size:7.4pt; letter-spacing:.14em; text-transform:uppercase; color:var(--deep);">${room} · ${sizes}</div>
      <div class="abs arch" style="left:45mm; top:124mm; width:120mm; height:126mm;"></div>
      <div class="abs ph" style="left:54mm; top:136mm; width:102mm; height:98mm; background-image:url(${photo});"></div>
      <div class="abs lotus" style="left:88mm; top:238mm; width:30mm; height:17mm;"></div>
      <div class="abs" style="left:0; top:254mm; width:210mm; text-align:center; font-family:var(--display); font-size:15pt; color:var(--deep);">${customer}</div>
      <div class="abs" style="left:18mm; top:278mm; width:174mm; font-family:var(--body); font-size:6.4pt; letter-spacing:.2em; text-transform:uppercase; color:var(--accent);">Made in Nagercoil · தமிழ்நாடு</div>
      ${contactBand()}
    </div></div>`;
  }

  // bandTop
  return `<div class="page cover"><div class="sheet">
    <div class="abs ph" style="left:-3mm; top:-3mm; width:216mm; height:172mm; background-image:url(${photo});"></div>
    <div class="abs" style="left:-3mm; top:169mm; width:216mm; height:0.5mm; background:var(--gold);"></div>
    <div class="abs band" style="left:-3mm; top:-3mm; width:216mm; height:15mm;"></div>
    <div class="abs" style="left:18mm; top:3mm; width:120mm; font-family:var(--body); font-size:6.8pt; letter-spacing:.28em; text-transform:uppercase; color:var(--cream);">Grace Wood Industry</div>
    <div class="abs tamil" style="left:18mm; top:7.6mm; width:120mm; font-size:6.6pt; color:var(--gold);">கிரேஸ் வூட் இண்டஸ்ட்ரி</div>
    <div class="abs" style="right:18mm; top:4mm; width:82mm; text-align:right; font-family:var(--body); font-size:6.2pt; letter-spacing:.14em; color:var(--cream);">${meta}</div>
    <div class="abs goldLine" style="left:-3mm; top:15.5mm; width:216mm;"></div>
    <div class="abs paisley" style="right:18mm; top:176mm; width:16mm; height:22mm;"></div>
    <div class="abs head" style="left:18mm; top:182mm; width:174mm; font-size:42pt;">${title}</div>
    ${goldRule(18, 232, 24)}
    <div class="abs tamil" style="left:18mm; top:224mm; width:174mm; font-size:8.4pt; color:var(--accent);">${taRoom}</div>
    <div class="abs" style="left:18mm; top:240mm; width:100mm;"><div class="micro">${room}</div><div class="micro" style="margin-top:2mm;">${sizes}</div></div>
    <div class="abs" style="right:18mm; top:240mm; width:62mm; text-align:right; font-family:var(--display); font-size:14pt; color:var(--deep);">${customer}</div>
    <div class="abs" style="left:18mm; top:278mm; width:174mm; font-family:var(--body); font-size:6.4pt; letter-spacing:.2em; text-transform:uppercase; color:var(--accent);">Made in Nagercoil · தமிழ்நாடு</div>
    ${contactBand()}
  </div></div>`;
}

function storyHtml(values, design, copy, photos) {
  const photo = photos[design.storyPhoto] ?? photos[0] ?? values.insideImage;
  const photoAlt = photos[(design.storyPhoto + 1) % Math.max(1, photos.length)] ?? values.insideImage2;
  const statement = escapeHtml(design.statement);
  const headline = escapeHtml(copy.headline);
  const closing = escapeHtml(copy.closing);
  const bodyColumns = columnsHtml(copy.body, 2);

  if (design.story === 'hero') {
    return `<div class="page"><div class="sheet">
      <div class="abs ph" style="left:-3mm; top:-3mm; width:216mm; height:182mm; background-image:url(${photo});"></div>
      <div class="abs" style="left:18mm; top:190mm; width:174mm;"><div class="headlineLabel">${headline}</div></div>
      <div class="abs serif" style="left:18mm; top:198mm; width:174mm; font-size:26pt;">${statement}</div>
      <div class="abs" style="left:18mm; top:236mm; width:174mm;">${bodyColumns}</div>
      <div class="abs closingLine" style="left:18mm; top:274mm; width:174mm;">${closing}</div>
      ${folio(2)}
    </div></div>`;
  }
  if (design.story === 'diptych') {
    return `<div class="page"><div class="sheet">
      <div class="abs ph" style="left:-3mm; top:-3mm; width:111mm; height:196mm; background-image:url(${photo});"></div>
      <div class="abs ph" style="left:105mm; top:-3mm; width:111mm; height:196mm; background-image:url(${photoAlt});"></div>
      <div class="abs" style="left:18mm; top:200mm; width:174mm;"><div class="headlineLabel">${headline}</div></div>
      <div class="abs serif" style="left:18mm; top:209mm; width:104mm; font-size:26pt;">${statement}</div>
      <div class="abs" style="left:18mm; top:252mm; width:174mm;">${bodyColumns}</div>
      <div class="abs micro" style="left:18mm; top:272mm; width:174mm;">${closing}</div>
      ${folio(2)}
    </div></div>`;
  }
  if (design.story === 'collage') {
    return `<div class="page"><div class="sheet">
      <div class="abs serif" style="left:18mm; top:22mm; width:104mm; font-size:28pt;">${statement}</div>
      <div class="abs" style="left:18mm; top:70mm; width:100mm;"><div class="headlineLabel">${headline}</div></div>
      <div class="abs ph" style="left:18mm; top:80mm; width:100mm; height:132mm; background-image:url(${photo});"></div>
      <div class="abs ph" style="left:126mm; top:80mm; width:66mm; height:88mm; background-image:url(${photoAlt});"></div>
      <div class="abs" style="left:126mm; top:174mm; width:66mm;"><div class="caption">${escapeHtml(values.exterior)}. ${escapeHtml(values.interior)}.</div></div>
      <div class="abs" style="left:18mm; top:222mm; width:174mm;">${bodyColumns}</div>
      <div class="abs closingLine" style="left:18mm; top:268mm; width:174mm;">${closing}</div>
      ${folio(2)}
    </div></div>`;
  }
  // editorial: tall photo on the left, quiet text column on the right
  return `<div class="page"><div class="sheet">
    <div class="abs ph" style="left:-3mm; top:-3mm; width:121mm; height:303mm; background-image:url(${photo});"></div>
    <div class="abs paisley" style="right:18mm; top:18mm; width:12mm; height:16mm;"></div>
    <div class="abs" style="left:130mm; top:24mm; width:62mm;"><div class="headlineLabel">${headline}</div></div>
    <div class="abs serif" style="left:130mm; top:32mm; width:64mm; font-size:26pt;">${statement}</div>
    <div class="abs" style="left:130mm; top:100mm; width:62mm;"><div class="rule" style="width:18mm;"></div></div>
    <div class="abs" style="left:130mm; top:96mm; width:64mm;"><div class="goldLine" style="width:20mm; margin-bottom:4mm;"></div><div class="body">${escapeHtml(copy.body)}</div></div>
    <div class="abs closingLine" style="left:130mm; top:246mm; width:62mm; font-size:8.5pt;">${closing}</div>
    <div class="folio" style="left:130mm; right:18mm;"><span>Grace Wood</span><span>02 / 04</span></div>
  </div></div>`;
}

function finishCards(values) {
  return [1, 2, 3, 4].map((index) => ({
    name: values[`mat${index}Name`],
    image: values[`mat${index}Image`],
  }));
}

function materialsHtml(values, design) {
  const cards = finishCards(values);
  const nameTag = (entry, index) =>
    `<div class="swatchName"><span class="swatchIndex">0${index + 1}</span>${escapeHtml(entry.name)}</div>`;
  const head = `<div class="abs band" style="left:-3mm; top:-3mm; width:216mm; height:40mm;"></div>
    <div class="abs" style="left:18mm; top:7mm; width:130mm; font-family:var(--display); font-size:26pt; color:var(--cream);">Materials</div>
    <div class="abs" style="right:18mm; top:11mm; width:80mm; text-align:right; font-family:var(--body); font-size:6.6pt; letter-spacing:.18em; text-transform:uppercase; color:var(--cream);">${escapeHtml(values.orderNo)}</div>
    <div class="abs paisley" style="left:152mm; top:7mm; width:12mm; height:18mm; opacity:0.95;"></div>
    <div class="abs goldLine" style="left:0; top:40mm; width:210mm;"></div>
    <div class="abs jaali" style="left:0; top:41mm; width:210mm; height:6mm; opacity:0.9;"></div>`;
  const finishLine = `<div class="abs caption" style="left:18mm; top:250mm; width:174mm;">${escapeHtml(values.finishExt)}. ${escapeHtml(values.finishInt)}. ${escapeHtml(values.edgeNote)}.</div><div class="abs micro" style="left:18mm; top:266mm; width:174mm;">Shown as samples, matched in person</div>`;

  if (design.materials === 'filmstrip') {
    return `<div class="page"><div class="sheet">${head}
      ${cards
        .map(
          (entry, index) =>
            `<div class="abs" style="left:${18 + index * 43}mm; top:50mm; width:38mm;">
              <div class="ph" style="border:0.45mm solid var(--gold); padding:1.4mm; background-color:#fff; width:38mm; height:152mm; background-image:url(${entry.image});"></div>
              ${nameTag(entry, index)}
            </div>`,
        )
        .join('')}
      ${finishLine}${folio(3)}</div></div>`;
  }
  if (design.materials === 'band') {
    return `<div class="page"><div class="sheet">${head}
      <div class="abs" style="left:-3mm; top:50mm; width:216mm; height:110mm; display:flex;">
        ${cards
          .map(
            (entry) =>
              `<div style="border:0.45mm solid var(--gold); border-right:none; background-color:#fff; width:54mm; height:110mm; background-image:url(${entry.image}); background-size:cover; background-position:center;"></div>`,
          )
          .join('')}
      </div>
      <div class="abs" style="left:18mm; top:168mm; width:174mm; display:flex;">
        ${cards.map((entry, index) => `<div style="width:43mm;">${nameTag(entry, index)}</div>`).join('')}
      </div>
      ${finishLine}${folio(3)}</div></div>`;
  }
  if (design.materials === 'museum') {
    return `<div class="page"><div class="sheet">${head}
      <div class="abs ph" style="border:0.45mm solid var(--gold); padding:1.8mm; background-color:#fff; left:18mm; top:50mm; width:114mm; height:164mm; background-image:url(${cards[0].image});"></div>
      <div class="abs swatchName" style="left:18mm; top:217mm; width:114mm;"><span class="swatchIndex">01</span>${escapeHtml(cards[0].name)}</div>
      ${cards
        .slice(1)
        .map(
          (entry, index) =>
            `<div class="abs" style="left:142mm; top:${50 + index * 56}mm; width:50mm;">
              <div class="ph" style="border:0.45mm solid var(--gold); padding:1.4mm; background-color:#fff; width:50mm; height:42mm; background-image:url(${entry.image});"></div>
              ${nameTag(entry, index)}
            </div>`,
        )
        .join('')}
      ${finishLine}${folio(3)}</div></div>`;
  }
  if (design.materials === 'stacked') {
    return `<div class="page"><div class="sheet">${head}
      <div class="abs ph" style="left:18mm; top:50mm; width:174mm; height:96mm; background-image:url(${cards[0].image});"></div>
      <div class="abs" style="left:18mm; top:154mm; width:174mm; display:flex;">
        ${cards
          .slice(1)
          .map(
            (entry, index) =>
              `<div style="width:57mm;"><div class="ph" style="border:0.45mm solid var(--gold); padding:1.4mm; background-color:#fff; width:53mm; height:53mm; background-image:url(${entry.image});"></div>${nameTag(entry, index + 1)}</div>`,
          )
          .join('')}
      </div>
      ${finishLine}${folio(3)}</div></div>`;
  }
  // grid4
  return `<div class="page"><div class="sheet">${head}
    ${cards
      .map(
        (entry, index) =>
          `<div class="abs" style="left:${18 + (index % 2) * 88}mm; top:${52 + Math.floor(index / 2) * 92}mm; width:84mm;">
            <div class="ph" style="border:0.45mm solid var(--gold); padding:1.6mm; background-color:#fff; width:84mm; height:72mm; background-image:url(${entry.image});"></div>
            ${nameTag(entry, index)}
          </div>`,
      )
      .join('')}
    ${finishLine}${folio(3)}</div></div>`;
}

function specificationHtml(values, design) {
  const groups = specGroups(values);
  const allFacts = groups.flatMap((group) => group.facts);
  const drawingTop = design.spec === 'ledger' ? 172 : design.spec === 'cards' ? 164 : 158;
  const head = `<div class="abs" style="left:18mm; top:14mm; width:140mm; font-family:var(--body); font-size:8pt; letter-spacing:.26em; text-transform:uppercase; color:var(--deep);">Specification</div>
    <div class="abs micro" style="right:18mm; top:14mm;">${escapeHtml(values.orderNo)}</div>
    <div class="abs goldLine" style="left:18mm; top:23mm; width:174mm;"></div>
    <div class="abs" style="left:18mm; top:25.5mm; width:174mm; height:0.14mm; background:var(--gold);"></div>
    <div class="abs jaali" style="left:18mm; top:27mm; width:174mm; height:5mm; opacity:0.8;"></div>
    <div class="abs lotus" style="right:18mm; top:12mm; width:14mm; height:8mm;"></div>`;
  const contact = `<div class="abs goldLine" style="left:18mm; top:264mm; width:174mm;"></div>
    <div class="abs" style="left:18mm; top:268mm; width:174mm; font-family:var(--body); font-size:6.6pt; line-height:1.6; letter-spacing:.04em; color:var(--deep);">Grace Wood Industry · 26J Rajjakamangalam Road, Chettikulam, Nagercoil 629001<br>+91 63740 43346 · info.gracewoodindustry@gmail.com</div>`;

  if (design.spec === 'ledger') {
    return `<div class="page"><div class="sheet">${head}
      <div class="abs serif" style="left:18mm; top:34mm; width:174mm; font-size:25pt;">${escapeHtml(values.title)}</div>
      <div class="abs" style="left:18mm; top:56mm; width:174mm;">${rowsHtml(allFacts)}</div>
      ${drawingBlock(values, drawingTop)}${contact}${folio(4)}</div></div>`;
  }
  if (design.spec === 'cards') {
    return `<div class="page"><div class="sheet">${head}
      <div class="abs serif" style="left:18mm; top:34mm; width:174mm; font-size:25pt;">${escapeHtml(values.title)}</div>
      ${groups
        .map(
          (group, index) =>
            `<div class="abs" style="left:${18 + (index % 2) * 89}mm; top:${56 + Math.floor(index / 2) * 54}mm; width:80mm; border-top:0.35mm solid var(--gold); padding-top:4mm;">
              <div class="label" style="margin-bottom:3mm;">${escapeHtml(group.title)}</div>
              ${rowsHtml(group.facts)}
            </div>`,
        )
        .join('')}
      ${drawingBlock(values, drawingTop)}${contact}${folio(4)}</div></div>`;
  }
  if (design.spec === 'threeColumn') {
    return `<div class="page"><div class="sheet">${head}
      <div class="abs serif" style="left:18mm; top:34mm; width:174mm; font-size:25pt;">${escapeHtml(values.title)}</div>
      ${groups
        .map(
          (group, index) =>
            `<div class="abs" style="left:${18 + index * 60}mm; top:58mm; width:54mm;">
              <div class="label" style="margin-bottom:3mm;">${escapeHtml(group.title)}</div>
              ${rowsHtml(group.facts)}
            </div>`,
        )
        .join('')}
      ${drawingBlock(values, drawingTop)}${contact}${folio(4)}</div></div>`;
  }
  if (design.spec === 'stacked') {
    return `<div class="page"><div class="sheet">${head}
      <div class="abs serif" style="left:18mm; top:34mm; width:174mm; font-size:25pt;">${escapeHtml(values.title)}</div>
      <div class="abs" style="left:18mm; top:56mm; width:82mm;">
        <div class="label" style="margin-bottom:2.5mm;">${escapeHtml(groups[0].title)}</div>
        ${rowsHtml(groups[0].facts)}
        <div class="label" style="margin:5mm 0 2.5mm;">${escapeHtml(groups[2].title)}</div>
        ${rowsHtml(groups[2].facts)}
      </div>
      <div class="abs" style="left:110mm; top:56mm; width:82mm;">
        <div class="label" style="margin-bottom:2.5mm;">${escapeHtml(groups[1].title)}</div>
        ${rowsHtml(groups[1].facts)}
      </div>
      ${drawingBlock(values, drawingTop)}${contact}${folio(4)}</div></div>`;
  }

  // twoColumn
  return `<div class="page"><div class="sheet">${head}
    <div class="abs serif" style="left:18mm; top:34mm; width:174mm; font-size:25pt;">${escapeHtml(values.title)}</div>
    <div class="abs" style="left:18mm; top:58mm; width:82mm;">${rowsHtml([...groups[0].facts, ...groups[2].facts])}</div>
    <div class="abs" style="left:110mm; top:58mm; width:82mm;">${rowsHtml(groups[1].facts)}</div>
    ${drawingBlock(values, drawingTop)}${contact}${folio(4)}</div></div>`;
}

/** Merge studio overrides into a design that already exists. */
export function mergeDesignOverrides(base, overrides, photoCount = 1) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new LlmError('The design overrides could not be read.', { type: 'invalid_reply' });
  }
  const design = { ...base };
  if (overrides.tone !== undefined) {
    const tone = clean(overrides.tone);
    design.tone = pickEnum(TONE_ALIASES[tone.toLowerCase()] ?? tone, TONES, 'tone', design.tone);
  }
  if (overrides.type !== undefined) design.type = pickEnum(overrides.type, TYPES, 'type', design.type);
  if (overrides.cover !== undefined) design.cover = pickEnum(overrides.cover, COVERS, 'cover', design.cover);
  if (overrides.story !== undefined) {
    const story = clean(overrides.story);
    design.story = STORY_ALIASES[story] ?? pickEnum(story, STORY_LAYOUTS, 'story', design.story);
  }
  if (overrides.materials !== undefined) {
    design.materials = pickEnum(overrides.materials, MATERIALS_LAYOUTS, 'materials', design.materials);
  }
  if (overrides.spec !== undefined) design.spec = pickEnum(overrides.spec, SPECS, 'spec', design.spec);
  if (overrides.coverPhoto !== undefined) design.coverPhoto = pickPhoto(overrides.coverPhoto, photoCount, design.coverPhoto ?? 0);
  if (overrides.storyPhoto !== undefined) design.storyPhoto = pickPhoto(overrides.storyPhoto, photoCount, design.storyPhoto ?? 0);
  if (overrides.detailPhoto !== undefined) design.detailPhoto = pickPhoto(overrides.detailPhoto, photoCount, design.detailPhoto ?? 0);
  if (overrides.statement !== undefined) {
    design.statement = capText(overrides.statement, 100) || design.statement;
  }
  return design;
}

/** Validate a copy object the studio edited by hand. */
export function readCopyOverride(copy) {
  if (!copy || typeof copy !== 'object' || Array.isArray(copy)) {
    throw new LlmError('The brochure copy could not be read.', { type: 'invalid_reply' });
  }
  const headline = capText(copy.headline, 120);
  const body = capText(copy.body, 2400);
  const closing = capText(copy.closing, 160);
  if (!headline || body.split(/\s+/).filter(Boolean).length < 20) {
    throw new LlmError('The brochure copy needs a headline and a body.', { type: 'invalid_reply' });
  }
  return { headline, body, closing };
}

/** Compile a validated design into one print ready HTML document. */
export function compileAiBrochure({ order, materials, palette: providedPalette, design, copy, templatesDir, attachmentImages = [] }) {
  const values = buildVoucherValues({
    order,
    materials,
    templatesDir,
    logger: { warn() {}, info() {}, error() {}, debug() {} },
    attachmentImages,
  });
  const photos = attachmentImages.length > 0
    ? attachmentImages
    : [values.coverImage, values.insideImage, values.insideImage2, values.detailImage];
  const palette = INDIAN_PALETTES[design.tone] ?? providedPalette;
  const stack = TYPE_STACKS[design.type] ?? TYPE_STACKS.editorial;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(values.title)} · ${escapeHtml(values.orderNo)}</title>
<link rel="stylesheet" href="../fonts/brand.css">
<style>
:root { ${paletteCss(palette)}
  --cream: ${palette.coverPaper};
  --gold: #C79A3A;
  --deep: ${palette.dark};
  --display: ${stack.display};
  --body: ${stack.body};
}
${BASE_CSS}
</style></head><body>
${coverHtml(values, design, photos)}
${storyHtml(values, design, copy, photos)}
${materialsHtml(values, design)}
${specificationHtml(values, design)}
</body></html>`;
}

/** Human label for a design, stored with the render for the studio history. */
export function designLabel(design) {
  const words = [design.type, design.tone, design.cover, design.story, design.materials, design.spec];
  return words.map((word) => word.replace(/([A-Z])/g, ' $1').trim()).join(' · ');
}
