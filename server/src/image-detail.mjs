// Real magnifier plates for the brochure. Each plate is an actual crop of the
// client's photograph, enlarged and encoded as a PNG data URI, so the printed
// loupe is a true detail of the picture rather than a shaped copy of it.
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { PNG } from 'pngjs';
import { decode as decodeJpeg } from 'jpeg-js';
import { colourName } from './image-palette.mjs';

/** Full resolution pixels, which a magnified plate needs. */
function decodeFull(filePath) {
  let buffer;
  try {
    buffer = readFileSync(filePath);
  } catch {
    return null;
  }
  try {
    if (buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50) {
      const png = PNG.sync.read(buffer);
      return { width: png.width, height: png.height, data: png.data, channels: 4 };
    }
    if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8) {
      const jpeg = decodeJpeg(buffer, { useTArray: true, formatAsRGBA: true });
      return { width: jpeg.width, height: jpeg.height, data: jpeg.data, channels: 4 };
    }
  } catch {
    return null;
  }
  return null;
}

function pixelAt(image, x, y) {
  const index = (y * image.width + x) * image.channels;
  return [image.data[index], image.data[index + 1], image.data[index + 2]];
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

/** Encode RGB rows as a PNG data URI. */
export function pngDataUri(width, height, rows) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const raw = Buffer.concat(rows);
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

function toHex([r, g, b]) {
  return `#${[r, g, b].map((value) => Math.round(value).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

/**
 * A square crop centred on a detail, averaged down to `size` pixels and
 * returned as a ready to place PNG. The same crop is also averaged to one
 * colour, which is what the caption names.
 */
export function detailPlate(filePath, candidate, size = 560) {
  const image = decodeFull(filePath);
  if (!image || !image.width || !image.height) return null;
  const { width, height } = image;

  const side = Math.max(8, Math.min(width, height, Math.round(Math.min(width, height) * 0.24)));
  const centreX = Math.round((candidate.x / 100) * width);
  const centreY = Math.round((candidate.y / 100) * height);
  const left = Math.max(0, Math.min(centreX - side / 2, width - side));
  const top = Math.max(0, Math.min(centreY - side / 2, height - side));

  const rows = [];
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let samples = 0;
  const step = side / size;
  for (let outY = 0; outY < size; outY += 1) {
    const row = Buffer.alloc(1 + size * 3);
    const sourceY = Math.min(height - 1, Math.round(top + outY * step));
    for (let outX = 0; outX < size; outX += 1) {
      const sourceX = Math.max(0, Math.min(width - 1, Math.round(left + outX * step)));
      const [r, g, b] = pixelAt(image, sourceX, sourceY);
      row[1 + outX * 3] = r;
      row[1 + outX * 3 + 1] = g;
      row[1 + outX * 3 + 2] = b;
      sumR += r;
      sumG += g;
      sumB += b;
      samples += 1;
    }
    rows.push(row);
  }
  const hex = toHex([sumR / samples, sumG / samples, sumB / samples]);
  return { dataUri: pngDataUri(size, size, rows), hex, name: colourName(hex) };
}

/**
 * A small copy of the picture for a vision model: big enough to read the room,
 * small enough to keep the request cheap.
 */
export function thumbnailDataUri(filePath, max = 640) {
  const image = decodeFull(filePath);
  if (!image || !image.width || !image.height) return null;
  const scale = Math.min(1, max / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    const sourceY = Math.min(image.height - 1, Math.round(y / scale));
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(image.width - 1, Math.round(x / scale));
      const [r, g, b] = pixelAt(image, sourceX, sourceY);
      row[1 + x * 3] = r;
      row[1 + x * 3 + 1] = g;
      row[1 + x * 3 + 2] = b;
    }
    rows.push(row);
  }
  return pngDataUri(width, height, rows);
}

/** Detail plates for the chosen candidates of one photograph. */
export function detailPlatesFor(filePath, candidates) {
  return (candidates ?? []).map((candidate, index) => {
    const plate = detailPlate(filePath, candidate);
    if (!plate) return null;
    return {
      index: index + 1,
      x: candidate.x,
      y: candidate.y,
      colour: plate.hex,
      name: plate.name,
      dataUri: plate.dataUri,
    };
  }).filter(Boolean);
}
