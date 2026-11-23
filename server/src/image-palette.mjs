// Reads colours out of the client's own photographs so the brochure can print
// a true palette callout and mirror the project's tones. Pure JavaScript
// decoders, no native build, no network: PNG and JPEG are supported, anything
// else simply yields no palette.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { decode as decodeJpeg } from 'jpeg-js';

function toRgbPixels(data, width, height, channels) {
  const pixels = [];
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 4000)));
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const index = (y * width + x) * channels;
      pixels.push([data[index], data[index + 1], data[index + 2]]);
    }
  }
  return pixels;
}

function decodeImage(buffer) {
  // PNG
  if (buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50) {
    const png = PNG.sync.read(buffer);
    return toRgbPixels(png.data, png.width, png.height, 4);
  }
  // JPEG
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    const jpeg = decodeJpeg(buffer, { useTArray: true, formatAsRGBA: false });
    return toRgbPixels(jpeg.data, jpeg.width, jpeg.height, 3);
  }
  return null;
}

function toHex([r, g, b]) {
  return `#${[r, g, b].map((value) => Math.round(value).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

function distance(a, b) {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

/**
 * Four dominant colours of one photograph, most frequent first, kept apart so
 * a palette has range instead of four shades of the same wall.
 */
export function photoPalette(filePath, count = 4) {
  let buffer;
  try {
    buffer = readFileSync(filePath);
  } catch {
    return null;
  }
  let pixels;
  try {
    pixels = decodeImage(buffer);
  } catch {
    return null;
  }
  if (!pixels || pixels.length === 0) return null;

  // Coarse histogram in 16-step buckets, then average each winning bucket.
  const buckets = new Map();
  for (const [r, g, b] of pixels) {
    const key = `${r >> 4}-${g >> 4}-${b >> 4}`;
    const entry = buckets.get(key) ?? { r: 0, g: 0, b: 0, n: 0 };
    entry.r += r;
    entry.g += g;
    entry.b += b;
    entry.n += 1;
    buckets.set(key, entry);
  }
  const ranked = [...buckets.values()]
    .sort((a, b) => b.n - a.n)
    .map((entry) => [entry.r / entry.n, entry.g / entry.n, entry.b / entry.n]);

  const chosen = [];
  for (const colour of ranked) {
    if (chosen.every((kept) => distance(kept, colour) > 42)) chosen.push(colour);
    if (chosen.length === count) break;
  }
  // A flat image (a colour chip upload) may not offer range; repeat its tone.
  while (chosen.length < count) chosen.push(ranked[0] ?? [128, 128, 128]);
  return chosen.map(toHex);
}

/** Palettes for every image in an order, keyed photo1, photo2, ... */
export function photoPalettesFor(order, mediaDir) {
  const attachments = Array.isArray(order?.attachments) ? order.attachments : [];
  const images = attachments.filter(
    (file) =>
      /^image\//i.test(String(file.contentType ?? '')) ||
      /\.(jpe?g|png)$/i.test(String(file.url ?? '')),
  );
  const palettes = {};
  images.forEach((file, index) => {
    const palette = photoPalette(path.join(mediaDir, path.basename(file.url)));
    if (palette) palettes[`photo${index + 1}`] = palette;
  });
  return palettes;
}
