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

export function decodeImage(buffer) {
  // PNG
  if (buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50) {
    const png = PNG.sync.read(buffer);
    return {
      width: png.width,
      height: png.height,
      pixels: toRgbPixels(png.data, png.width, png.height, 4),
    };
  }
  // JPEG
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    const jpeg = decodeJpeg(buffer, { useTArray: true, formatAsRGBA: false });
    return {
      width: jpeg.width,
      height: jpeg.height,
      pixels: toRgbPixels(jpeg.data, jpeg.width, jpeg.height, 3),
    };
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
  let decoded;
  try {
    decoded = decodeImage(buffer);
  } catch {
    return null;
  }
  if (!decoded || !decoded.pixels || decoded.pixels.length === 0) return null;
  const pixels = decoded.pixels;

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

/** Raw pixels of one image file, or null when the format is not readable. */
export function decodeImageFile(filePath) {
  let buffer;
  try {
    buffer = readFileSync(filePath);
  } catch {
    return null;
  }
  try {
    return decodeImage(buffer);
  } catch {
    return null;
  }
}

/** Palettes for every image in an order, keyed photo1, photo2, ... */
/**
 * The actual colour under one point of a photograph, averaged over a small
 * window. Used by the marking tools so a tap fills the colour name and code
 * instead of asking the studio to type them.
 */
export function sampleColourAt(filePath, xPercent, yPercent) {
  let buffer;
  try {
    buffer = readFileSync(filePath);
  } catch {
    return null;
  }
  let decoded;
  try {
    if (buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50) {
      const png = PNG.sync.read(buffer);
      decoded = { width: png.width, height: png.height, data: png.data, channels: 4 };
    } else if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8) {
      const jpeg = decodeJpeg(buffer, { useTArray: true, formatAsRGBA: false });
      decoded = { width: jpeg.width, height: jpeg.height, data: jpeg.data, channels: 3 };
    } else {
      return null;
    }
  } catch {
    return null;
  }
  const x = Math.min(decoded.width - 1, Math.max(0, Math.round((Number(xPercent) / 100) * (decoded.width - 1))));
  const y = Math.min(decoded.height - 1, Math.max(0, Math.round((Number(yPercent) / 100) * (decoded.height - 1))));
  const radius = Math.max(2, Math.round(Math.min(decoded.width, decoded.height) * 0.025));
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let py = Math.max(0, y - radius); py <= Math.min(decoded.height - 1, y + radius); py += 1) {
    for (let px = Math.max(0, x - radius); px <= Math.min(decoded.width - 1, x + radius); px += 1) {
      const index = (py * decoded.width + px) * decoded.channels;
      r += decoded.data[index];
      g += decoded.data[index + 1];
      b += decoded.data[index + 2];
      count += 1;
    }
  }
  if (count === 0) return null;
  return toHex([r / count, g / count, b / count]);
}

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

// Showroom brochures name their colours, the way a car brochure prints
// "Pearl White" under the swatch. The nearest curated name is used, so the
// brochure reads like a paint card rather than a hexadecimal dump.
const COLOUR_NAMES = [
  ['#F8F2E7', 'Warm Ivory'],
  ['#F1E7D6', 'Vanilla Cream'],
  ['#E8DCC8', 'Sand Beige'],
  ['#D9C7A7', 'Almond'],
  ['#C9B996', 'Oat'],
  ['#B9A98F', 'Stone'],
  ['#AC9B84', 'Greige'],
  ['#9A9A94', 'Ash Grey'],
  ['#8A7F72', 'Taupe'],
  ['#8B6F47', 'Chestnut'],
  ['#A9784B', 'Honey Oak'],
  ['#794617', 'Walnut'],
  ['#5C3A21', 'Espresso'],
  ['#3F2A1D', 'Dark Walnut'],
  ['#B98A55', 'Brass'],
  ['#C79A3A', 'Antique Gold'],
  ['#7C2A22', 'Merlot'],
  ['#4A1116', 'Oxblood'],
  ['#1AA3C8', 'Teal'],
  ['#173B44', 'Deep Teal'],
  ['#2E4740', 'Forest Slate'],
  ['#1E2528', 'Charcoal'],
  ['#6E7370', 'Graphite'],
  ['#FFFFFF', 'Chalk'],
];

function hexToRgb(hex) {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(String(hex ?? '').trim());
  if (!match) return null;
  const value = Number.parseInt(match[1], 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/** The nearest showroom name for one hex colour. */
export function colourName(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return 'Custom';
  let best = COLOUR_NAMES[0];
  let bestDistance = Infinity;
  for (const entry of COLOUR_NAMES) {
    const candidate = hexToRgb(entry[0]);
    const distance =
      (candidate[0] - rgb[0]) ** 2 + (candidate[1] - rgb[1]) ** 2 + (candidate[2] - rgb[2]) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = entry;
    }
  }
  // A colour far from the card keeps its own voice instead of borrowing the
  // nearest name flatly.
  const named = best[1];
  if (bestDistance > 90 * 90) {
    const [r, g, b] = rgb;
    const warm = r > g && g >= b;
    return warm ? `Custom ${named}` : `Custom ${named}`;
  }
  return named;
}
