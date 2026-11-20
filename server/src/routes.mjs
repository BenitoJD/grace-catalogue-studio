import { readdirSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { Hono } from 'hono';

import {
  ORDER_TEXT_FIELDS,
  createCustomer,
  createMaterial,
  createOrder,
  createRender,
  deleteOrder,
  getCustomer,
  getOrder,
  getRender,
  listCustomers,
  listMaterials,
  listOrders,
  listRenders,
  listRendersForOrder,
  updateOrder,
} from './db.mjs';
import {
  DEFAULT_RATE_LIMIT_PER_MIN,
  DEFAULT_RENDER_LIMIT_PER_MIN,
  parseCorsOrigins,
  parsePositiveInt,
} from './config.mjs';
import { installHttpHardening, isExecutable } from './http.mjs';
import { createLogger, parseLogLevel } from './logger.mjs';
import { buildKitValues, createRenderer, newRenderId } from './render.mjs';
import { createPreviewStore } from './previews.mjs';
import {
  buildVoucherDocumentValues,
  loadVariants,
  resolveTemplateSelection,
  templateCatalog,
} from './variants.mjs';

const API_VERSION = '1.0.0';

// Validation caps. Titles and human names get more room than the short
// specification fields; template ids have their own small cap.
const TITLE_MAX_LENGTH = 120;
const NAME_MAX_LENGTH = 120;
const FIELD_MAX_LENGTH = 80;
const TEMPLATE_ID_MAX_LENGTH = 64;

// Only these fields must be present on create. The rest start empty and can be
// filled in with PATCH, which keeps the mobile form forgiving.
const REQUIRED_ORDER_FIELDS = new Set(['title', 'room', 'width', 'height', 'depth', 'shutters']);

const IMAGE_TYPES = new Map([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['webp', 'image/webp'],
  ['gif', 'image/gif'],
  ['svg', 'image/svg+xml'],
]);

function fail(c, status, message) {
  return c.json({ error: message, requestId: c.get('requestId') ?? null }, status);
}

async function readJsonObject(c) {
  let body;
  try {
    body = await c.req.json();
  } catch {
    return { error: 'Request body must be valid JSON.' };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Request body must be a JSON object.' };
  }
  return { body };
}

/**
 * Read one text field. Strings are trimmed; anything that is not a string
 * (numbers, arrays, objects, booleans) is rejected instead of being coerced.
 */
function readText(body, key, { required = false, maxLength = FIELD_MAX_LENGTH } = {}) {
  const raw = body[key];
  if (raw === undefined || raw === null) {
    if (required) return { error: `Field "${key}" is required.` };
    return { value: '' };
  }
  if (typeof raw !== 'string') {
    return { error: `Field "${key}" must be text.` };
  }
  const value = raw.trim();
  if (value === '') {
    if (required) return { error: `Field "${key}" is required.` };
    return { value: '' };
  }
  if (value.length > maxLength) {
    return { error: `Field "${key}" must be ${maxLength} characters or fewer.` };
  }
  return { value };
}

function readOptionalImageUrl(body, key, maxLength = FIELD_MAX_LENGTH) {
  const raw = body[key];
  if (raw === undefined || raw === null) return { value: null };
  if (typeof raw !== 'string') return { error: `Field "${key}" must be text.` };
  const value = raw.trim();
  if (value.length > maxLength) {
    return { error: `Field "${key}" must be ${maxLength} characters or fewer.` };
  }
  return { value: value === '' ? null : value };
}

async function sendFile(c, filePath, contentType) {
  try {
    const data = await readFile(filePath);
    return c.body(data, 200, {
      'Content-Type': contentType,
      'Content-Length': String(data.length),
    });
  } catch {
    return fail(c, 404, 'File not found.');
  }
}

function removeRenderFiles(rendersDir, renderId) {
  try {
    rmSync(path.join(rendersDir, `${renderId}.pdf`), { force: true });
    for (const name of readdirSync(rendersDir)) {
      if (name.startsWith(`${renderId}-`) && name.endsWith('.png')) {
        rmSync(path.join(rendersDir, name), { force: true });
      }
    }
  } catch {
    // Best effort cleanup only.
  }
}

function checkDatabase(db) {
  try {
    const row = db.prepare('SELECT 1 AS ok').get();
    if (row && Number(row.ok) === 1) return { ok: true, error: null };
    return { ok: false, error: 'The database did not answer the readiness query.' };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function createApp(options) {
  const { db, dataDir, templatesDir } = options;
  const rendersDir = path.join(dataDir, 'renders');
  const weasyprintBin = options.weasyprintBin ?? 'weasyprint';
  const pdftoppmBin = options.pdftoppmBin ?? 'pdftoppm';

  const logger =
    options.logger ??
    createLogger({ level: options.logLevel ?? parseLogLevel(process.env.LOG_LEVEL) });
  const corsOrigins = Array.isArray(options.corsOrigins)
    ? options.corsOrigins
    : typeof options.corsOrigins === 'string'
      ? parseCorsOrigins(options.corsOrigins)
      : parseCorsOrigins(process.env.CORS_ORIGINS);
  const rateLimitPerMin =
    options.rateLimitPerMin ??
    parsePositiveInt(process.env.RATE_LIMIT_PER_MIN, DEFAULT_RATE_LIMIT_PER_MIN);
  const renderLimitPerMin =
    options.renderLimitPerMin ??
    parsePositiveInt(process.env.RENDER_LIMIT_PER_MIN, DEFAULT_RENDER_LIMIT_PER_MIN);

  const variants = loadVariants(templatesDir);
  const renderer =
    options.renderer ??
    createRenderer({
      templatesDir,
      dataDir,
      weasyprintBin,
      pdftoppmBin,
    });
  const previewStore = createPreviewStore({
    variants,
    templatesDir,
    dataDir,
    renderer,
    log: logger,
  });

  const app = new Hono();
  const lifecycle = { shuttingDown: false };

  installHttpHardening(app, {
    logger,
    corsOrigins,
    rateLimitPerMin,
    renderLimitPerMin,
    isShuttingDown: () => lifecycle.shuttingDown,
  });

  // Concurrent requests for the same document share one build instead of
  // queueing a second identical render behind the first.
  const inflightRenders = new Map();

  function startRenderJob(key, run) {
    const promise = (async () => run())();
    inflightRenders.set(key, promise);
    const cleanup = () => {
      if (inflightRenders.get(key) === promise) inflightRenders.delete(key);
    };
    promise.then(cleanup, cleanup);
    return promise;
  }

  // -------------------------------------------------------------------------
  // Health and readiness
  // -------------------------------------------------------------------------

  // Cheap liveness check: the process is up. It touches nothing on disk.
  app.get('/health', (c) => c.json({ ok: true, version: API_VERSION }));

  // Readiness check: the database answers and the renderer binary is usable.
  // Returns 503 with a JSON reason when either dependency is missing.
  app.get('/ready', (c) => {
    const database = checkDatabase(db);
    const weasyprint = isExecutable(weasyprintBin);

    if (database.ok && weasyprint) {
      return c.json({
        ready: true,
        version: API_VERSION,
        checks: { database: true, weasyprint: true },
      });
    }

    const reasons = [];
    if (!database.ok) reasons.push(`database: ${database.error}`);
    if (!weasyprint) reasons.push(`weasyprint: "${weasyprintBin}" is missing or not executable`);
    return c.json(
      {
        ready: false,
        error: `Not ready. ${reasons.join(' ')}`,
        requestId: c.get('requestId') ?? null,
        checks: { database: database.ok, weasyprint },
      },
      503,
    );
  });

  // -------------------------------------------------------------------------
  // Bootstrap
  // -------------------------------------------------------------------------

  app.get('/api/bootstrap', (c) =>
    c.json({
      customers: listCustomers(db),
      orders: listOrders(db),
      materials: listMaterials(db),
    }),
  );

  // -------------------------------------------------------------------------
  // Brochure templates and their thumbnails
  // -------------------------------------------------------------------------

  app.get('/api/templates', (c) => c.json(templateCatalog(variants)));

  app.get('/previews/:file', async (c) => {
    const match = /^([a-z0-9]+(?:-[a-z0-9]+)*)\.png$/.exec(c.req.param('file'));
    if (!match || !variants.byId.has(match[1])) {
      return fail(c, 404, 'Preview not found.');
    }
    const filePath = await previewStore.ensure(match[1]);
    return sendFile(c, filePath, 'image/png');
  });

  // -------------------------------------------------------------------------
  // Customers
  // -------------------------------------------------------------------------

  app.get('/api/customers', (c) => c.json(listCustomers(db)));

  app.post('/api/customers', async (c) => {
    const parsed = await readJsonObject(c);
    if (parsed.error) return fail(c, 400, parsed.error);

    const name = readText(parsed.body, 'name', {
      required: true,
      maxLength: NAME_MAX_LENGTH,
    });
    if (name.error) return fail(c, 400, name.error);
    const phone = readText(parsed.body, 'phone');
    if (phone.error) return fail(c, 400, phone.error);
    const address = readText(parsed.body, 'address');
    if (address.error) return fail(c, 400, address.error);

    const customer = createCustomer(db, {
      name: name.value,
      phone: phone.value,
      address: address.value,
    });
    return c.json(customer, 201);
  });

  // -------------------------------------------------------------------------
  // Orders
  // -------------------------------------------------------------------------

  app.get('/api/orders', (c) => c.json(listOrders(db)));

  app.post('/api/orders', async (c) => {
    const parsed = await readJsonObject(c);
    if (parsed.error) return fail(c, 400, parsed.error);

    const customerId = readText(parsed.body, 'customerId', { required: true });
    if (customerId.error) return fail(c, 400, customerId.error);
    if (!getCustomer(db, customerId.value)) {
      return fail(c, 400, 'Customer not found. Create the customer first.');
    }

    const fields = {};
    for (const field of ORDER_TEXT_FIELDS) {
      const result = readText(parsed.body, field, {
        required: REQUIRED_ORDER_FIELDS.has(field),
        maxLength: field === 'title' ? TITLE_MAX_LENGTH : FIELD_MAX_LENGTH,
      });
      if (result.error) return fail(c, 400, result.error);
      fields[field] = result.value;
    }

    const order = createOrder(db, { ...fields, customerId: customerId.value });
    return c.json(order, 201);
  });

  app.get('/api/orders/:id', (c) => {
    const order = getOrder(db, c.req.param('id'));
    if (!order) return fail(c, 404, 'Order not found.');
    return c.json(order);
  });

  app.patch('/api/orders/:id', async (c) => {
    const id = c.req.param('id');
    if (!getOrder(db, id)) return fail(c, 404, 'Order not found.');

    const parsed = await readJsonObject(c);
    if (parsed.error) return fail(c, 400, parsed.error);

    const patch = {};

    if ('customerId' in parsed.body) {
      const customerId = readText(parsed.body, 'customerId', { required: true });
      if (customerId.error) return fail(c, 400, customerId.error);
      if (!getCustomer(db, customerId.value)) {
        return fail(c, 400, 'Customer not found.');
      }
      patch.customerId = customerId.value;
    }

    if ('status' in parsed.body) {
      if (parsed.body.status !== 'draft' && parsed.body.status !== 'approved') {
        return fail(c, 400, 'Field "status" must be "draft" or "approved".');
      }
      patch.status = parsed.body.status;
    }

    for (const field of ORDER_TEXT_FIELDS) {
      if (!(field in parsed.body)) continue;
      const result = readText(parsed.body, field, {
        maxLength: field === 'title' ? TITLE_MAX_LENGTH : FIELD_MAX_LENGTH,
      });
      if (result.error) return fail(c, 400, result.error);
      patch[field] = result.value;
    }

    if (Object.keys(patch).length === 0) {
      return fail(c, 400, 'No order fields to update.');
    }

    const order = updateOrder(db, id, patch);
    return c.json(order);
  });

  app.delete('/api/orders/:id', (c) => {
    const id = c.req.param('id');
    const renders = listRendersForOrder(db, id);
    if (!deleteOrder(db, id)) return fail(c, 404, 'Order not found.');
    for (const render of renders) removeRenderFiles(rendersDir, render.id);
    return c.json({ ok: true });
  });

  // -------------------------------------------------------------------------
  // Materials
  // -------------------------------------------------------------------------

  app.post('/api/materials', async (c) => {
    const parsed = await readJsonObject(c);
    if (parsed.error) return fail(c, 400, parsed.error);

    const name = readText(parsed.body, 'name', {
      required: true,
      maxLength: NAME_MAX_LENGTH,
    });
    if (name.error) return fail(c, 400, name.error);
    const kind = readText(parsed.body, 'kind', { required: true });
    if (kind.error) return fail(c, 400, kind.error);
    const hex = readText(parsed.body, 'hex', { required: true });
    if (hex.error) return fail(c, 400, hex.error);
    if (!/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(hex.value)) {
      return fail(c, 400, 'Field "hex" must be a colour like #A65E22.');
    }
    const imageUrl = readOptionalImageUrl(parsed.body, 'imageUrl');
    if (imageUrl.error) return fail(c, 400, imageUrl.error);

    const material = createMaterial(db, {
      name: name.value,
      kind: kind.value,
      hex: hex.value,
      imageUrl: imageUrl.value,
    });
    return c.json(material, 201);
  });

  // -------------------------------------------------------------------------
  // Renders
  // -------------------------------------------------------------------------

  app.post('/api/orders/:id/render', async (c) => {
    const order = getOrder(db, c.req.param('id'));
    if (!order) return fail(c, 404, 'Order not found.');

    const parsed = await readJsonObject(c);
    if (parsed.error) return fail(c, 400, parsed.error);

    const kind = parsed.body.kind;
    if (kind !== 'voucher' && kind !== 'kit') {
      return fail(c, 400, 'Field "kind" must be "voucher" or "kit".');
    }

    // templateId is optional. Missing means the first template in the
    // catalogue; an unknown id is a client error, not a fallback.
    let templateId = variants.defaultTemplateId;
    const requestedTemplateId = parsed.body.templateId;
    if (requestedTemplateId !== undefined && requestedTemplateId !== null) {
      if (typeof requestedTemplateId !== 'string') {
        return fail(c, 400, 'Field "templateId" must be a template id.');
      }
      const requested = requestedTemplateId.trim();
      if (requested === '') {
        return fail(c, 400, 'Field "templateId" must be a template id.');
      }
      if (requested.length > TEMPLATE_ID_MAX_LENGTH) {
        return fail(
          c,
          400,
          `Field "templateId" must be ${TEMPLATE_ID_MAX_LENGTH} characters or fewer.`,
        );
      }
      if (!variants.byId.has(requested)) {
        return fail(
          c,
          400,
          `Unknown templateId "${requested}". GET /api/templates lists the available templates.`,
        );
      }
      templateId = requested;
    }

    // Concurrent identical renders (same order, kind and template) share one
    // build: the second request awaits the first instead of queueing another.
    const renderKey = `${order.id}|${kind}|${kind === 'voucher' ? templateId : ''}`;
    let job = inflightRenders.get(renderKey);
    if (!job) {
      job = startRenderJob(renderKey, async () => {
        const selection =
          kind === 'voucher' ? resolveTemplateSelection(variants, templateId) : null;
        const values =
          kind === 'voucher'
            ? buildVoucherDocumentValues({
                order,
                materials: listMaterials(db),
                templatesDir,
                variants,
                templateId,
              })
            : buildKitValues();
        const renderId = newRenderId();
        const result = await renderer.render({
          kind,
          values,
          renderId,
          templateFile: selection?.templateFile,
          builtDir: kind === 'voucher' ? 'voucher' : undefined,
        });

        return createRender(db, {
          id: renderId,
          orderId: order.id,
          kind,
          pageCount: result.pageCount,
          pdfUrl: result.pdfUrl,
          pageUrls: result.pageUrls,
          templateId: kind === 'voucher' ? templateId : null,
        });
      });
    }

    const render = await job;
    return c.json(render, 201);
  });

  app.get('/api/renders', (c) => c.json(listRenders(db)));

  app.get('/api/renders/:id', (c) => {
    const render = getRender(db, c.req.param('id'));
    if (!render) return fail(c, 404, 'Render not found.');
    return c.json(render);
  });

  // -------------------------------------------------------------------------
  // Files
  // -------------------------------------------------------------------------

  app.get('/files/:name', (c) => {
    const name = c.req.param('name');
    if (!/^[A-Za-z0-9_-]+\.pdf$/.test(name)) {
      return fail(c, 404, 'File not found.');
    }
    return sendFile(c, path.join(rendersDir, name), 'application/pdf');
  });

  app.get('/pages/:renderId/:file', (c) => {
    const renderId = c.req.param('renderId');
    if (!/^[A-Za-z0-9_-]+$/.test(renderId)) {
      return fail(c, 404, 'Page not found.');
    }
    const match = /^(\d+)\.png$/.exec(c.req.param('file'));
    if (!match) return fail(c, 404, 'Page not found.');
    const page = Number.parseInt(match[1], 10);
    if (!Number.isInteger(page) || page < 1) {
      return fail(c, 404, 'Page not found.');
    }
    return sendFile(c, path.join(rendersDir, `${renderId}-${page}.png`), 'image/png');
  });

  app.get('/media/:name', (c) => {
    const name = c.req.param('name');
    if (!/^[A-Za-z0-9._-]+$/.test(name) || name.includes('..')) {
      return fail(c, 404, 'File not found.');
    }
    const extension = path.extname(name).slice(1).toLowerCase();
    const contentType = IMAGE_TYPES.get(extension);
    if (!contentType) return fail(c, 404, 'File not found.');
    return sendFile(c, path.join(dataDir, 'media', name), contentType);
  });

  // Optional hook for the server entry point: it uses this to warm the
  // template previews in the background without blocking boot.
  if (typeof options.onReady === 'function') {
    options.onReady({ variants, renderer, previewStore });
  }

  // Exposed so the entry point can stop accepting new work during shutdown.
  app.lifecycle = lifecycle;
  app.renderer = renderer;

  return app;
}
