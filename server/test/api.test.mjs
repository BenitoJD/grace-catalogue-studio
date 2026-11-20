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
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { serve } from '@hono/node-server';

import {
  SCHEMA_VERSION,
  createCustomer,
  createMaterial,
  createOrder,
  createRender,
  deleteCustomer,
  getSetting,
  listRenders,
  listSettings,
  openDb,
  setSetting,
} from '../src/db.mjs';
import { resolveWeasyprint } from '../src/config.mjs';
import { LlmError, buildNoteMessages, requestChat, resolveLlmConfig } from '../src/llm.mjs';
import { createLogger } from '../src/logger.mjs';
import { sweepRenders } from '../src/retention.mjs';
import { createApp } from '../src/routes.mjs';

// The suite fires a large burst of requests from 127.0.0.1. Give the shared
// app generous limits so test order cannot trip the limiter; the dedicated rate
// limit tests build their own app with low limits instead.
process.env.RATE_LIMIT_PER_MIN = '100000';
process.env.RENDER_LIMIT_PER_MIN = '100000';
process.env.NOTE_LIMIT_PER_MIN = '100000';

const rootDir = fileURLToPath(new URL('../..', import.meta.url));
const templatesDir = path.join(rootDir, 'templates');
const weasyprintBin = resolveWeasyprint(rootDir);
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

// ---------------------------------------------------------------------------
// Local OpenAI compatible mock provider
// ---------------------------------------------------------------------------
//
// The language model tests never touch the real internet. Every provider call
// lands on this loopback HTTP server, which records what it was sent and can
// answer with a reply, an OpenAI style error or a plain text error.

const mockProviderState = {
  mode: 'ok',
  reply: 'ok',
  errorStatus: 402,
  errorBody: null,
  textError: 'Free usage limit reached',
  delayMs: 0,
  requests: [],
};

let mockProvider;
let mockProviderUrl;

function startMockProvider() {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      let raw = '';
      request.on('data', (chunk) => {
        raw += chunk;
      });
      request.on('end', () => {
        let json = null;
        try {
          json = raw === '' ? null : JSON.parse(raw);
        } catch {
          json = null;
        }
        mockProviderState.requests.push({
          method: request.method,
          url: request.url,
          headers: request.headers,
          body: raw,
          json,
        });

        const reply = () => {
          if (response.destroyed || response.writableEnded) return;
          if (mockProviderState.mode === 'provider_error') {
            const body =
              mockProviderState.errorBody ?? {
                error: { message: 'Insufficient balance', type: 'insufficient_balance' },
              };
            response.writeHead(mockProviderState.errorStatus, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify(body));
            return;
          }
          if (mockProviderState.mode === 'text_error') {
            response.writeHead(500, { 'Content-Type': 'text/plain' });
            response.end(mockProviderState.textError);
            return;
          }
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(
            JSON.stringify({
              id: 'chatcmpl-mock',
              object: 'chat.completion',
              model: json?.model ?? 'mock-model',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: mockProviderState.reply },
                  finish_reason: 'stop',
                },
              ],
            }),
          );
        };

        if (mockProviderState.delayMs > 0) setTimeout(reply, mockProviderState.delayMs);
        else reply();
      });
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

async function stopMockProvider() {
  if (!mockProvider) return;
  await new Promise((resolve) => {
    mockProvider.server.close(resolve);
    mockProvider.server.closeAllConnections?.();
  });
  mockProvider = null;
}

function resetMockProvider(overrides = {}) {
  Object.assign(mockProviderState, {
    mode: 'ok',
    reply: 'ok',
    errorStatus: 402,
    errorBody: null,
    textError: 'Free usage limit reached',
    delayMs: 0,
    ...overrides,
  });
  mockProviderState.requests.length = 0;
}

function lastProviderRequest() {
  return mockProviderState.requests[mockProviderState.requests.length - 1];
}

function resetLlmState() {
  db.prepare('DELETE FROM settings').run();
  resetMockProvider();
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

  mockProvider = await startMockProvider();
  mockProviderUrl = mockProvider.url;

  db = openDb(path.join(dataDir, 'catalog.db'));
  for (const material of DEMO_MATERIALS) createMaterial(db, material);

  // llmEnv: {} keeps the suite independent from any LLM_* variables in the
  // environment of whoever runs the tests.
  const app = createApp({ db, dataDir, templatesDir, weasyprintBin, pdftoppmBin, llmEnv: {} });
  const started = await startApp(app);
  server = started.server;
  baseUrl = `http://127.0.0.1:${started.port}`;
});

after(async () => {
  await stopServer(server ? { server } : null);
  await stopMockProvider();
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
  // The default allowlist echoes the request origin, it does not use "*".
  const response = await fetch(`${baseUrl}/api/bootstrap`, {
    headers: { Origin: 'http://localhost:8081' },
  });
  assert.equal(
    response.headers.get('access-control-allow-origin'),
    'http://localhost:8081',
  );
  assert.match(response.headers.get('vary') ?? '', /origin/i);

  const preflight = await fetch(`${baseUrl}/api/customers`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'http://localhost:8081',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(
    preflight.headers.get('access-control-allow-origin'),
    'http://localhost:8081',
  );
  assert.match(preflight.headers.get('access-control-allow-methods') ?? '', /POST/);
  assert.match((preflight.headers.get('access-control-allow-headers') ?? '').toLowerCase(), /content-type/);

  // An origin outside the allowlist gets no CORS headers at all.
  const unknown = await fetch(`${baseUrl}/api/bootstrap`, {
    headers: { Origin: 'http://unknown.example' },
  });
  assert.equal(unknown.status, 200);
  assert.equal(unknown.headers.get('access-control-allow-origin'), null);

  // CORS_ORIGINS="*" keeps the old allow-anything mode available.
  const wildcardApp = createApp({
    db,
    dataDir,
    templatesDir,
    weasyprintBin,
    pdftoppmBin,
    corsOrigins: ['*'],
    rateLimitPerMin: 1000,
    renderLimitPerMin: 1000,
  });
  const started = await startApp(wildcardApp);
  try {
    const wildcard = await fetch(`http://127.0.0.1:${started.port}/health`, {
      headers: { Origin: 'http://anything.example' },
    });
    assert.equal(wildcard.headers.get('access-control-allow-origin'), '*');
  } finally {
    await stopServer({ server: started.server });
  }
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
  const brokenFamilyDir = path.join(brokenVoucherDir, 'families');
  mkdirSync(brokenFamilyDir, { recursive: true });

  const template = readFileSync(
    path.join(templatesDir, 'voucher', 'families', 'atelier.html'),
    'utf8',
  );
  writeFileSync(
    path.join(brokenFamilyDir, 'atelier.html'),
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
// Ten complete document families, three palettes each
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PALETTE_IDS = ['copper', 'ink', 'olive', 'indigo', 'sand'];
const FAMILY_IDS = [
  'atelier',
  'swiss',
  'gallery',
  'index',
  'dark',
  'blueprint',
  'lookbook',
  'poster',
  'card',
  'folio',
];
const COVER_IDS = [
  'editorial',
  'grid',
  'void',
  'contents',
  'reversed',
  'technical',
  'photoFirst',
  'display',
  'card',
  'centred',
];

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

async function pageHash(render, pageNumber) {
  const response = await fetch(`${baseUrl}${render.pageUrls[pageNumber - 1]}`);
  assert.equal(response.status, 200);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.ok(bytes.subarray(0, 8).equals(PNG_SIGNATURE));
  return hashBytes(bytes);
}

test('lists 30 templates from ten complete families, three palettes each', { timeout: 120_000 }, async () => {
  const templates = await fetchTemplates();
  assert.equal(templates.length, 30);
  assert.equal(new Set(templates.map((template) => template.id)).size, 30);

  for (const template of templates) {
    assert.equal(typeof template.id, 'string');
    assert.ok(template.name && template.name.trim().length > 0, 'every template needs a human name');
    assert.ok(PALETTE_IDS.includes(template.palette), `unknown palette ${template.palette}`);
    assert.ok(FAMILY_IDS.includes(template.family), `unknown family ${template.family}`);
    assert.ok(COVER_IDS.includes(template.cover), `unknown cover ${template.cover}`);
    assert.equal(template.pageCount, 4);
    assert.equal(template.previewUrl, `/previews/${template.id}.png`);
    assert.equal(template.id, `${template.family}-${template.palette}`);
  }

  const combinations = new Set(templates.map((template) => `${template.family}/${template.palette}`));
  assert.equal(combinations.size, 30, 'every family and palette pair appears exactly once');

  for (const family of FAMILY_IDS) {
    const entries = templates.filter((template) => template.family === family);
    assert.equal(entries.length, 3, `family ${family} needs three palettes`);
    assert.equal(new Set(entries.map((entry) => entry.palette)).size, 3);
  }

  assert.equal(templates[0].id, 'atelier-copper', 'the first template is the default');
  assert.ok(templates.some((template) => template.name === 'Ink Swiss'));
  assert.ok(templates.some((template) => template.name === 'Sand Poster'));
  assert.ok(templates.some((template) => template.name === 'Olive Card'));
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

test('every template renders four pages and no two share any page image', { timeout: 900_000 }, async () => {
  const templates = await fetchTemplates();
  const pageHashes = [new Set(), new Set(), new Set(), new Set()];

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

    for (let page = 1; page <= 4; page += 1) {
      pageHashes[page - 1].add(await pageHash(render, page));
    }
  }

  for (let page = 1; page <= 4; page += 1) {
    assert.equal(
      pageHashes[page - 1].size,
      30,
      `no two templates may share a page ${page} image`,
    );
  }
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
  const ids = ['atelier-copper', 'swiss-ink', 'lookbook-sand'];
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
  assert.equal(render.templateId, 'atelier-copper', 'the default template is the first one');

  const text = pdfText(path.join(dataDir, 'renders', `${render.id}.pdf`));
  const pages = text.split('\f');
  const cover = normaliseText(pages[0]);
  assert.ok(cover.includes(longTitle), `the full title must appear on the cover, got: ${cover}`);
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

test('all 30 template previews exist, open and differ', { timeout: 600_000 }, async () => {
  const templates = await fetchTemplates();
  const previewHashes = new Set();

  for (const template of templates) {
    const response = await fetch(`${baseUrl}${template.previewUrl}`);
    assert.equal(response.status, 200, `${template.id} preview should open`);
    assert.match(response.headers.get('content-type') ?? '', /image\/png/);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.ok(bytes.length > 10_000, `${template.id} preview should not be empty`);
    assert.ok(bytes.subarray(0, 8).equals(PNG_SIGNATURE), `${template.id} preview should be a PNG`);
    previewHashes.add(hashBytes(bytes));
  }

  assert.equal(previewHashes.size, 30, 'every template needs its own preview image');
});

test('kit renders keep working and carry no templateId', { timeout: 120_000 }, async () => {
  const response = await postJson(`${baseUrl}/api/orders/${orderId}/render`, { kind: 'kit' });
  const raw = await response.text();
  assert.equal(response.status, 201, raw);
  const render = JSON.parse(raw);
  assert.equal(render.kind, 'kit');
  assert.equal(render.templateId, null);
  assert.ok(render.pageCount >= 1);
  assert.ok(existsSync(path.join(dataDir, 'renders', `${render.id}.pdf`)));
});


// ---------------------------------------------------------------------------
// Production hardening: request ids, logging, headers, limits, data integrity
// ---------------------------------------------------------------------------

test('every response carries a unique request id and the security headers', async () => {
  const first = await fetch(`${baseUrl}/health`);
  const second = await fetch(`${baseUrl}/health`);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  const firstId = first.headers.get('x-request-id');
  const secondId = second.headers.get('x-request-id');
  assert.match(firstId, uuid);
  assert.match(secondId, uuid);
  assert.notEqual(firstId, secondId, 'request ids must be unique per request');

  assert.equal(first.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(first.headers.get('x-frame-options'), 'DENY');
  assert.equal(first.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(
    first.headers.get('permissions-policy'),
    'camera=(), microphone=(), geolocation=()',
  );
});

test('request logging writes one structured JSON record with the request id', () => {
  const lines = [];
  const logger = createLogger({ level: 'info', write: (record) => lines.push(record) });

  logger.request({
    requestId: 'req-1',
    method: 'GET',
    path: '/health',
    status: 200,
    durationMs: 1.5,
  });
  assert.equal(lines.length, 1);
  assert.deepEqual(Object.keys(lines[0]).sort(), [
    'durationMs',
    'level',
    'method',
    'path',
    'requestId',
    'status',
    'time',
  ]);
  assert.equal(lines[0].level, 'info');
  assert.equal(lines[0].requestId, 'req-1');
  assert.equal(lines[0].path, '/health');
  assert.ok(Number.isFinite(Date.parse(lines[0].time)));

  // LOG_LEVEL filtering: 5xx records are errors, and a higher level hides info.
  logger.request({ requestId: 'req-2', method: 'GET', path: '/x', status: 500, durationMs: 2 });
  assert.equal(lines[1].level, 'error');
  const quiet = [];
  const quietLogger = createLogger({
    level: 'error',
    write: (record) => quiet.push(record),
  });
  quietLogger.request({
    requestId: 'req-3',
    method: 'GET',
    path: '/health',
    status: 200,
    durationMs: 1,
  });
  assert.equal(quiet.length, 0, 'info requests are hidden at LOG_LEVEL=error');
});

test('unknown routes return a JSON 404 with the request id', async () => {
  const response = await fetch(`${baseUrl}/api/this-route-does-not-exist`);
  assert.equal(response.status, 404);
  assert.match(response.headers.get('content-type') ?? '', /application\/json/);
  const body = await response.json();
  assert.ok(body.error);
  assert.equal(body.requestId, response.headers.get('x-request-id'));
});

test('a request body over 64 KB is rejected with 413 JSON', async () => {
  const response = await postJson(`${baseUrl}/api/customers`, {
    name: 'x'.repeat(70 * 1024),
  });
  assert.equal(response.status, 413);
  const body = await response.json();
  assert.match(body.error, /too large/i);
  assert.equal(body.requestId, response.headers.get('x-request-id'));
});

test('rate limits a client when RATE_LIMIT_PER_MIN is low', async () => {
  const limitedApp = createApp({
    db,
    dataDir,
    templatesDir,
    weasyprintBin,
    pdftoppmBin,
    rateLimitPerMin: 3,
    renderLimitPerMin: 1000,
  });
  const started = await startApp(limitedApp);
  const limitedBase = `http://127.0.0.1:${started.port}`;

  try {
    const statuses = [];
    let limitedResponse = null;
    for (let index = 0; index < 5; index += 1) {
      const response = await fetch(`${limitedBase}/health`);
      statuses.push(response.status);
      if (response.status === 429 && !limitedResponse) limitedResponse = response;
    }
    assert.deepEqual(statuses.slice(0, 3), [200, 200, 200]);
    assert.equal(statuses[3], 429);
    assert.ok(limitedResponse, 'the fourth request must be rate limited');

    const retryAfter = Number.parseInt(limitedResponse.headers.get('retry-after') ?? '', 10);
    assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1, 'Retry-After must be present');
    const body = await limitedResponse.json();
    assert.match(body.error, /too many requests/i);
    assert.equal(body.requestId, limitedResponse.headers.get('x-request-id'));
  } finally {
    await stopServer({ server: started.server });
  }
});

test('render requests have their own per minute limit', async () => {
  const renderLimitedApp = createApp({
    db,
    dataDir,
    templatesDir,
    weasyprintBin,
    pdftoppmBin,
    rateLimitPerMin: 1000,
    renderLimitPerMin: 1,
  });
  const started = await startApp(renderLimitedApp);
  const renderUrl = `http://127.0.0.1:${started.port}/api/orders/${orderId}/render`;

  try {
    const [first, second] = await Promise.all([
      postJson(renderUrl, { kind: 'kit' }),
      postJson(renderUrl, { kind: 'kit' }),
    ]);
    const responses = [first, second].sort((left, right) => left.status - right.status);
    assert.deepEqual(
      responses.map((response) => response.status),
      [201, 429],
    );
    const limited = responses.find((response) => response.status === 429);
    assert.ok(limited, 'one of the two renders must be rate limited');
    assert.match(limited.headers.get('retry-after') ?? '', /^\d+$/);
    const body = await limited.json();
    assert.match(body.error, /too many render requests/i);
    assert.ok(body.requestId);
  } finally {
    await stopServer({ server: started.server });
  }
});

test('ready reports the database and WeasyPrint are usable', async () => {
  const response = await fetch(`${baseUrl}/ready`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ready, true);
  assert.deepEqual(body.checks, { database: true, weasyprint: true });
});

test('ready returns 503 with a JSON reason when WeasyPrint is missing', async () => {
  const missingApp = createApp({
    db,
    dataDir,
    templatesDir,
    weasyprintBin: path.join(tempDir, 'missing-weasyprint'),
    pdftoppmBin,
    rateLimitPerMin: 1000,
    renderLimitPerMin: 1000,
  });
  const started = await startApp(missingApp);

  try {
    const response = await fetch(`http://127.0.0.1:${started.port}/ready`);
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.ready, false);
    assert.match(body.error, /weasyprint/i);
    assert.equal(body.checks.database, true);
    assert.equal(body.checks.weasyprint, false);
    assert.equal(body.requestId, response.headers.get('x-request-id'));
  } finally {
    await stopServer({ server: started.server });
  }
});

test('retention sweep deletes old renders and files and keeps fresh ones', () => {
  const retentionDataDir = path.join(tempDir, 'retention-data');
  const rendersDir = path.join(retentionDataDir, 'renders');
  mkdirSync(rendersDir, { recursive: true });
  const retentionDb = openDb(path.join(retentionDataDir, 'retention.db'));

  try {
    const customer = createCustomer(retentionDb, { name: 'Retention Customer' });
    const order = createOrder(retentionDb, {
      customerId: customer.id,
      title: 'Retention Wardrobe',
      room: 'Guest bedroom',
      width: '1800 mm',
      height: '2100 mm',
      depth: '600 mm',
      shutters: '2',
    });

    const oldId = 'r-old-retention';
    const freshId = 'r-fresh-retention';
    const oldCreatedAt = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    for (const [renderId, createdAt] of [
      [oldId, oldCreatedAt],
      [freshId, new Date().toISOString()],
    ]) {
      createRender(retentionDb, {
        id: renderId,
        orderId: order.id,
        kind: 'voucher',
        pageCount: 1,
        pdfUrl: `/files/${renderId}.pdf`,
        pageUrls: [`/pages/${renderId}/1.png`],
        templateId: 'atelier-copper',
        createdAt,
      });
      writeFileSync(path.join(rendersDir, `${renderId}.pdf`), '%PDF-test');
      writeFileSync(path.join(rendersDir, `${renderId}-1.png`), 'png-test');
    }
    // A page image with no render row is an orphan left behind by a crash.
    const orphanPath = path.join(rendersDir, 'r-deleted-1.png');
    writeFileSync(orphanPath, 'png-orphan');

    const result = sweepRenders(retentionDb, {
      dataDir: retentionDataDir,
      retentionDays: 30,
    });
    assert.equal(result.deletedRenders, 1);
    assert.deepEqual(result.deletedRenderIds, [oldId]);
    assert.equal(result.deletedOrphanPages, 1);

    assert.equal(existsSync(path.join(rendersDir, `${oldId}.pdf`)), false);
    assert.equal(existsSync(path.join(rendersDir, `${oldId}-1.png`)), false);
    assert.equal(existsSync(orphanPath), false);
    assert.equal(existsSync(path.join(rendersDir, `${freshId}.pdf`)), true);
    assert.equal(existsSync(path.join(rendersDir, `${freshId}-1.png`)), true);

    const remaining = listRenders(retentionDb);
    assert.deepEqual(
      remaining.map((render) => render.id),
      [freshId],
    );

    // RENDER_RETENTION_DAYS=0 means keep everything forever.
    const keepId = 'r-keep-forever';
    createRender(retentionDb, {
      id: keepId,
      orderId: order.id,
      kind: 'voucher',
      pageCount: 1,
      pdfUrl: `/files/${keepId}.pdf`,
      pageUrls: [`/pages/${keepId}/1.png`],
      templateId: 'atelier-copper',
      createdAt: oldCreatedAt,
    });
    writeFileSync(path.join(rendersDir, `${keepId}.pdf`), '%PDF-test');
    const disabled = sweepRenders(retentionDb, {
      dataDir: retentionDataDir,
      retentionDays: 0,
    });
    assert.equal(disabled.skipped, true);
    assert.equal(disabled.deletedRenders, 0);
    assert.equal(listRenders(retentionDb).length, 2);
    assert.equal(existsSync(path.join(rendersDir, `${keepId}.pdf`)), true);
  } finally {
    retentionDb.close();
    rmSync(retentionDataDir, { recursive: true, force: true });
  }
});

test('concurrent identical renders create only one render row', { timeout: 120_000 }, async () => {
  const before = (await (await fetch(`${baseUrl}/api/renders`)).json()).length;
  const requestBody = { kind: 'voucher', templateId: 'lookbook-copper' };

  const [first, second] = await Promise.all([
    postJson(`${baseUrl}/api/orders/${orderId}/render`, requestBody),
    postJson(`${baseUrl}/api/orders/${orderId}/render`, requestBody),
  ]);
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  const firstRender = await first.json();
  const secondRender = await second.json();
  assert.equal(firstRender.id, secondRender.id, 'both requests must get the same render');

  const after = (await (await fetch(`${baseUrl}/api/renders`)).json()).length;
  assert.equal(after, before + 1, 'an identical concurrent render must create one row');
});

test('validation caps long values and rejects non string fields', async () => {
  const longTitle = await postJson(`${baseUrl}/api/orders`, {
    ...DEMO_ORDER,
    customerId,
    title: 'x'.repeat(200),
  });
  assert.equal(longTitle.status, 400);
  const titleBody = await longTitle.json();
  assert.match(titleBody.error, /title/i);
  assert.match(titleBody.error, /120/);

  const longField = await postJson(`${baseUrl}/api/orders`, {
    ...DEMO_ORDER,
    customerId,
    room: 'x'.repeat(81),
  });
  assert.equal(longField.status, 400);
  const fieldBody = await longField.json();
  assert.match(fieldBody.error, /room/i);
  assert.match(fieldBody.error, /80/);

  const numericTitle = await postJson(`${baseUrl}/api/orders`, {
    ...DEMO_ORDER,
    customerId,
    title: 12345,
  });
  assert.equal(numericTitle.status, 400);
  assert.match((await numericTitle.json()).error, /title.*text/i);

  const arrayTitle = await postJson(`${baseUrl}/api/orders`, {
    ...DEMO_ORDER,
    customerId,
    title: ['not a string'],
  });
  assert.equal(arrayTitle.status, 400);
  assert.match((await arrayTitle.json()).error, /title.*text/i);

  const longName = await postJson(`${baseUrl}/api/customers`, { name: 'x'.repeat(200) });
  assert.equal(longName.status, 400);
  assert.match((await longName.json()).error, /name/i);

  const longTemplateId = await postJson(`${baseUrl}/api/orders/${orderId}/render`, {
    kind: 'voucher',
    templateId: 'x'.repeat(65),
  });
  assert.equal(longTemplateId.status, 400);
  const templateBody = await longTemplateId.json();
  assert.match(templateBody.error, /templateId/i);
  assert.match(templateBody.error, /64/);
});

test('sqlite foreign keys, WAL, pragmas and indices are active', async () => {
  const foreignKeys = db.prepare('PRAGMA foreign_keys').get();
  assert.equal(Number(foreignKeys.foreign_keys), 1);

  const journalMode = db.prepare('PRAGMA journal_mode').get();
  assert.equal(String(journalMode.journal_mode).toLowerCase(), 'wal');

  const busyTimeout = db.prepare('PRAGMA busy_timeout').get();
  assert.equal(Number(busyTimeout.timeout), 5000);

  const synchronous = db.prepare('PRAGMA synchronous').get();
  assert.equal(Number(synchronous.synchronous), 1, 'synchronous must be NORMAL');

  const userVersion = db.prepare('PRAGMA user_version').get();
  assert.equal(Number(userVersion.user_version), SCHEMA_VERSION);

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.name);
  assert.ok(tables.includes('settings'), 'the current schema has a settings table');

  const indices = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
    .all()
    .map((row) => row.name);
  for (const index of [
    'orders_customer_idx',
    'orders_created_idx',
    'renders_order_created_idx',
    'renders_created_idx',
  ]) {
    assert.ok(indices.includes(index), `missing index ${index}`);
  }

  // A customer with orders can not be deleted, so orders are never orphaned.
  assert.throws(
    () => db.prepare('DELETE FROM customers WHERE id = ?').run(customerId),
    /FOREIGN KEY|constraint/i,
  );
  assert.throws(() => deleteCustomer(db, customerId), /orders?/i);

  const orderResponse = await fetch(`${baseUrl}/api/orders/${orderId}`);
  assert.equal(orderResponse.status, 200, 'the order must survive the refused delete');
  assert.equal((await orderResponse.json()).customerId, customerId);
});


test('the migration runner upgrades a pre versioning database to the current schema', () => {
  const legacyDir = path.join(tempDir, 'legacy-data');
  mkdirSync(legacyDir, { recursive: true });
  const legacyPath = path.join(legacyDir, 'legacy.db');
  const legacy = new DatabaseSync(legacyPath);
  try {
    // The old schema had no user_version and no renders.templateId column.
    legacy.exec(`
      CREATE TABLE customers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '',
        address TEXT NOT NULL DEFAULT '', createdAt TEXT NOT NULL
      );
      CREATE TABLE orders (
        id TEXT PRIMARY KEY, orderNo TEXT NOT NULL UNIQUE,
        customerId TEXT NOT NULL REFERENCES customers(id),
        title TEXT NOT NULL, room TEXT NOT NULL, width TEXT NOT NULL,
        height TEXT NOT NULL, depth TEXT NOT NULL, shutters TEXT NOT NULL,
        carcass TEXT NOT NULL DEFAULT '', backPanel TEXT NOT NULL DEFAULT '',
        shuttersMat TEXT NOT NULL DEFAULT '', drawers TEXT NOT NULL DEFAULT '',
        exterior TEXT NOT NULL DEFAULT '', interior TEXT NOT NULL DEFAULT '',
        hinges TEXT NOT NULL DEFAULT '', channels TEXT NOT NULL DEFAULT '',
        edgeShutter TEXT NOT NULL DEFAULT '', edgeCarcass TEXT NOT NULL DEFAULT '',
        edgeNote TEXT NOT NULL DEFAULT '', handle TEXT NOT NULL DEFAULT '',
        handleNote TEXT NOT NULL DEFAULT '', finishExt TEXT NOT NULL DEFAULT '',
        finishInt TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft',
        createdAt TEXT NOT NULL
      );
      CREATE TABLE materials (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
        hex TEXT NOT NULL, imageUrl TEXT, createdAt TEXT NOT NULL
      );
      CREATE TABLE renders (
        id TEXT PRIMARY KEY, orderId TEXT NOT NULL REFERENCES orders(id),
        kind TEXT NOT NULL, pageCount INTEGER NOT NULL, pdfUrl TEXT NOT NULL,
        pageUrls TEXT NOT NULL, createdAt TEXT NOT NULL
      );
      CREATE INDEX orders_customer_idx ON orders (customerId);
      INSERT INTO customers VALUES ('c1', 'Legacy Customer', '', '', '2025-01-01T00:00:00.000Z');
      INSERT INTO orders (id, orderNo, customerId, title, room, width, height, depth, shutters, createdAt)
        VALUES ('o1', 'GWI-2025-001', 'c1', 'Legacy Order', 'Room', '1', '1', '1', '1', '2025-01-01T00:00:00.000Z');
      INSERT INTO renders (id, orderId, kind, pageCount, pdfUrl, pageUrls, createdAt)
        VALUES ('r1', 'o1', 'voucher', 4, '/files/r1.pdf', '["/pages/r1/1.png"]', '2025-01-01T00:00:00.000Z');
    `);
  } finally {
    legacy.close();
  }

  const upgraded = openDb(legacyPath);
  try {
    assert.equal(Number(upgraded.prepare('PRAGMA user_version').get().user_version), SCHEMA_VERSION);
    const renderColumns = upgraded
      .prepare('PRAGMA table_info(renders)')
      .all()
      .map((column) => column.name);
    assert.ok(renderColumns.includes('templateId'), 'the migration adds renders.templateId');
    const settingsColumns = upgraded
      .prepare('PRAGMA table_info(settings)')
      .all()
      .map((column) => column.name)
      .sort();
    assert.deepEqual(settingsColumns, ['key', 'updated_at', 'value'], 'version 2 adds the settings table');
    assert.equal(listSettings(upgraded).length, 0, 'a pre versioning database starts with no saved settings');

    const indices = upgraded
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all()
      .map((row) => row.name);
    assert.ok(indices.includes('orders_created_idx'));
    assert.ok(indices.includes('renders_created_idx'));

    // Existing rows survive the upgrade.
    assert.equal(upgraded.prepare('SELECT COUNT(*) AS count FROM orders').get().count, 1);
    assert.equal(upgraded.prepare('SELECT COUNT(*) AS count FROM renders').get().count, 1);
  } finally {
    upgraded.close();
    rmSync(legacyDir, { recursive: true, force: true });
  }
});
// ---------------------------------------------------------------------------
// Runtime language model: settings, connection test and order note drafting
// ---------------------------------------------------------------------------

const LLM_KEY = 'sk-test-provider-key-9f2c';
const LLM_MODEL = 'test-model-1';

async function putLlmSettings(body, base = baseUrl) {
  return fetch(`${base}/api/llm/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function configureLlm(overrides = {}) {
  const response = await putLlmSettings({
    endpoint: `${mockProviderUrl}/`,
    model: LLM_MODEL,
    apiKey: LLM_KEY,
    ...overrides,
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}

test('llm settings are empty and the model routes answer 400 until configured', async () => {
  resetLlmState();

  const settingsResponse = await fetch(`${baseUrl}/api/llm/settings`);
  assert.equal(settingsResponse.status, 200);
  assert.deepEqual(await settingsResponse.json(), {
    endpoint: '',
    model: '',
    hasKey: false,
    source: 'none',
    updatedAt: null,
  });

  const testResponse = await fetch(`${baseUrl}/api/llm/test`, { method: 'POST' });
  assert.equal(testResponse.status, 400);
  assert.match((await testResponse.json()).error, /configure/i);

  const noteResponse = await fetch(`${baseUrl}/api/orders/${orderId}/note`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(noteResponse.status, 400);
  assert.match((await noteResponse.json()).error, /configure/i);
  assert.equal(mockProviderState.requests.length, 0, 'an unconfigured route may not call a provider');
});

test('llm settings validation rejects bad input without saving anything', async () => {
  resetLlmState();

  const ftp = await putLlmSettings({ endpoint: 'ftp://example.com/v1' });
  assert.equal(ftp.status, 400);
  assert.match((await ftp.json()).error, /http/i);

  const longEndpoint = await putLlmSettings({ endpoint: `https://example.com/${'a'.repeat(4000)}` });
  assert.equal(longEndpoint.status, 400);
  assert.match((await longEndpoint.json()).error, /300/);

  const longModel = await putLlmSettings({ model: 'm'.repeat(121) });
  assert.equal(longModel.status, 400);
  assert.match((await longModel.json()).error, /120/);

  const longKey = await putLlmSettings({ apiKey: 'k'.repeat(401) });
  assert.equal(longKey.status, 400);
  assert.match((await longKey.json()).error, /400/);

  const unknown = await putLlmSettings({ endpoint: 'https://example.com/v1', extra: 'nope' });
  assert.equal(unknown.status, 400);
  assert.match((await unknown.json()).error, /unknown/i);

  const notText = await putLlmSettings({ model: 42 });
  assert.equal(notText.status, 400);

  // A rejected request must not have written a partial configuration.
  const unchanged = await (await fetch(`${baseUrl}/api/llm/settings`)).json();
  assert.equal(unchanged.source, 'none');
  assert.equal(unchanged.endpoint, '');
  assert.equal(unchanged.hasKey, false);

  // Both http and https endpoints are accepted; the trailing slash goes away.
  const httpsOk = await putLlmSettings({ endpoint: 'https://example.com/v1/' });
  assert.equal(httpsOk.status, 200);
  assert.equal((await httpsOk.json()).endpoint, 'https://example.com/v1');
});

test('llm settings roundtrip stores the key server side and never returns it', async () => {
  resetLlmState();

  const savedResponse = await putLlmSettings({
    endpoint: `${mockProviderUrl}/`,
    model: LLM_MODEL,
    apiKey: LLM_KEY,
  });
  assert.equal(savedResponse.status, 200);
  const savedRaw = await savedResponse.text();
  assert.equal(savedRaw.includes(LLM_KEY), false, 'the key must never be returned');
  const saved = JSON.parse(savedRaw);
  assert.equal(saved.endpoint, mockProviderUrl, 'trailing slashes are trimmed');
  assert.equal(saved.model, LLM_MODEL);
  assert.equal(saved.hasKey, true);
  assert.equal(saved.source, 'settings');
  assert.ok(!Number.isNaN(Date.parse(saved.updatedAt)));
  assert.equal(Object.hasOwn(saved, 'apiKey'), false, 'the response shape has no key field');

  // The values, including the key, are persisted in SQLite.
  assert.equal(getSetting(db, 'llm_api_key').value, LLM_KEY);
  assert.equal(getSetting(db, 'llm_endpoint').value, mockProviderUrl);

  const fetchedRaw = await (await fetch(`${baseUrl}/api/llm/settings`)).text();
  assert.equal(fetchedRaw.includes(LLM_KEY), false);
  assert.deepEqual(JSON.parse(fetchedRaw), saved);
});

test('the connection test calls the provider with the bearer key and configured model', async () => {
  resetLlmState();
  await configureLlm();
  resetMockProvider({ reply: '  ok  ' });

  const response = await fetch(`${baseUrl}/api/llm/test`, { method: 'POST' });
  const raw = await response.text();
  assert.equal(response.status, 200, raw);
  assert.equal(raw.includes(LLM_KEY), false, 'the key must never be returned');
  const body = JSON.parse(raw);
  assert.equal(body.ok, true);
  assert.equal(body.sample, 'ok', 'the sample is trimmed');
  assert.equal(body.model, LLM_MODEL);
  assert.ok(Number.isInteger(body.latencyMs) && body.latencyMs >= 0);

  assert.equal(mockProviderState.requests.length, 1);
  const request = lastProviderRequest();
  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/chat/completions', 'requests go to <endpoint>/chat/completions');
  assert.equal(request.headers.authorization, `Bearer ${LLM_KEY}`);
  assert.equal(request.json.model, LLM_MODEL);
  assert.equal(request.json.max_tokens, 16);
  assert.equal(request.json.temperature, 0);
  assert.deepEqual(request.json.messages, [
    { role: 'system', content: 'You are a connection test.' },
    { role: 'user', content: 'Reply with the single word ok.' },
  ]);

  // A long reply is capped instead of being copied whole into the sample.
  resetMockProvider({ reply: ' ok'.repeat(200) });
  const capped = await (await fetch(`${baseUrl}/api/llm/test`, { method: 'POST' })).json();
  assert.equal(capped.ok, true);
  assert.ok(capped.sample.length <= 200, `the sample must be capped, got ${capped.sample.length}`);
  assert.ok(capped.sample.startsWith('ok ok'));
});

test('a failing provider is surfaced through a 502 with the provider message', async () => {
  resetLlmState();
  await configureLlm();

  // OpenAI style { error: { message, type } } body.
  resetMockProvider({ mode: 'provider_error' });
  const response = await fetch(`${baseUrl}/api/llm/test`, { method: 'POST' });
  const raw = await response.text();
  assert.equal(response.status, 502, raw);
  assert.equal(raw.includes(LLM_KEY), false, 'a failed call must not leak the key');
  assert.equal(raw.toLowerCase().includes('stack'), false, 'no stack trace may be returned');
  const body = JSON.parse(raw);
  assert.equal(body.ok, false);
  assert.equal(body.error.message, 'Insufficient balance', 'the provider message is surfaced verbatim');
  assert.equal(body.error.status, 402);
  assert.equal(body.error.type, 'insufficient_balance');

  // Plain text error body.
  resetMockProvider({ mode: 'text_error' });
  const textResponse = await fetch(`${baseUrl}/api/llm/test`, { method: 'POST' });
  assert.equal(textResponse.status, 502);
  const textBody = await textResponse.json();
  assert.equal(textBody.ok, false);
  assert.equal(textBody.error.message, 'Free usage limit reached');
  assert.equal(textBody.error.status, 500);

  // A very long provider message is capped, not copied whole.
  resetMockProvider({
    mode: 'text_error',
    textError: `Free usage limit reached ${'x'.repeat(2000)}`,
  });
  const longBody = await (await fetch(`${baseUrl}/api/llm/test`, { method: 'POST' })).json();
  assert.ok(
    longBody.error.message.length <= 300,
    `the provider message must be capped, got ${longBody.error.message.length}`,
  );
  assert.ok(longBody.error.message.startsWith('Free usage limit reached'));
});

test('the order note is drafted from the order details over the provider', async () => {
  resetLlmState();
  await configureLlm();
  const noteText =
    'Hello Test Customer, your Master Bedroom Wardrobe is taking shape in our Nagercoil workshop. We will share the next update on WhatsApp.';
  resetMockProvider({ reply: ` ${noteText} ` });

  const response = await fetch(`${baseUrl}/api/orders/${orderId}/note`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  const raw = await response.text();
  assert.equal(response.status, 200, raw);
  assert.equal(raw.includes(LLM_KEY), false, 'the key must never be returned');
  const body = JSON.parse(raw);
  assert.equal(body.note, noteText);
  assert.equal(body.model, LLM_MODEL);
  assert.ok(Number.isInteger(body.latencyMs) && body.latencyMs >= 0);

  const request = lastProviderRequest();
  assert.equal(request.url, '/chat/completions');
  assert.equal(request.headers.authorization, `Bearer ${LLM_KEY}`);
  const prompt = request.json.messages.map((message) => message.content).join('\n');
  assert.ok(prompt.includes('Master Bedroom Wardrobe'), 'the prompt carries the order title');
  assert.ok(prompt.includes('Test Customer'), 'the prompt carries the customer name');
  assert.ok(prompt.includes('Master bedroom'), 'the prompt carries the room');
  assert.ok(prompt.includes('2400 mm'), 'the prompt carries the dimensions');
  assert.ok(prompt.includes('18 mm BWP plywood'), 'the prompt carries the materials');
  assert.ok(prompt.includes('2 mm PVC'), 'the prompt carries the edge band');
  assert.ok(prompt.includes('Matte black aluminium'), 'the prompt carries the handles');
  assert.ok(prompt.includes('Matte outside, white inside'), 'the prompt carries the finish');
  assert.match(prompt, /under 60 words/i);
  assert.match(prompt, /British Indian English/i);
  assert.match(prompt, /no em dashes/i);
  assert.match(prompt, /WhatsApp/i);
  assert.match(prompt, /invent/i);
});

test('order note answers 404 for an unknown order and 502 when the provider fails', async () => {
  resetLlmState();
  await configureLlm();

  const missing = await fetch(`${baseUrl}/api/orders/does-not-exist/note`, { method: 'POST' });
  assert.equal(missing.status, 404);

  resetMockProvider({ mode: 'provider_error' });
  const failed = await fetch(`${baseUrl}/api/orders/${orderId}/note`, { method: 'POST' });
  const raw = await failed.text();
  assert.equal(failed.status, 502);
  assert.equal(raw.includes(LLM_KEY), false);
  const body = JSON.parse(raw);
  assert.equal(body.ok, false);
  assert.equal(body.error.message, 'Insufficient balance');
});

test('clearing the api key removes it and disables the model routes', async () => {
  resetLlmState();
  await configureLlm();
  resetMockProvider({ mode: 'provider_error' }); // would fail loudly if a call slipped through

  const clearedResponse = await putLlmSettings({ apiKey: '' });
  const clearedRaw = await clearedResponse.text();
  assert.equal(clearedResponse.status, 200);
  assert.equal(clearedRaw.includes(LLM_KEY), false);
  const cleared = JSON.parse(clearedRaw);
  assert.equal(cleared.hasKey, false);
  assert.equal(getSetting(db, 'llm_api_key'), null, 'the stored key row is deleted');

  const testResponse = await fetch(`${baseUrl}/api/llm/test`, { method: 'POST' });
  assert.equal(testResponse.status, 400);
  const noteResponse = await fetch(`${baseUrl}/api/orders/${orderId}/note`, { method: 'POST' });
  assert.equal(noteResponse.status, 400);
  assert.equal(mockProviderState.requests.length, 0, 'no provider call may happen without a key');
});

test('the api key never appears in responses or request logs', async () => {
  resetLlmState();
  const logLines = [];
  const auditLogger = createLogger({
    level: 'debug',
    write: (record) => logLines.push(JSON.stringify(record)),
  });
  const auditApp = createApp({
    db,
    dataDir,
    templatesDir,
    weasyprintBin,
    pdftoppmBin,
    logger: auditLogger,
    llmEnv: {},
    rateLimitPerMin: 1000,
    renderLimitPerMin: 1000,
    noteLimitPerMin: 1000,
  });
  const started = await startApp(auditApp);
  const auditBase = `http://127.0.0.1:${started.port}`;
  try {
    resetMockProvider({ mode: 'provider_error' });
    const bodies = [];
    const saved = await putLlmSettings(
      { endpoint: mockProviderUrl, model: LLM_MODEL, apiKey: LLM_KEY },
      auditBase,
    );
    bodies.push(await saved.text());
    bodies.push(await (await fetch(`${auditBase}/api/llm/settings`)).text());
    bodies.push(await (await fetch(`${auditBase}/api/llm/test`, { method: 'POST' })).text());
    bodies.push(await (await fetch(`${auditBase}/api/orders/${orderId}/note`, { method: 'POST' })).text());

    resetMockProvider();
    bodies.push(await (await fetch(`${auditBase}/api/llm/test`, { method: 'POST' })).text());
    bodies.push(await (await fetch(`${auditBase}/api/orders/${orderId}/note`, { method: 'POST' })).text());

    const cleared = await putLlmSettings({ apiKey: '' }, auditBase);
    bodies.push(await cleared.text());

    for (const body of bodies) {
      assert.equal(body.includes(LLM_KEY), false, 'no language model response may contain the key');
    }
    assert.ok(logLines.length > 0, 'the audit logger saw request records');
    for (const line of logLines) {
      assert.equal(line.includes(LLM_KEY), false, 'request logs must never contain the key');
    }
    assert.equal(getSetting(db, 'llm_api_key'), null);
  } finally {
    await stopServer({ server: started.server });
  }
});

test('the environment configures the provider and stored settings override it', async () => {
  const envDb = openDb(':memory:');
  const envApp = createApp({
    db: envDb,
    dataDir,
    templatesDir,
    weasyprintBin,
    pdftoppmBin,
    llmEnv: {
      LLM_ENDPOINT: `${mockProviderUrl}/`,
      LLM_MODEL: LLM_MODEL,
      LLM_API_KEY: LLM_KEY,
    },
    rateLimitPerMin: 1000,
    renderLimitPerMin: 1000,
    noteLimitPerMin: 1000,
  });
  const started = await startApp(envApp);
  const envBase = `http://127.0.0.1:${started.port}`;
  try {
    resetMockProvider();

    const settings = await (await fetch(`${envBase}/api/llm/settings`)).json();
    assert.equal(settings.source, 'env');
    assert.equal(settings.endpoint, mockProviderUrl, 'the environment endpoint is trimmed');
    assert.equal(settings.model, LLM_MODEL);
    assert.equal(settings.hasKey, true);
    assert.equal(settings.updatedAt, null);

    const tested = await fetch(`${envBase}/api/llm/test`, { method: 'POST' });
    assert.equal(tested.status, 200);
    assert.equal(lastProviderRequest().headers.authorization, `Bearer ${LLM_KEY}`);
    assert.equal(lastProviderRequest().json.model, LLM_MODEL);

    // A stored value wins, while fields that were not stored keep coming from
    // the environment.
    const savedResponse = await putLlmSettings({ model: 'stored-model' }, envBase);
    const saved = await savedResponse.json();
    assert.equal(saved.source, 'settings');
    assert.equal(saved.model, 'stored-model');
    assert.equal(saved.endpoint, mockProviderUrl);
    assert.equal(saved.hasKey, true);

    mockProviderState.requests.length = 0;
    await fetch(`${envBase}/api/llm/test`, { method: 'POST' });
    assert.equal(lastProviderRequest().json.model, 'stored-model');
  } finally {
    envDb.close();
    await stopServer({ server: started.server });
  }
});

test('language model helpers are unit testable without the internet', async () => {
  // Config resolution: settings table first, environment second.
  const unitDb = openDb(':memory:');
  try {
    const none = resolveLlmConfig(unitDb, {});
    assert.equal(none.source, 'none');
    assert.equal(none.configured, false);
    assert.equal(none.updatedAt, null);

    const fromEnv = resolveLlmConfig(unitDb, {
      LLM_ENDPOINT: `${mockProviderUrl}/`,
      LLM_MODEL: 'env-model',
      LLM_API_KEY: LLM_KEY,
    });
    assert.equal(fromEnv.source, 'env');
    assert.equal(fromEnv.endpoint, mockProviderUrl);
    assert.equal(fromEnv.model, 'env-model');
    assert.equal(fromEnv.apiKey, LLM_KEY);
    assert.equal(fromEnv.configured, true);

    setSetting(unitDb, 'llm_endpoint', `${mockProviderUrl}/`);
    setSetting(unitDb, 'llm_model', 'stored-model');
    const stored = resolveLlmConfig(unitDb, {
      LLM_ENDPOINT: 'https://env.example/v1',
      LLM_MODEL: 'env-model',
      LLM_API_KEY: LLM_KEY,
    });
    assert.equal(stored.source, 'settings');
    assert.equal(stored.endpoint, mockProviderUrl, 'stored endpoints are trimmed as well');
    assert.equal(stored.model, 'stored-model');
    assert.equal(stored.apiKey, LLM_KEY, 'a missing stored key still falls back to the environment');
  } finally {
    unitDb.close();
  }

  // Prompt builder: order facts only, and the drafting rules are explicit.
  const order = {
    customerName: 'Ravi Kumar',
    title: 'Master Bedroom Wardrobe',
    room: 'Master bedroom',
    width: '2400 mm',
    height: '2100 mm',
    depth: '600 mm',
    shutters: '3',
    carcass: '18 mm BWP plywood',
    backPanel: '',
    shuttersMat: '18 mm BWP plywood',
    drawers: '',
    exterior: '1 mm laminate',
    interior: '',
    hinges: '',
    channels: '',
    edgeShutter: '2 mm PVC',
    edgeCarcass: '',
    edgeNote: '',
    handle: 'Matte black aluminium',
    handleNote: '',
    finishExt: 'Matte outside',
    finishInt: '',
  };
  const messages = buildNoteMessages(order);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'system');
  assert.match(messages[0].content, /under 60 words/i);
  assert.match(messages[0].content, /British Indian English/i);
  assert.match(messages[0].content, /no em dashes/i);
  assert.match(messages[0].content, /WhatsApp/i);
  assert.equal(messages[1].role, 'user');
  const prompt = messages[1].content;
  for (const expected of [
    'Ravi Kumar',
    'Master Bedroom Wardrobe',
    'Master bedroom',
    '2400 mm',
    '18 mm BWP plywood',
    '2 mm PVC',
    'Matte black aluminium',
    'Matte outside',
  ]) {
    assert.ok(prompt.includes(expected), `the prompt should include ${expected}`);
  }
  assert.equal(prompt.includes('undefined'), false);
  assert.equal(prompt.includes('null'), false);
  assert.equal(prompt.toLowerCase().includes('back panel'), false, 'empty facts are omitted');

  // The request function can be called directly against the loopback mock.
  resetMockProvider({ reply: ' ok ' });
  const success = await requestChat({
    endpoint: `${mockProviderUrl}/`,
    model: 'unit-model',
    apiKey: LLM_KEY,
    messages: [{ role: 'user', content: 'hi' }],
    maxTokens: 5,
    temperature: 0,
  });
  assert.equal(success.content, 'ok');
  assert.equal(success.model, 'unit-model');
  assert.ok(Number.isFinite(success.latencyMs) && success.latencyMs >= 0);

  resetMockProvider({ mode: 'text_error' });
  await assert.rejects(
    () =>
      requestChat({
        endpoint: mockProviderUrl,
        model: 'unit-model',
        apiKey: LLM_KEY,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    (error) => {
      assert.ok(error instanceof LlmError);
      assert.equal(error.message, 'Free usage limit reached');
      assert.equal(error.status, 500);
      return true;
    },
  );

  // A slow provider aborts on the timeout budget and reports a timeout type.
  resetMockProvider({ delayMs: 300 });
  await assert.rejects(
    () =>
      requestChat({
        endpoint: mockProviderUrl,
        model: 'unit-model',
        apiKey: LLM_KEY,
        messages: [{ role: 'user', content: 'hi' }],
        timeoutMs: 50,
      }),
    (error) => {
      assert.ok(error instanceof LlmError);
      assert.equal(error.type, 'timeout');
      assert.match(error.message, /timeout/i);
      assert.equal(error.message.includes(LLM_KEY), false);
      return true;
    },
  );
  resetMockProvider();
});

test('the note route has its own per minute rate limit', async () => {
  resetLlmState();
  await configureLlm();
  resetMockProvider({ reply: 'ok' });

  const noteLimitedApp = createApp({
    db,
    dataDir,
    templatesDir,
    weasyprintBin,
    pdftoppmBin,
    llmEnv: {},
    rateLimitPerMin: 1000,
    renderLimitPerMin: 1000,
    noteLimitPerMin: 1,
  });
  const started = await startApp(noteLimitedApp);
  try {
    const url = `http://127.0.0.1:${started.port}/api/orders/${orderId}/note`;
    const responses = await Promise.all([
      fetch(url, { method: 'POST' }),
      fetch(url, { method: 'POST' }),
    ]);
    const statuses = responses.map((response) => response.status).sort();
    assert.deepEqual(statuses, [200, 429]);
    const limited = responses.find((response) => response.status === 429);
    assert.match(limited.headers.get('retry-after') ?? '', /^\d+$/);
    assert.match((await limited.json()).error, /too many note requests/i);
  } finally {
    await stopServer({ server: started.server });
  }
});

test('a version 1 database upgrades in place to the settings schema', () => {
  const upgradeDir = path.join(tempDir, 'upgrade-data');
  mkdirSync(upgradeDir, { recursive: true });
  const upgradePath = path.join(upgradeDir, 'upgrade.db');

  // A fresh database starts on the current version with both migrations.
  const fresh = openDb(upgradePath);
  try {
    assert.equal(Number(fresh.prepare('PRAGMA user_version').get().user_version), SCHEMA_VERSION);
    createCustomer(fresh, { name: 'Upgrade Customer' });
    // Simulate a database written by the version 1 release, before settings.
    fresh.exec('DROP TABLE settings');
    fresh.exec('PRAGMA user_version = 1');
  } finally {
    fresh.close();
  }

  const upgraded = openDb(upgradePath);
  try {
    assert.equal(Number(upgraded.prepare('PRAGMA user_version').get().user_version), SCHEMA_VERSION);
    const settingsColumns = upgraded
      .prepare('PRAGMA table_info(settings)')
      .all()
      .map((column) => column.name)
      .sort();
    assert.deepEqual(settingsColumns, ['key', 'updated_at', 'value']);
    assert.equal(listSettings(upgraded).length, 0, 'the upgraded database starts with no saved settings');
    assert.equal(
      upgraded.prepare('SELECT COUNT(*) AS count FROM customers').get().count,
      1,
      'existing rows survive the upgrade',
    );
  } finally {
    upgraded.close();
    rmSync(upgradeDir, { recursive: true, force: true });
  }
});
