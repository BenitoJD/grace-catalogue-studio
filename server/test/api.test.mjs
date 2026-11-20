import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { serve } from '@hono/node-server';

import { createMaterial, openDb } from '../src/db.mjs';
import { createApp } from '../src/routes.mjs';

const rootDir = fileURLToPath(new URL('../..', import.meta.url));
const templatesDir = path.join(rootDir, 'templates');
const weasyprintBin = path.join(rootDir, 'specimen', '.venv', 'bin', 'weasyprint');
const pdftoppmBin = 'pdftoppm';

let tempDir;
let dataDir;
let db;
let server;
let baseUrl;
let customerId;
let orderId;

function startApp(app) {
  return new Promise((resolve, reject) => {
    const started = serve({ fetch: app.fetch, port: 0 }, (info) => {
      resolve({ server: started, port: info.port });
    });
    started.once('error', reject);
  });
}

async function stopServer(started) {
  if (!started) return;
  await new Promise((resolve) => {
    started.server.close(resolve);
    started.server.closeAllConnections?.();
  });
}

async function postJson(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const DEMO_MATERIALS = [
  { name: 'Dark Walnut', kind: 'laminate', hex: '#3F2A1D', imageUrl: '/media/tex-walnut.jpg' },
  { name: 'Cream', kind: 'laminate', hex: '#E8DCC8', imageUrl: '/media/tex-cream.jpg' },
  { name: 'Ash Grey', kind: 'laminate', hex: '#9A9A94', imageUrl: '/media/tex-grey.jpg' },
  { name: 'Edge band', kind: 'edge band', hex: '#8B5A2B', imageUrl: '/media/tex-band.jpg' },
];

const DEMO_ORDER = {
  title: 'Master Bedroom Wardrobe',
  room: 'Master bedroom',
  width: '2400 mm',
  height: '2100 mm',
  depth: '600 mm',
  shutters: '3 · 800 mm',
  carcass: '18 mm BWP plywood',
  backPanel: '6 mm plywood',
  shuttersMat: '18 mm BWP plywood',
  drawers: '12 mm plywood',
  exterior: '1 mm laminate',
  interior: '0.8 mm white laminate',
  hinges: 'Soft-close',
  channels: 'Soft-close telescopic',
  edgeShutter: '2 mm PVC',
  edgeCarcass: '0.8 mm PVC',
  edgeNote: 'Colour matched',
  handle: 'Matte black aluminium',
  handleNote: 'Vertical · three sets',
  finishExt: 'Matte outside, white inside',
  finishInt: 'No painting',
};

before(async () => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'grace-api-test-'));
  dataDir = path.join(tempDir, 'data');
  mkdirSync(path.join(dataDir, 'renders'), { recursive: true });

  db = openDb(path.join(dataDir, 'catalog.db'));
  for (const material of DEMO_MATERIALS) createMaterial(db, material);

  const app = createApp({ db, dataDir, templatesDir, weasyprintBin, pdftoppmBin });
  const started = await startApp(app);
  server = started.server;
  baseUrl = `http://127.0.0.1:${started.port}`;
});

after(async () => {
  await stopServer(server ? { server } : null);
  if (db) {
    try {
      db.close();
    } catch {
      // Already closed.
    }
  }
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

test('health returns ok and version', async () => {
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, version: '1.0.0' });
});

test('bootstrap returns customers, orders and materials', async () => {
  const response = await fetch(`${baseUrl}/api/bootstrap`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(Array.isArray(body.customers));
  assert.ok(Array.isArray(body.orders));
  assert.ok(Array.isArray(body.materials));
  assert.equal(body.customers.length, 0);
  assert.equal(body.orders.length, 0);
  assert.equal(body.materials.length, DEMO_MATERIALS.length);
});

test('cors allows the web app origin and content type', async () => {
  const response = await fetch(`${baseUrl}/api/bootstrap`, {
    headers: { Origin: 'http://localhost:8081' },
  });
  assert.equal(response.headers.get('access-control-allow-origin'), '*');

  const preflight = await fetch(`${baseUrl}/api/customers`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'http://localhost:8081',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
  assert.match(preflight.headers.get('access-control-allow-methods') ?? '', /POST/);
  assert.match((preflight.headers.get('access-control-allow-headers') ?? '').toLowerCase(), /content-type/);
});

test('rejects a customer without a name', async () => {
  const response = await postJson(`${baseUrl}/api/customers`, { phone: '+91 90000 00000' });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.match(body.error, /name/i);
});

test('creates a customer', async () => {
  const response = await postJson(`${baseUrl}/api/customers`, {
    name: 'Test Customer',
    phone: '+91 90000 00000',
    address: 'Nagercoil',
  });
  assert.equal(response.status, 201);
  const customer = await response.json();
  assert.equal(customer.name, 'Test Customer');
  assert.equal(customer.phone, '+91 90000 00000');
  assert.equal(customer.address, 'Nagercoil');
  assert.equal(typeof customer.id, 'string');
  assert.ok(customer.createdAt);
  customerId = customer.id;
});

test('rejects an order without a customerId', async () => {
  const response = await postJson(`${baseUrl}/api/orders`, DEMO_ORDER);
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.match(body.error, /customerId/);
});

test('creates an order with a generated order number', async () => {
  const response = await postJson(`${baseUrl}/api/orders`, {
    ...DEMO_ORDER,
    customerId,
  });
  assert.equal(response.status, 201);
  const order = await response.json();
  assert.match(order.orderNo, /^GWI-\d{4}-001$/);
  assert.equal(order.customerId, customerId);
  assert.equal(order.customerName, 'Test Customer');
  assert.equal(order.title, DEMO_ORDER.title);
  assert.equal(order.status, 'draft');
  assert.ok(order.id);
  assert.ok(order.createdAt);
  orderId = order.id;
});

test('gets an order by id', async () => {
  const response = await fetch(`${baseUrl}/api/orders/${orderId}`);
  assert.equal(response.status, 200);
  const order = await response.json();
  assert.equal(order.id, orderId);
  assert.equal(order.width, '2400 mm');
  assert.equal(order.customerName, 'Test Customer');

  const missing = await fetch(`${baseUrl}/api/orders/does-not-exist`);
  assert.equal(missing.status, 404);
  assert.ok((await missing.json()).error);
});

test('updates an order', async () => {
  const response = await fetch(`${baseUrl}/api/orders/${orderId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'approved', handleNote: 'Two vertical sets' }),
  });
  assert.equal(response.status, 200);
  const order = await response.json();
  assert.equal(order.status, 'approved');
  assert.equal(order.handleNote, 'Two vertical sets');
});

test('creates a material', async () => {
  const response = await postJson(`${baseUrl}/api/materials`, {
    name: 'Brushed Brass',
    kind: 'handle finish',
    hex: '#B08D57',
    imageUrl: '/media/tex-band.jpg',
  });
  assert.equal(response.status, 201);
  const material = await response.json();
  assert.equal(material.name, 'Brushed Brass');
  assert.equal(material.kind, 'handle finish');
  assert.equal(material.hex, '#B08D57');
  assert.equal(material.imageUrl, '/media/tex-band.jpg');
  assert.ok(material.id);
  assert.ok(material.createdAt);
});

test('renders a voucher with 4 pages and a real PDF', async () => {
  const response = await postJson(`${baseUrl}/api/orders/${orderId}/render`, { kind: 'voucher' });
  assert.equal(response.status, 201);
  const render = await response.json();

  assert.equal(render.kind, 'voucher');
  assert.equal(render.pageCount, 4);
  assert.equal(render.orderId, orderId);
  assert.equal(render.pdfUrl, `/files/${render.id}.pdf`);
  assert.deepEqual(render.pageUrls, [1, 2, 3, 4].map((page) => `/pages/${render.id}/${page}.png`));

  const pdfPath = path.join(dataDir, 'renders', `${render.id}.pdf`);
  assert.ok(existsSync(pdfPath), 'PDF should exist on disk');
  assert.ok(statSync(pdfPath).size > 10 * 1024, 'PDF should be larger than 10 KB');

  // The built HTML must not be left behind in the template directory.
  assert.equal(
    existsSync(path.join(templatesDir, 'voucher', `built-${render.id}.html`)),
    false,
    'built HTML should be cleaned up',
  );

  const pdfResponse = await fetch(`${baseUrl}${render.pdfUrl}`);
  assert.equal(pdfResponse.status, 200);
  assert.match(pdfResponse.headers.get('content-type') ?? '', /application\/pdf/);
  const pdfBytes = Buffer.from(await pdfResponse.arrayBuffer());
  assert.ok(pdfBytes.length > 10 * 1024, 'served PDF should be larger than 10 KB');
  assert.equal(pdfBytes.subarray(0, 4).toString('utf8'), '%PDF');

  const pageResponse = await fetch(`${baseUrl}${render.pageUrls[0]}`);
  assert.equal(pageResponse.status, 200);
  assert.match(pageResponse.headers.get('content-type') ?? '', /image\/png/);
  assert.ok((await pageResponse.arrayBuffer()).byteLength > 0);
});

test('rejects a render with an unknown kind', async () => {
  const response = await postJson(`${baseUrl}/api/orders/${orderId}/render`, { kind: 'poster' });
  assert.equal(response.status, 400);
  assert.ok((await response.json()).error);
});

test('lists and gets renders', async () => {
  const listResponse = await fetch(`${baseUrl}/api/renders`);
  assert.equal(listResponse.status, 200);
  const renders = await listResponse.json();
  assert.equal(renders.length, 1);
  const render = renders[0];
  assert.equal(render.pageCount, 4);
  assert.equal(render.pageUrls.length, 4);

  const getResponse = await fetch(`${baseUrl}/api/renders/${render.id}`);
  assert.equal(getResponse.status, 200);
  const fetched = await getResponse.json();
  assert.equal(fetched.id, render.id);
  assert.equal(fetched.pdfUrl, render.pdfUrl);
});

test('fails a render when a placeholder is unfilled', async () => {
  const brokenRoot = path.join(tempDir, 'broken-templates');
  const brokenVoucherDir = path.join(brokenRoot, 'voucher');
  mkdirSync(brokenVoucherDir, { recursive: true });

  const template = readFileSync(path.join(templatesDir, 'voucher', 'index.html'), 'utf8');
  writeFileSync(
    path.join(brokenVoucherDir, 'index.html'),
    `${template}\n<div>{{neverProvided}}</div>\n`,
    'utf8',
  );

  const brokenApp = createApp({
    db,
    dataDir,
    templatesDir: brokenRoot,
    weasyprintBin,
    pdftoppmBin,
  });
  const started = await startApp(brokenApp);

  try {
    const before = (await (await fetch(`${baseUrl}/api/renders`)).json()).length;
    const response = await postJson(
      `http://127.0.0.1:${started.port}/api/orders/${orderId}/render`,
      { kind: 'voucher' },
    );
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.match(body.error, /Unfilled placeholder/);
    assert.match(body.error, /neverProvided/);

    const after = (await (await fetch(`${baseUrl}/api/renders`)).json()).length;
    assert.equal(after, before, 'a failed render must not be recorded');
    assert.equal(
      readdirSync(brokenVoucherDir).filter((name) => name.startsWith('built-')).length,
      0,
      'a failed render must clean up the built HTML',
    );
  } finally {
    await stopServer({ server: started.server });
  }
});

test('deletes an order and its renders', async () => {
  const created = await postJson(`${baseUrl}/api/orders`, {
    ...DEMO_ORDER,
    title: 'Store Room Shelves',
    customerId,
  });
  assert.equal(created.status, 201);
  const order = await created.json();

  const deleted = await fetch(`${baseUrl}/api/orders/${order.id}`, { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), { ok: true });

  const missing = await fetch(`${baseUrl}/api/orders/${order.id}`);
  assert.equal(missing.status, 404);

  const missingAgain = await fetch(`${baseUrl}/api/orders/${order.id}`, { method: 'DELETE' });
  assert.equal(missingAgain.status, 404);
});

// ---------------------------------------------------------------------------
// Selectable brochure templates
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PALETTE_IDS = ['copper', 'ink', 'olive', 'indigo', 'sand'];
const COVER_IDS = ['fullBleed', 'splitRight', 'splitLeft', 'bandTop', 'typeOnly', 'centred'];

async function fetchTemplates() {
  const response = await fetch(`${baseUrl}/api/templates`);
  assert.equal(response.status, 200);
  return response.json();
}

function normaliseText(value) {
  return value.replace(/\s+/g, ' ').trim();
}

function pdfText(filePath) {
  return execFileSync('pdftotext', [filePath, '-'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
}

function hashBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function renderVoucher(templateId) {
  const body = { kind: 'voucher' };
  if (templateId !== undefined) body.templateId = templateId;
  const response = await postJson(`${baseUrl}/api/orders/${orderId}/render`, body);
  const text = await response.text();
  return { status: response.status, body: text === '' ? null : JSON.parse(text) };
}

test('lists 30 templates, every palette crossed with every cover', { timeout: 120_000 }, async () => {
  const templates = await fetchTemplates();
  assert.equal(templates.length, 30);
  assert.equal(new Set(templates.map((template) => template.id)).size, 30);

  for (const template of templates) {
    assert.equal(typeof template.id, 'string');
    assert.ok(template.name && template.name.trim().length > 0, 'every template needs a human name');
    assert.ok(PALETTE_IDS.includes(template.palette), `unknown palette ${template.palette}`);
    assert.ok(COVER_IDS.includes(template.cover), `unknown cover ${template.cover}`);
    assert.equal(template.pageCount, 4);
    assert.equal(template.previewUrl, `/previews/${template.id}.png`);
  }

  const combinations = new Set(templates.map((template) => `${template.palette}/${template.cover}`));
  assert.equal(combinations.size, 30, 'all five palettes by six covers are present exactly once');

  assert.equal(templates[0].id, 'copper-full-bleed', 'the first template is the default');
  assert.ok(templates.some((template) => template.name === 'Ink Split Right'));
  assert.ok(templates.some((template) => template.name === 'Sand Type Only'));
  assert.ok(templates.some((template) => template.name === 'Olive Centred'));
});

test('serves valid cached preview PNGs for at least five templates', { timeout: 240_000 }, async () => {
  const templates = await fetchTemplates();

  for (const template of templates.slice(0, 5)) {
    const response = await fetch(`${baseUrl}${template.previewUrl}`);
    assert.equal(response.status, 200, `${template.id} preview should be generated on demand`);
    assert.match(response.headers.get('content-type') ?? '', /image\/png/);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.ok(bytes.length > 10_000, `${template.id} preview should not be empty`);
    assert.ok(bytes.subarray(0, 8).equals(PNG_SIGNATURE), `${template.id} preview should be a PNG`);

    const cached = path.join(dataDir, 'previews', `${template.id}.png`);
    assert.ok(existsSync(cached), `${template.id} preview should be cached at data/previews`);
    assert.ok(statSync(cached).size > 10_000);
  }

  const unknown = await fetch(`${baseUrl}/previews/not-a-template.png`);
  assert.equal(unknown.status, 404);
});

test('every template renders a real four page voucher without unfilled placeholders', { timeout: 900_000 }, async () => {
  const templates = await fetchTemplates();
  const firstPageHashes = new Set();

  for (const template of templates) {
    const { status, body: render } = await renderVoucher(template.id);
    assert.equal(status, 201, `${template.id} failed to render: ${JSON.stringify(render)}`);
    assert.equal(render.kind, 'voucher');
    assert.equal(render.templateId, template.id);
    assert.equal(render.pageCount, 4, `${template.id} must be a four page voucher`);
    assert.equal(render.pageUrls.length, 4);

    const pdfPath = path.join(dataDir, 'renders', `${render.id}.pdf`);
    assert.ok(existsSync(pdfPath), `${template.id} should write a PDF`);
    assert.ok(statSync(pdfPath).size > 10 * 1024, `${template.id} PDF should not be empty`);
    assert.ok(!pdfText(pdfPath).includes('{{'), `${template.id} left an unfilled placeholder in the PDF`);

    const pageOne = await fetch(`${baseUrl}${render.pageUrls[0]}`);
    assert.equal(pageOne.status, 200);
    const pageOneBytes = Buffer.from(await pageOne.arrayBuffer());
    assert.ok(pageOneBytes.subarray(0, 8).equals(PNG_SIGNATURE));
    firstPageHashes.add(hashBytes(pageOneBytes));
  }

  assert.equal(firstPageHashes.size, 30, 'every template should have a distinguishable cover');
});

test('rejects an unknown templateId with 400 without recording a render', { timeout: 120_000 }, async () => {
  const before = (await (await fetch(`${baseUrl}/api/renders`)).json()).length;
  const response = await postJson(`${baseUrl}/api/orders/${orderId}/render`, {
    kind: 'voucher',
    templateId: 'definitely-not-a-template',
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.match(body.error, /template/i);
  assert.match(body.error, /definitely-not-a-template/);
  const again = (await (await fetch(`${baseUrl}/api/renders`)).json()).length;
  assert.equal(again, before, 'a rejected template id must not create a render');
});

test('three templateIds produce visibly different PDFs', { timeout: 240_000 }, async () => {
  const ids = ['copper-full-bleed', 'ink-split-right', 'sand-type-only'];
  const runs = [];

  for (const id of ids) {
    const { status, body: render } = await renderVoucher(id);
    assert.equal(status, 201, `${id} failed to render`);
    const pdfPath = path.join(dataDir, 'renders', `${render.id}.pdf`);
    const pageOne = await fetch(`${baseUrl}${render.pageUrls[0]}`);
    const bytes = Buffer.from(await pageOne.arrayBuffer());
    runs.push({ id, size: statSync(pdfPath).size, hash: hashBytes(bytes) });
  }

  assert.equal(new Set(runs.map((run) => run.size)).size, 3, 'PDF file sizes should differ');
  assert.equal(new Set(runs.map((run) => run.hash)).size, 3, 'page one images should differ');
});

test('cover title is the order title and the whole title is in the PDF text layer', { timeout: 240_000 }, async () => {
  const longTitle = 'Master Bedroom Wardrobe with Sliding Shutters and Loft Storage';
  const created = await postJson(`${baseUrl}/api/orders`, {
    ...DEMO_ORDER,
    title: longTitle,
    room: 'Guest bedroom',
    customerId,
  });
  assert.equal(created.status, 201);
  const order = await created.json();

  const response = await postJson(`${baseUrl}/api/orders/${order.id}/render`, { kind: 'voucher' });
  const raw = await response.text();
  assert.equal(response.status, 201, raw);
  const render = JSON.parse(raw);
  assert.equal(render.pageCount, 4);
  assert.equal(render.templateId, 'copper-full-bleed', 'the default template is the first one');

  const text = pdfText(path.join(dataDir, 'renders', `${render.id}.pdf`));
  const pages = text.split('\f');
  const cover = normaliseText(pages[0]);
  assert.ok(
    cover.includes(longTitle),
    `the full title must appear on the cover, got: ${cover}`,
  );
  assert.ok(!cover.includes('{{'), 'no unfilled placeholder may reach the cover');
  assert.equal(normaliseText(pages[1]).includes('Specification'), true, 'the voucher keeps its four pages');
});

test('customer names stay in sentence case on the cover and the signature line', { timeout: 240_000 }, async () => {
  // The shared test order is for "Test Customer".
  const { status, body: render } = await renderVoucher();
  assert.equal(status, 201, JSON.stringify(render));
  const pages = pdfText(path.join(dataDir, 'renders', `${render.id}.pdf`)).split('\f');
  const cover = normaliseText(pages[0]);
  assert.ok(cover.includes('Test Customer'), `the cover should show the name as entered, got: ${cover}`);
  assert.ok(!cover.includes('TEST CUSTOMER'), 'the cover must not uppercase customer names');
  const specification = normaliseText(pages[1]);
  assert.ok(
    specification.includes('Test Customer'),
    'the signature line should show the customer name in normal case',
  );

  // Tamil names must render as entered: no uppercase transform and the
  // embedded Noto Sans Tamil fallback must supply the glyphs.
  const tamilCustomer = await (
    await postJson(`${baseUrl}/api/customers`, { name: 'அருண் குமார்' })
  ).json();
  const tamilOrder = await (
    await postJson(`${baseUrl}/api/orders`, {
      ...DEMO_ORDER,
      title: 'Master Bedroom Wardrobe',
      customerId: tamilCustomer.id,
    })
  ).json();
  const tamilResponse = await postJson(`${baseUrl}/api/orders/${tamilOrder.id}/render`, {
    kind: 'voucher',
  });
  const tamilRaw = await tamilResponse.text();
  assert.equal(tamilResponse.status, 201, tamilRaw);
  const tamilRender = JSON.parse(tamilRaw);
  const tamilPages = pdfText(path.join(dataDir, 'renders', `${tamilRender.id}.pdf`)).split('\f');
  assert.ok(
    normaliseText(tamilPages[0]).includes('அருண் குமார்'),
    'a Tamil customer name should appear as entered in the cover text layer',
  );
});
