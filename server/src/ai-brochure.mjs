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
  '{"design":{"tone":"copper|ink|olive|indigo|sand","type":"editorial|modern|classic","cover":"fullBleed|splitLeft|splitRight|bandTop|framed|masthead","story":"hero|editorial|diptych|collage","materials":"grid4|filmstrip|band|museum|stacked","spec":"twoColumn|threeColumn|ledger|cards|stacked","coverPhoto":0,"storyPhoto":1,"detailPhoto":2,"statement":"one calm line, at most 80 characters"},"copy":{"headline":"...","body":"...","closing":"..."}}',
  'The four pages:',
  '1. Cover. A strong photograph, the brand, the piece and the customer. Almost nothing else.',
  '2. Story. One or two photographs and the statement as a large line. The body sits small in a column, like a caption in a magazine.',
  '3. Materials. The four finish textures at size, names in small caps. This is a colour page, not a table.',
  '4. Specification. The technical details, set quietly at the back for the workshop and the client file, not the reason to open the brochure.',
  'Design rules:',
  '- Choose the tone and type that suit the room and the piece. Vary them from order to order.',
  '- Avoid the obvious default. A split cover with editorial type is the safe answer, so use it for at most one order in three. Prefer masthead, bandTop or framed covers, and mix modern and classic type.',
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
  const rawStory = clean(parsed.design.story ?? parsed.design.inside);
  const story = STORY_ALIASES[rawStory] ?? pickEnum(rawStory, STORY_LAYOUTS, 'story', 'editorial');
  const rawMaterials = clean(parsed.design.materials ?? parsed.design.finishes);
  const design = {
    tone: pickEnum(parsed.design.tone, TONES, 'tone', 'copper'),
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
  .page { position:relative; width:216mm; height:303mm; overflow:hidden; page-break-after:always; background:var(--paper); }
  .page:last-child { page-break-after:auto; }
  .sheet { position:absolute; left:3mm; top:3mm; width:210mm; height:297mm; }
  .abs { position:absolute; }
  .ph { background-size:cover; background-position:center; background-repeat:no-repeat; }
  .micro { font-family:var(--body); font-size:4.9pt; letter-spacing:.24em; text-transform:uppercase; color:var(--faint); }
  .label { font-family:var(--body); font-size:5.2pt; letter-spacing:.24em; text-transform:uppercase; color:var(--muted); }
  .value { font-family:var(--body); font-size:6.2pt; line-height:1.4; color:var(--ink); }
  .head { font-family:var(--display); font-weight:400; color:var(--ink); line-height:1.0; letter-spacing:-.015em; }
  .serif { font-family:var(--display); font-weight:400; color:var(--ink); line-height:1.02; letter-spacing:-.01em; }
  .body { font-family:var(--body); font-size:6.1pt; line-height:1.62; color:var(--muted); }
  .caption { font-family:var(--body); font-size:5.4pt; line-height:1.5; color:var(--muted); }
  .rule { height:0.16mm; background:var(--hair); }
  .acc { background:var(--accent); }
  .folio { position:absolute; left:18mm; right:18mm; bottom:7.5mm; display:flex; justify-content:space-between; font-family:var(--body); font-size:4.4pt; letter-spacing:.2em; text-transform:uppercase; color:var(--faint); }
  .folioDark { color:rgba(255,255,255,0.72); }
  .row { display:flex; justify-content:space-between; align-items:baseline; gap:6mm; border-bottom:0.12mm solid var(--hair); padding:1.7mm 0; }
  .row .k { font-family:var(--body); font-size:4.8pt; letter-spacing:.16em; text-transform:uppercase; color:var(--muted); }
  .row .v { font-family:var(--body); font-size:6pt; color:var(--ink); text-align:right; }
  .body2col { display:flex; gap:6mm; }
  .body2col > div { flex:1; font-family:var(--body); font-size:5.9pt; line-height:1.62; color:var(--muted); }
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

function columnsHtml(text, columns = 2) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const perColumn = Math.ceil(words.length / columns);
  const chunks = [];
  for (let index = 0; index < columns; index += 1) {
    chunks.push(words.slice(index * perColumn, (index + 1) * perColumn).join(' '));
  }
  return `<div class="body2col">${chunks.map((chunk) => `<div>${escapeHtml(chunk)}</div>`).join('')}</div>`;
}

function folio(page, dark = false) {
  return `<div class="folio ${dark ? 'folioDark' : ''}"><span>Grace Wood Industry · Nagercoil</span><span>0${page} / 04</span></div>`;
}

function coverHtml(values, design, photos) {
  const photo = photos[design.coverPhoto] ?? photos[0] ?? values.coverImage;
  const title = escapeHtml(values.title);
  const room = escapeHtml(values.room);
  const customer = escapeHtml(values.customerName);
  const meta = `${escapeHtml(values.orderNo)} · ${escapeHtml(values.date)}`;
  const logo = '<img class="abs" src="../assets/grace-logo.png" style="left:18mm; top:14mm; width:12mm;">';

  if (design.cover === 'fullBleed') {
    return `<div class="page cover"><div class="abs ph" style="left:-3mm; top:-3mm; width:216mm; height:303mm; background-image:url(${photo});"></div>
      <div class="abs" style="left:-3mm; top:150mm; width:216mm; height:156mm; background:linear-gradient(to top, rgba(8,7,6,0.82) 0%, rgba(8,7,6,0.35) 55%, rgba(8,7,6,0) 100%);"></div>
      <div class="abs micro white" style="left:18mm; top:18mm; letter-spacing:.32em;">Grace Wood Industry</div>
      <div class="abs micro white" style="right:18mm; top:18mm; text-align:right;">${meta}</div>
      <div class="abs head white" style="left:18mm; top:196mm; width:174mm; font-size:42pt;">${title}</div>
      <div class="abs" style="left:18mm; top:252mm; width:174mm;"><div class="rule" style="width:24mm; background:rgba(255,255,255,0.55);"></div></div>
      <div class="abs micro white" style="left:18mm; top:259mm; width:174mm;">${customer} · ${room} · ${escapeHtml(values.width)}</div>
      ${folio(1, true)}
    </div>`;
  }

  if (design.cover === 'splitLeft' || design.cover === 'splitRight') {
    const photoFirst = design.cover === 'splitLeft';
    const photoStyle = photoFirst
      ? 'left:-3mm; top:-3mm; width:111mm; height:303mm;'
      : 'left:105mm; top:-3mm; width:111mm; height:303mm;';
    const textLeft = photoFirst ? 116 : 18;
    const textWidth = 78;
    return `<div class="page cover"><div class="abs ph" style="${photoStyle} background-image:url(${photo});"></div>
      <div class="abs micro" style="left:${textLeft}mm; top:16mm; width:${textWidth}mm;">Grace Wood Industry</div>
      <div class="abs micro" style="left:${textLeft}mm; top:21mm; width:${textWidth}mm;">${meta}</div>
      <div class="abs head" style="left:${textLeft}mm; top:88mm; width:${textWidth}mm; font-size:30pt;">${title}</div>
      <div class="abs" style="left:${textLeft}mm; top:170mm; width:${textWidth}mm;"><div class="rule acc" style="width:22mm;"></div></div>
      <div class="abs" style="left:${textLeft}mm; top:178mm; width:${textWidth}mm;"><div class="micro">${room}</div><div class="micro" style="margin-top:1.5mm;">${escapeHtml(values.width)} · ${escapeHtml(values.height)} · ${escapeHtml(values.depth)}</div></div>
      <div class="abs" style="left:${textLeft}mm; top:232mm; width:${textWidth}mm; font-family:var(--body); font-size:7pt; color:var(--ink);">${customer}</div>
      <div class="abs micro" style="left:${textLeft}mm; top:284mm; width:${textWidth}mm;">Grace Wood Industry · Nagercoil</div>
      <div class="abs micro" style="left:${photoFirst ? 116 : 18}mm; top:284mm;">01 / 04</div>
    </div>`;
  }

  if (design.cover === 'masthead') {
    return `<div class="page cover"><div class="sheet">
      ${logo}
      <div class="abs" style="left:0; top:40mm; width:210mm; text-align:center; font-family:var(--body); font-size:6.4pt; letter-spacing:.4em; text-transform:uppercase; color:var(--accent);">Grace Wood Industry</div>
      <div class="abs head" style="left:18mm; top:52mm; width:174mm; text-align:center; font-size:42pt;">${title}</div>
      <div class="abs micro" style="left:18mm; top:112mm; width:174mm; text-align:center;">${customer} · ${room}</div>
      <div class="abs ph" style="left:-3mm; top:129mm; width:216mm; height:174mm; background-image:url(${photo});"></div>
      <div class="abs micro" style="left:18mm; top:118mm; width:174mm; text-align:center;">${meta}</div>
      ${folio(1, true)}
    </div></div>`;
  }

  if (design.cover === 'framed') {
    return `<div class="page cover"><div class="sheet">
      ${logo}
      <div class="abs micro" style="left:18mm; top:22mm; width:174mm; text-align:center;">Grace Wood Industry</div>
      <div class="abs" style="left:53mm; top:40mm; width:104mm; height:150mm; border:0.25mm solid var(--ink); padding:5mm;">
        <div class="abs ph" style="left:5mm; top:5mm; width:94mm; height:140mm; background-image:url(${photo});"></div>
      </div>
      <div class="abs head" style="left:18mm; top:208mm; width:174mm; text-align:center; font-size:24pt;">${title}</div>
      <div class="abs micro" style="left:18mm; top:250mm; width:174mm; text-align:center;">${customer} · ${room}</div>
      <div class="abs micro" style="left:18mm; top:280mm; width:174mm; text-align:center;">${meta} · Grace Wood Industry</div>
      ${folio(1)}
    </div></div>`;
  }

  // bandTop
  return `<div class="page cover"><div class="sheet">
    <div class="abs ph" style="left:-3mm; top:-3mm; width:216mm; height:174mm; background-image:url(${photo});"></div>
    ${logo}
    <div class="abs micro" style="right:18mm; top:18mm; width:70mm; text-align:right;">${meta}</div>
    <div class="abs head" style="left:18mm; top:184mm; width:174mm; font-size:36pt;">${title}</div>
    <div class="abs" style="left:18mm; top:232mm; width:174mm;"><div class="rule acc" style="width:22mm;"></div></div>
    <div class="abs" style="left:18mm; top:240mm; width:96mm;"><div class="micro">${room}</div><div class="micro" style="margin-top:1.5mm;">${escapeHtml(values.width)} · ${escapeHtml(values.height)} · ${escapeHtml(values.depth)}</div></div>
    <div class="abs" style="right:18mm; top:240mm; width:60mm; text-align:right; font-family:var(--body); font-size:7pt; color:var(--ink);">${customer}</div>
    ${folio(1)}
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
      <div class="abs" style="left:18mm; top:244mm; width:174mm;">${bodyColumns}</div>
      <div class="abs closingLine" style="left:18mm; top:268mm; width:174mm;">${closing}</div>
      ${folio(2)}
    </div></div>`;
  }
  if (design.story === 'diptych') {
    return `<div class="page"><div class="sheet">
      <div class="abs ph" style="left:-3mm; top:-3mm; width:111mm; height:196mm; background-image:url(${photo});"></div>
      <div class="abs ph" style="left:105mm; top:-3mm; width:111mm; height:196mm; background-image:url(${photoAlt});"></div>
      <div class="abs" style="left:18mm; top:204mm; width:174mm;"><div class="headlineLabel">${headline}</div></div>
      <div class="abs serif" style="left:18mm; top:212mm; width:100mm; font-size:22pt;">${statement}</div>
      <div class="abs" style="left:18mm; top:252mm; width:174mm;">${bodyColumns}</div>
      <div class="abs micro" style="left:18mm; top:272mm; width:174mm;">${closing}</div>
      ${folio(2)}
    </div></div>`;
  }
  if (design.story === 'collage') {
    return `<div class="page"><div class="sheet">
      <div class="abs serif" style="left:18mm; top:22mm; width:100mm; font-size:22pt;">${statement}</div>
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
    <div class="abs" style="left:130mm; top:24mm; width:62mm;"><div class="headlineLabel">${headline}</div></div>
    <div class="abs serif" style="left:130mm; top:34mm; width:62mm; font-size:21pt;">${statement}</div>
    <div class="abs" style="left:130mm; top:100mm; width:62mm;"><div class="rule" style="width:18mm;"></div></div>
    <div class="abs" style="left:130mm; top:92mm; width:62mm;"><div class="rule" style="width:18mm; margin-bottom:4mm;"></div><div class="body">${escapeHtml(copy.body)}</div></div>
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
  const head = `<div class="abs label" style="left:18mm; top:18mm;">Materials</div><div class="abs micro" style="right:18mm; top:18mm;">${escapeHtml(values.orderNo)}</div><div class="abs rule" style="left:18mm; top:24mm; width:174mm;"></div><div class="abs acc" style="left:18mm; top:30mm; width:14mm; height:0.6mm;"></div>`;
  const finishLine = `<div class="abs caption" style="left:18mm; top:258mm; width:174mm;">${escapeHtml(values.finishExt)}. ${escapeHtml(values.finishInt)}. ${escapeHtml(values.edgeNote)}.</div><div class="abs micro" style="left:18mm; top:270mm; width:174mm;">Shown as samples, matched in person</div>`;

  if (design.materials === 'filmstrip') {
    return `<div class="page"><div class="sheet">${head}
      <div class="abs serif" style="left:18mm; top:34mm; width:174mm; font-size:19pt;">Finish palette</div>
      ${cards
        .map(
          (entry, index) =>
            `<div class="abs" style="left:${18 + index * 43}mm; top:60mm; width:38mm;">
              <div class="ph" style="width:38mm; height:160mm; background-image:url(${entry.image});"></div>
              <div class="micro" style="margin-top:2.5mm;">${escapeHtml(entry.name)}</div>
            </div>`,
        )
        .join('')}
      ${finishLine}${folio(3)}</div></div>`;
  }
  if (design.materials === 'band') {
    return `<div class="page"><div class="sheet">${head}
      <div class="abs serif" style="left:18mm; top:34mm; width:174mm; font-size:19pt;">Finish palette</div>
      <div class="abs" style="left:-3mm; top:64mm; width:216mm; height:120mm; display:flex;">
        ${cards
          .map(
            (entry) =>
              `<div style="width:52.5mm; height:120mm; background-image:url(${entry.image}); background-size:cover; background-position:center;"></div>`,
          )
          .join('')}
      </div>
      <div class="abs" style="left:18mm; top:190mm; width:174mm; display:flex;">
        ${cards
          .map((entry) => `<div style="width:43.5mm;"><div class="micro">${escapeHtml(entry.name)}</div></div>`)
          .join('')}
      </div>
      ${finishLine}${folio(3)}</div></div>`;
  }
  if (design.materials === 'museum') {
    return `<div class="page"><div class="sheet">${head}
      <div class="abs serif" style="left:18mm; top:34mm; width:174mm; font-size:19pt;">Finish palette</div>
      <div class="abs ph" style="left:18mm; top:58mm; width:116mm; height:170mm; background-image:url(${cards[0].image});"></div>
      ${cards
        .slice(1)
        .map(
          (entry, index) =>
            `<div class="abs" style="left:144mm; top:${58 + index * 58}mm; width:48mm;">
              <div class="ph" style="width:48mm; height:40mm; background-image:url(${entry.image});"></div>
              <div class="micro" style="margin-top:1.6mm;">${escapeHtml(entry.name)}</div>
            </div>`,
        )
        .join('')}
      ${finishLine}${folio(3)}</div></div>`;
  }
  if (design.materials === 'stacked') {
    return `<div class="page"><div class="sheet">${head}
      <div class="abs serif" style="left:18mm; top:34mm; width:174mm; font-size:19pt;">Finish palette</div>
      <div class="abs ph" style="left:18mm; top:58mm; width:174mm; height:104mm; background-image:url(${cards[0].image});"></div>
      <div class="abs" style="left:18mm; top:174mm; width:174mm; display:flex;">
        ${cards
          .slice(1)
          .map(
            (entry) =>
              `<div style="width:56mm;"><div class="ph" style="width:52mm; height:52mm; background-image:url(${entry.image});"></div><div class="micro" style="margin-top:1.6mm;">${escapeHtml(entry.name)}</div></div>`,
          )
          .join('')}
      </div>
      ${finishLine}${folio(3)}</div></div>`;
  }
  // grid4: four large texture squares
  return `<div class="page"><div class="sheet">${head}
    <div class="abs serif" style="left:18mm; top:34mm; width:174mm; font-size:19pt;">Finish palette</div>
    ${cards
      .map(
        (entry, index) =>
          `<div class="abs" style="left:${18 + (index % 2) * 88}mm; top:${60 + Math.floor(index / 2) * 88}mm; width:84mm;">
            <div class="ph" style="width:84mm; height:72mm; background-image:url(${entry.image});"></div>
            <div class="micro" style="margin-top:2mm;">${escapeHtml(entry.name)}</div>
          </div>`,
      )
      .join('')}
    ${finishLine}${folio(3)}</div></div>`;
}

function specificationHtml(values, design) {
  const groups = specGroups(values);
  const allFacts = groups.flatMap((group) => group.facts);
  const head = `<div class="abs label" style="left:18mm; top:18mm;">Specification</div><div class="abs micro" style="right:18mm; top:18mm;">${escapeHtml(values.orderNo)}</div><div class="abs rule" style="left:18mm; top:24mm; width:174mm;"></div>`;
  const contact = `<div class="abs" style="left:18mm; top:262mm; width:174mm;"><div class="rule" style="width:174mm;"></div><div class="micro" style="margin-top:3mm;">Grace Wood Industry · Chettikulam, Nagercoil 629001 · +91 63740 43346 · info.gracewoodindustry@gmail.com</div></div>`;

  if (design.spec === 'ledger') {
    return `<div class="page"><div class="sheet">${head}
      <div class="abs serif" style="left:18mm; top:36mm; width:174mm; font-size:22pt;">${escapeHtml(values.title)}</div>
      <div class="abs" style="left:18mm; top:56mm; width:174mm;">${rowsHtml(allFacts)}</div>
      ${contact}${folio(4)}</div></div>`;
  }
  if (design.spec === 'cards') {
    return `<div class="page"><div class="sheet">${head}
      <div class="abs serif" style="left:18mm; top:36mm; width:174mm; font-size:22pt;">${escapeHtml(values.title)}</div>
      ${groups
        .map(
          (group, index) =>
            `<div class="abs" style="left:${18 + (index % 2) * 89}mm; top:${58 + Math.floor(index / 2) * 64}mm; width:80mm; border-top:0.25mm solid var(--ink); padding-top:4mm;">
              <div class="label" style="margin-bottom:2.5mm;">${escapeHtml(group.title)}</div>
              ${rowsHtml(group.facts)}
            </div>`,
        )
        .join('')}
      ${contact}${folio(4)}</div></div>`;
  }
  if (design.spec === 'threeColumn') {
    return `<div class="page"><div class="sheet">${head}
      <div class="abs serif" style="left:18mm; top:36mm; width:174mm; font-size:22pt;">${escapeHtml(values.title)}</div>
      ${groups
        .map(
          (group, index) =>
            `<div class="abs" style="left:${18 + index * 60}mm; top:58mm; width:54mm;">
              <div class="label" style="margin-bottom:2.5mm;">${escapeHtml(group.title)}</div>
              ${rowsHtml(group.facts)}
            </div>`,
        )
        .join('')}
      ${contact}${folio(4)}</div></div>`;
  }
  if (design.spec === 'stacked') {
    return `<div class="page"><div class="sheet">${head}
      <div class="abs serif" style="left:18mm; top:36mm; width:174mm; font-size:22pt;">${escapeHtml(values.title)}</div>
      ${groups
        .map(
          (group, index) =>
            `<div class="abs" style="left:18mm; top:${58 + index * 62}mm; width:174mm;">
              <div class="label" style="margin-bottom:2mm;">${escapeHtml(group.title)}</div>
              ${rowsHtml(group.facts)}
            </div>`,
        )
        .join('')}
      ${contact}${folio(4)}</div></div>`;
  }
  // twoColumn
  return `<div class="page"><div class="sheet">${head}
    <div class="abs serif" style="left:18mm; top:36mm; width:174mm; font-size:22pt;">${escapeHtml(values.title)}</div>
    <div class="abs" style="left:18mm; top:58mm; width:82mm;">${rowsHtml([...groups[0].facts, ...groups[2].facts])}</div>
    <div class="abs" style="left:110mm; top:58mm; width:82mm;">${rowsHtml(groups[1].facts)}</div>
    ${contact}${folio(4)}</div></div>`;
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
