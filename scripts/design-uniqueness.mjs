// Renders every voucher design with the same order and measures how different
// the pages actually are, so "unique" is a number instead of an opinion.
//
//   node scripts/design-uniqueness.mjs [--api http://localhost:8787] [--out /tmp/design-uniqueness.json]
//
// For each design it renders a voucher, converts every page to a small grey
// image with pdftoppm, and computes a dHash. Pairwise Hamming distances tell us
// whether two designs are near duplicates. A cover distance under 8 of 64 bits
// is treated as suspicious and printed for review.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const api = process.argv.includes('--api')
  ? process.argv[process.argv.indexOf('--api') + 1]
  : 'http://localhost:8787';
const outFile = process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1]
  : path.join(os.tmpdir(), 'design-uniqueness.json');

const SUSPICIOUS_BITS = 8;
const PAGE_COUNT = 4;

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${url} ${response.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

function parsePgm(buffer) {
  // P5 header: magic, width height, maxval, then binary grey bytes.
  let index = 0;
  const tokens = [];
  while (tokens.length < 4 && index < buffer.length) {
    while (buffer[index] === 0x20 || buffer[index] === 0x0a || buffer[index] === 0x0d || buffer[index] === 0x09) index += 1;
    if (buffer[index] === 0x23) {
      while (buffer[index] !== 0x0a) index += 1;
      continue;
    }
    const start = index;
    while (index < buffer.length && ![0x20, 0x0a, 0x0d, 0x09].includes(buffer[index])) index += 1;
    tokens.push(buffer.toString('ascii', start, index));
  }
  index += 1; // single whitespace after maxval
  const width = Number(tokens[1]);
  const height = Number(tokens[2]);
  const pixels = buffer.subarray(index, index + width * height);
  return { width, height, pixels };
}

function dHash(pixels) {
  const { width, height, pixels: grey } = pixels;
  const bits = [];
  for (let row = 0; row < 8; row += 1) {
    const y0 = Math.floor((row * height) / 9);
    const y1 = Math.floor(((row + 1) * height) / 9);
    for (let col = 0; col < 8; col += 1) {
      const x0 = Math.floor((col * width) / 9);
      const x1 = Math.floor(((col + 1) * width) / 9);
      const x2 = Math.floor(((col + 2) * width) / 9);
      let left = 0;
      let right = 0;
      let count = 0;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < Math.max(x0 + 1, x1); x += 1) {
          left += grey[y * width + x] ?? 0;
          count += 1;
        }
        for (let x = x1; x < Math.max(x1 + 1, x2); x += 1) {
          right += grey[y * width + x] ?? 0;
        }
        if (y >= y1 - 1) break;
      }
      bits.push(left / Math.max(1, count) > right / Math.max(1, count) ? 1 : 0);
    }
  }
  return bits;
}

function hamming(a, b) {
  let distance = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) distance += a[i] === b[i] ? 0 : 1;
  return distance;
}

const templates = await (await fetch(`${api}/api/templates`)).json();
if (!Array.isArray(templates) || templates.length !== 30) {
  throw new Error(`Expected 30 designs, got ${templates?.length}`);
}

const customer = await postJson(`${api}/api/customers`, { name: 'Design Review' });
const order = await postJson(`${api}/api/orders`, {
  customerId: customer.id,
  title: 'Master Bedroom Wardrobe',
  room: 'Master bedroom',
  width: '2400 mm',
  height: '2100 mm',
  depth: '600 mm',
  shutters: '3'
});

const tmp = mkdtempSync(path.join(os.tmpdir(), 'design-check-'));
const results = [];
try {
  for (const template of templates) {
    const render = await postJson(`${api}/api/orders/${order.id}/render`, {
      kind: 'voucher',
      templateId: template.id
    });
    const pdf = await fetch(`${api}${render.pdfUrl}`);
    const pdfFile = path.join(tmp, `${template.id}.pdf`);
    writeFileSync(pdfFile, Buffer.from(await pdf.arrayBuffer()));
    const pages = [];
    for (let page = 1; page <= PAGE_COUNT; page += 1) {
      const prefix = path.join(tmp, `${template.id}-p${page}`);
      execFileSync('pdftoppm', ['-gray', '-r', '40', '-f', String(page), '-l', String(page), pdfFile, prefix]);
      pages.push(dHash(parsePgm(readFileSync(`${prefix}-${page}.pgm`))));
    }
    results.push({ id: template.id, family: template.family, palette: template.palette, pages });
    process.stdout.write('.');
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log('');

const pairs = [];
for (let i = 0; i < results.length; i += 1) {
  for (let j = i + 1; j < results.length; j += 1) {
    const cover = hamming(results[i].pages[0], results[j].pages[0]);
    const pageDistances = results[i].pages.map((_, page) => hamming(results[i].pages[page], results[j].pages[page]));
    pairs.push({
      a: results[i].id,
      b: results[j].id,
      cover,
      pageDistances,
      document: pageDistances.reduce((sum, value) => sum + value, 0)
    });
  }
}

pairs.sort((a, b) => a.cover - b.cover);
const suspicious = pairs.filter((pair) => pair.cover <= SUSPICIOUS_BITS);
const summary = {
  designs: results.length,
  comparisons: pairs.length,
  minCoverDistance: pairs[0]?.cover ?? 0,
  averageCoverDistance: Math.round((pairs.reduce((sum, pair) => sum + pair.cover, 0) / pairs.length) * 10) / 10,
  minDocumentDistance: Math.min(...pairs.map((pair) => pair.document)),
  suspiciousPairs: suspicious.slice(0, 20)
};

console.log(JSON.stringify(summary, null, 2));
writeFileSync(outFile, JSON.stringify({ summary, pairs }, null, 2));
console.log(`saved ${outFile}`);
