// Customer PDFs are often how a studio sends its drawings and render sheets.
// The brochure needs pixels, so the first page of a PDF is rasterised once and
// cached beside the uploads. Poppler does the conversion when it is installed.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
export function extractLargestJpeg(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
  let best = null;
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
    // JPEG streams begin with SOI and end with EOI.
    const soi = chunk.indexOf(Buffer.from([0xff, 0xd8, 0xff]));
    if (soi !== -1) {
      const eoi = chunk.lastIndexOf(Buffer.from([0xff, 0xd9]));
      if (eoi > soi && (!best || eoi - soi > best.length)) {
        best = chunk.subarray(soi, eoi + 2);
      }
    }
    cursor = end + 'endstream'.length;
  }
  return best;
}

/**
 * Rasterise the first page of one uploaded PDF, cached by file name. Returns
 * the preview path, or throws with a readable reason when it cannot.
 */
export async function ensurePdfPreview(dataDir, mediaDir, mediaUrl, pdftoppmBin = 'pdftoppm') {
  const previewPath = pdfPreviewPath(dataDir, mediaUrl);
  if (existsSync(previewPath) && readFileSync(previewPath).length > 0) return previewPath;
  const source = path.join(mediaDir, path.basename(String(mediaUrl)));
  if (!existsSync(source)) throw new Error('The PDF attachment was not found.');
  mkdirSync(pdfPreviewDir(dataDir), { recursive: true });
  const prefix = previewPath.replace(/\.png$/i, '');
  try {
    await execFileAsync(pdftoppmBin, [
      '-png',
      '-f',
      '1',
      '-l',
      '1',
      '-scale-to',
      '1600',
      '-singlefile',
      source,
      prefix,
    ]);
  } catch (error) {
    // No poppler on this machine: fall back to the render embedded in the PDF.
    const embedded = extractLargestJpeg(readFileSync(source));
    if (embedded && embedded.length > 10_000) {
      const jpegPath = previewPath.replace(/\.png$/i, '.jpg');
      writeFileSync(jpegPath, embedded);
      return jpegPath;
    }
    if (error?.code === 'ENOENT') {
      throw new Error(
        'PDF pages cannot be read on this machine yet. Send the pages as pictures as well, or install poppler.',
      );
    }
    throw new Error(`The PDF page could not be read. ${String(error?.message ?? '').slice(0, 120)}`);
  }
  if (!existsSync(previewPath)) throw new Error('The PDF page could not be converted.');
  return previewPath;
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
        files.push(await ensurePdfPreview(dataDir, mediaDir, url, pdftoppmBin));
      } catch {
        // A PDF without a page image simply does not join the picture set; the
        // studio can still attach the page as a picture.
      }
    }
  }
  return files;
}
