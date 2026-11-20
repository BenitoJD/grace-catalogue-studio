import { escapeHtml } from './render.mjs';

// Cover titles are fitted on the server because WeasyPrint does not shrink
// type. The family template positions a title wrapper; this module chooses the
// line breaks and the font size that fit inside that wrapper.

const MM_PER_PT = 25.4 / 72;
const MAX_TITLE_LINES = 3;

// Conservative average glyph width in em for the display serif and grotesque.
// Deliberately generous: WeasyPrint wraps a line that is even slightly too
// wide, and a third line must never become a fourth. Titles shrink a little
// more than strictly needed instead of clipping or reflowing.
const CHAR_EM = 0.6;
const SPACE_EM = 0.3;

function text(value) {
  return String(value ?? '').trim();
}

function lineWidthEm(words) {
  const characters = words.reduce((total, word) => total + word.length, 0);
  return characters * CHAR_EM + Math.max(0, words.length - 1) * SPACE_EM;
}

// Split words into `lineCount` contiguous lines with the narrowest possible
// widest line. Titles are a handful of words, so a small dynamic program is
// plenty.
function partitionWords(words, lineCount) {
  const count = words.length;
  const best = Array.from({ length: count + 1 }, () =>
    Array(lineCount + 1).fill(Number.POSITIVE_INFINITY),
  );
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

// Choose the line break and font size for a title. At most three lines. The
// size is limited by the title box width, the space above the footer or photo,
// and the family's own type scale, so a long title shrinks instead of clipping.
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

// Raw markup for the {{title}} placeholder. Family templates style the wrapper
// and supply the position; this fragment carries the fitted size and breaks.
export function buildTitleMarkup(title, options) {
  const lineHeight = options.lineHeight ?? 1;
  const plan = planCoverTitle(title, options);
  const lines = plan.lines.map((line) => escapeHtml(line.join(' '))).join('<br>');
  return `<div style="font-size:${plan.sizePt}pt; line-height:${lineHeight};">${lines}</div>`;
}
