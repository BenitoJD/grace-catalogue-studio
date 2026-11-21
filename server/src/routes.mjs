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
  deleteSetting,
  getCustomer,
  getMaterial,
  getOrder,
  getRender,
  listCustomers,
  listMaterials,
  listOrders,
  listRenders,
  listRendersForOrder,
  setOrderCopy,
  setSetting,
  updateMaterial,
  updateOrder,
} from './db.mjs';
import {
  DEFAULT_NOTE_LIMIT_PER_MIN,
  DEFAULT_RATE_LIMIT_PER_MIN,
  DEFAULT_RENDER_LIMIT_PER_MIN,
  parseCorsOrigins,
  parsePositiveInt,
} from './config.mjs';
import { installHttpHardening, isExecutable } from './http.mjs';
import {
  CONNECTION_TEST_MESSAGES,
  COPY_MAX_TOKENS,
  COPY_TEMPERATURE,
  LLM_SETTING_KEYS,
  NOT_CONFIGURED_MESSAGE,
  NOTE_MAX_TOKENS,
  NOTE_TEMPERATURE,
  SAMPLE_MAX_CHARS,
  TEST_MAX_TOKENS,
  buildCopyMessages,
  buildCopyRepairMessages,
  buildNoteMessages,
  capText,
  copyQualityIssues,
  llmFailureBody,
  parseCopyReply,
  publicLlmSettings,
  requestChat,
  resolveLlmConfig,
  validateApiKey,
  validateEndpoint,
  validateModel,
} from './llm.mjs';
import { createLogger, parseLogLevel } from './logger.mjs';
import { buildKitValues, createRenderer, newRenderId } from './render.mjs';
import {
  RATE_CARD_TEMPLATE,
  buildRateCardValues,
  rateCardCatalog,
  resolveRateCardVariant,
} from './catalogue.mjs';
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
// The customer brief is loose prose, so it gets a much larger cap than the
// short specification fields.
const BRIEF_MAX_LENGTH = 2000;
// Trade rate card fields.
const PRICE_UNIT_MAX_LENGTH = 20;
const SKU_MAX_LENGTH = 40;
const PRICE_AMOUNT_ERROR = 'Field "priceAmount" must be a number greater than or equal to zero.';

function orderFieldMaxLength(field) {
  if (field === 'title') return TITLE_MAX_LENGTH;
  if (field === 'brief') return BRIEF_MAX_LENGTH;
  return FIELD_MAX_LENGTH;
}

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

// The database row carries copy_json as text for the renderer. JSON responses
// expose the parsed copy only; the raw column never leaves the server.
function orderPayload(order) {
  if (!order) return order;
  const { copy_json: _copyJson, ...payload } = order;
  return payload;
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

// Same shape, but an empty body (a client that only wants the defaults) is
// accepted as an empty object.
async function readOptionalJsonObject(c) {
  let raw;
  try {
    raw = await c.req.text();
  } catch {
    return { error: 'Request body could not be read.' };
  }
  if (raw.trim() === '') return { body: {} };
  let body;
  try {
    body = JSON.parse(raw);
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

// The API documents camelCase field names; the snake_case column names are
// accepted too so a script that speaks the database spelling still works.
function aliasedKeys(...names) {
  return names;
}

function readAliasedText(body, names, maxLength) {
  const key = names.find((name) => body[name] !== undefined);
  if (key === undefined) return { present: false, value: undefined };
  const raw = body[key];
  if (raw === undefined || raw === null) return { present: true, value: '' };
  if (typeof raw !== 'string') {
    return { present: true, error: `Field "${names[0]}" must be text.` };
  }
  const value = raw.trim();
  if (value.length > maxLength) {
    return {
      present: true,
      error: `Field "${names[0]}" must be ${maxLength} characters or fewer.`,
    };
  }
  return { present: true, value };
}

function readPriceAmount(body) {
  const key = aliasedKeys('priceAmount', 'price_amount').find((name) => body[name] !== undefined);
  if (key === undefined) return { present: false, value: undefined };
  const raw = body[key];
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
    return { present: true, error: PRICE_AMOUNT_ERROR };
  }
  return { present: true, value: raw };
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
  const noteLimitPerMin =
    options.noteLimitPerMin ??
    parsePositiveInt(process.env.NOTE_LIMIT_PER_MIN, DEFAULT_NOTE_LIMIT_PER_MIN);
  // Read the provider environment here, once per created app, so tests can
  // isolate themselves and the runtime keeps the normal process environment.
  const llmEnv = options.llmEnv ?? process.env;

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
    noteLimitPerMin,
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
  // Catalogue documents: the trade rate card
  // -------------------------------------------------------------------------

  app.get('/api/catalogue/templates', (c) => c.json(rateCardCatalog()));

  app.post('/api/catalogue/render', async (c) => {
    const parsed = await readOptionalJsonObject(c);
    if (parsed.error) return fail(c, 400, parsed.error);

    let templateId = null;
    const requestedTemplateId = parsed.body.templateId;
    if (requestedTemplateId !== undefined && requestedTemplateId !== null) {
      if (typeof requestedTemplateId !== 'string') {
        return fail(c, 400, 'Field "templateId" must be a template id.');
      }
      const requested = requestedTemplateId.trim();
      if (requested === '') return fail(c, 400, 'Field "templateId" must be a template id.');
      if (requested.length > TEMPLATE_ID_MAX_LENGTH) {
        return fail(
          c,
          400,
          `Field "templateId" must be ${TEMPLATE_ID_MAX_LENGTH} characters or fewer.`,
        );
      }
      if (!resolveRateCardVariant(requested)) {
        return fail(
          c,
          400,
          `Unknown templateId "${requested}". GET /api/catalogue/templates lists the available rate card templates.`,
        );
      }
      templateId = requested;
    }
    const variant = resolveRateCardVariant(templateId);
    templateId = variant.id;

    // Concurrent identical rate cards share one build, like voucher renders.
    const renderKey = `catalogue|${templateId}`;
    let job = inflightRenders.get(renderKey);
    if (!job) {
      job = startRenderJob(renderKey, async () => {
        const values = buildRateCardValues({
          materials: listMaterials(db),
          variants,
          variant,
        });
        const renderId = newRenderId();
        const result = await renderer.render({
          kind: 'catalogue',
          values,
          renderId,
          templateFile: RATE_CARD_TEMPLATE,
        });
        return createRender(db, {
          id: renderId,
          orderId: null,
          kind: 'catalogue',
          pageCount: result.pageCount,
          pdfUrl: result.pdfUrl,
          pageUrls: result.pageUrls,
          templateId,
        });
      });
    }

    const render = await job;
    return c.json(render, 201);
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
        maxLength: orderFieldMaxLength(field),
      });
      if (result.error) return fail(c, 400, result.error);
      fields[field] = result.value;
    }

    const order = createOrder(db, { ...fields, customerId: customerId.value });
    return c.json(orderPayload(order), 201);
  });

  app.get('/api/orders/:id', (c) => {
    const order = getOrder(db, c.req.param('id'));
    if (!order) return fail(c, 404, 'Order not found.');
    return c.json(orderPayload(order));
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
        maxLength: orderFieldMaxLength(field),
      });
      if (result.error) return fail(c, 400, result.error);
      patch[field] = result.value;
    }

    if (Object.keys(patch).length === 0) {
      return fail(c, 400, 'No order fields to update.');
    }

    const order = updateOrder(db, id, patch);
    return c.json(orderPayload(order));
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

    const priceAmount = readPriceAmount(parsed.body);
    if (priceAmount.error) return fail(c, 400, priceAmount.error);
    const priceUnit = readAliasedText(
      parsed.body,
      aliasedKeys('priceUnit', 'price_unit'),
      PRICE_UNIT_MAX_LENGTH,
    );
    if (priceUnit.error) return fail(c, 400, priceUnit.error);
    const sku = readAliasedText(parsed.body, aliasedKeys('sku'), SKU_MAX_LENGTH);
    if (sku.error) return fail(c, 400, sku.error);

    const material = createMaterial(db, {
      name: name.value,
      kind: kind.value,
      hex: hex.value,
      imageUrl: imageUrl.value,
      priceAmount: priceAmount.value ?? 0,
      priceUnit: priceUnit.value ?? '',
      sku: sku.value ?? '',
    });
    return c.json(material, 201);
  });

  app.get('/api/materials', (c) => c.json(listMaterials(db)));

  app.get('/api/materials/:id', (c) => {
    const material = getMaterial(db, c.req.param('id'));
    if (!material) return fail(c, 404, 'Material not found.');
    return c.json(material);
  });

  app.patch('/api/materials/:id', async (c) => {
    const id = c.req.param('id');
    if (!getMaterial(db, id)) return fail(c, 404, 'Material not found.');

    const parsed = await readJsonObject(c);
    if (parsed.error) return fail(c, 400, parsed.error);

    const patch = {};

    for (const [field, maxLength] of [
      ['name', NAME_MAX_LENGTH],
      ['kind', FIELD_MAX_LENGTH],
    ]) {
      if (!(field in parsed.body)) continue;
      const result = readText(parsed.body, field, { maxLength });
      if (result.error) return fail(c, 400, result.error);
      patch[field] = result.value;
    }

    if ('hex' in parsed.body) {
      const hex = readText(parsed.body, 'hex', { required: true });
      if (hex.error) return fail(c, 400, hex.error);
      if (!/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(hex.value)) {
        return fail(c, 400, 'Field "hex" must be a colour like #A65E22.');
      }
      patch.hex = hex.value;
    }

    if ('imageUrl' in parsed.body) {
      const imageUrl = readOptionalImageUrl(parsed.body, 'imageUrl');
      if (imageUrl.error) return fail(c, 400, imageUrl.error);
      patch.imageUrl = imageUrl.value;
    }

    const priceAmount = readPriceAmount(parsed.body);
    if (priceAmount.error) return fail(c, 400, priceAmount.error);
    if (priceAmount.present) patch.priceAmount = priceAmount.value;

    const priceUnit = readAliasedText(
      parsed.body,
      aliasedKeys('priceUnit', 'price_unit'),
      PRICE_UNIT_MAX_LENGTH,
    );
    if (priceUnit.error) return fail(c, 400, priceUnit.error);
    if (priceUnit.present) patch.priceUnit = priceUnit.value;

    const sku = readAliasedText(parsed.body, aliasedKeys('sku'), SKU_MAX_LENGTH);
    if (sku.error) return fail(c, 400, sku.error);
    if (sku.present) patch.sku = sku.value;

    if (Object.keys(patch).length === 0) {
      return fail(c, 400, 'No material fields to update.');
    }

    return c.json(updateMaterial(db, id, patch));
  });

  // -------------------------------------------------------------------------
  // Language model: runtime settings, connection test and note drafting
  // -------------------------------------------------------------------------

  function llmFailureResponse(c, error) {
    // Provider status and type help operations, but the key stays out of every
    // log line and response.
    logger.warn('Language model request failed.', {
      requestId: c.get('requestId') ?? null,
      type: typeof error?.type === 'string' ? error.type : 'unknown',
      providerStatus: Number.isInteger(error?.status) ? error.status : undefined,
    });
    return c.json(llmFailureBody(error), 502);
  }

  // No key is ever returned: hasKey only says whether one is available.
  app.get('/api/llm/settings', (c) =>
    c.json(publicLlmSettings(resolveLlmConfig(db, llmEnv))),
  );

  app.put('/api/llm/settings', async (c) => {
    const parsed = await readJsonObject(c);
    if (parsed.error) return fail(c, 400, parsed.error);
    const body = parsed.body;

    // Reject unknown fields instead of silently ignoring a typo that would
    // leave the operator looking at unchanged settings.
    const allowedFields = new Set(['endpoint', 'model', 'apiKey']);
    for (const key of Object.keys(body)) {
      if (!allowedFields.has(key)) {
        return fail(
          c,
          400,
          `Unknown field "${key}". Allowed fields are endpoint, model and apiKey.`,
        );
      }
    }

    // Validate everything before writing anything, so a rejected request can
    // not leave a half applied configuration behind.
    let endpoint;
    if ('endpoint' in body) {
      const result = validateEndpoint(body.endpoint);
      if (result.error) return fail(c, 400, result.error);
      endpoint = result.value;
    }
    let model;
    if ('model' in body) {
      const result = validateModel(body.model);
      if (result.error) return fail(c, 400, result.error);
      model = result.value;
    }
    let apiKey;
    if ('apiKey' in body) {
      const result = validateApiKey(body.apiKey);
      if (result.error) return fail(c, 400, result.error);
      apiKey = result.value;
    }

    if (endpoint !== undefined) setSetting(db, LLM_SETTING_KEYS.endpoint, endpoint);
    if (model !== undefined) setSetting(db, LLM_SETTING_KEYS.model, model);
    if (apiKey !== undefined) {
      // An empty string means "forget the stored key" so resolution falls back
      // to the environment.
      if (apiKey === '') deleteSetting(db, LLM_SETTING_KEYS.apiKey);
      else setSetting(db, LLM_SETTING_KEYS.apiKey, apiKey);
    }

    return c.json(publicLlmSettings(resolveLlmConfig(db, llmEnv)));
  });

  // A real provider call with a short budget. The response never carries the
  // key, only the outcome and a trimmed sample of the reply.
  app.post('/api/llm/test', async (c) => {
    const config = resolveLlmConfig(db, llmEnv);
    if (!config.configured) return fail(c, 400, NOT_CONFIGURED_MESSAGE);
    try {
      const result = await requestChat({
        endpoint: config.endpoint,
        model: config.model,
        apiKey: config.apiKey,
        messages: CONNECTION_TEST_MESSAGES,
        maxTokens: TEST_MAX_TOKENS,
        temperature: 0,
      });
      return c.json({
        ok: true,
        latencyMs: result.latencyMs,
        model: result.model,
        sample: capText(result.content, SAMPLE_MAX_CHARS),
      });
    } catch (error) {
      return llmFailureResponse(c, error);
    }
  });

  // Draft a short WhatsApp note for one order. The prompt carries every filled
  // in order field and forbids inventing the rest.
  app.post('/api/orders/:id/note', async (c) => {
    const order = getOrder(db, c.req.param('id'));
    if (!order) return fail(c, 404, 'Order not found.');
    const config = resolveLlmConfig(db, llmEnv);
    if (!config.configured) return fail(c, 400, NOT_CONFIGURED_MESSAGE);
    try {
      const result = await requestChat({
        endpoint: config.endpoint,
        model: config.model,
        apiKey: config.apiKey,
        messages: buildNoteMessages(order),
        maxTokens: NOTE_MAX_TOKENS,
        temperature: NOTE_TEMPERATURE,
      });
      return c.json({
        note: result.content,
        model: result.model,
        latencyMs: result.latencyMs,
      });
    } catch (error) {
      return llmFailureResponse(c, error);
    }
  });

  // Write the brochure copy for one order. The brief is stored first so the
  // customer's own wording is never lost even if the model call fails. The
  // prompt asks for strict JSON and the reply is parsed defensively.
  app.post('/api/orders/:id/copy', async (c) => {
    const id = c.req.param('id');
    let order = getOrder(db, id);
    if (!order) return fail(c, 404, 'Order not found.');

    const parsed = await readOptionalJsonObject(c);
    if (parsed.error) return fail(c, 400, parsed.error);
    const body = parsed.body;

    // brief is optional. A string replaces the stored brief; an empty string
    // clears it. Anything that is not a string is rejected rather than coerced.
    let brief;
    if ('brief' in body && body.brief !== undefined && body.brief !== null) {
      if (typeof body.brief !== 'string') return fail(c, 400, 'Field "brief" must be text.');
      const trimmed = body.brief.trim();
      if (trimmed.length > BRIEF_MAX_LENGTH) {
        return fail(c, 400, `Field "brief" must be ${BRIEF_MAX_LENGTH} characters or fewer.`);
      }
      brief = trimmed;
    }
    // regenerate is accepted for client intent but every copy request writes a
    // fresh copy: the brief may have changed since the stored one was written.
    if (
      'regenerate' in body &&
      body.regenerate !== undefined &&
      body.regenerate !== null &&
      typeof body.regenerate !== 'boolean'
    ) {
      return fail(c, 400, 'Field "regenerate" must be true or false.');
    }

    if (brief !== undefined) order = updateOrder(db, id, { brief });

    const config = resolveLlmConfig(db, llmEnv);
    if (!config.configured) return fail(c, 400, NOT_CONFIGURED_MESSAGE);

    try {
      let result = await requestChat({
        endpoint: config.endpoint,
        model: config.model,
        apiKey: config.apiKey,
        messages: buildCopyMessages(order, order.brief ?? ''),
        maxTokens: COPY_MAX_TOKENS,
        temperature: COPY_TEMPERATURE,
      });
      let copy = parseCopyReply(result.content);
      let issues = copyQualityIssues(copy, order);
      if (issues.length > 0) {
        logger.warn('Brochure copy needed a repair pass.', { issues });
        result = await requestChat({
          endpoint: config.endpoint,
          model: config.model,
          apiKey: config.apiKey,
          messages: buildCopyRepairMessages(order, order.brief ?? '', copy, issues),
          maxTokens: COPY_MAX_TOKENS,
          temperature: COPY_TEMPERATURE,
        });
        copy = parseCopyReply(result.content);
        issues = copyQualityIssues(copy, order);
        if (issues.length > 0) {
          logger.warn('Brochure copy still has issues after the repair pass.', { issues });
        }
      }
      setOrderCopy(db, id, copy);
      return c.json({ copy, model: result.model, latencyMs: result.latencyMs });
    } catch (error) {
      return llmFailureResponse(c, error);
    }
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
                logger,
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
