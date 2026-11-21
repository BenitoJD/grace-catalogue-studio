// The AI art director.
//
// Instead of picking one of the fixed brochure templates, the model designs a
// document for this order: a tone, a type pairing and a composition for each of
// the four pages. It also writes the headline, body and closing in the same
// call. This module turns that design into print safe HTML and validates it
// before anything is rendered.
import { LlmError, capText, clean, parseJsonObject } from './llm.mjs';
import { buildVoucherValues, escapeHtml } from './render.mjs';

export const TONES = ['copper', 'ink', 'olive', 'indigo', 'sand'];
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

const DESIGN_KIT = [
  'You are the art director and copywriter for one printed brochure at Grace Wood Industry, a wardrobe and furniture workshop in Nagercoil.',
  'Design a four page A4 document for this single order and write its copy. Every order gets a fresh composition; do not think of stock templates.',
  'Reply with strict JSON only, exactly this shape:',
  '{"design":{"tone":"copper|ink|olive|indigo|sand","type":"editorial|modern|classic","cover":"fullBleed|splitLeft|splitRight|bandTop|framed|masthead","spec":"twoColumn|threeColumn|ledger|cards|stacked","finishes":"grid4|filmstrip|stacked|band|museum","inside":"photoEssay|diptych|heroStatement|splitStory","coverPhoto":0,"detailPhoto":1,"insidePhoto":2,"statement":"one calm line, at most 80 characters"},"copy":{"headline":"...","body":"...","closing":"..."}}',
  'Design rules:',
  '- Choose the tone and type that suit the room and the piece. Vary them from order to order.',
  '- Avoid the obvious default. A split cover with editorial type is the safe answer, so use it for at most one order in three. Prefer masthead, bandTop or framed covers, and mix modern and classic type, unless the photographs clearly need a split.',
  '- Choose the cover layout that suits the photographs available: fullBleed for one strong photo, split for two, framed for a quieter document, bandTop or masthead for a graphic one.',
  '- coverPhoto, detailPhoto and insidePhoto are indexes into the available photographs, starting at 0. They may repeat if there is only one photo.',
  '- statement is the large line printed inside, understated, a phrase not a sentence of sales copy.',
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

export function buildAiBrochureMessages(order, brief, photoCount) {
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
      content: `${facts}\n\nPhotographs available: ${photoCount}.\nCustomer brief, use only what is useful:\n${clean(brief) || '(none supplied)'}`,
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
  const design = {
    tone: pickEnum(parsed.design.tone, TONES, 'tone', 'copper'),
    type: pickEnum(parsed.design.type, TYPES, 'type', 'editorial'),
    cover: pickEnum(parsed.design.cover, COVERS, 'cover', 'bandTop'),
    spec: pickEnum(parsed.design.spec, SPECS, 'spec', 'twoColumn'),
    finishes: pickEnum(parsed.design.finishes, FINISHES, 'finishes', 'grid4'),
    inside: pickEnum(parsed.design.inside, INSIDES, 'inside', 'photoEssay'),
    coverPhoto: pickPhoto(parsed.design.coverPhoto, photoCount, 0),
    detailPhoto: pickPhoto(parsed.design.detailPhoto, photoCount, 0),
    insidePhoto: pickPhoto(parsed.design.insidePhoto, photoCount, 0),
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
  .page { position:relative; width:216mm; height:303mm; overflow:hidden; page-break-after:always; background:var(--paper); }
  .page:last-child { page-break-after:auto; }
  .sheet { position:absolute; left:3mm; top:3mm; width:210mm; height:297mm; }
  .abs { position:absolute; }
  .ph { background-size:cover; background-position:center; background-repeat:no-repeat; }
  .micro { font-family:var(--body); font-size:5pt; letter-spacing:.22em; text-transform:uppercase; color:var(--faint); }
  .label { font-family:var(--body); font-size:5pt; letter-spacing:.2em; text-transform:uppercase; color:var(--muted); }
  .value { font-family:var(--body); font-size:6.4pt; line-height:1.35; color:var(--ink); }
  .head { font-family:var(--display); font-weight:400; color:var(--ink); line-height:1.02; letter-spacing:-.01em; }
  .body { font-family:var(--body); font-size:6.4pt; line-height:1.65; color:var(--muted); }
  .rule { height:0.16mm; background:var(--hair); }
  .acc { background:var(--accent); }
  .row { display:flex; justify-content:space-between; align-items:baseline; gap:6mm; border-bottom:0.12mm solid var(--hair); padding:1.6mm 0; }
  .row .k { font-family:var(--body); font-size:5pt; letter-spacing:.18em; text-transform:uppercase; color:var(--muted); }
  .row .v { font-family:var(--body); font-size:6.2pt; color:var(--ink); text-align:right; }
  .plain { font-family:var(--body); font-size:5.6pt; letter-spacing:.04em; color:var(--faint); }
  .bodycopy:empty { display:none; }
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

function coverHtml(values, design, photos) {
  const photo = photos[design.coverPhoto] ?? photos[0] ?? values.coverImage;
  const title = escapeHtml(values.title);
  const meta = `<div class="micro" style="left:18mm; top:18mm; width:120mm;">${escapeHtml(values.orderNo)} · ${escapeHtml(values.date)}</div>`;
  const logo = '<img class="abs" src="../assets/grace-logo.png" style="left:18mm; top:14mm; width:11mm;">';
  const name = `<div class="micro" style="left:18mm; top:276mm; width:174mm;">${escapeHtml(values.customerName)} · ${escapeHtml(values.room)}</div>`;
  const footer = `<div class="micro" style="left:18mm; top:284mm;">Grace Wood Industry · ${escapeHtml(values.shopLine)}</div><div class="micro" style="right:18mm; top:284mm;">01 / 04</div>`;
  const titleBlock = (style) => `<div class="head abs" style="${style}">${title}</div>`;

  if (design.cover === 'fullBleed') {
    return `<div class="page cover"><div class="abs ph" style="left:0; top:0; width:216mm; height:303mm; background-image:url(${photo});"></div>
      <div class="abs" style="left:0; top:150mm; width:216mm; height:153mm; background:linear-gradient(to top, rgba(10,9,8,0.72), rgba(10,9,8,0));"></div>
      <div class="abs" style="left:18mm; top:20mm; width:110mm; color:var(--on-dark);">${meta}</div>
      ${titleBlock('left:18mm; top:198mm; width:180mm; font-size:34pt; color:var(--on-dark);')}
      <div class="abs" style="left:18mm; top:244mm; width:170mm; color:rgba(255,255,255,0.82); font-family:var(--body); font-size:7pt; line-height:1.5;">${escapeHtml(values.exterior)}, ${escapeHtml(values.interior)}</div>
      <div class="abs" style="left:18mm; top:262mm; width:170mm; color:rgba(255,255,255,0.7);" class="micro">${escapeHtml(values.customerName)} · ${escapeHtml(values.orderNo)}</div>
    </div>`;
  }
  if (design.cover === 'splitLeft' || design.cover === 'splitRight') {
    const photoLeft = design.cover === 'splitLeft';
    const photoStyle = photoLeft
      ? 'left:0; top:0; width:96mm; height:303mm;'
      : 'right:0; top:0; width:96mm; height:303mm;';
    const textLeft = photoLeft ? 108 : 18;
    return `<div class="page cover"><div class="abs ph" style="${photoStyle} background-image:url(${photo});"></div>
      <div class="abs" style="left:${textLeft}mm; top:18mm; width:${photoLeft ? 96 : 92}mm;">${meta}</div>
      ${titleBlock(`left:${textLeft}mm; top:72mm; width:${photoLeft ? 92 : 92}mm; font-size:30pt;`)}
      <div class="abs rule acc" style="left:${textLeft}mm; top:${photoLeft ? 168 : 160}mm; width:26mm;"></div>
      <div class="abs" style="left:${textLeft}mm; top:${photoLeft ? 178 : 170}mm; width:${photoLeft ? 80 : 88}mm;">${rowsHtml([
        ['Width', values.width],
        ['Height', values.height],
        ['Depth', values.depth],
        ['Handle', values.handle],
      ])}</div>
      <div class="abs" style="left:${textLeft}mm; top:262mm; width:${photoLeft ? 80 : 88}mm;">${escapeHtml(values.customerName)}</div>
      <div class="abs micro" style="left:${textLeft}mm; top:284mm; width:${photoLeft ? 80 : 88}mm;">Grace Wood Industry</div>
    </div>`;
  }
  if (design.cover === 'framed') {
    return `<div class="page cover"><div class="sheet">
      <div class="abs micro" style="left:18mm; top:16mm; width:174mm; text-align:center;">${escapeHtml(values.orderNo)} · ${escapeHtml(values.date)}</div>
      ${titleBlock('left:30mm; top:30mm; width:150mm; text-align:center; font-size:26pt;')}
      <div class="abs" style="left:45mm; top:62mm; width:120mm; height:150mm; border:0.3mm solid var(--ink); padding:6mm;">
        <div class="abs ph" style="left:6mm; top:6mm; width:108mm; height:138mm; background-image:url(${photo});"></div>
      </div>
      <div class="abs micro" style="left:18mm; top:228mm; width:174mm; text-align:center;">${escapeHtml(values.room)} · ${escapeHtml(values.width)} · ${escapeHtml(values.height)}</div>
      <div class="abs" style="left:18mm; top:244mm; width:174mm; text-align:center; font-family:var(--body); font-size:7pt; color:var(--muted);">${escapeHtml(values.customerName)}</div>
      <div class="abs micro" style="left:18mm; top:284mm;">Grace Wood Industry · Nagercoil</div>
      <div class="abs micro" style="right:18mm; top:284mm;">01 / 04</div>
    </div></div>`;
  }
  if (design.cover === 'masthead') {
    return `<div class="page cover"><div class="sheet">
      ${logo}
      <div class="abs" style="left:18mm; top:70mm; width:174mm; font-family:var(--body); font-size:8pt; letter-spacing:.34em; text-transform:uppercase; color:var(--accent);">Grace Wood Industry</div>
      ${titleBlock('left:18mm; top:82mm; width:174mm; font-size:44pt;')}
      <div class="abs rule" style="left:18mm; top:168mm; width:174mm;"></div>
      <div class="abs micro" style="left:18mm; top:172mm; width:90mm;">${escapeHtml(values.orderNo)} · ${escapeHtml(values.date)}</div>
      <div class="abs micro" style="right:18mm; top:172mm; width:80mm; text-align:right;">${escapeHtml(values.room)}</div>
      <div class="abs ph" style="left:18mm; top:188mm; width:174mm; height:76mm; background-image:url(${photo});"></div>
      <div class="abs micro" style="left:18mm; top:270mm; width:174mm;">${escapeHtml(values.customerName)} · ${escapeHtml(values.width)} · ${escapeHtml(values.handle)}</div>
      <div class="abs micro" style="left:18mm; top:284mm;">Grace Wood Industry · Nagercoil</div>
      <div class="abs micro" style="right:18mm; top:284mm;">01 / 04</div>
    </div></div>`;
  }
  // bandTop
  return `<div class="page cover"><div class="sheet">
    <div class="abs ph" style="left:0; top:0; width:210mm; height:132mm; background-image:url(${photo});"></div>
    <div class="abs" style="left:18mm; top:12mm; width:174mm;">${meta}</div>
    ${titleBlock('left:18mm; top:152mm; width:174mm; font-size:36pt;')}
    <div class="abs rule acc" style="left:18mm; top:224mm; width:24mm;"></div>
    <div class="abs" style="left:18mm; top:232mm; width:104mm;">${rowsHtml([
      ['Width', values.width],
      ['Height', values.height],
      ['Handle', values.handle],
    ])}</div>
    <div class="abs micro" style="right:18mm; top:232mm; width:56mm; text-align:right;">${escapeHtml(values.customerName)}<br>${escapeHtml(values.room)}</div>
    <div class="abs micro" style="left:18mm; top:284mm;">Grace Wood Industry · Nagercoil</div>
    <div class="abs micro" style="right:18mm; top:284mm;">01 / 04</div>
  </div></div>`;
}

function specHtml(values, design) {
  const head = `<div class="abs label" style="left:18mm; top:16mm;">02 · Specification</div><div class="abs micro" style="right:18mm; top:16mm;">${escapeHtml(values.orderNo)}</div><div class="abs rule" style="left:18mm; top:22mm; width:174mm;"></div>`;
  const footer = `<div class="abs micro" style="left:18mm; top:284mm;">${escapeHtml(values.shopLine)}</div><div class="abs micro" style="right:18mm; top:284mm;">02 / 04</div>`;
  const groups = specGroups(values);
  const allFacts = groups.flatMap((group) => group.facts);

  if (design.spec === 'threeColumn') {
    const columns = groups
      .map(
        (group, index) =>
          `<div class="abs" style="left:${18 + index * 60}mm; top:34mm; width:54mm;">
            <div class="label" style="margin-bottom:3mm;">${escapeHtml(group.title)}</div>
            ${rowsHtml(group.facts)}
          </div>`,
      )
      .join('');
    return `<div class="page"><div class="sheet">${head}<div class="abs head" style="left:18mm; top:26mm; width:174mm; font-size:20pt;">${escapeHtml(values.title)}</div>${columns}${footer}</div></div>`;
  }
  if (design.spec === 'ledger') {
    return `<div class="page"><div class="sheet">${head}
      <div class="abs head" style="left:18mm; top:28mm; width:174mm; font-size:22pt;">${escapeHtml(values.title)}</div>
      <div class="abs" style="left:18mm; top:48mm; width:174mm;">${rowsHtml(allFacts)}</div>
      <div class="abs micro" style="left:18mm; top:272mm;">Every line measured before cutting</div>
      ${footer}</div></div>`;
  }
  if (design.spec === 'cards') {
    const cards = groups
      .map(
        (group, index) =>
          `<div class="abs" style="left:${18 + (index % 2) * 89}mm; top:${40 + Math.floor(index / 2) * 78}mm; width:80mm; height:70mm; border:0.2mm solid var(--hair); padding:6mm;">
            <div class="label" style="margin-bottom:3mm;">${escapeHtml(group.title)}</div>
            ${rowsHtml(group.facts)}
          </div>`,
      )
      .join('');
    return `<div class="page"><div class="sheet">${head}<div class="abs head" style="left:18mm; top:28mm; width:174mm; font-size:22pt;">${escapeHtml(values.title)}</div>${cards}${footer}</div></div>`;
  }
  if (design.spec === 'stacked') {
    return `<div class="page"><div class="sheet">${head}
      <div class="abs head" style="left:18mm; top:28mm; width:174mm; font-size:24pt;">${escapeHtml(values.title)}</div>
      <div class="abs" style="left:28mm; top:52mm; width:154mm;">${groups
        .map(
          (group) =>
            `<div class="label" style="margin:4mm 0 1.5mm;">${escapeHtml(group.title)}</div>${rowsHtml(group.facts)}`,
        )
        .join('')}</div>
      ${footer}</div></div>`;
  }
  // twoColumn
  return `<div class="page"><div class="sheet">${head}
    <div class="abs head" style="left:18mm; top:28mm; width:174mm; font-size:24pt;">${escapeHtml(values.title)}</div>
    <div class="abs" style="left:18mm; top:52mm; width:82mm;">${rowsHtml([...groups[0].facts, ...groups[2].facts])}</div>
    <div class="abs" style="left:110mm; top:52mm; width:82mm;">${rowsHtml(groups[1].facts)}</div>
    <div class="abs rule" style="left:18mm; top:272mm; width:174mm;"></div>
    ${footer}</div></div>`;
}

function finishCards(values) {
  return [1, 2, 3, 4].map((index) => ({
    name: values[`mat${index}Name`],
    image: values[`mat${index}Image`],
  }));
}

function finishesHtml(values, design) {
  const head = `<div class="abs label" style="left:18mm; top:16mm;">03 · Finishes</div><div class="abs micro" style="right:18mm; top:16mm;">${escapeHtml(values.orderNo)}</div><div class="abs rule" style="left:18mm; top:22mm; width:174mm;"></div>`;
  const footer = `<div class="abs micro" style="left:18mm; top:284mm;">Shades confirmed against physical samples</div><div class="abs micro" style="right:18mm; top:284mm;">03 / 04</div>`;
  const cards = finishCards(values);
  const card = (index, style) => `<div class="abs" style="${style}">
      <div class="ph" style="width:100%; height:100%; background-image:url(${cards[index].image});"></div>
      <div class="micro" style="margin-top:2mm;">${escapeHtml(cards[index].name)}</div>
    </div>`;
  const title = `<div class="abs head" style="left:18mm; top:28mm; width:174mm; font-size:22pt;">${escapeHtml(values.title)}</div>`;

  if (design.finishes === 'filmstrip') {
    const strip = cards
      .map(
        (entry, index) =>
          `<div class="abs" style="left:${18 + index * 43}mm; top:60mm; width:37mm;">
            <div class="ph" style="width:37mm; height:46mm; background-image:url(${entry.image});"></div>
            <div class="micro" style="margin-top:2mm;">${escapeHtml(entry.name)}</div>
          </div>`,
      )
      .join('');
    return `<div class="page"><div class="sheet">${head}${title}${strip}
      <div class="abs ph" style="left:18mm; top:132mm; width:174mm; height:70mm; background-image:url(${values.detailImage});"></div>
      <div class="abs body" style="left:18mm; top:212mm; width:174mm;">${escapeHtml(values.finishExt)}. ${escapeHtml(values.finishInt)}.</div>
      ${footer}</div></div>`;
  }
  if (design.finishes === 'stacked') {
    return `<div class="page"><div class="sheet">${head}${title}
      <div class="abs" style="left:18mm; top:54mm; width:174mm;">${cards
        .map(
          (entry, index) =>
            `<div class="abs" style="left:0; top:${index * 42}mm; width:174mm; height:42mm; border-bottom:0.12mm solid var(--hair);">
              <div class="abs ph" style="left:0; top:4mm; width:34mm; height:32mm; background-image:url(${entry.image});"></div>
              <div class="abs" style="left:42mm; top:12mm; font-family:var(--display); font-size:11pt; color:var(--ink);">${escapeHtml(entry.name)}</div>
            </div>`,
        )
        .join('')}</div>
      ${footer}</div></div>`;
  }
  if (design.finishes === 'band') {
    return `<div class="page"><div class="sheet"><div class="abs" style="left:0; top:0; width:210mm; height:150mm; background:var(--cover-paper);"></div>${head}${title}
      ${cards
        .map(
          (entry, index) =>
            `<div class="abs" style="left:${18 + index * 43}mm; top:76mm; width:37mm;">
              <div class="ph" style="width:37mm; height:52mm; background-image:url(${entry.image});"></div>
              <div class="micro" style="margin-top:2mm;">${escapeHtml(entry.name)}</div>
            </div>`,
        )
        .join('')}
      <div class="abs ph" style="left:18mm; top:164mm; width:174mm; height:64mm; background-image:url(${values.detailImage});"></div>
      ${footer}</div></div>`;
  }
  if (design.finishes === 'museum') {
    return `<div class="page"><div class="sheet">${head}${title}
      ${cards
        .map(
          (entry, index) =>
            `<div class="abs" style="left:${18 + (index % 2) * 89}mm; top:${54 + Math.floor(index / 2) * 74}mm; width:80mm; height:66mm; border:0.2mm solid var(--hair); padding:5mm;">
              <div class="ph" style="width:70mm; height:44mm; background-image:url(${entry.image});"></div>
              <div class="micro" style="margin-top:2mm;">${escapeHtml(entry.name)}</div>
            </div>`,
        )
        .join('')}
      <div class="abs body" style="left:18mm; top:232mm; width:174mm;">${escapeHtml(values.finishExt)}. ${escapeHtml(values.finishInt)}.</div>
      ${footer}</div></div>`;
  }
  // grid4
  return `<div class="page"><div class="sheet">${head}${title}
    ${cards
      .map(
        (entry, index) =>
          `<div class="abs" style="left:${18 + (index % 2) * 89}mm; top:${54 + Math.floor(index / 2) * 84}mm; width:80mm;">
            <div class="ph" style="width:80mm; height:58mm; background-image:url(${entry.image});"></div>
            <div class="micro" style="margin-top:2mm;">${escapeHtml(entry.name)}</div>
          </div>`,
      )
      .join('')}
    <div class="abs body" style="left:18mm; top:236mm; width:174mm;">${escapeHtml(values.finishExt)}. ${escapeHtml(values.finishInt)}. ${escapeHtml(values.edgeNote)}.</div>
    ${footer}</div></div>`;
}

function insideHtml(values, design, copy, photos) {
  const photoA = photos[design.insidePhoto] ?? photos[0] ?? values.insideImage;
  const photoB = photos[(design.insidePhoto + 1) % Math.max(1, photos.length)] ?? values.insideImage2;
  const head = `<div class="abs label" style="left:18mm; top:16mm;">04 · Inside</div><div class="abs micro" style="right:18mm; top:16mm;">${escapeHtml(values.orderNo)}</div><div class="abs rule" style="left:18mm; top:22mm; width:174mm;"></div>`;
  const footer = `<div class="abs micro" style="left:18mm; top:284mm;">${escapeHtml(values.shopLine)}</div><div class="abs micro" style="right:18mm; top:284mm;">04 / 04</div>`;
  const statement = escapeHtml(design.statement);
  const headline = escapeHtml(copy.headline);
  const body = escapeHtml(copy.body);
  const closing = escapeHtml(copy.closing);

  if (design.inside === 'diptych') {
    return `<div class="page"><div class="sheet">${head}
      <div class="abs head" style="left:18mm; top:30mm; width:174mm; font-size:26pt;">${statement}</div>
      <div class="abs ph" style="left:18mm; top:64mm; width:84mm; height:96mm; background-image:url(${photoA});"></div>
      <div class="abs ph" style="left:108mm; top:64mm; width:84mm; height:96mm; background-image:url(${photoB});"></div>
      <div class="abs body" style="left:18mm; top:174mm; width:174mm;">${body}</div>
      <div class="abs head" style="left:18mm; top:246mm; width:174mm; font-size:13pt;">${closing}</div>
      ${footer}</div></div>`;
  }
  if (design.inside === 'heroStatement') {
    return `<div class="page"><div class="sheet">${head}
      <div class="abs head" style="left:18mm; top:36mm; width:174mm; font-size:34pt;">${statement}</div>
      <div class="abs micro" style="left:18mm; top:86mm; width:174mm;">${headline}</div>
      <div class="abs ph" style="left:18mm; top:98mm; width:174mm; height:96mm; background-image:url(${photoA});"></div>
      <div class="abs body" style="left:18mm; top:204mm; width:174mm;">${body}</div>
      <div class="abs micro" style="left:18mm; top:266mm;">${closing}</div>
      ${footer}</div></div>`;
  }
  if (design.inside === 'splitStory') {
    return `<div class="page"><div class="sheet">${head}
      <div class="abs ph" style="left:0; top:0; width:96mm; height:297mm; background-image:url(${photoA});"></div>
      <div class="abs" style="left:108mm; top:34mm; width:84mm;">
        <div class="head" style="font-size:20pt;">${statement}</div>
        <div class="micro" style="margin-top:4mm;">${headline}</div>
        <div class="body" style="margin-top:4mm;">${body}</div>
        <div class="head" style="margin-top:6mm; font-size:12pt;">${closing}</div>
      </div>
      ${footer}</div></div>`;
  }
  // photoEssay
  return `<div class="page"><div class="sheet">${head}
    <div class="abs head" style="left:18mm; top:30mm; width:174mm; font-size:24pt;">${statement}</div>
    <div class="abs ph" style="left:18mm; top:60mm; width:174mm; height:92mm; background-image:url(${photoA});"></div>
    <div class="abs ph" style="left:18mm; top:158mm; width:84mm; height:44mm; background-image:url(${photoB});"></div>
    <div class="abs" style="left:110mm; top:158mm; width:82mm;">
      <div class="plain">${headline}</div>
      <div class="body" style="margin-top:2mm;">${body}</div>
    </div>
    <div class="abs head" style="left:18mm; top:252mm; width:174mm; font-size:12pt;">${closing}</div>
    ${footer}</div></div>`;
}

/** Compile a validated design into one print ready HTML document. */
export function compileAiBrochure({ order, materials, palette, design, copy, templatesDir, attachmentImages = [] }) {
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
  const stack = TYPE_STACKS[design.type] ?? TYPE_STACKS.editorial;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(values.title)} · ${escapeHtml(values.orderNo)}</title>
<link rel="stylesheet" href="../fonts/brand.css">
<style>
:root { ${paletteCss(palette)}
  --display: ${stack.display};
  --body: ${stack.body};
}
${BASE_CSS}
</style></head><body>
${coverHtml(values, design, photos)}
${specHtml(values, design)}
${finishesHtml(values, design)}
${insideHtml(values, design, copy, photos)}
</body></html>`;
}

/** Human label for a design, stored with the render for the studio history. */
export function designLabel(design) {
  const words = [design.type, design.tone, design.cover, design.spec, design.finishes, design.inside];
  return words.map((word) => word.replace(/([A-Z])/g, ' $1').trim()).join(' · ');
}
