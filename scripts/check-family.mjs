// Checks one voucher family file in isolation: fills it with a fixture order,
// renders it with WeasyPrint, and reports page count, leftover placeholders and
// where the page images were written. Used while authoring new designs.
//
//   node scripts/check-family.mjs --file templates/voucher/families/atelier.html \
//     --palette copper --title '{"widthMm":174,"availableHeightMm":46,"maxSizePt":46,"lineHeight":0.98}'
//
// Output images land in /tmp/family-check/<name>/page-N.png
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { resolveWeasyprint } from '../server/src/config.mjs';
import { loadVariants, paletteVariables, SAMPLE_MATERIALS, SAMPLE_ORDER } from '../server/src/variants.mjs';
import { buildTitleMarkup } from '../server/src/title.mjs';
import { buildVoucherValues, fillTemplate } from '../server/src/render.mjs';

const run = promisify(execFile);
const rootDir = path.resolve(new URL('..', import.meta.url).pathname);
const templatesDir = path.join(rootDir, 'templates');

function arg(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

const file = path.resolve(arg('file'));
const paletteId = arg('palette', 'copper');
const familyId = arg('family', path.basename(file, '.html'));
const titleJson = arg('title', '{"widthMm":174,"availableHeightMm":46,"maxSizePt":46,"lineHeight":0.98}');

if (!file.endsWith('.html')) {
  console.error('Pass --file pointing at a family html file.');
  process.exit(1);
}

const variants = loadVariants(templatesDir);
const palette = variants.palettes.find((entry) => entry.id === paletteId);
if (!palette) {
  console.error(`Unknown palette "${paletteId}". Available: ${variants.palettes.map((p) => p.id).join(', ')}`);
  process.exit(1);
}

const logger = {
  warn() {},
  info() {},
  error() {},
  debug() {},
};

const values = buildVoucherValues({
  order: SAMPLE_ORDER,
  materials: SAMPLE_MATERIALS,
  templatesDir,
  logger,
});
let titleConfig;
try {
  titleConfig = JSON.parse(titleJson);
} catch {
  console.error('--title must be JSON.');
  process.exit(1);
}

const filled = fillTemplate(
  readFileSync(file, 'utf8'),
  {
    ...values,
    paletteCss: { raw: paletteVariables(palette) },
    title: { raw: buildTitleMarkup(values.title, titleConfig) }
  },
  'voucher'
);

const outDir = path.join('/tmp/family-check', familyId);
mkdirSync(outDir, { recursive: true });
// Build inside templates/voucher, like production, so ../assets and ../fonts resolve.
const builtFile = path.join(templatesDir, 'voucher', `.check-${familyId}.html`);
const pdfFile = path.join(outDir, 'family.pdf');
for (const name of ['page-1.png', 'page-2.png', 'page-3.png', 'page-4.png']) {
  rmSync(path.join(outDir, name), { force: true });
}

try {
  writeFileSync(builtFile, filled, 'utf8');
  const weasyprint = resolveWeasyprint(rootDir, process.env);
  await run(weasyprint, [builtFile, pdfFile], { timeout: 120_000, maxBuffer: 20 * 1024 * 1024 });
  const { stdout: info } = await run('pdfinfo', [pdfFile]);
  const pages = Number(/Pages:\s+(\d+)/.exec(info)?.[1] ?? 0);
  const { stdout: text } = await run('pdftotext', [pdfFile, '-']);
  const leftover = [...new Set([...text.matchAll(/\{\{[^}]+\}\}/g)].map((m) => m[0]))];
  await run('pdftoppm', ['-png', '-r', '90', pdfFile, path.join(outDir, 'page')]);
  if (pages !== 4) {
    console.error(`FAIL ${familyId}: ${pages} pages, expected 4`);
    process.exit(1);
  }
  if (leftover.length > 0) {
    console.error(`FAIL ${familyId}: leftover placeholders ${leftover.join(', ')}`);
    process.exit(1);
  }
  console.log(`PASS ${familyId}: 4 pages, no leftover placeholders`);
  console.log(`pages: ${outDir}/page-1.png ... page-4.png`);
} catch (error) {
  console.error(`FAIL ${familyId}: ${String(error.stderr ?? error.message).slice(0, 600)}`);
  process.exit(1);
} finally {
  rmSync(builtFile, { force: true });
}
