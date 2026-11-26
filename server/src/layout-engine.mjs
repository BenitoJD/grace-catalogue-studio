// Deterministic print layout engine.
//
// The model's job in this engine is content: the story, the order of pictures,
// the headline, the closing line. The studio owns the geometry: a 216 x 303 mm
// page, a 174 mm live area, a 12 column grid with 4 mm gutters and a 4.5 mm
// baseline. Nothing here is absolutely positioned by guesswork, so two blocks
// cannot collide and every margin is measured.
import { clean } from './llm.mjs';
import { colourName } from './image-palette.mjs';

export const PAGE = Object.freeze({
  width: 216,
  height: 303,
  liveLeft: 21,
  liveTop: 24,
  liveWidth: 174,
  liveHeight: 255,
  columns: 12,
  column: 130 / 12,
  gutter: 4,
  baseline: 4.5,
  folioBottom: 9,
});

export const GRID_PITCH = PAGE.column + PAGE.gutter;

/** Left edge of a 1 based column. */
export function columnX(column) {
  return PAGE.liveLeft + (Math.min(PAGE.columns, Math.max(1, column)) - 1) * GRID_PITCH;
}

/** Width of a span of columns including its gutters. */
export function spanWidth(columns) {
  const count = Math.min(PAGE.columns, Math.max(1, columns));
  return count * PAGE.column + (count - 1) * PAGE.gutter;
}

/** Snap a millimetre value down to the baseline grid. */
export function baselineY(value) {
  return Math.max(0, Math.round(value / PAGE.baseline) * PAGE.baseline);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function hasDashes(value) {
  return /[\u2013\u2014]/.test(String(value ?? ''));
}

function cleanText(value) {
  return clean(String(value ?? '').replace(/[\u2013\u2014]/g, '-'));
}

/** Characters that fit one line of a column at a given point size. */
export function lineCapacity(widthMm, fontPt) {
  const fontMm = fontPt * 0.3528;
  return Math.max(8, Math.floor(widthMm / (fontMm * 0.52)));
}

/**
 * Split copy into measured chunks that fit a fixed number of lines. Never
 * returns a chunk longer than the box can hold, so the printed page can not
 * overflow into the next block.
 */
export function fitCopy(text, { widthMm, fontPt, maxLines }) {
  const capacity = lineCapacity(widthMm, fontPt) * Math.max(1, maxLines);
  const words = cleanText(text).split(/\s+/).filter(Boolean);
  const chunks = [];
  let current = '';
  for (const word of words) {
    const candidate = current === '' ? word : `${current} ${word}`;
    if (candidate.length <= capacity) {
      current = candidate;
      continue;
    }
    if (current !== '') chunks.push(current);
    current = word.length > capacity ? word.slice(0, capacity) : word;
  }
  if (current !== '') chunks.push(current);
  return chunks.length > 0 ? chunks : [''];
}

function box({ x, y, width, style, content }) {
  return (
    `<div style="position:absolute;left:${x.toFixed(2)}mm;top:${y.toFixed(2)}mm;width:${width.toFixed(2)}mm;${style}">` +
    `${content}</div>`
  );
}

function folio(pageNumber) {
  return box({
    x: columnX(12) + PAGE.column - 10,
    y: PAGE.height - PAGE.folioBottom - 3,
    width: 10,
    style: 'text-align:right;font-family:var(--body);font-size:6.5pt;letter-spacing:0.16em;color:#8A7A66;',
    content: String(pageNumber).padStart(2, '0'),
  });
}

function kicker(text, x, y, width, color = '#8A7A66') {
  return box({
    x,
    y,
    width,
    style: `font-family:var(--body);font-size:6.4pt;line-height:1.5;letter-spacing:0.22em;text-transform:uppercase;color:${color};`,
    content: escapeHtml(cleanText(text)),
  });
}

function displayTitle(text, x, y, width, size = 34) {
  return box({
    x,
    y,
    width,
    style: `font-family:var(--display);font-size:${size}pt;line-height:1.04;color:var(--deep);`,
    content: escapeHtml(cleanText(text)),
  });
}

function bodyBox(text, x, y, width, lines = 18, size = 9.2) {
  return box({
    x,
    y,
    width,
    style: `font-family:var(--body);font-size:${size}pt;line-height:1.62;color:var(--ink);`,
    content: escapeHtml(text),
  });
}

function picture(token, x, y, width, height, caption = '') {
  const image = `<img src="${token}" style="display:block;width:100%;height:100%;object-fit:contain;">`;
  const captionBox =
    caption === ''
      ? ''
      : box({
          x,
          y: y + height + 4,
          width,
          style: 'font-family:var(--body);font-size:6.6pt;line-height:1.6;letter-spacing:0.04em;color:var(--muted);',
          content: escapeHtml(cleanText(caption)),
        });
  return box({
    x,
    y,
    width,
    style: `height:${height.toFixed(2)}mm;background:#EFE7D8;overflow:hidden;`,
    content: image,
  }) + captionBox;
}

function paletteRow(hexes, names, x, y, width) {
  const count = Math.max(1, hexes.length);
  const gap = 3;
  const chip = (width - gap * (count - 1)) / count;
  return hexes
    .map((hex, index) => {
      const chipX = x + index * (chip + gap);
      return box({
        x: chipX,
        y,
        width: chip,
        style: 'font-family:var(--body);font-size:5.8pt;line-height:1.35;letter-spacing:0.06em;color:var(--ink);',
        content:
          `<div style="height:14mm;background:${escapeHtml(hex)};border:0.2mm solid #D9D0C1;"></div>` +
          `<div style="margin-top:1.6mm;">${escapeHtml(cleanText(names[index] ?? hex))}<br>` +
          `<span style="color:#6E6E73;">${escapeHtml(hex)}</span></div>`,
      });
    })
    .join('');
}

function logoMark() {
  return (
    `<div class="page-brand" style="position:absolute;left:14mm;bottom:8mm;background:#F7F2E9;padding:1mm 1.8mm;">` +
    `<img src="{{logo}}" style="display:block;width:8mm;height:auto;"></div>`
  );
}

/** Cover: one photograph, brand plate, title, Tamil line and folio. */
export function coverPage({ order, photo, theme }) {
  const folioX = columnX(12) + PAGE.column - 10;
  return (
    `<div class="page" style="background:var(--paper);">` +
    picture(photo, PAGE.liveLeft, PAGE.liveTop, PAGE.liveWidth, 158) +
    box({
      x: PAGE.liveLeft,
      y: baselineY(PAGE.liveTop + 158 + 8),
      width: spanWidth(8),
      style: 'font-family:var(--body);font-size:6.6pt;line-height:1.6;letter-spacing:0.22em;text-transform:uppercase;color:#8A7A66;',
      content: escapeHtml(cleanText(`${order.title ?? 'Custom joinery'} · ${order.room ?? 'Room to confirm'}`)),
    }) +
    displayTitle('{{headline}}', PAGE.liveLeft, baselineY(202), spanWidth(9), 30) +
    box({
      x: PAGE.liveLeft,
      y: baselineY(244),
      width: spanWidth(6),
      style: 'font-family:var(--display);font-size:10pt;font-style:italic;line-height:1.5;color:var(--muted);',
      content: '{{brandTamil}}',
    }) +
    box({
      x: PAGE.liveLeft,
      y: baselineY(258),
      width: spanWidth(5),
      style: 'font-family:var(--body);font-size:6.2pt;line-height:1.6;letter-spacing:0.12em;color:#6E6152;',
      content: '{{brand}}<br>{{phone}}<br>{{email}}',
    }) +
    folio(1) +
    logoMark() +
    `</div>`
  );
}

/** Story page: kicker, title, measured copy in two columns, optional picture. */
export function storyPage({ photo, kickerText, title, chunks, theme, pageNumber }) {
  const columnWidth = spanWidth(6);
  const linesPerBox = 24;
  const left = chunks.slice(0, 2);
  const blocks = left
    .map((text, index) =>
      bodyBox(text, columnX(1 + index * 6), baselineY(126), columnWidth, linesPerBox),
    )
    .join('');
  return (
    `<div class="page" style="background:var(--paper);">` +
    kicker(kickerText, PAGE.liveLeft, PAGE.liveTop, spanWidth(8)) +
    displayTitle(title, PAGE.liveLeft, baselineY(PAGE.liveTop + 8), spanWidth(10), 30) +
    blocks +
    folio(pageNumber) +
    logoMark() +
    `</div>`
  );
}

/** Walker page: one whole photograph, caption and its palette. */
export function picturePage({ photo, caption, palette, names, pageNumber }) {
  return (
    `<div class="page" style="background:var(--paper);">` +
    picture(photo, PAGE.liveLeft, baselineY(PAGE.liveTop + 8), PAGE.liveWidth, 150, caption) +
    paletteRow(palette, names, PAGE.liveLeft, baselineY(208), PAGE.liveWidth) +
    box({
      x: PAGE.liveLeft,
      y: baselineY(244),
      width: spanWidth(9),
      style: 'font-family:var(--display);font-size:15pt;line-height:1.25;color:var(--deep);',
      content: 'The room, in the colours it already holds.',
    }) +
    folio(pageNumber) +
    logoMark() +
    `</div>`
  );
}

/** Closing page: contact plate, closing line and Tamil line. */
export function closingPage({ pageNumber }) {
  return (
    `<div class="page" style="background:var(--paper);">` +
    kicker('The client file', PAGE.liveLeft, PAGE.liveTop, spanWidth(6)) +
    displayTitle('{{closing}}', PAGE.liveLeft, baselineY(PAGE.liveTop + 14), spanWidth(9), 26) +
    box({
      x: PAGE.liveLeft,
      y: baselineY(206),
      width: spanWidth(8),
      style: 'height:52mm;',
      content: `<img src="{{contactPlateLight}}" style="width:100%;height:auto;display:block;">`,
    }) +
    box({
      x: columnX(10),
      y: baselineY(206),
      width: spanWidth(3),
      style: 'font-family:var(--body);font-size:6.4pt;line-height:1.7;letter-spacing:0.12em;color:#6E6152;text-align:right;',
      content: '{{placeTamil}}<br><br>{{brandTamil}}',
    }) +
    folio(pageNumber) +
    logoMark() +
    `</div>`
  );
}

/**
 * Compose a complete book from content only. The returned pages are token based
 * HTML; the existing compiler fills the brand, photos and palettes.
 */
export function layoutStudioBook({
  order = {},
  copy = {},
  photos = [],
  photoPalettes = {},
  pictureAnalysis = [],
  format = 'pamphlet',
}) {
  const body = cleanText(copy.body ?? '');
  const headline = cleanText(copy.headline ?? '');
  const captionFor = (index) =>
    cleanText(pictureAnalysis?.[index]?.summary ?? '') || 'The room, photographed.';
  const paletteFor = (index) => (Array.isArray(photoPalettes[`photo${index + 1}`]) ? photoPalettes[`photo${index + 1}`] : []);
  const namesFor = (index) => paletteFor(index).map((hex) => colourName(hex));

  const pages = [];
  let pageNumber = 1;
  pages.push(coverPage({ order, photo: '{{photo1}}', theme: null }));
  pageNumber += 1;

  const chunks = fitCopy(body, { widthMm: spanWidth(6), fontPt: 9.2, maxLines: 24 });
  const rows = Math.max(1, Math.ceil(chunks.length / 2));
  for (let row = 0; row < rows; row += 1) {
    const rowChunks = chunks.slice(row * 2, row * 2 + 2);
    const photoIndex = row;
    pages.push(
      storyPage({
        photo: photos[photoIndex] ? `{{photo${photoIndex + 1}}}` : null,
        kickerText: row === 0 ? 'The story' : 'The story, continued',
        title: row === 0 ? headline : 'A room held together by its materials.',
        chunks: rowChunks,
        theme: null,
        pageNumber,
      }),
    );
    pageNumber += 1;
  }

  for (let index = 0; index < photos.length; index += 1) {
    pages.push(
      picturePage({
        photo: `{{photo${index + 1}}}`,
        caption: captionFor(index),
        palette: paletteFor(index).slice(0, 4),
        names: namesFor(index),
        pageNumber,
      }),
    );
    pageNumber += 1;
  }

  pages.push(closingPage({ pageNumber }));
  return pages;
}
