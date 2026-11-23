// Customer PDFs are often how a studio sends its drawings and render sheets.
// The brochure needs pixels, so the first page of a PDF is rasterised once and
// cached beside the uploads. Poppler does the conversion when it is installed.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function isPdf(file) {
  return (
    /^application\/pdf/i.test(String(file?.contentType ?? '')) ||
    /\.pdf$/i.test(String(file?.url ?? file?.name ?? ''))
  );
}

export function pdfPreviewDir(dataDir) {
  return path.join(dataDir, 'pdf-previews');
}

export function pdfPreviewPath(dataDir, mediaUrl) {
  return path.join(pdfPreviewDir(dataDir), `${path.basename(String(mediaUrl), '.pdf')}.png`);
}

/**
 * Many interior PDFs are a page with one big render pasted into them. When no
 * PDF rasteriser is installed, the largest embedded JPEG is still a perfectly
 * usable picture: extract it straight from the file.
 */
export function extractEmbeddedJpegs(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
  const found = [];
  let cursor = 0;
  while (cursor < bytes.length) {
    const start = bytes.indexOf('stream', cursor);
    if (start === -1) break;
    let dataStart = start + 'stream'.length;
    if (bytes[dataStart] === 0x0d) dataStart += 1;
    if (bytes[dataStart] === 0x0a) dataStart += 1;
    const end = bytes.indexOf('endstream', dataStart);
    if (end === -1) break;
    const chunk = bytes.subarray(dataStart, end);
    const soi = chunk.indexOf(Buffer.from([0xff, 0xd8, 0xff]));
    if (soi !== -1) {
      const eoi = chunk.lastIndexOf(Buffer.from([0xff, 0xd9]));
      if (eoi > soi) found.push(chunk.subarray(soi, eoi + 2));
    }
    cursor = end + 'endstream'.length;
  }
  // The biggest images are the actual pages; small ones are thumbnails.
  return found.filter((jpeg) => jpeg.length > 10_000);
}

/** Kept for callers that only want one picture out of a PDF. */
export function extractLargestJpeg(buffer) {
  const found = extractEmbeddedJpegs(buffer);
  return found.sort((a, b) => b.length - a.length)[0] ?? null;
}

/**
 * Rasterise the first page of one uploaded PDF, cached by file name. Returns
 * the preview path, or throws with a readable reason when it cannot.
 */
export const MAX_PDF_PAGES = 12;

export function pdfManifestPath(dataDir, mediaUrl) {
  return path.join(pdfPreviewDir(dataDir), `${path.basename(String(mediaUrl), '.pdf')}.json`);
}

function pageNumber(file) {
  const match = /-(\d+)\.(png|jpe?g)$/i.exec(file);
  return match ? Number.parseInt(match[1], 10) : 0;
}

function listPageFiles(mediaUrl, dataDir) {
  const base = path.basename(String(mediaUrl), '.pdf');
  const dir = pdfPreviewDir(dataDir);
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.startsWith(`${base}-`) && /\.(png|jpe?g)$/i.test(name))
    .sort((a, b) => pageNumber(a) - pageNumber(b))
    .slice(0, MAX_PDF_PAGES)
    .map((name) => path.join(dir, name))
    .filter((filePath) => existsSync(filePath));
}

/**
 * Rasterise every page of one uploaded PDF, cached as page images. Returns an
 * ordered list of page picture paths.
 */
export async function ensurePdfPages(dataDir, mediaDir, mediaUrl, pdftoppmBin = 'pdftoppm') {
  const cached = listPageFiles(mediaUrl, dataDir);
  if (cached.length > 0) return cached;
  const source = path.join(mediaDir, path.basename(String(mediaUrl)));
  if (!existsSync(source)) throw new Error('The PDF attachment was not found.');
  mkdirSync(pdfPreviewDir(dataDir), { recursive: true });
  const base = path.basename(String(mediaUrl), '.pdf');
  const prefix = path.join(pdfPreviewDir(dataDir), base);
  try {
    await execFileAsync(pdftoppmBin, [
      '-png',
      '-scale-to',
      '1600',
      source,
      prefix,
    ]);
  } catch (error) {
    // No poppler on this machine: every render embedded in the PDF becomes a
    // page picture instead.
    const embedded = extractEmbeddedJpegs(readFileSync(source)).slice(0, MAX_PDF_PAGES);
    if (embedded.length > 0) {
      embedded.forEach((jpeg, index) => {
        writeFileSync(path.join(pdfPreviewDir(dataDir), `${base}-${index + 1}.jpg`), jpeg);
      });
    } else if (error?.code === 'ENOENT') {
      throw new Error(
        'PDF pages cannot be read on this machine yet. Send the pages as pictures as well, or install poppler.',
      );
    } else {
      throw new Error(`The PDF could not be read. ${String(error?.message ?? '').slice(0, 120)}`);
    }
  }
  const pages = listPageFiles(mediaUrl, dataDir);
  if (pages.length === 0) throw new Error('The PDF has no readable pages.');
  writeFileSync(
    pdfManifestPath(dataDir, mediaUrl),
    JSON.stringify({ pages: pages.map((filePath) => path.basename(filePath)) }),
  );
  return pages;
}

/** Ordered picture files for an order: uploads plus PDF first pages. */
export async function orderPhotoPaths(order, { mediaDir, dataDir, pdftoppmBin }) {
  const attachments = Array.isArray(order?.attachments) ? order.attachments : [];
  const files = [];
  for (const file of attachments) {
    const url = String(file?.url ?? '');
    if (/^image\//i.test(String(file?.contentType ?? '')) || /\.(jpe?g|png|webp)$/i.test(url)) {
      const filePath = path.join(mediaDir, path.basename(url));
      if (existsSync(filePath)) files.push(filePath);
      continue;
    }
    if (isPdf(file)) {
      try {
        files.push(...(await ensurePdfPages(dataDir, mediaDir, url, pdftoppmBin)));
      } catch {
        // A PDF without page images simply does not join the picture set; the
        // studio can still attach the pages as pictures.
      }
    }
  }
  return files;
}
