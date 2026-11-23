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

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
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
  getOrder,
  getSetting,
  llmCacheStats,
  putLlmCache,
  listRenders,
  listSettings,
  openDb,
  setOrderCopy,
  setSetting,
} from '../src/db.mjs';
import { parseDesignerReply } from '../src/ai-brochure.mjs';
import { resolveWeasyprint } from '../src/config.mjs';
import { buildLlmCacheKey, cacheExpiryCutoff } from '../src/llm-cache.mjs';
import { installEgressGuard, isAllowedEgressUrl } from '../src/egress.mjs';
import {
  buildIntakeMessages,
  cleanReadyReply,
  ensureMissingMentioned,
  humanList,
  normaliseDimension,
  normaliseFieldValue,
  scrubBrief,
} from '../src/intake.mjs';
import {
  COPY_BODY_MAX_CHARS,
  COPY_CLOSING_MAX_CHARS,
  COPY_HEADLINE_MAX_CHARS,
  TEST_MAX_TOKENS,
  copyQualityIssues,
  LlmError,
  buildCopyMessages,
  buildCopyRepairMessages,
  buildNoteMessages,
  parseCopyReply,
  providerBodyExtras,
  providerHeaders,
  requestChat,
  resolveLlmConfig,
} from '../src/llm.mjs';
import { createLogger } from '../src/logger.mjs';
import {
  buildVoucherValues,
  createRenderer,
  fillTemplate,
  newRenderId,
  noteCopyValues,
} from '../src/render.mjs';
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
const DESIGNER_HTML = readFileSync(path.join(rootDir, 'scripts', 'fixtures', 'designer-reply.html'), 'utf8');
const DESIGNER_LONG_HTML = readFileSync(path.join(rootDir, 'scripts', 'fixtures', 'designer-reply-long.html'), 'utf8');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CATALOG_FAMILIES = ['Atelier', 'Ledger', 'Jaali', 'Monsoon', 'Kolam', 'Verandah', 'Bazaar', 'Manuscript', 'Courtyard', 'Silk Route', 'Laterite', 'Palm Court'];
const CATALOG_PALETTES = [
  { paper: '#FBF3E4', ink: '#2A1512', deep: '#4A1116', accent: '#7C2A22', gold: '#C79A3A', hair: '#E3D2B8', muted: '#6B4A3E', onDark: '#FBF3E4' },
  { paper: '#F8F3E6', ink: '#142A28', deep: '#123B3A', accent: '#1E5C5A', gold: '#D9B76A', hair: '#D9D2BC', muted: '#4C615C', onDark: '#F8F3E6' },
  { paper: '#FBF4E7', ink: '#2B1A0F', deep: '#5A2A1E', accent: '#A65E22', gold: '#E8C27A', hair: '#E4D3B8', muted: '#6B4E36', onDark: '#FBF4E7' },
  { paper: '#F8F2E3', ink: '#12222E', deep: '#0D3350', accent: '#16537E', gold: '#E8C27A', hair: '#D8D0BC', muted: '#4A5B66', onDark: '#F8F2E3' },
];
const CATALOG_ORNAMENTS = ['jaali', 'paisley', 'lotus', 'rangoli', 'arch', 'none'];

function catalogBatch(start, count = 25) {
  const designs = Array.from({ length: count }, (_, index) => {
    const number = start + index + 1;
    return {
      id: `mock-design-${number}`,
      name: `Mock Design ${number}`,
      family: CATALOG_FAMILIES[number % CATALOG_FAMILIES.length],
      mood: 'quiet, warm, measured',
      summary: 'A calm printed look with warm paper and one precise accent',
      palette: CATALOG_PALETTES[number % CATALOG_PALETTES.length],
      displayFont: number % 2 === 0 ? 'Barlow' : 'Instrument Serif',
      bodyFont: 'Barlow',
      coverIdea: 'A tall photograph with the title low and the brand at the head',
      ornament: CATALOG_ORNAMENTS[number % CATALOG_ORNAMENTS.length],
    };
  });
  return JSON.stringify({ designs });
}

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
  replies: [],
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
          const queued = mockProviderState.replies.shift();
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(
            JSON.stringify({
              id: 'chatcmpl-mock',
              object: 'chat.completion',
              model: json?.model ?? 'mock-model',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: queued ?? mockProviderState.reply },
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
    replies: [],
    ...overrides,
  });
  mockProviderState.requests.length = 0;
}

function lastProviderRequest() {
  return mockProviderState.requests[mockProviderState.requests.length - 1];
}

function resetLlmState() {
  db.prepare('DELETE FROM settings').run();
  // Each language model test starts with an empty reply cache so a hit from an
  // earlier test can never change the provider request counts it asserts on.
  db.prepare('DELETE FROM llm_cache').run();
  resetMockProvider();
}

const DEMO_MATERIALS = [
  {
    name: 'Dark Walnut',
    kind: 'laminate',
    hex: '#3F2A1D',
    imageUrl: '/media/tex-walnut.jpg',
    priceAmount: 1240,
    priceUnit: 'sheet',
    sku: 'GW-WAL-06',
  },
  {
    name: 'Cream',
    kind: 'laminate',
    hex: '#E8DCC8',
    imageUrl: '/media/tex-cream.jpg',
    priceAmount: 980,
    priceUnit: 'sheet',
    sku: 'GW-CRM-04',
  },
  {
    name: 'Ash Grey',
    kind: 'laminate',
    hex: '#9A9A94',
    imageUrl: '/media/tex-grey.jpg',
    priceAmount: 1120,
    priceUnit: 'sheet',
    sku: 'GW-ASH-07',
  },
  {
    name: 'Edge band',
    kind: 'edge band',
    hex: '#8B5A2B',
    imageUrl: '/media/tex-band.jpg',
    priceAmount: 18,
    priceUnit: 'metre',
    sku: 'GW-EDG-02',
  },
];

// Product photography always comes from uploads, so the suite brings its
// own: one tiny valid PNG written into data/media wherever a render or a
// preview needs customer photography or finish swatches.
const FIXTURE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const FIXTURE_ROOM_FILES = [1, 2].map((index) => ({
  url: `/media/fixture-room-${index}.png`,
  name: `fixture-room-${index}.png`,
  contentType: 'image/png',
  bytes: 69,
}));
const FIXTURE_SWATCH_FILE = {
  url: '/media/fixture-swatch.png',
  name: 'fixture-swatch.png',
  contentType: 'image/png',
  bytes: 69,
};

function writeFixtureMedia() {
  const bytes = Buffer.from(FIXTURE_PNG_BASE64, 'base64');
  mkdirSync(path.join(dataDir, 'media'), { recursive: true });
  for (const file of [...FIXTURE_ROOM_FILES, FIXTURE_SWATCH_FILE]) {
    writeFileSync(path.join(dataDir, 'media', path.basename(file.url)), bytes);
  }
}

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
  const app = createApp({
    db,
    dataDir,
    templatesDir,
    weasyprintBin,
    pdftoppmBin,
    llmEnv: {},
    previewsEnabled: false,
  });
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
  writeFixtureMedia();
  const response = await postJson(`${baseUrl}/api/orders`, {
    ...DEMO_ORDER,
    customerId,
    attachments: FIXTURE_ROOM_FILES,
  });
  assert.equal(response.status, 201);
  const order = await response.json();
  assert.match(order.orderNo, /^JDS-\d{4}-001$/);
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

test('workshop finish photos come from uploads, never from a bundle', async () => {
  const materials = await (await fetch(`${baseUrl}/api/materials`)).json();
  assert.ok(materials.length >= 4, 'the seeded finishes exist');
  for (const material of materials) {
    if (typeof material.imageUrl === 'string' && material.imageUrl.startsWith('/media/tex-')) {
      const response = await fetch(`${baseUrl}/api/materials/${material.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageUrl: FIXTURE_SWATCH_FILE.url }),
      });
      assert.equal(response.status, 200, material.name);
    }
  }
  const stored = await (await fetch(`${baseUrl}/api/materials`)).json();
  assert.ok(
    stored.every((material) => material.imageUrl === null || material.imageUrl === FIXTURE_SWATCH_FILE.url),
    'every material points at an upload or at nothing',
  );
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
// Thirty complete document families, one palette each
// ---------------------------------------------------------------------------

const templateManifest = JSON.parse(readFileSync(path.join(templatesDir, 'variants.json'), 'utf8'));
const PALETTE_IDS = templateManifest.palettes.map((palette) => palette.id);
const FAMILY_IDS = templateManifest.families.map((family) => family.id);

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

test('lists 30 designs from thirty unique families, one palette each', { timeout: 120_000 }, async () => {
  const templates = await fetchTemplates();
  assert.equal(templates.length, 30);
  assert.equal(new Set(templates.map((template) => template.id)).size, 30);
  assert.equal(new Set(templates.map((template) => template.family)).size, 30, 'every design is its own family');
  assert.equal(new Set(templates.map((template) => template.name)).size, 30, 'every design needs its own name');

  for (const template of templates) {
    assert.equal(typeof template.id, 'string');
    assert.ok(template.name && template.name.trim().length > 0, 'every template needs a human name');
    assert.ok(PALETTE_IDS.includes(template.palette), `unknown palette ${template.palette}`);
    assert.ok(FAMILY_IDS.includes(template.family), `unknown family ${template.family}`);
    assert.match(template.cover, /^[A-Za-z][A-Za-z0-9]*$/, `family ${template.family} needs a cover descriptor`);
    assert.equal(template.pageCount, 4);
    assert.equal(template.previewUrl, `/previews/${template.id}.png`);
    assert.equal(template.id, `${template.family}-${template.palette}`);
  }

  const combinations = new Set(templates.map((template) => `${template.family}/${template.palette}`));
  assert.equal(combinations.size, 30, 'every family and palette pair appears exactly once');

  for (const family of new Set(templates.map((template) => template.family))) {
    const entries = templates.filter((template) => template.family === family);
    assert.equal(entries.length, 1, `family ${family} must not be repeated in another palette`);
  }

  assert.equal(templates[0].id, 'atelier-copper', 'the first template is the default');
});

test('every family is a different document, not a recolour', async () => {
  const hashes = new Map();
  for (const family of templateManifest.families) {
    const html = readFileSync(path.join(templatesDir, family.file), 'utf8');
    const digest = createHash('sha256').update(html).digest('hex');
    assert.equal(hashes.has(digest), false, `${family.id} duplicates ${hashes.get(digest)}`);
    hashes.set(digest, family.id);
    for (const token of [
      '{{noteHeadline}}',
      '{{noteBody}}',
      '{{noteClosing}}',
      '.copy-headline:empty',
      '{{coverImage}}',
      '{{detailImage}}',
      '{{insideImage}}',
      '{{insideImage2}}',
      '{{width}}',
      '{{handle}}',
      '{{mat1Image}}',
      '{{paletteCss}}',
    ]) {
      assert.ok(html.includes(token), `${family.id} is missing ${token}`);
    }
  }
  assert.equal(hashes.size, 30, 'thirty families, thirty different files');
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
    attachments: FIXTURE_ROOM_FILES,
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
      attachments: FIXTURE_ROOM_FILES,
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
  const requestBody = { kind: 'voucher', templateId: 'lookbook-sand' };

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
    const legacyOrderColumns = upgraded
      .prepare('PRAGMA table_info(orders)')
      .all()
      .map((column) => column.name);
    assert.ok(legacyOrderColumns.includes('brief'), 'version 3 adds orders.brief');
    assert.ok(legacyOrderColumns.includes('copy_json'), 'version 3 adds orders.copy_json');

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
    provider: 'custom',
    providerLabel: 'Custom / OpenAI compatible',
    endpoint: '',
    model: '',
    hasKey: false,
    keyOptional: false,
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
  assert.equal(request.json.max_tokens, TEST_MAX_TOKENS);
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

  // Brochure copy prompt: strict JSON, the agreed limits, no dashes.
  const copyMessages = buildCopyMessages(order, 'Customer wants a calm bedroom with more hanging space.');
  assert.equal(copyMessages[0].role, 'system');
  assert.equal(copyMessages[1].role, 'user');
  assert.match(copyMessages[0].content, /strict JSON/i);
  assert.match(copyMessages[0].content, /at most 56 characters/i);
  assert.match(copyMessages[0].content, /95 to 145 words/i);
  assert.match(copyMessages[0].content, /at most 80 characters/i);
  assert.match(copyMessages[0].content, /no em dashes or en dashes/i);
  assert.match(copyMessages[0].content, /British Indian English/i);
  assert.match(copyMessages[0].content, /Never invent/i);
  assert.ok(copyMessages[1].content.includes('Ravi Kumar'));
  assert.ok(copyMessages[1].content.includes('Master Bedroom Wardrobe'));
  assert.ok(copyMessages[1].content.includes('Customer wants a calm bedroom with more hanging space.'));

  // Defensive reply parsing: bare JSON, fenced JSON with prose, caps, garbage.
  assert.deepEqual(parseCopyReply(JSON.stringify({ headline: 'H', body: 'B', closing: 'C' })), {
    headline: 'H',
    body: 'B',
    closing: 'C',
  });
  assert.deepEqual(
    parseCopyReply('Here you go:\n```json\n{"headline":" H ","body":"B","closing":" C "}\n```\nRegards.'),
    { headline: 'H', body: 'B', closing: 'C' },
  );
  const cappedCopy = parseCopyReply(
    JSON.stringify({
      headline: 'H'.repeat(COPY_HEADLINE_MAX_CHARS + 20),
      body: 'B'.repeat(COPY_BODY_MAX_CHARS + 200),
      closing: 'C'.repeat(COPY_CLOSING_MAX_CHARS + 20),
    }),
  );
  assert.equal(cappedCopy.headline.length, COPY_HEADLINE_MAX_CHARS);
  assert.equal(cappedCopy.body.length, COPY_BODY_MAX_CHARS);
  assert.equal(cappedCopy.closing.length, COPY_CLOSING_MAX_CHARS);
  for (const garbage of ['Sure, here is the copy.', '{"headline": 1, "body": "B", "closing": "C"}', '{}']) {
    assert.throws(
      () => parseCopyReply(garbage),
      (error) => error instanceof LlmError && /could not be read/i.test(error.message),
    );
  }

  // Render values: copy becomes the three note tokens, malformed copy warns and
  // renders with empty strings instead of failing.
  const renderWarnings = [];
  const renderLogger = { warn: (message) => renderWarnings.push(message) };
  assert.deepEqual(noteCopyValues({ id: 'x' }, renderLogger), {
    noteHeadline: '',
    noteBody: '',
    noteClosing: '',
  });
  assert.deepEqual(
    noteCopyValues({ id: 'x', copy: { headline: 'H', body: 'B', closing: 'C' } }, renderLogger),
    { noteHeadline: 'H', noteBody: 'B', noteClosing: 'C' },
  );
  assert.deepEqual(
    noteCopyValues({ id: 'x', copy: null, copy_json: '{broken json' }, renderLogger),
    { noteHeadline: '', noteBody: '', noteClosing: '' },
  );
  assert.deepEqual(
    noteCopyValues({ id: 'x', copy: null, copy_json: '[]' }, renderLogger),
    { noteHeadline: '', noteBody: '', noteClosing: '' },
  );
  assert.equal(renderWarnings.length, 2, 'each malformed copy logs one warning');

  // The renderer passes the copy to the family templates as the three note
  // tokens, and supplies empty strings when the order has no copy.
  const copyValues = buildVoucherValues({
    order: {
      ...order,
      copy: { headline: 'A quiet bedroom', body: 'Planned around the whole room.', closing: 'Talk to us.' },
    },
    materials: [],
    templatesDir,
  });
  assert.equal(copyValues.noteHeadline, 'A quiet bedroom');
  assert.equal(copyValues.noteBody, 'Planned around the whole room.');
  assert.equal(copyValues.noteClosing, 'Talk to us.');
  assert.equal(
    fillTemplate('{{noteHeadline}}|{{noteBody}}|{{noteClosing}}', copyValues, 'voucher'),
    'A quiet bedroom|Planned around the whole room.|Talk to us.',
  );
  const emptyCopyValues = buildVoucherValues({ order: { ...order }, materials: [], templatesDir });
  assert.deepEqual(
    [emptyCopyValues.noteHeadline, emptyCopyValues.noteBody, emptyCopyValues.noteClosing],
    ['', '', ''],
  );
  assert.equal(fillTemplate('[{{noteBody}}]', emptyCopyValues, 'voucher'), '[]');

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

test('a version 1 database upgrades in place to the current schema', () => {
  const upgradeDir = path.join(tempDir, 'upgrade-data');
  mkdirSync(upgradeDir, { recursive: true });
  const upgradePath = path.join(upgradeDir, 'upgrade.db');

  // A fresh database starts on the current version with both migrations.
  const fresh = openDb(upgradePath);
  try {
    assert.equal(Number(fresh.prepare('PRAGMA user_version').get().user_version), SCHEMA_VERSION);
    createCustomer(fresh, { name: 'Upgrade Customer' });
    // Simulate a database written by the version 1 release: no settings table
    // and no brief or copy_json columns on orders.
    fresh.exec('DROP TABLE settings');
    fresh.exec('ALTER TABLE orders DROP COLUMN brief');
    fresh.exec('ALTER TABLE orders DROP COLUMN copy_json');
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
    const orderColumns = upgraded
      .prepare('PRAGMA table_info(orders)')
      .all()
      .map((column) => column.name);
    assert.ok(orderColumns.includes('brief'), 'version 3 adds orders.brief');
    assert.ok(orderColumns.includes('copy_json'), 'version 3 adds orders.copy_json');
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

// ---------------------------------------------------------------------------
// Brochure copy generation and rendering
// ---------------------------------------------------------------------------

const BROCHURE_COPY = {
  headline: 'Room for the calm to settle',
  body:
    'The bedroom had the wall and not much else, so this wardrobe takes the full run and leaves the floor clear. ' +
    'Three shutters open on soft close hinges, and the hanging section is deep enough for a full season of clothes. ' +
    'Warm wood on the outside keeps the light gentle, and the white interior makes the shelves easy to read when the doors are open. ' +
    'The drawers sit low, where the folded things go, and the handles are matte so the front stays quiet. ' +
    'It is a piece built to disappear into the room and let the calm do the rest.',
  closing: 'Measured for the room, made in Nagercoil.',
};
const COPY_BRIEF =
  'The customer wants a calm, uncluttered bedroom for two with plenty of hanging space and warm wood tones.';

test('order copy generation stores the copy and returns the three fields', async () => {
  resetLlmState();
  await configureLlm();
  resetMockProvider({ reply: JSON.stringify(BROCHURE_COPY) });

  const response = await postJson(`${baseUrl}/api/orders/${orderId}/copy`, { brief: COPY_BRIEF });
  const raw = await response.text();
  assert.equal(response.status, 200, raw);
  assert.equal(raw.includes(LLM_KEY), false, 'the key must never be returned');
  const body = JSON.parse(raw);
  assert.deepEqual(body.copy, BROCHURE_COPY);
  assert.equal(body.model, LLM_MODEL);
  assert.ok(Number.isInteger(body.latencyMs) && body.latencyMs >= 0);

  // The provider saw the order, the customer and the brief.
  assert.equal(mockProviderState.requests.length, 1);
  const request = lastProviderRequest();
  assert.equal(request.url, '/chat/completions');
  assert.equal(request.headers.authorization, `Bearer ${LLM_KEY}`);
  const prompt = request.json.messages.map((message) => message.content).join('\n');
  assert.ok(prompt.includes('Master Bedroom Wardrobe'), 'the prompt carries the order title');
  assert.ok(prompt.includes('Test Customer'), 'the prompt carries the customer name');
  assert.ok(prompt.includes(COPY_BRIEF), 'the prompt carries the brief text');
  assert.ok(prompt.includes('18 mm BWP plywood'), 'the prompt carries the materials');
  assert.ok(prompt.includes('2 mm PVC'), 'the prompt carries the edge band');
  assert.ok(prompt.includes('Matte black aluminium'), 'the prompt carries the handles');
  assert.ok(prompt.includes('Matte outside, white inside'), 'the prompt carries the finish');
  assert.match(prompt, /strict JSON/i);
  assert.match(prompt, /at most 56 characters/i);
  assert.match(prompt, /95 to 145 words/i);
  assert.match(prompt, /at most 80 characters/i);
  assert.match(prompt, /no em dashes or en dashes/i);
  assert.match(prompt, /British Indian English/i);
  assert.match(prompt, /Never invent/i);

  // Stored as JSON text on the order; the detail endpoint parses it.
  const storedRow = db.prepare('SELECT copy_json FROM orders WHERE id = ?').get(orderId);
  assert.deepEqual(JSON.parse(storedRow.copy_json), BROCHURE_COPY);
  const detail = await (await fetch(`${baseUrl}/api/orders/${orderId}`)).json();
  assert.equal(detail.brief, COPY_BRIEF);
  assert.deepEqual(detail.copy, BROCHURE_COPY);
  assert.equal(Object.hasOwn(detail, 'copy_json'), false, 'the raw column is not exposed');

  // Lists carry the brief but stay small by omitting the copy.
  const list = await (await fetch(`${baseUrl}/api/orders`)).json();
  const listed = list.find((entry) => entry.id === orderId);
  assert.equal(listed.brief, COPY_BRIEF);
  assert.equal('copy' in listed, false, 'lists omit the generated copy');

  // The response is valid with an empty body as well (all fields optional).
  resetMockProvider({ reply: JSON.stringify(BROCHURE_COPY) });
  const emptyBody = await fetch(`${baseUrl}/api/orders/${orderId}/copy`, { method: 'POST' });
  assert.equal(emptyBody.status, 200);
  assert.deepEqual((await emptyBody.json()).copy, BROCHURE_COPY);
});

test('a thin model reply triggers one repair pass and still returns a document', async () => {
  resetLlmState();
  await configureLlm();
  const thin = {
    headline: 'Room to breathe',
    body: 'A short body that leaves too much unsaid for a printed page.',
    closing: 'Made for the room.'
  };
  resetMockProvider({ reply: JSON.stringify(thin) });

  const response = await postJson(`${baseUrl}/api/orders/${orderId}/copy`, { brief: COPY_BRIEF });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.copy.headline, thin.headline);
  assert.equal(mockProviderState.requests.length, 2, 'one original request and one repair');
  const repair = lastProviderRequest();
  const repairPrompt = repair.json.messages.map((message) => message.content).join('\n');
  assert.match(repairPrompt, /body too short/i);
  assert.match(repairPrompt, /90 to 150 words/);
});

test('order copy parses a fenced JSON reply with prose around it', async () => {
  resetLlmState();
  await configureLlm();
  resetMockProvider({
    reply:
      'Here is the brochure copy you asked for:\n```json\n' +
      JSON.stringify(BROCHURE_COPY) +
      '\n```\nLet me know if you need a different tone.',
  });

  const response = await postJson(`${baseUrl}/api/orders/${orderId}/copy`, { brief: COPY_BRIEF });
  const raw = await response.text();
  assert.equal(response.status, 200, raw);
  assert.deepEqual(JSON.parse(raw).copy, BROCHURE_COPY);
});

test('order copy returns a readable 502 when the model reply can not be read', async () => {
  resetLlmState();
  await configureLlm();

  const created = await postJson(`${baseUrl}/api/orders`, {
    ...DEMO_ORDER,
    title: 'Copy Failure Wardrobe',
    customerId,
  });
  assert.equal(created.status, 201);
  const failureOrder = await created.json();
  assert.equal(failureOrder.copy, null);

  resetMockProvider({ reply: 'Sure! Here is the brochure copy in a nice tone.' });
  const response = await postJson(`${baseUrl}/api/orders/${failureOrder.id}/copy`, {});
  const raw = await response.text();
  assert.equal(response.status, 502, raw);
  assert.equal(raw.includes(LLM_KEY), false);
  assert.equal(raw.toLowerCase().includes('stack'), false, 'no stack trace may be returned');
  const body = JSON.parse(raw);
  assert.equal(body.ok, false);
  assert.match(body.error.message, /could not be read/i);
  assert.equal(body.error.type, 'invalid_reply');

  const detail = await (await fetch(`${baseUrl}/api/orders/${failureOrder.id}`)).json();
  assert.equal(detail.copy, null, 'a failed generation must not store a copy');
});

test('orders accept a brief on create and update and cap it at 2000 characters', async () => {
  const created = await postJson(`${baseUrl}/api/orders`, {
    ...DEMO_ORDER,
    title: 'Brief Wardrobe',
    customerId,
    brief: 'Customer wants warm wood tones and a quiet finish.',
  });
  assert.equal(created.status, 201);
  const order = await created.json();
  assert.equal(order.brief, 'Customer wants warm wood tones and a quiet finish.');
  assert.equal(order.copy, null);

  const patched = await fetch(`${baseUrl}/api/orders/${order.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ brief: 'Updated after the site visit: more drawers on the left.' }),
  });
  assert.equal(patched.status, 200);
  assert.equal(
    (await patched.json()).brief,
    'Updated after the site visit: more drawers on the left.',
  );

  const tooLongCreate = await postJson(`${baseUrl}/api/orders`, {
    ...DEMO_ORDER,
    title: 'Brief Too Long',
    customerId,
    brief: 'x'.repeat(2001),
  });
  assert.equal(tooLongCreate.status, 400);
  const tooLongCreateBody = await tooLongCreate.json();
  assert.match(tooLongCreateBody.error, /brief/i);
  assert.match(tooLongCreateBody.error, /2000/);

  const tooLongCopy = await postJson(`${baseUrl}/api/orders/${orderId}/copy`, {
    brief: 'x'.repeat(2001),
  });
  assert.equal(tooLongCopy.status, 400);
  const tooLongCopyBody = await tooLongCopy.json();
  assert.match(tooLongCopyBody.error, /brief/i);
  assert.match(tooLongCopyBody.error, /2000/);
});

test('order copy answers 400 without a provider and 404 for an unknown order', async () => {
  resetLlmState();
  resetMockProvider();

  const missing = await postJson(`${baseUrl}/api/orders/does-not-exist/copy`, {});
  assert.equal(missing.status, 404);

  const unconfigured = await postJson(`${baseUrl}/api/orders/${orderId}/copy`, {});
  assert.equal(unconfigured.status, 400);
  assert.match((await unconfigured.json()).error, /configure/i);
  assert.equal(mockProviderState.requests.length, 0, 'no provider call without configuration');
});

test('the api key never appears in any copy response', async () => {
  resetLlmState();
  await configureLlm();
  const bodies = [];

  resetMockProvider({ reply: JSON.stringify(BROCHURE_COPY) });
  bodies.push(await (await postJson(`${baseUrl}/api/orders/${orderId}/copy`, { brief: COPY_BRIEF })).text());
  bodies.push(await (await fetch(`${baseUrl}/api/llm/settings`)).text());
  bodies.push(await (await fetch(`${baseUrl}/api/orders/${orderId}`)).text());
  bodies.push(await (await fetch(`${baseUrl}/api/orders`)).text());

  resetMockProvider({ reply: 'not a json reply' });
  bodies.push(await (await postJson(`${baseUrl}/api/orders/${orderId}/copy`, {})).text());
  bodies.push(
    await (await postJson(`${baseUrl}/api/orders/${orderId}/copy`, { brief: 'x'.repeat(2001) })).text(),
  );

  for (const body of bodies) {
    assert.equal(body.includes(LLM_KEY), false, 'no copy related response may contain the key');
  }
});

test('a voucher prints the generated copy and still renders without one', { timeout: 240_000 }, async () => {
  resetLlmState();
  await configureLlm();
  resetMockProvider({ reply: JSON.stringify(BROCHURE_COPY) });
  const generated = await postJson(`${baseUrl}/api/orders/${orderId}/copy`, { brief: COPY_BRIEF });
  assert.equal(generated.status, 200);

  const withCopy = await postJson(`${baseUrl}/api/orders/${orderId}/render`, { kind: 'voucher' });
  const withCopyRaw = await withCopy.text();
  assert.equal(withCopy.status, 201, withCopyRaw);
  const render = JSON.parse(withCopyRaw);
  assert.equal(render.pageCount, 4);
  const copiedText = normaliseText(pdfText(path.join(dataDir, 'renders', `${render.id}.pdf`))).toLowerCase();
  assert.ok(
    copiedText.includes(BROCHURE_COPY.headline.toLowerCase()),
    'the generated headline must be printed in the PDF',
  );
  assert.ok(
    copiedText.includes('the white interior makes the shelves easy to read'),
    'the generated body must be printed in the PDF',
  );
  assert.ok(
    copiedText.includes(BROCHURE_COPY.closing.toLowerCase()),
    'the generated closing must be printed in the PDF',
  );
  assert.equal(copiedText.includes('{{'), false, 'no placeholder may reach the PDF');

  // An order with no generated copy still renders the same four page document,
  // with the copy block empty.
  const created = await postJson(`${baseUrl}/api/orders`, {
    ...DEMO_ORDER,
    title: 'No Copy Wardrobe',
    customerId,
    attachments: FIXTURE_ROOM_FILES,
  });
  assert.equal(created.status, 201);
  const noCopyOrder = await created.json();
  assert.equal(noCopyOrder.copy, null);
  const withoutCopy = await postJson(`${baseUrl}/api/orders/${noCopyOrder.id}/render`, {
    kind: 'voucher',
  });
  const withoutCopyRaw = await withoutCopy.text();
  assert.equal(withoutCopy.status, 201, withoutCopyRaw);
  const plainRender = JSON.parse(withoutCopyRaw);
  assert.equal(plainRender.pageCount, 4);
  assert.equal(
    normaliseText(pdfText(path.join(dataDir, 'renders', `${plainRender.id}.pdf`)))
      .toLowerCase()
      .includes('planned around the whole room'),
    false,
  );
});

test('a malformed copy_json is ignored by a render instead of failing it', { timeout: 240_000 }, async () => {
  const created = await postJson(`${baseUrl}/api/orders`, {
    ...DEMO_ORDER,
    title: 'Malformed Copy Wardrobe',
    customerId,
    attachments: FIXTURE_ROOM_FILES,
  });
  assert.equal(created.status, 201);
  const order = await created.json();
  db.prepare('UPDATE orders SET copy_json = ? WHERE id = ?').run('{not valid json', order.id);

  const response = await postJson(`${baseUrl}/api/orders/${order.id}/render`, { kind: 'voucher' });
  const raw = await response.text();
  assert.equal(response.status, 201, raw);
  const render = JSON.parse(raw);
  assert.equal(render.pageCount, 4);

  // The malformed value never surfaces on the API either.
  const detail = await (await fetch(`${baseUrl}/api/orders/${order.id}`)).json();
  assert.equal(detail.copy, null);
});

test('a version 2 database upgrades in place and keeps its settings', () => {
  const upgradeDir = path.join(tempDir, 'upgrade-v2-data');
  mkdirSync(upgradeDir, { recursive: true });
  const upgradePath = path.join(upgradeDir, 'upgrade-v2.db');

  const fresh = openDb(upgradePath);
  let orderIdV2;
  try {
    const customer = createCustomer(fresh, { name: 'Version Two Customer' });
    orderIdV2 = createOrder(fresh, {
      customerId: customer.id,
      title: 'Version Two Wardrobe',
      room: 'Guest bedroom',
      width: '1800 mm',
      height: '2100 mm',
      depth: '600 mm',
      shutters: '2',
      brief: 'Old brief',
    }).id;
    setSetting(fresh, 'llm_model', 'kept-model');
    // Simulate the version 2 release: settings exist, orders have no brief or
    // copy_json columns yet.
    fresh.exec('ALTER TABLE orders DROP COLUMN brief');
    fresh.exec('ALTER TABLE orders DROP COLUMN copy_json');
    fresh.exec('PRAGMA user_version = 2');
  } finally {
    fresh.close();
  }

  const upgraded = openDb(upgradePath);
  try {
    assert.equal(Number(upgraded.prepare('PRAGMA user_version').get().user_version), SCHEMA_VERSION);
    const orderColumns = upgraded
      .prepare('PRAGMA table_info(orders)')
      .all()
      .map((column) => column.name);
    assert.ok(orderColumns.includes('brief'), 'migration 3 adds orders.brief');
    assert.ok(orderColumns.includes('copy_json'), 'migration 3 adds orders.copy_json');
    assert.equal(getSetting(upgraded, 'llm_model')?.value, 'kept-model', 'settings survive');
    assert.equal(
      upgraded.prepare('SELECT COUNT(*) AS count FROM customers').get().count,
      1,
      'existing rows survive',
    );
    const order = upgraded.prepare('SELECT brief, copy_json FROM orders WHERE id = ?').get(orderIdV2);
    assert.equal(order.brief, '', 'the new column starts on its default');
    assert.equal(order.copy_json, null);
  } finally {
    upgraded.close();
    rmSync(upgradeDir, { recursive: true, force: true });
  }
});

test('orders without materials fall back to the house specification', { timeout: 90_000 }, async () => {
  const response = await postJson(`${baseUrl}/api/orders`, {
    customerId,
    title: 'Minimal Wardrobe',
    room: 'Study',
    width: '2000 mm',
    height: '2100 mm',
    depth: '600 mm',
    shutters: '2',
    attachments: FIXTURE_ROOM_FILES,
  });
  assert.equal(response.status, 201);
  const order = await response.json();
  assert.equal(order.carcass, '18 mm BWP plywood');
  assert.equal(order.backPanel, '6 mm plywood');
  assert.equal(order.interior, '0.8 mm white laminate');
  assert.equal(order.handle, 'Matte black aluminium');
  assert.equal(order.finishInt, 'No painting');

  const cleared = await fetch(`${baseUrl}/api/orders/${order.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ carcass: '   ' }),
  });
  assert.equal(cleared.status, 200);
  assert.equal((await cleared.json()).carcass, '18 mm BWP plywood');

  const rendered = await postJson(`${baseUrl}/api/orders/${order.id}/render`, { kind: 'voucher' });
  assert.equal(rendered.status, 201);
  const render = await rendered.json();
  assert.equal(render.pageCount, 4);

  const pdf = Buffer.from(await (await fetch(`${baseUrl}${render.pdfUrl}`)).arrayBuffer());
  const file = path.join(tempDir, 'minimal.pdf');
  writeFileSync(file, pdf);
  const text = execFileSync('pdftotext', [file, '-'], { encoding: 'utf8' }).replace(/\s+/g, ' ');
  assert.match(text, /18 mm BWP plywood/);
  assert.match(text, /Matte black aluminium/);
  assert.match(text, /0.8 mm white laminate/);
});

test('brochure copy renders when supplied and disappears when empty', { timeout: 300_000 }, async () => {
  const headline = 'Built around your morning routine, measured and finished by hand';
  const bodyStart =
    'The wardrobe is built in our Nagercoil workshop from eighteen millimetre BWP plywood, cut on a CNC nesting bed and edge banded by hand. ' +
    'The same hands that milled the plywood fit every hinge, adjust every channel and finish every edge before the wardrobe leaves the bench. ';
  let body = bodyStart;
  while (body.length < 1000) body += 'Extra care is taken at every stage of the build. ';
  body = body.slice(0, 1000).replace(/[^A-Za-z.]$/, '.');
  const closing =
    'Every wardrobe leaves our workshop measured twice, finished by hand and fitted by the same team that built it.';
  assert.equal(body.length, 1000, 'the maximum body length is exercised');
  assert.ok(body.includes('The same hands that milled the plywood fit every hinge'));

  const renderPdf = async (templateId) => {
    const response = await postJson(`${baseUrl}/api/orders/${orderId}/render`, {
      kind: 'voucher',
      templateId,
    });
    const raw = await response.text();
    assert.equal(response.status, 201, raw);
    const render = JSON.parse(raw);
    assert.equal(render.pageCount, 4);
    return pdfText(path.join(dataDir, 'renders', `${render.id}.pdf`));
  };
  const families = ['atelier-copper', 'gallery-sand', 'swiss-ink'];

  setOrderCopy(db, orderId, { headline, body, closing });
  try {
    for (const templateId of families) {
      const text = await renderPdf(templateId);
      const pages = text.split('\f');
      const flat = normaliseText(text);
      assert.ok(flat.includes(headline), `${templateId} should carry the headline`);
      assert.ok(
        flat.includes('The same hands that milled the plywood fit every hinge'),
        `${templateId} should carry the body`,
      );
      assert.ok(flat.includes(closing), `${templateId} should carry the closing`);
      assert.ok(
        normaliseText(pages[0]).includes(headline),
        `${templateId} headline belongs on the cover`,
      );
      assert.ok(
        normaliseText(pages[3]).includes(closing),
        `${templateId} closing belongs on the last page`,
      );
      assert.ok(!flat.includes('{{'), `${templateId} should not leak a placeholder`);
    }
  } finally {
    setOrderCopy(db, orderId, null);
  }

  for (const templateId of families) {
    const text = await renderPdf(templateId);
    const flat = normaliseText(text);
    assert.equal(flat.includes(headline), false, `${templateId} headline must vanish with no copy`);
    assert.equal(flat.includes(closing), false, `${templateId} closing must vanish with no copy`);
    assert.equal(
      flat.includes('The same hands that milled the plywood fit every hinge'),
      false,
      `${templateId} body must vanish with no copy`,
    );
    assert.ok(!flat.includes('{{'), `${templateId} should not leak a placeholder`);
  }
});

// ---------------------------------------------------------------------------
// Trade rate card
// ---------------------------------------------------------------------------

test('materials keep a trade rate, unit and SKU through POST, GET, PATCH and bootstrap', async () => {
  const created = await postJson(`${baseUrl}/api/materials`, {
    name: 'Matte Oak',
    kind: 'laminate',
    hex: '#8B6F47',
    imageUrl: '/media/tex-band.jpg',
    priceAmount: 1450.5,
    priceUnit: 'sheet',
    sku: 'GW-OAK-08',
  });
  assert.equal(created.status, 201);
  const material = await created.json();
  assert.equal(material.priceAmount, 1450.5);
  assert.equal(material.priceUnit, 'sheet');
  assert.equal(material.sku, 'GW-OAK-08');

  const listed = await (await fetch(`${baseUrl}/api/materials`)).json();
  const fromList = listed.find((entry) => entry.id === material.id);
  assert.ok(fromList, 'GET /api/materials should include the new material');
  assert.equal(fromList.priceAmount, 1450.5);
  assert.equal(fromList.priceUnit, 'sheet');
  assert.equal(fromList.sku, 'GW-OAK-08');

  const fetched = await (await fetch(`${baseUrl}/api/materials/${material.id}`)).json();
  assert.equal(fetched.priceAmount, 1450.5);
  assert.equal(fetched.priceUnit, 'sheet');
  assert.equal(fetched.sku, 'GW-OAK-08');

  const bootstrap = await (await fetch(`${baseUrl}/api/bootstrap`)).json();
  const fromBootstrap = bootstrap.materials.find((entry) => entry.id === material.id);
  assert.ok(fromBootstrap, 'bootstrap should include the new material');
  assert.equal(fromBootstrap.priceAmount, 1450.5);
  assert.equal(fromBootstrap.sku, 'GW-OAK-08');

  const patchedResponse = await fetch(`${baseUrl}/api/materials/${material.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ priceAmount: 1500, priceUnit: 'panel', sku: 'GW-OAK-09' }),
  });
  assert.equal(patchedResponse.status, 200);
  const patched = await patchedResponse.json();
  assert.equal(patched.priceAmount, 1500);
  assert.equal(patched.priceUnit, 'panel');
  assert.equal(patched.sku, 'GW-OAK-09');
  assert.equal(patched.name, 'Matte Oak', 'PATCH must leave untouched fields alone');

  // A material without trade fields still stores the zero defaults.
  const blank = await postJson(`${baseUrl}/api/materials`, {
    name: 'Sample Board',
    kind: 'sample',
    hex: '#CCBBAA',
  });
  assert.equal(blank.status, 201);
  const blankMaterial = await blank.json();
  assert.equal(blankMaterial.priceAmount, 0);
  assert.equal(blankMaterial.priceUnit, '');
  assert.equal(blankMaterial.sku, '');

  // The snake_case column spelling is accepted too for scripts.
  const snake = await postJson(`${baseUrl}/api/materials`, {
    name: 'Snake Case Board',
    kind: 'sample',
    hex: '#BBAA99',
    price_amount: 12.5,
    price_unit: 'metre',
    sku: 'GW-SNK-01',
  });
  assert.equal(snake.status, 201);
  const snakeMaterial = await snake.json();
  assert.equal(snakeMaterial.priceAmount, 12.5);
  assert.equal(snakeMaterial.priceUnit, 'metre');
});

test('material prices reject bad values without saving anything', async () => {
  const cases = [
    { priceAmount: -1, field: 'priceAmount' },
    { priceAmount: '1240', field: 'priceAmount' },
    { priceAmount: Number.POSITIVE_INFINITY, field: 'priceAmount' },
    { priceUnit: 'x'.repeat(21), field: 'priceUnit' },
    { sku: 'x'.repeat(41), field: 'sku' },
  ];
  for (const invalid of cases) {
    const body = { name: 'Invalid Rate', kind: 'laminate', hex: '#123456' };
    const field = invalid.field;
    body[field] = invalid[field];
    // JSON can not carry Infinity, so send a raw body for that case.
    const payload =
      invalid.priceAmount === Number.POSITIVE_INFINITY
        ? '{"name":"Invalid Rate","kind":"laminate","hex":"#123456","priceAmount":1e999}'
        : JSON.stringify(body);
    const response = await fetch(`${baseUrl}/api/materials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    });
    assert.equal(response.status, 400, `${field} should be rejected`);
    const error = (await response.json()).error;
    assert.match(error, new RegExp(field, 'i'));
  }

  const before = (await (await fetch(`${baseUrl}/api/materials`)).json()).length;
  const invalidPatch = await fetch(`${baseUrl}/api/materials/${orderId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ priceAmount: -5 }),
  });
  assert.equal(invalidPatch.status, 404, 'a bad id is a not found even for price patches');

  const materials = await (await fetch(`${baseUrl}/api/materials`)).json();
  assert.equal(materials.length, before, 'a rejected material must not be stored');
  const first = materials[0];
  const badAmount = await fetch(`${baseUrl}/api/materials/${first.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ priceAmount: -5 }),
  });
  assert.equal(badAmount.status, 400);
  assert.match((await badAmount.json()).error, /priceAmount/i);
  const badUnit = await fetch(`${baseUrl}/api/materials/${first.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ priceUnit: 'x'.repeat(21) }),
  });
  assert.equal(badUnit.status, 400);
  assert.match((await badUnit.json()).error, /priceUnit/i);
  const badSku = await fetch(`${baseUrl}/api/materials/${first.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sku: 'x'.repeat(41) }),
  });
  assert.equal(badSku.status, 400);
  assert.match((await badSku.json()).error, /sku/i);
});

test('the catalogue rate card renders its variants from the material rates', { timeout: 300_000 }, async () => {
  const catalogResponse = await fetch(`${baseUrl}/api/catalogue/templates`);
  assert.equal(catalogResponse.status, 200);
  const catalog = await catalogResponse.json();
  assert.equal(catalog.length, 3);
  assert.deepEqual(
    catalog.map((entry) => entry.id),
    ['rate-card-ledger', 'rate-card-grid', 'rate-card-tags'],
  );
  for (const entry of catalog) {
    assert.ok(entry.name);
    assert.ok(['copper', 'ink', 'olive'].includes(entry.palette));
  }

  // No body: the first variant is the default.
  const response = await postJson(`${baseUrl}/api/catalogue/render`, {});
  assert.equal(response.status, 201);
  const render = await response.json();
  assert.equal(render.kind, 'catalogue');
  assert.equal(render.orderId, null);
  assert.equal(render.templateId, 'rate-card-ledger');
  assert.ok(render.pageCount >= 1 && render.pageCount <= 2);
  assert.equal(render.pageUrls.length, render.pageCount);

  const pdfPath = path.join(dataDir, 'renders', `${render.id}.pdf`);
  assert.ok(existsSync(pdfPath), 'the rate card PDF should exist');
  assert.ok(statSync(pdfPath).size > 10 * 1024);
  const text = pdfText(pdfPath);
  assert.ok(text.includes('Dark Walnut'), 'the rate card should list seeded materials');
  assert.match(text, /1,?240/, 'the rate card should show the seeded walnut rate');
  assert.match(text, /GST/i, 'the GST note belongs on the rate card');
  assert.ok(text.includes('SKU'));
  assert.ok(text.includes('GW-WAL-06'));

  const pdfResponse = await fetch(`${baseUrl}${render.pdfUrl}`);
  assert.equal(pdfResponse.status, 200);
  assert.match(pdfResponse.headers.get('content-type') ?? '', /application\/pdf/);
  const pageResponse = await fetch(`${baseUrl}${render.pageUrls[0]}`);
  assert.equal(pageResponse.status, 200);
  assert.match(pageResponse.headers.get('content-type') ?? '', /image\/png/);

  for (const entry of catalog) {
    const variantResponse = await postJson(`${baseUrl}/api/catalogue/render`, {
      templateId: entry.id,
    });
    const variantRaw = await variantResponse.text();
    assert.equal(variantResponse.status, 201, variantRaw);
    const variantRender = JSON.parse(variantRaw);
    assert.equal(variantRender.templateId, entry.id);
    assert.equal(variantRender.kind, 'catalogue');
    assert.ok(variantRender.pageCount >= 1 && variantRender.pageCount <= 2);
    const variantText = pdfText(path.join(dataDir, 'renders', `${variantRender.id}.pdf`));
    assert.ok(variantText.includes('Dark Walnut'), `${entry.id} should list the seeded materials`);
    assert.match(variantText, /1,?240/, `${entry.id} should show the seeded rate`);
    assert.match(variantText, /GST/i, `${entry.id} should note GST`);
  }
});

test('an unknown catalogue templateId is rejected without writing a render', async () => {
  const before = (await (await fetch(`${baseUrl}/api/renders`)).json()).length;
  const response = await postJson(`${baseUrl}/api/catalogue/render`, {
    templateId: 'not-a-rate-card',
  });
  assert.equal(response.status, 400);
  const error = (await response.json()).error;
  assert.match(error, /Unknown templateId/i);
  assert.match(error, /not-a-rate-card/);
  const after = (await (await fetch(`${baseUrl}/api/renders`)).json()).length;
  assert.equal(after, before, 'a rejected catalogue template must not create a render');
});

test('the catalogue render fails when a placeholder is unfilled', async () => {
  const brokenRoot = path.join(tempDir, 'broken-catalogue');
  const brokenCatalogueDir = path.join(brokenRoot, 'catalogue');
  mkdirSync(brokenCatalogueDir, { recursive: true });
  const template = readFileSync(
    path.join(templatesDir, 'catalogue', 'rate-card.html'),
    'utf8',
  );
  writeFileSync(
    path.join(brokenCatalogueDir, 'rate-card.html'),
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
      `http://127.0.0.1:${started.port}/api/catalogue/render`,
      {},
    );
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.match(body.error, /Unfilled placeholder/);
    assert.match(body.error, /neverProvided/);
    const after = (await (await fetch(`${baseUrl}/api/renders`)).json()).length;
    assert.equal(after, before, 'a failed catalogue render must not be recorded');
    assert.equal(
      readdirSync(brokenCatalogueDir).filter((name) => name.startsWith('built-')).length,
      0,
      'a failed catalogue render must clean up the built HTML',
    );
  } finally {
    await stopServer({ server: started.server });
  }
});


test('openCode endpoints get a routing session header, other providers do not', async () => {
  const goHeaders = providerHeaders('https://opencode.ai/zen/go/v1', 'secret-key');
  assert.match(goHeaders['x-opencode-session'], /^studio-[0-9a-f-]{36}$/);
  assert.equal(goHeaders.Authorization, 'Bearer secret-key');
  assert.equal(goHeaders['Content-Type'], 'application/json');

  const second = providerHeaders('https://opencode.ai/zen/go/v1', 'secret-key');
  assert.equal(second['x-opencode-session'], goHeaders['x-opencode-session'], 'session stays stable');

  for (const endpoint of ['http://127.0.0.1:9999/v1', 'https://api.openai.com/v1', 'not a url']) {
    const headers = providerHeaders(endpoint, 'secret-key');
    assert.equal(headers['x-opencode-session'], undefined, `no session header for ${endpoint}`);
    assert.equal(headers.Authorization, 'Bearer secret-key');
  }
});


test('openCode providers are asked for direct answers, other providers get a plain body', async () => {
  assert.deepEqual(providerBodyExtras('https://opencode.ai/zen/go/v1'), { reasoning_effort: 'none' });
  assert.deepEqual(providerBodyExtras('https://opencode.ai/zen/v1'), { reasoning_effort: 'none' });
  assert.deepEqual(providerBodyExtras('https://api.openai.com/v1'), {});
  assert.deepEqual(providerBodyExtras('http://127.0.0.1:9999/v1'), {});
  assert.deepEqual(providerBodyExtras('not a url'), {});
});


test('copy quality gate catches thin bodies and internal paperwork talk', async () => {
  const good = {
    headline: 'Loft above for the winter bedding',
    body: Array.from({ length: 110 }, (_, index) => `word${index}`).join(' '),
    closing: 'Drawn to the wall it stands against.'
  };
  assert.deepEqual(copyQualityIssues(good), []);

  const thin = copyQualityIssues({ ...good, body: 'Too short a body for a brochure page.' });
  assert.equal(thin.length, 1);
  assert.match(thin[0], /too short/);

  const meta = copyQualityIssues({ ...good, body: `${good.body} the specification lists the rest` });
  assert.equal(meta.length, 1);
  assert.match(meta[0], /paperwork/);

  const carcassOrder = { carcass: '18 mm BWP plywood', backPanel: '6 mm plywood' };
  const carcass = copyQualityIssues(
    { ...good, body: `${good.body} The carcass is 18 mm BWP plywood.` },
    carcassOrder
  );
  assert.ok(carcass.some((issue) => /carcass/.test(issue)));

  const hyped = copyQualityIssues({
    ...good,
    body: `${good.body} The premium finish feels luxurious in the room.`
  });
  assert.ok(hyped.some((issue) => /marketing cliché/.test(issue)), 'hype words are rejected');

  const selling = copyQualityIssues({
    ...good,
    body: `${good.body} You will love how your wardrobe looks.`
  });
  assert.ok(selling.some((issue) => /addresses the reader/.test(issue)), 'second person is rejected');

  const repeated = copyQualityIssues({
    ...good,
    body: `${good.body} It keeps the grain calm and keeps the edge neat.`
  });
  assert.equal(repeated.length, 1);
  assert.match(repeated[0], /repeats "keeps"/);

  const order = { ...DEMO_ORDER, customerName: 'Anitha Selvam' };
  const repaired = buildCopyRepairMessages(order, 'loft and lighter oak', { ...good, body: 'short' }, ['body too short (3 words)']);
  assert.equal(repaired.at(-1).role, 'user');
  assert.match(repaired.at(-1).content, /body too short/);
  assert.match(repaired.at(-1).content, /90 to 150 words/);
});


test('a repeated copy request is served from the model cache', async () => {
  resetLlmState();
  await configureLlm();
  resetMockProvider({ reply: JSON.stringify(BROCHURE_COPY) });

  const first = await postJson(`${baseUrl}/api/orders/${orderId}/copy`, { brief: COPY_BRIEF });
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.equal(firstBody.cached, false);
  const requestsAfterFirst = mockProviderState.requests.length;
  assert.ok(requestsAfterFirst >= 1);

  const second = await postJson(`${baseUrl}/api/orders/${orderId}/copy`, { brief: COPY_BRIEF });
  assert.equal(second.status, 200);
  const secondBody = await second.json();
  assert.equal(secondBody.cached, true, 'the second identical request comes from the cache');
  assert.equal(secondBody.latencyMs, 0);
  assert.deepEqual(secondBody.copy, firstBody.copy);
  assert.equal(
    mockProviderState.requests.length,
    requestsAfterFirst,
    'a cache hit must not call the provider',
  );
});

test('regenerate bypasses the model cache', async () => {
  resetLlmState();
  await configureLlm();
  resetMockProvider({ reply: JSON.stringify(BROCHURE_COPY) });
  const before = mockProviderState.requests.length;

  await postJson(`${baseUrl}/api/orders/${orderId}/copy`, { brief: COPY_BRIEF });
  const regenerated = await postJson(`${baseUrl}/api/orders/${orderId}/copy`, {
    brief: COPY_BRIEF,
    regenerate: true,
  });
  assert.equal(regenerated.status, 200);
  const body = await regenerated.json();
  assert.equal(body.cached, false);
  assert.equal(mockProviderState.requests.length, before + 2);

  // The regenerated copy replaces the cached one, so the next plain request is
  // served from cache with the new words and no extra provider call.
  const afterRegenerate = await postJson(`${baseUrl}/api/orders/${orderId}/copy`, { brief: COPY_BRIEF });
  const cachedAgain = await afterRegenerate.json();
  assert.equal(cachedAgain.cached, true);
  assert.deepEqual(cachedAgain.copy, body.copy);
  assert.equal(mockProviderState.requests.length, before + 2);
});

test('a different brief misses the model cache', async () => {
  resetLlmState();
  await configureLlm();
  resetMockProvider({ reply: JSON.stringify(BROCHURE_COPY) });
  const before = mockProviderState.requests.length;

  await postJson(`${baseUrl}/api/orders/${orderId}/copy`, { brief: 'Brief one, calm bedroom.' });
  const second = await postJson(`${baseUrl}/api/orders/${orderId}/copy`, { brief: 'Brief two, more hanging.' });
  assert.equal(second.status, 200);
  assert.equal((await second.json()).cached, false);
  assert.equal(mockProviderState.requests.length, before + 2);
});

test('the model cache exposes stats and can be purged', async () => {
  resetLlmState();
  await configureLlm();
  resetMockProvider({ reply: JSON.stringify(BROCHURE_COPY) });
  await postJson(`${baseUrl}/api/orders/${orderId}/copy`, { brief: COPY_BRIEF });
  await postJson(`${baseUrl}/api/orders/${orderId}/copy`, { brief: COPY_BRIEF });

  const stats = await (await fetch(`${baseUrl}/api/llm/cache/stats`)).json();
  assert.equal(stats.enabled, true);
  assert.ok(stats.entries >= 1);
  assert.ok(stats.hits >= 1);

  const purged = await (await fetch(`${baseUrl}/api/llm/cache/purge`, { method: 'POST' })).json();
  assert.ok(purged.deleted >= 1);
  const after = await (await fetch(`${baseUrl}/api/llm/cache/stats`)).json();
  assert.equal(after.entries, 0);
});

test('an expired cache entry is ignored and replaced', async () => {
  resetLlmState();
  await configureLlm();
  resetMockProvider({ reply: JSON.stringify(BROCHURE_COPY) });

  // Seed an entry that has aged out, keyed exactly like the real request.
  const messages = buildCopyMessages(
    getOrder(db, orderId),
    COPY_BRIEF,
  );
  const key = buildLlmCacheKey({ endpoint: mockProviderUrl, model: LLM_MODEL, messages });
  const staleCopy = { headline: 'Stale headline', body: 'stale body', closing: 'stale closing' };
  putLlmCache(db, {
    key,
    endpoint: mockProviderUrl,
    model: LLM_MODEL,
    responseJson: JSON.stringify({ copy: staleCopy, model: LLM_MODEL }),
  });
  db.prepare('UPDATE llm_cache SET created_at = ? WHERE key = ?').run(
    '2000-01-01T00:00:00.000Z',
    key,
  );
  // Move the brief used above to the one the request will send.
  db.prepare('UPDATE orders SET brief = ? WHERE id = ?').run(COPY_BRIEF, orderId);

  const before = mockProviderState.requests.length;
  const response = await postJson(`${baseUrl}/api/orders/${orderId}/copy`, { brief: COPY_BRIEF });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.cached, false, 'an expired entry must not be served');
  assert.notEqual(body.copy.headline, 'Stale headline');
  assert.equal(mockProviderState.requests.length, before + 1);
});

test('cache keys are stable and change with the brief or model', async () => {
  const messages = [
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: 'order one' },
  ];
  const base = { endpoint: 'https://opencode.ai/zen/go/v1', model: 'deepseek-v4.1-flash', messages };
  const key = buildLlmCacheKey(base);
  assert.equal(key.length, 64);
  assert.equal(buildLlmCacheKey(base), key, 'the same request hashes the same');
  assert.notEqual(
    buildLlmCacheKey({ ...base, messages: [{ role: 'system', content: 'system prompt' }, { role: 'user', content: 'order two' }] }),
    key,
  );
  assert.notEqual(buildLlmCacheKey({ ...base, model: 'another-model' }), key);
  assert.notEqual(buildLlmCacheKey({ ...base, endpoint: 'https://api.openai.com/v1' }), key);
  assert.ok(cacheExpiryCutoff(1) < new Date().toISOString());
  assert.equal(cacheExpiryCutoff(0), null);
});


test('conversational intake extracts an order and reports what is still missing', async () => {
  resetLlmState();
  await configureLlm();
  resetMockProvider({
    reply: JSON.stringify({
      reply: 'Noted, a wardrobe for Anitha. Which room is it for?',
      order: {
        customerName: 'Anitha Selvam',
        title: 'Master Bedroom Wardrobe',
        width: '2400 mm',
        budget: 'under one lakh',
        randomField: 'drop me',
      },
      ready: true,
    }),
  });

  const response = await postJson(`${baseUrl}/api/intake`, {
    messages: [
      {
        role: 'user',
        content:
          'Need a wardrobe for Anitha in the master bedroom, 2400 wide and 600 deep. Budget under one lakh.',
      },
    ],
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.draft.customerName, 'Anitha Selvam');
  assert.equal(body.draft.width, '2400 mm');
  assert.equal('budget' in body.draft, false, 'unknown fields are dropped');
  assert.equal('randomField' in body.draft, false, 'unknown fields are dropped');
  assert.equal(body.ready, false, 'the model cannot declare ready while essentials are missing');
  assert.ok(body.missing.includes('the room'));
  assert.match(body.reply, /room/i);
  assert.equal(JSON.stringify(body).includes(LLM_KEY), false);

  // A second turn supplies the gaps and merges with the draft.
  const firstDraft = body.draft;
  resetMockProvider({
    reply: JSON.stringify({
      reply: 'That is everything needed. The brochure can be made.',
      order: { room: 'Master bedroom' },
      ready: true,
    }),
  });
  const second = await postJson(`${baseUrl}/api/intake`, {
    messages: [
      { role: 'user', content: 'Need a wardrobe for Anitha in the master bedroom.' },
      { role: 'assistant', content: body.reply },
      { role: 'user', content: 'It is the master bedroom.' },
    ],
    draft: firstDraft,
  });
  assert.equal(second.status, 200);
  const merged = await second.json();
  assert.equal(merged.draft.width, '2400 mm', 'the earlier draft is kept');
  assert.equal(merged.draft.room, 'Master bedroom');
  assert.equal(merged.ready, true);
  assert.deepEqual(merged.missing, []);

  const prompt = lastProviderRequest().json.messages.map((message) => message.content).join('\n');
  assert.match(prompt, /2400 mm/, 'the current draft is sent back to the model');
});

test('conversational intake validates its input and failures', async () => {
  resetLlmState();
  const unconfigured = await postJson(`${baseUrl}/api/intake`, {
    messages: [{ role: 'user', content: 'A wardrobe please.' }],
  });
  assert.equal(unconfigured.status, 400);

  await configureLlm();
  const empty = await postJson(`${baseUrl}/api/intake`, { messages: [] });
  assert.equal(empty.status, 400);
  const missingContent = await postJson(`${baseUrl}/api/intake`, { messages: [{ role: 'user' }] });
  assert.equal(missingContent.status, 400);
  const tooLong = await postJson(`${baseUrl}/api/intake`, {
    messages: [{ role: 'user', content: 'x'.repeat(4001) }],
  });
  assert.equal(tooLong.status, 400);

  resetMockProvider({ reply: 'I could not read that.' });
  const unreadable = await postJson(`${baseUrl}/api/intake`, {
    messages: [{ role: 'user', content: 'A wardrobe please.' }],
  });
  assert.equal(unreadable.status, 502);
  const failure = await unreadable.json();
  assert.equal(failure.error.type, 'invalid_reply');
  assert.match(failure.error.message, /intake reply/i);
});


test('intake dimensions land in millimetres without guessing', async () => {
  assert.equal(normaliseDimension('2400'), '2400 mm');
  assert.equal(normaliseDimension('2400 mm'), '2400 mm');
  assert.equal(normaliseDimension('5 feet'), '1525 mm');
  assert.equal(normaliseDimension("5'"), '1525 mm');
  assert.equal(normaliseDimension("5'6\""), '1675 mm');
  assert.equal(normaliseDimension('60 inches'), '1525 mm');
  assert.equal(normaliseDimension('240 cm'), '2400 mm');
  assert.equal(normaliseDimension('about two feet'), 'about two feet', 'no arithmetic on words');
  assert.equal(normaliseFieldValue('shutters', '3 shutters'), '3');
  assert.equal(normaliseFieldValue('shutters', 'Three'), '3');
  assert.equal(normaliseFieldValue('shutters', 'sliding'), 'sliding');
});


test('the brief never carries money, dates or deadlines', async () => {
  assert.equal(scrubBrief('Mirror inside the door. Budget 45000.'), 'Mirror inside the door.');
  assert.equal(scrubBrief('Wants it before Deepavali. Lighter oak.'), 'Lighter oak.');
  assert.equal(scrubBrief('Keep under one lakh. Two locking drawers.'), 'Two locking drawers.');
  assert.equal(scrubBrief('Delivery by 15/12/2026. Sliding shutters.'), 'Sliding shutters.');
  assert.equal(scrubBrief('Loft on top and a mirror inside the door.'), 'Loft on top and a mirror inside the door.');
  assert.equal(scrubBrief('Budget 45000 only.'), '');
});


test('the copy gate catches a material thickness turned into a count', async () => {
  const order = {
    shutters: '3',
    drawers: '12 mm plywood',
    carcass: '18 mm BWP plywood',
    backPanel: '6 mm plywood',
  };
  const base = {
    headline: 'Cream shutters for the guest room wall',
    closing: 'Made for the room.',
  };
  const body = Array.from({ length: 100 }, (_, index) => `word${index}`).join(' ');

  const invented = copyQualityIssues(
    { ...base, body: `${body} Twelve drawers sit behind the shutters.` },
    order,
  );
  assert.ok(
    invented.some((issue) => /invents a count/.test(issue)),
    'twelve drawers from a 12 mm material must be flagged',
  );

  const honest = copyQualityIssues(
    { ...base, body: `${body} Three shutters close over the hanging space.` },
    order,
  );
  assert.equal(honest.some((issue) => /invents a count/.test(issue)), false);
});


test('the reply always names the exact missing details', async () => {
  assert.equal(humanList(['one']), 'one');
  assert.equal(humanList(['one', 'two']), 'one and two');
  assert.equal(humanList(['one', 'two', 'three']), 'one, two and three');

  const vague = ensureMissingMentioned('I need more information.', [
    'customerName',
    'width',
    'shutters',
  ]);
  assert.match(vague, /customer name/);
  assert.match(vague, /the width/);
  assert.match(vague, /number of shutters/);
  assert.doesNotMatch(vague, /more information/);

  // A field already asked about is not repeated, the rest are added.
  const partial = ensureMissingMentioned('What is the width?', ['width', 'depth']);
  assert.match(partial, /the depth/);
  assert.doesNotMatch(partial, /the width and the depth/);

  // Nothing missing means nothing is added.
  assert.equal(ensureMissingMentioned('The brochure can be made.', []), 'The brochure can be made.');
  assert.equal(ensureMissingMentioned('Noted', ['height']), 'Noted. I still need the height.');
});

test('the intake route forces the missing list into the reply', async () => {
  resetLlmState();
  await configureLlm();
  resetMockProvider({
    reply: JSON.stringify({
      reply: 'I need more information.',
      order: { customerName: 'Anita' },
      ready: false,
    }),
  });

  const response = await postJson(`${baseUrl}/api/intake`, {
    messages: [{ role: 'user', content: 'A wardrobe for Anita please.' }],
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.doesNotMatch(body.reply, /more information/i);
  for (const phrase of ['the piece', 'the room']) {
    assert.ok(body.reply.includes(phrase), `the reply names ${phrase}`);
  }
  assert.ok(body.missing.length >= 1);

  // If the model already listed everything, the reply is left untouched.
  resetMockProvider({
    reply: JSON.stringify({
      reply: 'I have the name. I still need the piece and the room.',
      order: { customerName: 'Anita' },
      ready: false,
    }),
  });
  const second = await (await postJson(`${baseUrl}/api/intake`, {
    messages: [{ role: 'user', content: 'A wardrobe for Anita please.' }],
  })).json();
  assert.equal(second.reply, 'I have the name. I still need the piece and the room.');
});


test('a malformed intake reply is retried once before it fails', async () => {
  resetLlmState();
  await configureLlm();
  resetMockProvider({
    replies: [
      'Sorry, I did not catch that.',
      JSON.stringify({ reply: 'Noted.', order: { customerName: 'Anita' }, ready: false }),
    ],
  });

  const response = await postJson(`${baseUrl}/api/intake`, {
    messages: [{ role: 'user', content: 'A wardrobe for Anita please.' }],
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(body.reply.includes('the piece'), 'the honest reply is returned after the retry');
  assert.equal(mockProviderState.requests.length, 2, 'one original request and one retry');

  resetMockProvider({ replies: ['still not json', 'also not json'] });
  const failed = await postJson(`${baseUrl}/api/intake`, {
    messages: [{ role: 'user', content: 'A wardrobe please.' }],
  });
  assert.equal(failed.status, 502);
  assert.equal(mockProviderState.requests.length, 2, 'only one retry, then the failure is surfaced');
});


test('images can be uploaded and served back', async () => {
  const tinyPng =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const response = await postJson(`${baseUrl}/api/media`, {
    contentType: 'image/png',
    data: tinyPng,
  });
  assert.equal(response.status, 201);
  const uploaded = await response.json();
  assert.match(uploaded.url, /^\/media\/[0-9a-f-]+\.png$/);
  assert.equal(uploaded.contentType, 'image/png');
  assert.ok(uploaded.bytes > 0);

  const served = await fetch(`${baseUrl}${uploaded.url}`);
  assert.equal(served.status, 200);
  assert.match(served.headers.get('content-type') ?? '', /image\/png/);
  const bytes = Buffer.from(await served.arrayBuffer());
  assert.deepEqual(bytes, Buffer.from(tinyPng, 'base64'));
  assert.ok(existsSync(path.join(dataDir, 'media', path.basename(uploaded.url))));

  // A data URL prefix is accepted as well.
  const dataUrl = await postJson(`${baseUrl}/api/media`, {
    contentType: 'image/png',
    data: `data:image/png;base64,${tinyPng}`,
  });
  assert.equal(dataUrl.status, 201);
});

test('uploads accept any file type and keep the original name', async () => {
  const text = Buffer.from('Kumar wardrobe plan: width 2500 mm, height 2100 mm.', 'utf8').toString('base64');
  const uploaded = await postJson(`${baseUrl}/api/media`, {
    contentType: 'text/plain',
    name: 'plan.txt',
    data: text,
  });
  assert.equal(uploaded.status, 201);
  const file = await uploaded.json();
  assert.match(file.url, /^\/media\/[0-9a-f-]+\.txt$/);
  assert.equal(file.name, 'plan.txt');
  assert.equal(file.contentType, 'text/plain');

  const served = await fetch(`${baseUrl}${file.url}`);
  assert.equal(served.status, 200);
  assert.match(served.headers.get('content-type') ?? '', /text\/plain/);
  assert.equal(await served.text(), 'Kumar wardrobe plan: width 2500 mm, height 2100 mm.');

  // Binary types are accepted as sent, with a download disposition.
  const archive = Buffer.from('PK\u0003\u0004 not really a zip', 'latin1').toString('base64');
  const binary = await postJson(`${baseUrl}/api/media`, {
    contentType: 'application/zip',
    name: 'drawings.zip',
    data: archive,
  });
  assert.equal(binary.status, 201);
  const stored = await binary.json();
  const download = await fetch(`${baseUrl}${stored.url}`);
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition') ?? '', /attachment; filename="drawings.zip"/);

  const empty = await postJson(`${baseUrl}/api/media`, { contentType: 'text/plain', data: '' });
  assert.equal(empty.status, 400);
  const bad = await postJson(`${baseUrl}/api/media`, { contentType: 'text/plain', data: '***' });
  assert.equal(bad.status, 400);
});

test('orders keep their attachments and the intake reads text files', async () => {
  const text = Buffer.from('Client note: width 2500 mm, height 2100 mm, three shutters.', 'utf8').toString('base64');
  const uploadResponse = await postJson(`${baseUrl}/api/media`, {
    contentType: 'text/plain',
    name: 'client-note.txt',
    data: text,
  });
  assert.equal(uploadResponse.status, 201);
  const file = await uploadResponse.json();

  const created = await postJson(`${baseUrl}/api/orders`, {
    ...DEMO_ORDER,
    customerId,
    attachments: [file],
  });
  assert.equal(created.status, 201);
  const order = await created.json();
  assert.equal(order.attachments.length, 1);
  assert.equal(order.attachments[0].name, 'client-note.txt');
  assert.equal(order.attachments[0].url, file.url);
  assert.equal(Object.hasOwn(order, 'attachments_json'), false, 'the raw column is not exposed');

  const detail = await (await fetch(`${baseUrl}/api/orders/${order.id}`)).json();
  assert.equal(detail.attachments[0].name, 'client-note.txt');

  const badAttachment = await postJson(`${baseUrl}/api/orders`, {
    ...DEMO_ORDER,
    customerId,
    attachments: [{ url: 'https://example.com/file.jpg', name: 'x.jpg', contentType: 'image/jpeg', bytes: 10 }],
  });
  assert.equal(badAttachment.status, 400);

  resetLlmState();
  await configureLlm();
  resetMockProvider({
    reply: JSON.stringify({ reply: 'Noted.', order: { title: 'Wardrobe' }, ready: false }),
  });
  const intake = await postJson(`${baseUrl}/api/intake`, {
    messages: [{ role: 'user', content: 'The plan is attached.' }],
    attachments: [file],
  });
  const intakeRaw = await intake.text();
  assert.equal(intake.status, 200, intakeRaw);
  const prompt = lastProviderRequest().json.messages.map((message) => message.content).join('\n');
  assert.match(prompt, /client-note\.txt/, 'the attachment name reaches the model');
  assert.match(prompt, /width 2500 mm/, 'the text of the attached file reaches the model');
});


test('customer photos become the voucher photography', async () => {
  const values = buildVoucherValues({
    order: { ...DEMO_ORDER, customerName: 'Ravi', title: 'Master Bedroom Wardrobe' },
    materials: [],
    templatesDir,
    logger: createLogger({ level: 'error' }),
    attachmentImages: ['file:///tmp/one.jpg', 'file:///tmp/two.jpg', 'file:///tmp/three.jpg', 'file:///tmp/four.jpg'],
  });
  assert.equal(values.coverImage, 'file:///tmp/one.jpg');
  assert.equal(values.insideImage, 'file:///tmp/two.jpg');
  assert.equal(values.insideImage2, 'file:///tmp/three.jpg');
  assert.equal(values.detailImage, 'file:///tmp/four.jpg');
});


test('a ready intake reply never asks for more', async () => {
  assert.equal(
    cleanReadyReply('Thank you Ravi. I have the size noted. I still need the carcass material and the back panel.'),
    'Thank you Ravi. I have the size noted.',
  );
  assert.equal(
    cleanReadyReply('Everything is in place. The brochure can be made.'),
    'Everything is in place. The brochure can be made.',
  );
  assert.equal(cleanReadyReply('I still need the width.'), '');
  assert.equal(cleanReadyReply('Noted. Is the carcass plywood?'), 'Noted.');

  resetLlmState();
  await configureLlm();
  resetMockProvider({
    reply: JSON.stringify({
      reply: 'Noted. What is the carcass material?',
      order: {
        customerName: 'Ravi',
        title: 'Wardrobe',
        room: 'Bedroom',
        width: '2400 mm',
        height: '2100 mm',
        depth: '600 mm',
        shutters: '3',
      },
      ready: true,
    }),
  });
  const response = await postJson(`${baseUrl}/api/intake`, {
    messages: [{ role: 'user', content: 'Complete order with all the sizes and the name.' }],
  });
  const body = await response.json();
  assert.equal(body.ready, true);
  assert.doesNotMatch(body.reply, /carcass/i);
  assert.doesNotMatch(body.reply, /\?/);
});


function setOrderCopyForTest(copy = BROCHURE_COPY) {
  db.prepare('UPDATE orders SET copy_json = ?, design_direction = ? WHERE id = ?').run(
    JSON.stringify(copy),
    '',
    orderId,
  );
}

test('the model designs and typesets a printable brochure from scratch', { timeout: 240_000 }, async () => {
  resetLlmState();
  await configureLlm();
  setOrderCopyForTest();
  resetMockProvider({ reply: DESIGNER_HTML });

  const response = await postJson(`${baseUrl}/api/orders/${orderId}/ai-brochure`, {});
  const raw = await response.text();
  assert.equal(response.status, 201, raw);
  const body = JSON.parse(raw);
  assert.equal(body.render.kind, 'ai');
  assert.equal(body.render.templateId, null);
  assert.equal(body.render.pageCount, 4);
  assert.equal(body.render.design.designed, true);
  assert.match(body.render.design.label, /Designed by the model/i);
  assert.deepEqual(body.copy, BROCHURE_COPY);

  const text = pdfText(path.join(dataDir, 'renders', `${body.render.id}.pdf`));
  const flat = normaliseText(text);
  assert.ok(flat.toLowerCase().includes(BROCHURE_COPY.headline.toLowerCase()), 'the headline is printed');
  assert.ok(flat.includes(BROCHURE_COPY.closing), 'the closing is printed');
  assert.ok(flat.includes('Master Bedroom Wardrobe'), 'the title is printed');
  assert.ok(
    flat.replace(/\s+/g, '').toLowerCase().includes('testcustomer'),
    'the customer is printed',
  );
  assert.ok(flat.includes('The colour of the room'), 'the colour study is printed');
  assert.ok(flat.includes('Cream walls, warm timber'), 'the palette is described');
  assert.ok(/2400/.test(flat) === false, 'no dimension reaches the brochure');
  assert.equal(flat.includes('{{'), false, 'no token is printed');
  assert.equal(/\u2014|\u2013/.test(flat), false, 'no em dash or en dash reaches print');

  const detail = await (await fetch(`${baseUrl}/api/orders/${orderId}`)).json();
  assert.deepEqual(detail.copy, BROCHURE_COPY);

  const storedHtml = db.prepare('SELECT html FROM renders WHERE id = ?').get(body.render.id).html;
  assert.ok(typeof storedHtml === 'string' && storedHtml.length > 4000, 'the document is kept for the next edit');

  const prompt = lastProviderRequest().json.messages.map((message) => message.content).join('\n');
  assert.match(prompt, /art director, typographer and print designer/i);
  assert.match(prompt, /\{\{headline\}\}/);
  assert.match(prompt, /PHOTOGRAPHS AVAILABLE/);
});

test('two generated brochures print different pages', { timeout: 240_000 }, async () => {
  resetLlmState();
  await configureLlm();
  setOrderCopyForTest();
  resetMockProvider({ reply: DESIGNER_HTML });
  const first = await (await postJson(`${baseUrl}/api/orders/${orderId}/ai-brochure`, {})).json();

  const secondHtml = DESIGNER_HTML.replace('--deep:#173B44', '--deep:#0D3350').replace(
    '--accent:#1AA3C8',
    '--accent:#16537E',
  );
  resetMockProvider({ reply: secondHtml });
  const second = await (await postJson(`${baseUrl}/api/orders/${orderId}/ai-brochure`, {})).json();
  assert.notEqual(second.render.id, first.render.id);
  const firstPage = hashBytes(Buffer.from(await (await fetch(`${baseUrl}${first.render.pageUrls[1]}`)).arrayBuffer()));
  const secondPage = hashBytes(Buffer.from(await (await fetch(`${baseUrl}${second.render.pageUrls[1]}`)).arrayBuffer()));
  assert.notEqual(firstPage, secondPage, 'a different palette prints a different story page');
});

test('a longer brochure prints six pages when the content needs room', { timeout: 240_000 }, async () => {
  resetLlmState();
  await configureLlm();
  setOrderCopyForTest();
  resetMockProvider({ reply: DESIGNER_LONG_HTML });

  const response = await postJson(`${baseUrl}/api/orders/${orderId}/ai-brochure`, {});
  const raw = await response.text();
  assert.equal(response.status, 201, raw);
  const body = JSON.parse(raw);
  assert.equal(body.render.kind, 'ai');
  assert.equal(body.render.pageCount, 6);
  assert.equal(body.render.pageUrls.length, 6);

  const text = pdfText(path.join(dataDir, 'renders', `${body.render.id}.pdf`));
  const flat = normaliseText(text);
  assert.ok(flat.toLowerCase().includes(BROCHURE_COPY.headline.toLowerCase()), 'the headline is printed');
  assert.ok(flat.includes('Cream walls, warm timber'), 'the palette study is printed');
  assert.equal(flat.includes('{{'), false, 'no token is printed');
});

test('a brochure outside four to eight pages is rejected before print', () => {
  const pages = (count) =>
    Array.from({ length: count }, (_, index) => `<div class="page"><p>Page ${index + 1} carries some words for the count.</p></div>`).join('\n');
  assert.throws(() => parseDesignerReply(`<html><body>${pages(3)}</body></html>`, 2), /four to eight/);
  assert.throws(() => parseDesignerReply(`<html><body>${pages(9)}</body></html>`, 2), /four to eight/);
});

test('the designer is told the pictures are the source and must all be used', { timeout: 240_000 }, async () => {
  resetLlmState();
  await configureLlm();
  setOrderCopyForTest();
  resetMockProvider({ reply: DESIGNER_HTML });
  const response = await postJson(`${baseUrl}/api/orders/${orderId}/ai-brochure`, {});
  assert.equal(response.status, 201, await response.text());
  const prompt = lastProviderRequest().json.messages.map((message) => message.content).join('\n');
  assert.match(prompt, /every photograph token/i);
  assert.match(prompt, /loupe/i);
  assert.match(prompt, /colour palette/i);
  assert.match(prompt, /mirror/i);
  assert.match(prompt, /paint card/i);
  assert.match(prompt, /showroom/i);
  assert.match(prompt, /photo1 palette:/i);
  assert.match(prompt, /#[0-9A-F]{6}/i);
});

test('a document that ignores an uploaded picture is rejected', { timeout: 240_000 }, async () => {
  resetLlmState();
  await configureLlm();
  setOrderCopyForTest();
  // The order carries two photographs; this reply only prints the first.
  const singlePhoto = DESIGNER_HTML.replaceAll('{{photo2}}', '{{photo1}}');
  resetMockProvider({ reply: singlePhoto });
  const response = await postJson(`${baseUrl}/api/orders/${orderId}/ai-brochure`, {});
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.match(body.error.message, /photo2/i);
  assert.match(body.error.message, /never used|every photograph/i);
});

test('the intake asks which detail to magnify when pictures arrive unnamed', () => {
  const messages = buildIntakeMessages(
    [{ role: 'user', content: 'Here are the project photos.' }],
    {},
    'The customer attached 2 photographs.',
  );
  const prompt = messages.map((message) => message.content).join('\n').toLowerCase();
  assert.match(prompt, /magnif/);
  assert.match(prompt, /detail/);
});

test('an unusable design is retried once and then fails cleanly', { timeout: 120_000 }, async () => {
  resetLlmState();
  await configureLlm();
  setOrderCopyForTest();
  resetMockProvider({ reply: 'I made you a lovely brochure in my head.' });
  const response = await postJson(`${baseUrl}/api/orders/${orderId}/ai-brochure`, {});
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.error.type, 'invalid_reply');
  assert.equal(mockProviderState.requests.length, 2, 'one retry, then the failure is surfaced');
});

test('a chat sentence edits the order and the page it already has', { timeout: 300_000 }, async () => {
  resetLlmState();
  await configureLlm();
  setOrderCopyForTest();
  resetMockProvider({ reply: DESIGNER_HTML });
  const base = await (await postJson(`${baseUrl}/api/orders/${orderId}/ai-brochure`, {})).json();

  resetMockProvider({
    reply: JSON.stringify({
      reply: 'Done. The shutters are now dark walnut.',
      order: { finishExt: 'Dark walnut laminate outside' },
      rerender: true,
    }),
  });
  const editResponse = await postJson(`${baseUrl}/api/orders/${orderId}/edit`, {
    message: 'Make the shutters dark walnut.',
  });
  const editBody = await editResponse.json();
  assert.equal(editResponse.status, 200);
  assert.equal(editBody.rerender, true);
  assert.equal(editBody.order.finishExt, 'Dark walnut laminate outside');

  resetMockProvider({ reply: DESIGNER_HTML });
  const revised = await postJson(`${baseUrl}/api/orders/${orderId}/ai-brochure`, {
    edit: 'Make the shutters dark walnut.',
    copy: editBody.copy,
  });
  const raw = await revised.text();
  assert.equal(revised.status, 201, raw);
  const body = JSON.parse(raw);
  assert.notEqual(body.render.id, base.render.id);

  const messages = lastProviderRequest().json.messages;
  assert.ok(
    messages.some(
      (message) => message.role === 'assistant' && String(message.content).includes('<!DOCTYPE html>'),
    ),
    'the previous document is sent back so the design survives the edit',
  );
  assert.ok(
    messages.some((message) => String(message.content).includes('THE STUDIO IS CHANGING AN EXISTING BROCHURE')),
  );

  const detail = await (await fetch(`${baseUrl}/api/orders/${orderId}`)).json();
  assert.equal(detail.finishExt, 'Dark walnut laminate outside');
});


test('missing details can be skipped and marked to be confirmed', async () => {
  resetLlmState();
  await configureLlm();
  resetMockProvider({ reply: JSON.stringify({ reply: 'unused', order: {}, ready: false }) });
  const requestsBefore = mockProviderState.requests.length;
  const partialDraft = {
    customerName: 'Rani',
    title: 'Wardrobe',
    width: '2400 mm',
  };
  const response = await postJson(`${baseUrl}/api/intake`, {
    messages: [{ role: 'user', content: 'Customer name Rani, a wardrobe 2400 wide.' }],
    draft: partialDraft,
    skip: ['room'],
  });
  const raw = await response.text();
  assert.equal(response.status, 200, raw);
  const body = JSON.parse(raw);
  assert.equal(body.ready, true);
  assert.equal(body.draft.room, 'Room to confirm');
  assert.deepEqual(body.missing, []);
  assert.match(body.reply, /to be confirmed/i);
  assert.equal(mockProviderState.requests.length, requestsBefore, 'skipping makes no model call');
});

test('saying I do not know skips the detail without a model call', async () => {
  resetLlmState();
  await configureLlm();
  resetMockProvider({ reply: JSON.stringify({ reply: 'unused', order: {}, ready: false }) });
  const requestsBefore = mockProviderState.requests.length;
  const partialDraft = {
    customerName: 'Rani',
    title: 'Wardrobe',
    width: '2400 mm',
  };
  const response = await postJson(`${baseUrl}/api/intake`, {
    messages: [{ role: 'user', content: "I don't know the room." }],
    draft: partialDraft,
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.ready, true);
  assert.equal(body.draft.room, 'Room to confirm');
  assert.match(body.reply, /room/i);
  assert.match(body.reply, /to be confirmed/i);
  assert.equal(mockProviderState.requests.length, requestsBefore);
});


test('the provider catalog covers the major LLMs and leaks nothing', async () => {
  const response = await fetch(`${baseUrl}/api/llm/providers`);
  assert.equal(response.status, 200);
  const body = await response.json();
  const ids = body.providers.map((provider) => provider.id);
  for (const expected of ['deepseek', 'opencode', 'commandcode', 'openai', 'openrouter', 'custom']) {
    assert.ok(ids.includes(expected), `missing provider ${expected}`);
  }
  const commandCode = body.providers.find((provider) => provider.id === 'commandcode');
  assert.equal(commandCode.endpoint, 'https://api.commandcode.ai/provider/v1');
  assert.ok(commandCode.models.length > 0);
  assert.ok(!JSON.stringify(body).includes('apiKey'));
});

test('a provider choice fills its defaults and switching drops a stale endpoint', async () => {
  resetLlmState();
  await configureLlm();
  // Save a custom compatible endpoint first.
  let response = await fetch(`${baseUrl}/api/llm/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: 'custom',
      endpoint: `${mockProviderUrl}/`,
      model: 'mock-flash',
      apiKey: LLM_KEY,
    }),
  });
  assert.equal(response.status, 200);

  // Choosing a named provider without an endpoint drops the old URL and model,
  // so the provider defaults resolve instead of a stale one.
  response = await fetch(`${baseUrl}/api/llm/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'commandcode' }),
  });
  assert.equal(response.status, 200);
  const settings = await response.json();
  assert.equal(settings.provider, 'commandcode');
  assert.equal(settings.endpoint, 'https://api.commandcode.ai/provider/v1');
  assert.equal(settings.model, 'deepseek-v4-flash');
  assert.equal(settings.hasKey, true);
});

test('an unknown provider is rejected without changing settings', async () => {
  resetLlmState();
  await configureLlm();
  const before = await (await fetch(`${baseUrl}/api/llm/settings`)).json();
  const response = await fetch(`${baseUrl}/api/llm/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'not-a-provider' }),
  });
  assert.equal(response.status, 400);
  const after = await (await fetch(`${baseUrl}/api/llm/settings`)).json();
  assert.deepEqual(after, before);
});



test('a plain language edit changes the live order and asks for a re-render', async () => {
  resetLlmState();
  await configureLlm();
  resetMockProvider({
    reply: JSON.stringify({
      reply: 'Done. I changed the shutters to dark walnut.',
      order: { finishExt: 'Dark walnut laminate outside' },
      copy: { ...BROCHURE_COPY, headline: 'A walnut wardrobe for the guest room' },
      rerender: true,
    }),
  });
  const response = await postJson(`${baseUrl}/api/orders/${orderId}/edit`, {
    message: 'Make the shutters dark walnut and redo the cover.',
  });
  const raw = await response.text();
  assert.equal(response.status, 200, raw);
  const body = JSON.parse(raw);
  assert.equal(body.reply, 'Done. I changed the shutters to dark walnut.');
  assert.equal(body.order.finishExt, 'Dark walnut laminate outside');
  assert.equal(body.copy.headline, 'A walnut wardrobe for the guest room');
  assert.equal(body.rerender, true);
  const stored = await (await fetch(`${baseUrl}/api/orders/${orderId}`)).json();
  assert.equal(stored.finishExt, 'Dark walnut laminate outside');
});

test('an order-only edit still requests a re-render', async () => {
  resetLlmState();
  await configureLlm();
  resetMockProvider({
    reply: JSON.stringify({
      reply: 'Noted, the height is 2150.',
      order: { height: '2150 mm' },
      rerender: true,
    }),
  });
  const response = await postJson(`${baseUrl}/api/orders/${orderId}/edit`, {
    message: 'The height is actually 2150.',
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.rerender, true);
  assert.equal(body.order.height, '2150 mm');
});

test('attaching files to a live order saves them and re-renders with them', { timeout: 240_000 }, async () => {
  resetLlmState();
  await configureLlm();
  setOrderCopyForTest();
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  mkdirSync(path.join(dataDir, 'media'), { recursive: true });
  writeFileSync(path.join(dataDir, 'media', 'edit-proof.png'), png);
  writeFileSync(path.join(dataDir, 'media', 'edit-proof-two.png'), png);
  const file = {
    url: '/media/edit-proof.png',
    name: 'edit-proof.png',
    contentType: 'image/png',
    bytes: png.length,
  };
  const secondFile = {
    url: '/media/edit-proof-two.png',
    name: 'edit-proof-two.png',
    contentType: 'image/png',
    bytes: png.length,
  };
  resetMockProvider({
    reply: JSON.stringify({
      reply: 'Done. The new photograph is on the order.',
      order: {},
      rerender: true,
    }),
  });
  const response = await postJson(`${baseUrl}/api/orders/${orderId}/edit`, {
    message: '',
    attachments: [file, secondFile],
  });
  const raw = await response.text();
  assert.equal(response.status, 200, raw);
  const body = JSON.parse(raw);
  assert.equal(body.attachmentsAdded, 2);
  assert.equal(body.rerender, true);
  assert.equal(body.order.attachments.length, 2 + 2);
  assert.ok(body.order.attachments.some((file) => file.url === '/media/edit-proof.png'));
  const stored = await (await fetch(`${baseUrl}/api/orders/${orderId}`)).json();
  assert.equal(stored.attachments.length, 2 + 2);

  // Attaching the same file again adds nothing but still succeeds.
  const repeat = await postJson(`${baseUrl}/api/orders/${orderId}/edit`, {
    message: 'Noted.',
    attachments: [file],
  });
  assert.equal((await repeat.json()).attachmentsAdded, 0);

  // Over the cap the whole edit is rejected and nothing is saved.
  const tooMany = Array.from({ length: 21 }, (_, index) => ({ ...file, url: `/media/x-${index}.png` }));
  const rejected = await postJson(`${baseUrl}/api/orders/${orderId}/edit`, {
    message: 'Too many.',
    attachments: tooMany,
  });
  assert.equal(rejected.status, 400);

});

test('the colours are read from the order photographs and served to the app', { timeout: 240_000 }, async () => {
  const customer = await (
    await postJson(`${baseUrl}/api/customers`, { name: 'Palette Customer' })
  ).json();
  const created = await (
    await postJson(`${baseUrl}/api/orders`, {
      ...DEMO_ORDER,
      title: 'Palette Test Wardrobe',
      customerId: customer.id,
      attachments: FIXTURE_ROOM_FILES,
    })
  ).json();
  const response = await fetch(`${baseUrl}/api/orders/${created.id}/palettes`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.palettes.length, 2, 'one palette per uploaded picture');
  for (const palette of body.palettes) {
    assert.match(palette.photo, /^photo[12]$/);
    assert.equal(palette.colors.length, 4);
    for (const colour of palette.colors) {
      assert.match(colour, /^#[0-9A-F]{6}$/i);
    }
    assert.equal(palette.names.length, 4, 'every colour has a showroom name');
    for (const name of palette.names) {
      assert.ok(typeof name === 'string' && name.length >= 3, name);
    }
  }
  // The fixture pictures are 1 by 1 red PNGs.
  assert.equal(body.palettes[0].colors[0], '#FF0000');
  const missing = await fetch(`${baseUrl}/api/orders/not-an-order/palettes`);
  assert.equal(missing.status, 404);
});

test('the picture review circles likely details and shows the palette', { timeout: 240_000 }, async () => {
  const customer = await (await postJson(`${baseUrl}/api/customers`, { name: 'Review Customer' })).json();
  const created = await (
    await postJson(`${baseUrl}/api/orders`, {
      ...DEMO_ORDER,
      title: 'Review Wardrobe',
      customerId: customer.id,
      attachments: FIXTURE_ROOM_FILES,
    })
  ).json();
  const images = created.attachments.map((file) => file.url);
  const response = await postJson(`${baseUrl}/api/analyze-images`, { images });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.photos.length, 2);
  for (const photo of body.photos) {
    assert.match(photo.url, /^\/media\//);
    assert.equal(photo.analysis.palette.length, 4);
    for (const swatch of photo.analysis.palette) {
      assert.match(swatch.hex, /^#[0-9A-F]{6}$/i);
      assert.ok(swatch.name.length >= 3);
    }
    assert.equal(photo.analysis.candidates.length, 3);
    for (const candidate of photo.analysis.candidates) {
      assert.ok(candidate.x > 0 && candidate.x < 100);
      assert.ok(candidate.y > 0 && candidate.y < 100);
      assert.ok(candidate.label.startsWith('Detail'));
      // Every magnified circle names the colour inside it.
      assert.match(candidate.hex, /^#[0-9A-F]{6}$/i);
      assert.ok(candidate.name.length >= 3, candidate.name);
    }
  }
  assert.equal((await postJson(`${baseUrl}/api/analyze-images`, { images: [] })).status, 400);
  assert.equal(
    (await postJson(`${baseUrl}/api/analyze-images`, { images: ['/media/../etc/passwd'] })).status,
    400,
  );
  const missing = await postJson(`${baseUrl}/api/analyze-images`, { images: ['/media/nope.png'] });
  assert.equal(missing.status, 404);
});

test('a PDF sheet joins the picture review as a page image', { timeout: 240_000 }, async () => {
  const htmlPath = path.join(tempDir, 'pdf-sheet.html');
  const pdfPath = path.join(tempDir, 'pdf-sheet.pdf');
  writeFileSync(
    htmlPath,
    '<html><body style="margin:0"><div style="width:210mm;height:297mm;background:#C9B996"></div></body></html>',
  );
  execFileSync(weasyprintBin, [htmlPath, pdfPath], { stdio: 'ignore' });
  const upload = await postJson(`${baseUrl}/api/media`, {
    data: readFileSync(pdfPath).toString('base64'),
    name: 'pdf-sheet.pdf',
    contentType: 'application/pdf',
  });
  assert.equal(upload.status, 201);
  const uploaded = await upload.json();
  assert.match(uploaded.url, /^\/media\/.*\.pdf$/);

  const review = await postJson(`${baseUrl}/api/analyze-images`, { images: [uploaded.url] });
  const raw = await review.text();
  assert.equal(review.status, 200, raw);
  const body = JSON.parse(raw);
  assert.equal(body.photos.length, 1);
  const photo = body.photos[0];
  assert.match(photo.previewUrl, /^\/pdf-previews\/.+\.png$/);
  assert.equal(photo.analysis.palette.length, 4);
  assert.ok(photo.analysis.palette.some((swatch) => swatch.name === 'Oat'));
  assert.equal(photo.analysis.candidates.length, 3);
  for (const candidate of photo.analysis.candidates) {
    assert.match(candidate.hex, /^#[0-9A-F]{6}$/i);
    assert.ok(candidate.name.length >= 3);
  }

  const preview = await fetch(`${baseUrl}${photo.previewUrl}`);
  assert.equal(preview.status, 200);
  assert.match(preview.headers.get('content-type') ?? '', /image\/png/);
  const bytes = Buffer.from(await preview.arrayBuffer());
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');

  // The same sheet feeds the order palette, so an order can be all PDFs.
  const customer = await (await postJson(`${baseUrl}/api/customers`, { name: 'PDF Customer' })).json();
  const order = await (
    await postJson(`${baseUrl}/api/orders`, {
      ...DEMO_ORDER,
      title: 'PDF Sheet Wardrobe',
      customerId: customer.id,
      attachments: [uploaded],
    })
  ).json();
  const palettes = await (await fetch(`${baseUrl}/api/orders/${order.id}/palettes`)).json();
  assert.equal(palettes.palettes.length, 1);
  assert.equal(palettes.palettes[0].colors.length, 4);
  assert.equal(palettes.palettes[0].names.length, 4);
});

test('network egress only allows the configured model provider and loopback', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return { ok: true };
  };
  const restore = installEgressGuard({
    resolveConfig: () => ({ endpoint: 'https://api.deepseek.com/v1' }),
    fetchImpl: fakeFetch,
  });
  try {
    const config = { endpoint: 'https://api.deepseek.com/v1' };
    assert.equal(isAllowedEgressUrl('https://api.deepseek.com/v1/chat/completions', { config }), true);
    assert.equal(isAllowedEgressUrl('http://127.0.0.1:8787/health', { config }), true);
    assert.equal(isAllowedEgressUrl('https://fonts.googleapis.com/css', { config }), false);
    await globalThis.fetch('https://api.deepseek.com/v1/chat/completions', { method: 'POST' });
    await globalThis.fetch('http://127.0.0.1:8787/health');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].init.redirect, 'manual');
    await assert.rejects(
      () => globalThis.fetch('https://example.com/tracker.gif'),
      /Blocked external network call/,
    );
    assert.equal(calls.length, 2, 'the blocked request never reached the network');
  } finally {
    restore();
  }
});

test('templates never point at remote assets', () => {
  const problems = [];
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(html|css)$/i.test(entry.name)) continue;
      const text = readFileSync(full, 'utf8');
      for (const match of text.matchAll(/https?:\/\/[^\s)"']+/g)) {
        if (/w3\.org|w3\.org\/2000\/svg/.test(match[0])) continue;
        problems.push(`${path.relative(templatesDir, full)}: ${match[0]}`);
      }
    }
  }
  walk(templatesDir);
  assert.deepEqual(problems, []);
});
