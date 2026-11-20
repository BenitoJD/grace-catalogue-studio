import { escapeHtml } from './render.mjs';

// Cover compositions for the voucher. One base template owns the paper, the
// type styles and the specification, finishes and inside pages. The server
// builds page one from the cover layout and palette chosen by the variant.

const MM_PER_PT = 25.4 / 72;
const MAX_TITLE_LINES = 3;

// Conservative average glyph width in em for the cover serif. Used to pick a
// font size that fits the measured line box; the box is never clipped.
const CHAR_EM = 0.52;
const SPACE_EM = 0.28;

function esc(value) {
  return escapeHtml(value ?? '');
}

function text(value) {
  return String(value ?? '').trim();
}

function lineWidthEm(words) {
  const characters = words.reduce((total, word) => total + word.length, 0);
  return characters * CHAR_EM + Math.max(0, words.length - 1) * SPACE_EM;
}

// Split words into `lineCount` contiguous lines with the narrowest possible
// widest line. Small inputs only: titles are a handful of words.
function partitionWords(words, lineCount) {
  const count = words.length;
  const best = Array.from({ length: count + 1 }, () => Array(lineCount + 1).fill(Number.POSITIVE_INFINITY));
  const splitAt = Array.from({ length: count + 1 }, () => Array(lineCount + 1).fill(-1));
  best[0][0] = 0;

  for (let lines = 1; lines <= lineCount; lines += 1) {
    for (let end = 1; end <= count; end += 1) {
      for (let start = lines - 1; start < end; start += 1) {
        if (!Number.isFinite(best[start][lines - 1])) continue;
        const width = lineWidthEm(words.slice(start, end));
        const cost = Math.max(best[start][lines - 1], width);
        if (cost < best[end][lines]) {
          best[end][lines] = cost;
          splitAt[end][lines] = start;
        }
      }
    }
  }

  if (splitAt[count][lineCount] < 0) return null;
  const lines = [];
  let end = count;
  for (let linesLeft = lineCount; linesLeft >= 1; linesLeft -= 1) {
    const start = splitAt[end][linesLeft];
    lines.unshift(words.slice(start, end));
    end = start;
  }
  return lines;
}

// Choose the line break and font size for a cover title. At most three lines.
// The size is limited by the text box width, the space above the footer/photo
// and the layout's own type scale, so the full title always fits and stays in
// the PDF text layer.
export function planCoverTitle(title, { widthMm, availableHeightMm, maxSizePt, lineHeight = 1 }) {
  const words = text(title).split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return { lines: [], sizePt: maxSizePt, heightMm: 0 };
  }

  const widthPt = (widthMm * 72) / 25.4;
  const heightPt = (availableHeightMm * 72) / 25.4;
  const largestLineCount = Math.min(MAX_TITLE_LINES, words.length);

  let best = null;
  for (let lineCount = 1; lineCount <= largestLineCount; lineCount += 1) {
    const lines = partitionWords(words, lineCount);
    if (!lines) continue;
    const widestLineEm = Math.max(...lines.map(lineWidthEm));
    const sizeFromWidth = widthPt / widestLineEm;
    const sizeFromHeight = heightPt / (lineCount * lineHeight);
    const sizePt = Math.min(maxSizePt, sizeFromWidth, sizeFromHeight);
    const candidate = { lines, sizePt, lineCount };
    if (
      !best ||
      candidate.sizePt > best.sizePt + 0.01 ||
      (Math.abs(candidate.sizePt - best.sizePt) <= 0.01 && candidate.lineCount < best.lineCount)
    ) {
      best = candidate;
    }
  }

  // Round down to the half point so the estimate never overshoots the box.
  const sizePt = Math.max(8, Math.floor(best.sizePt * 2) / 2);
  const heightMm = best.lines.length * sizePt * lineHeight * MM_PER_PT;
  return { lines: best.lines, sizePt, heightMm };
}

function titleBlock(plan, { position, lineHeight, extraClass = '' }) {
  const html = plan.lines.map((line) => esc(line.join(' '))).join('<br>');
  return (
    `<div class="abs cover-title ${extraClass}" style="${position}; font-size:${plan.sizePt}pt; ` +
    `line-height:${lineHeight};">${html}</div>`
  );
}

function logo(variant, { left = '21mm', top = '21mm', width = '17mm' } = {}) {
  const source = variant === 'white' ? '../assets/derived/logo-white.png' : '../assets/grace-logo.png';
  return `<img class="abs" src="${source}" style="left:${left}; top:${top}; width:${width};">`;
}

function orderMeta(values, position, extraClass = '') {
  return (
    `<div class="abs cover-kicker ${extraClass}" style="${position};">` +
    `${esc(values.orderNo)}<br>${esc(values.date)}</div>`
  );
}

function accentRule(position, height = '0.7mm') {
  return `<div class="abs cover-rule" style="${position}; height:${height};"></div>`;
}

function dimsLine(values) {
  return [values.width, values.height, values.depth].map(text).filter(Boolean).join(' · ');
}

function paperFooter(values) {
  return (
    `<div class="abs cover-kicker cover-muted" style="left:21mm; top:287mm;">Grace Wood Industry · Nagercoil</div>` +
    `<div class="abs cover-kicker cover-muted" style="right:21mm; top:287mm; text-align:right;">01 / 04</div>`
  );
}

function photoFooter() {
  return (
    `<div class="abs cover-kicker on-photo" style="left:21mm; top:287mm;">Grace Wood Industry · Nagercoil</div>` +
    `<div class="abs cover-kicker on-photo" style="right:21mm; top:287mm; text-align:right;">01 / 04</div>`
  );
}

function customerName(values, position, { onPhoto = false, align = 'left', size = '6.6pt' } = {}) {
  const classes = onPhoto ? 'name cover-name on-photo' : 'name cover-name';
  return (
    `<div class="abs ${classes}" style="${position}; text-align:${align}; font-size:${size};">` +
    `${esc(values.customerName)}</div>`
  );
}

// ---------------------------------------------------------------------------
// Cover layouts
// ---------------------------------------------------------------------------

function fullBleed({ palette, values, typeScale }) {
  const plan = planCoverTitle(values.title, {
    widthMm: 174,
    availableHeightMm: 74,
    maxSizePt: typeScale.titleMaxPt,
    lineHeight: typeScale.titleLineHeight,
  });
  const titleBottomMm = 272;
  const titleTopMm = titleBottomMm - plan.heightMm;
  const nameTopMm = Math.max(24, titleTopMm - 7);

  return (
    `<div class="abs cover-photo" style="left:0; top:0; width:216mm; height:303mm; ` +
    `background-image:url(${esc(values.coverImage)});"></div>` +
    `<div class="abs" style="left:0; top:0; width:216mm; height:303mm; background-image:linear-gradient(180deg, ` +
    `${palette.gradientTop} 0%, rgba(0,0,0,0) 34%, ${palette.gradientBottom} 100%);"></div>` +
    logo('white') +
    orderMeta(values, 'right:21mm; top:24mm; text-align:right;', 'on-photo') +
    customerName(values, `left:21mm; top:${nameTopMm.toFixed(1)}mm;`, { onPhoto: true }) +
    titleBlock(plan, {
      position: `left:21mm; top:${titleTopMm.toFixed(1)}mm; width:174mm;`,
      lineHeight: typeScale.titleLineHeight,
      extraClass: 'on-photo',
    }) +
    photoFooter()
  );
}

function splitRight({ palette, values, typeScale }) {
  const plan = planCoverTitle(values.title, {
    widthMm: 84,
    availableHeightMm: 138,
    maxSizePt: typeScale.titleMaxPt,
    lineHeight: typeScale.titleLineHeight,
  });

  return (
    `<div class="abs cover-photo" style="left:108mm; top:0; width:108mm; height:303mm; ` +
    `background-image:url(${esc(values.coverImage)});"></div>` +
    `<div class="abs" style="left:108mm; top:0; width:108mm; height:303mm; background-image:linear-gradient(180deg, ` +
    `rgba(0,0,0,0) 74%, ${palette.gradientBottom} 100%);"></div>` +
    logo('ink', { width: '15mm' }) +
    orderMeta(values, 'left:21mm; top:50mm;', 'cover-muted') +
    accentRule('left:21mm; top:84mm; width:18mm;') +
    titleBlock(plan, {
      position: 'left:21mm; top:96mm; width:84mm;',
      lineHeight: typeScale.titleLineHeight,
    }) +
    customerName(values, 'left:21mm; top:244mm;', { size: '6.4pt' }) +
    `<div class="abs cover-kicker cover-muted" style="left:21mm; top:287mm;">Grace Wood Industry · Nagercoil</div>` +
    `<div class="abs cover-kicker on-photo" style="right:21mm; top:287mm; text-align:right;">01 / 04</div>`
  );
}

function splitLeft({ palette, values, typeScale }) {
  const plan = planCoverTitle(values.title, {
    widthMm: 84,
    availableHeightMm: 138,
    maxSizePt: typeScale.titleMaxPt,
    lineHeight: typeScale.titleLineHeight,
  });

  return (
    `<div class="abs cover-photo" style="left:0; top:0; width:108mm; height:303mm; ` +
    `background-image:url(${esc(values.coverImage)});"></div>` +
    `<div class="abs" style="left:0; top:0; width:108mm; height:303mm; background-image:linear-gradient(180deg, ` +
    `rgba(0,0,0,0) 74%, ${palette.gradientBottom} 100%);"></div>` +
    logo('ink', { left: '180mm', width: '15mm' }) +
    orderMeta(values, 'right:21mm; top:50mm; text-align:right;', 'cover-muted') +
    accentRule('right:21mm; top:84mm; width:18mm;') +
    titleBlock(plan, {
      position: 'right:21mm; top:96mm; width:84mm; text-align:right;',
      lineHeight: typeScale.titleLineHeight,
    }) +
    customerName(values, 'right:21mm; top:244mm;', { align: 'right', size: '6.4pt' }) +
    `<div class="abs cover-kicker on-photo" style="left:21mm; top:287mm;">01 / 04</div>` +
    `<div class="abs cover-kicker cover-muted" style="right:21mm; top:287mm; text-align:right;">Grace Wood Industry · Nagercoil</div>`
  );
}

function bandTop({ palette, values, typeScale }) {
  const plan = planCoverTitle(values.title, {
    widthMm: 174,
    availableHeightMm: 44,
    maxSizePt: typeScale.titleMaxPt,
    lineHeight: typeScale.titleLineHeight,
  });
  const roomLabel = text(values.room) || 'Wardrobe';

  return (
    `<div class="abs cover-photo" style="left:0; top:0; width:216mm; height:128mm; ` +
    `background-image:url(${esc(values.coverImage)});"></div>` +
    `<div class="abs" style="left:0; top:0; width:216mm; height:128mm; background-image:linear-gradient(180deg, ` +
    `${palette.bandScrim} 0%, rgba(0,0,0,0) 72%);"></div>` +
    logo('white') +
    orderMeta(values, 'right:21mm; top:24mm; text-align:right;', 'on-photo') +
    `<div class="abs cover-kicker on-photo" style="left:21mm; top:112mm;">${esc(roomLabel)}</div>` +
    accentRule('left:21mm; top:146mm; width:20mm;') +
    titleBlock(plan, {
      position: 'left:21mm; top:156mm; width:174mm;',
      lineHeight: typeScale.titleLineHeight,
    }) +
    `<div class="abs cover-kicker cover-muted" style="left:21mm; top:206mm;">${esc(dimsLine(values))}</div>` +
    customerName(values, 'left:21mm; top:246mm;', { size: '6.6pt' }) +
    paperFooter(values)
  );
}

function typeOnly({ palette, values, typeScale }) {
  const plan = planCoverTitle(values.title, {
    widthMm: 174,
    availableHeightMm: 86,
    maxSizePt: typeScale.titleMaxPt,
    lineHeight: typeScale.titleLineHeight,
  });
  const roomLabel = text(values.room) || 'Wardrobe proposal';

  return (
    `<div class="abs cover-kicker cover-label" style="left:21mm; top:62mm;">${esc(roomLabel)}</div>` +
    logo('ink') +
    orderMeta(values, 'right:21mm; top:24mm; text-align:right;', 'cover-muted') +
    titleBlock(plan, {
      position: 'left:21mm; top:74mm; width:174mm;',
      lineHeight: typeScale.titleLineHeight,
    }) +
    `<div class="abs cover-kicker cover-muted" style="left:21mm; top:168mm;">${esc(dimsLine(values))}</div>` +
    accentRule('left:21mm; top:190mm; width:174mm;', '0.3mm') +
    `<div class="abs cover-photo" style="left:21mm; top:198mm; width:174mm; height:40mm; ` +
    `background-image:url(${esc(values.coverImage)});"></div>` +
    customerName(values, 'left:21mm; top:250mm;', { size: '6.6pt' }) +
    paperFooter(values)
  );
}

function centred({ palette, values, typeScale }) {
  const plan = planCoverTitle(values.title, {
    widthMm: 174,
    availableHeightMm: 54,
    maxSizePt: typeScale.titleMaxPt,
    lineHeight: typeScale.titleLineHeight,
  });

  return (
    logo('ink', { left: '100mm', width: '16mm' }) +
    `<div class="abs cover-kicker cover-muted" style="left:21mm; top:48mm; width:174mm; text-align:center;">` +
    `${esc(values.orderNo)} · ${esc(values.date)}</div>` +
    accentRule('left:100mm; top:61mm; width:16mm;', '0.5mm') +
    titleBlock(plan, {
      position: 'left:21mm; top:74mm; width:174mm; text-align:center;',
      lineHeight: typeScale.titleLineHeight,
    }) +
    `<div class="abs cover-photo" style="left:48mm; top:140mm; width:120mm; height:88mm; ` +
    `background-image:url(${esc(values.coverImage)});"></div>` +
    `<div class="abs cover-kicker cover-muted" style="left:21mm; top:232mm; width:174mm; text-align:center;">` +
    `${esc(text(values.room))}</div>` +
    customerName(values, 'left:21mm; top:240mm; width:174mm;', { align: 'center', size: '6.6pt' }) +
    paperFooter(values)
  );
}

const COVER_LAYOUTS = {
  fullBleed,
  splitRight,
  splitLeft,
  bandTop,
  typeOnly,
  centred,
};

export function buildCoverBlock({ cover, palette, values, typeScale }) {
  const layout = COVER_LAYOUTS[cover];
  if (!layout) throw new Error(`Unknown cover layout "${cover}".`);
  return layout({ palette, values, typeScale });
}
