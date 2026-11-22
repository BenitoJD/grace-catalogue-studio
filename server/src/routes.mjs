import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

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
  getLlmCache,
  getMaterial,
  getOrder,
  getRender,
  llmCacheStats,
  pruneLlmCache,
  putLlmCache,
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
  parseCacheTtlHours,
  parseCorsOrigins,
  parsePositiveInt,
} from './config.mjs';
import { installHttpHardening, isExecutable, uploadBodyLimit } from './http.mjs';
import {
  buildAiBrochureMessages,
  compileAiBrochure,
  designLabel,
  mergeDesignOverrides,
  parseAiDesign,
  readCopyOverride,
} from './ai-brochure.mjs';
import { buildLlmCacheKey, cacheExpiryCutoff } from './llm-cache.mjs';
import {
  INTAKE_MAX_MESSAGE_CHARS,
  INTAKE_MAX_MESSAGES,
  INTAKE_MAX_TOKENS,
  INTAKE_TEMPERATURE,
  buildIntakeMessages,
  cleanReadyReply,
  ensureMissingMentioned,
  fieldsFromSkipRequest,
  mergeDraft,
  missingEssentials,
  missingFields,
  parseIntakeReply,
  skipDraftFields,
  skipReply,
  skipRequestFromMessage,
} from './intake.mjs';
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

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const UPLOAD_EXTENSIONS = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
  ['image/heic', 'heic'],
  ['application/pdf', 'pdf'],
  ['text/plain', 'txt'],
  ['text/csv', 'csv'],
  ['application/zip', 'zip'],
]);

/** Keep the customer's own extension when it is safe, otherwise derive one. */
function uploadExtension(originalName, contentType) {
  const fromName = /\.([A-Za-z0-9]{1,10})$/.exec(originalName)?.[1];
  if (fromName) return fromName.toLowerCase();
  return UPLOAD_EXTENSIONS.get(contentType) ?? 'bin';
}

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
  const { copy_json: _copyJson, attachments_json: _attachmentsJson, ...payload } = order;
  return payload;
}

const MAX_ORDER_ATTACHMENTS = 20;
const MAX_ATTACHMENT_TEXT = 2500;
const execFileAsync = promisify(execFile);

// Local file URLs for the images a customer uploaded with the order, so the
// voucher can print their own photographs instead of the house shots.
function voucherPhotoFiles(order, mediaDir) {
  const attachments = Array.isArray(order?.attachments) ? order.attachments : [];
  return attachments
    .filter((file) =>
      /^image\//i.test(String(file.contentType ?? '')) ||
      /\.(jpe?g|png|webp)$/i.test(String(file.url ?? '')),
    )
    .map((file) => path.join(mediaDir, path.basename(file.url)))
    .filter((filePath) => {
      try {
        return readFileSync(filePath).length > 0;
      } catch {
        return false;
      }
    })
    .map((filePath) => pathToFileURL(filePath).href);
}

/**
 * Text the model can read from the files the customer attached: PDF text and
 * plain text files are included, anything else is named but not guessed at.
 */
async function describeAttachments(attachments, mediaDir) {
  if (!attachments || attachments.length === 0) return '';
  const parts = [];
  for (const attachment of attachments.slice(0, 10)) {
    const filePath = path.join(mediaDir, path.basename(attachment.url));
    let note = `${attachment.name} (${attachment.contentType})`;
    try {
      const isPdf =
        attachment.contentType.includes('pdf') || attachment.url.toLowerCase().endsWith('.pdf');
      const isText =
        attachment.contentType.startsWith('text/') ||
        /\.(txt|csv|md|json)$/i.test(attachment.url);
      if (isPdf) {
        const { stdout } = await execFileAsync('pdftotext', [filePath, '-'], {
          timeout: 15000,
          maxBuffer: 8 * 1024 * 1024,
        });
        note += `\n${capText(stdout, MAX_ATTACHMENT_TEXT)}`;
      } else if (isText) {
        note += `\n${capText(await readFile(filePath, 'utf8'), MAX_ATTACHMENT_TEXT)}`;
      } else {
        note += ' (file attached, content is not text)';
      }
    } catch {
      note += ' (file attached)';
    }
    parts.push(note);
  }
  return parts.join('\n---\n').slice(0, 6000);
}

/** Files uploaded from the chat, validated lightly and kept as metadata. */
function readAttachments(body) {
  if (body.attachments === undefined || body.attachments === null) return { value: [] };
  if (!Array.isArray(body.attachments)) {
    return { error: 'Field "attachments" must be an array.' };
  }
  if (body.attachments.length > MAX_ORDER_ATTACHMENTS) {
    return { error: `An order may hold at most ${MAX_ORDER_ATTACHMENTS} attachments.` };
  }
  const value = [];
  for (const item of body.attachments) {
    if (!item || typeof item !== 'object') {
      return { error: 'Every attachment must be an object.' };
    }
    const url = typeof item.url === 'string' ? item.url.trim() : '';
    if (!/^\/media\/[A-Za-z0-9._-]+$/.test(url)) {
      return { error: 'Attachment "url" must point at an uploaded file.' };
    }
    const name = typeof item.name === 'string' ? item.name.trim().slice(0, 200) : '';
    if (name === '') return { error: 'Attachment "name" is required.' };
    const contentType =
      typeof item.contentType === 'string' && item.contentType.trim() !== ''
        ? item.contentType.trim().slice(0, 100)
        : 'application/octet-stream';
    const bytes = Number.isFinite(item.bytes) ? Math.max(0, Math.floor(item.bytes)) : 0;
    value.push({ url, name, contentType, bytes });
  }
  return { value };
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

async function sendFile(c, filePath, contentType, extraHeaders = {}) {
  try {
    const data = await readFile(filePath);
    return c.body(data, 200, {
      'Content-Type': contentType,
      'Content-Length': String(data.length),
      ...extraHeaders,
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
  const cacheTtlHours =
    options.llmCacheTtlHours ??
    parseCacheTtlHours(process.env.LLM_CACHE_TTL_HOURS);
  const cacheEnabled = Number.isFinite(cacheTtlHours) && cacheTtlHours > 0;
  const cacheCutoff = () => cacheExpiryCutoff(cacheTtlHours);

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

    const attachments = readAttachments(parsed.body);
    if (attachments.error) return fail(c, 400, attachments.error);

    const order = createOrder(db, {
      ...fields,
      customerId: customerId.value,
      attachments: attachments.value,
    });
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

    const messages = buildNoteMessages(order);
    const cacheKey = cacheEnabled
      ? buildLlmCacheKey({ endpoint: config.endpoint, model: config.model, messages })
      : null;
    if (cacheKey) {
      const hit = getLlmCache(db, cacheKey, cacheCutoff());
      if (hit) {
        logger.info('Language model cache hit.', { kind: 'note', orderId: order.id });
        const stored = JSON.parse(hit.response_json);
        return c.json({ ...stored, latencyMs: 0, cached: true });
      }
    }

    try {
      const result = await requestChat({
        endpoint: config.endpoint,
        model: config.model,
        apiKey: config.apiKey,
        messages,
        maxTokens: NOTE_MAX_TOKENS,
        temperature: NOTE_TEMPERATURE,
      });
      const payload = {
        note: result.content,
        model: result.model,
        latencyMs: result.latencyMs,
      };
      if (cacheKey) {
        putLlmCache(db, {
          key: cacheKey,
          endpoint: config.endpoint,
          model: config.model,
          responseJson: JSON.stringify({ note: payload.note, model: payload.model }),
        });
      }
      return c.json({ ...payload, cached: false });
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

    const bypassCache = body.regenerate === true;
    const baseMessages = buildCopyMessages(order, order.brief ?? '');
    // The key is built even on a regenerate: the fresh copy replaces the cached
    // one, so the next plain request cannot serve the older words.
    const cacheKey = cacheEnabled
      ? buildLlmCacheKey({ endpoint: config.endpoint, model: config.model, messages: baseMessages })
      : null;
    if (cacheKey && !bypassCache) {
      const hit = getLlmCache(db, cacheKey, cacheCutoff());
      if (hit) {
        logger.info('Language model cache hit.', { kind: 'copy', orderId: order.id });
        const stored = JSON.parse(hit.response_json);
        setOrderCopy(db, id, stored.copy);
        return c.json({ copy: stored.copy, model: stored.model, latencyMs: 0, cached: true });
      }
    }

    try {
      let result = await requestChat({
        endpoint: config.endpoint,
        model: config.model,
        apiKey: config.apiKey,
        messages: baseMessages,
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
      if (cacheKey) {
        putLlmCache(db, {
          key: cacheKey,
          endpoint: config.endpoint,
          model: config.model,
          responseJson: JSON.stringify({ copy, model: result.model }),
        });
      }
      return c.json({ copy, model: result.model, latencyMs: result.latencyMs, cached: false });
    } catch (error) {
      return llmFailureResponse(c, error);
    }
  });

  app.get('/api/llm/cache/stats', (c) => {
    const stats = llmCacheStats(db);
    return c.json({
      enabled: cacheEnabled,
      ttlHours: cacheTtlHours,
      entries: stats.entries,
      hits: stats.hits,
      oldest: stats.oldest,
    });
  });

  app.post('/api/llm/cache/purge', (c) => {
    const deleted = pruneLlmCache(db, '9999-12-31T23:59:59.999Z');
    logger.info('Language model cache purged.', { deleted });
    return c.json({ deleted });
  });

  // Conversational intake: the customer dumps what they know, the model
  // extracts the order and asks only for essentials that are still missing.
  app.post('/api/intake', async (c) => {
    const parsed = await readOptionalJsonObject(c);
    if (parsed.error) return fail(c, 400, parsed.error);
    const body = parsed.body ?? {};
    const messages = body.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return fail(c, 400, 'Field "messages" must be a non empty array.');
    }
    if (messages.length > INTAKE_MAX_MESSAGES) {
      return fail(c, 400, `Field "messages" may hold at most ${INTAKE_MAX_MESSAGES} messages.`);
    }
    const cleanMessages = [];
    for (const message of messages) {
      if (!message || typeof message !== 'object') {
        return fail(c, 400, 'Every message must be an object with a role and content.');
      }
      const role = message.role === 'assistant' ? 'assistant' : 'user';
      const content = typeof message.content === 'string' ? message.content.trim() : '';
      if (content === '') return fail(c, 400, 'Every message needs content.');
      if (content.length > INTAKE_MAX_MESSAGE_CHARS) {
        return fail(c, 400, `A message may hold at most ${INTAKE_MAX_MESSAGE_CHARS} characters.`);
      }
      cleanMessages.push({ role, content });
    }
    if (body.draft !== undefined && (body.draft === null || typeof body.draft !== 'object')) {
      return fail(c, 400, 'Field "draft" must be an object when present.');
    }
    if (body.skip !== undefined && !Array.isArray(body.skip)) {
      return fail(c, 400, 'Field "skip" must be an array of missing details when present.');
    }

    const config = resolveLlmConfig(db, llmEnv);
    if (!config.configured) return fail(c, 400, NOT_CONFIGURED_MESSAGE);

    // A customer who does not know a detail can say so, or the app can press
    // Skip. Marking it "to be confirmed" is a local decision: no model call and
    // no invented number.
    const lastUserMessage = [...cleanMessages].reverse().find((message) => message.role === 'user');
    const requestedSkip = body.skip !== undefined ? fieldsFromSkipRequest(body.skip) : null;
    const skipFields = body.skip !== undefined
      ? requestedSkip
      : skipRequestFromMessage(lastUserMessage?.content ?? '', body.draft ?? {});
    if (skipFields && skipFields.length > 0) {
      const nextDraft = skipDraftFields(body.draft ?? {}, skipFields);
      const missing = missingEssentials(nextDraft);
      logger.info('Intake skipped unknown details.', { fields: skipFields });
      return c.json({
        reply: skipReply(nextDraft, skipFields),
        draft: nextDraft,
        missing,
        ready: missing.length === 0,
        model: 'local',
        latencyMs: 0,
      });
    }

    try {
      const attachments = readAttachments(body);
      if (attachments.error) return fail(c, 400, attachments.error);
      const attachmentContext = await describeAttachments(
        attachments.value,
        path.join(dataDir, 'media'),
      );
      const intakeMessages = buildIntakeMessages(
        cleanMessages,
        body.draft ?? {},
        attachmentContext,
      );
      let result = await requestChat({
        endpoint: config.endpoint,
        model: config.model,
        apiKey: config.apiKey,
        messages: intakeMessages,
        maxTokens: INTAKE_MAX_TOKENS,
        temperature: INTAKE_TEMPERATURE,
      });
      let intake;
      try {
        intake = parseIntakeReply(result.content);
      } catch (error) {
        // Small models occasionally answer with prose instead of JSON. Ask once
        // more with the exact shape, then surface the failure if it repeats.
        if (error?.type !== 'invalid_reply') throw error;
        logger.warn('Intake reply could not be read, asking once more.', {
          reason: error.message,
        });
        result = await requestChat({
          endpoint: config.endpoint,
          model: config.model,
          apiKey: config.apiKey,
          messages: [
            ...intakeMessages,
            { role: 'assistant', content: capText(result.content, 1500) },
            {
              role: 'user',
              content:
                'That reply was not usable. Reply with the strict JSON object only, no prose: {"reply": "...", "order": { ... }, "ready": false}.',
            },
          ],
          maxTokens: INTAKE_MAX_TOKENS,
          temperature: INTAKE_TEMPERATURE,
        });
        intake = parseIntakeReply(result.content);
      }
      const draft = mergeDraft(body.draft ?? {}, intake.order);
      const missing = missingEssentials(draft);
      // Never let a vague "more details" reach the client: the reply names the
      // exact fields that are still empty.
      const missingFieldsList = missingFields(draft);
      const reply =
        missingFieldsList.length === 0
          ? cleanReadyReply(intake.reply)
          : ensureMissingMentioned(intake.reply, missingFieldsList);
      return c.json({
        reply,
        draft,
        missing,
        ready: missing.length === 0,
        model: result.model,
        latencyMs: result.latencyMs,
      });
    } catch (error) {
      return llmFailureResponse(c, error);
    }
  });

  // The AI art director: the model designs a fresh four page document for this
  // order and writes its copy in the same pass. With overrides the studio keeps
  // the design it already likes and re-renders only the choices it changed.
  app.post('/api/orders/:id/ai-brochure', async (c) => {
    let order = getOrder(db, c.req.param('id'));
    if (!order) return fail(c, 404, 'Order not found.');

    const parsed = await readOptionalJsonObject(c);
    if (parsed.error) return fail(c, 400, parsed.error);
    const body = parsed.body ?? {};

    let brief = order.brief ?? '';
    if (body.brief !== undefined) {
      if (typeof body.brief !== 'string') return fail(c, 400, 'Field "brief" must be a string.');
      brief = body.brief.trim().slice(0, 2000);
      if (brief !== order.brief) order = updateOrder(db, order.id, { brief });
    }

    let direction = order.design_direction ?? '';
    if (body.direction !== undefined) {
      if (typeof body.direction !== 'string') {
        return fail(c, 400, 'Field "direction" must be a string.');
      }
      direction = body.direction.trim().slice(0, 1200);
      if (direction !== (order.design_direction ?? '')) {
        order = updateOrder(db, order.id, { design_direction: direction });
      }
    }

    if (body.overrides !== undefined && (typeof body.overrides !== 'object' || body.overrides === null || Array.isArray(body.overrides))) {
      return fail(c, 400, 'Field "overrides" must be an object.');
    }
    const overrides = body.overrides ?? null;

    let copyOverride = null;
    if (body.copy !== undefined) {
      try {
        copyOverride = readCopyOverride(body.copy);
      } catch (error) {
        return fail(c, 400, error.message, 'invalid_reply');
      }
    }

    const photoPaths = voucherPhotoFiles(order, path.join(dataDir, 'media'));
    const photoCount = photoPaths.length > 0 ? photoPaths.length : 4;

    try {
      let design;
      let copy;
      let generated = null;
      let usedModel = null;
      let latencyMs = 0;

      if (overrides || copyOverride) {
        // Re-render path: keep the design the studio has and apply its edits.
        const previous = listRendersForOrder(db, order.id)
          .filter((render) => render.kind === 'ai' && render.design)
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
        const base = previous?.design
          ? { ...previous.design }
          : {
              tone: 'maroon',
              type: 'editorial',
              cover: 'fullBleed',
              story: 'hero',
              materials: 'grid4',
              spec: 'twoColumn',
              coverPhoto: 0,
              storyPhoto: 1,
              detailPhoto: 0,
              statement: 'Made for the room it stands in.',
            };
        design = mergeDesignOverrides(base, overrides ?? {}, photoCount);
        copy = copyOverride ?? order.copy ?? null;
        if (!copy) {
          return fail(c, 400, 'Write the brochure copy before changing the design.');
        }
        const issues = copyQualityIssues(copy, order);
        if (issues.length > 0) logger.warn('Studio edited copy has quality notes.', { issues });
        if (copyOverride) order = setOrderCopy(db, order.id, copy);
      } else {
        const config = resolveLlmConfig(db, llmEnv);
        if (!config.configured) return fail(c, 400, NOT_CONFIGURED_MESSAGE);
        const messages = buildAiBrochureMessages(order, brief, photoCount, direction);

        let result = await requestChat({
          endpoint: config.endpoint,
          model: config.model,
          apiKey: config.apiKey,
          messages,
          maxTokens: 3200,
          temperature: 0.75,
        });
        let parsedDesign;
        try {
          parsedDesign = parseAiDesign(result.content, photoCount);
        } catch (error) {
          if (error?.type !== 'invalid_reply') throw error;
          logger.warn('AI brochure design could not be read, asking once more.', { reason: error.message });
          result = await requestChat({
            endpoint: config.endpoint,
            model: config.model,
            apiKey: config.apiKey,
            messages: [
              ...messages,
              { role: 'assistant', content: capText(result.content, 1500) },
              {
                role: 'user',
                content:
                  'That reply was not usable. Reply with the strict JSON object only, no prose, using the exact field names and allowed values.',
              },
            ],
            maxTokens: 3200,
            temperature: 0.4,
          });
          parsedDesign = parseAiDesign(result.content, photoCount);
        }
        generated = parsedDesign;
        design = parsedDesign.design;
        copy = parsedDesign.copy;

        let issues = copyQualityIssues(copy, order);
        if (issues.length > 0) {
          logger.warn('AI brochure copy needs a repair pass.', { issues });
          const repair = await requestChat({
            endpoint: config.endpoint,
            model: config.model,
            apiKey: config.apiKey,
            messages: buildCopyRepairMessages(order, brief, copy, issues),
            maxTokens: COPY_MAX_TOKENS,
            temperature: COPY_TEMPERATURE,
          });
          copy = parseCopyReply(repair.content);
          issues = copyQualityIssues(copy, order);
          if (issues.length > 0) logger.warn('AI brochure copy still has issues.', { issues });
        }
        usedModel = result.model;
        latencyMs = result.latencyMs;
      }

      const palette = variants.palettesById.get(design.tone) ?? variants.palettes[0];
      const html = compileAiBrochure({
        order,
        materials: listMaterials(db),
        palette,
        design,
        copy,
        templatesDir,
        attachmentImages: photoPaths,
      });
      const renderId = newRenderId();
      const rendered = await renderer.renderHtml({ html, renderId });
      const render = createRender(db, {
        id: renderId,
        orderId: order.id,
        kind: 'ai',
        pageCount: rendered.pageCount,
        pdfUrl: rendered.pdfUrl,
        pageUrls: rendered.pageUrls,
        templateId: null,
        design: { ...design, label: designLabel(design) },
      });
      setOrderCopy(db, order.id, copy);
      return c.json({ render, design, copy, direction, model: usedModel, latencyMs }, 201);
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
                attachmentImages: voucherPhotoFiles(order, path.join(dataDir, 'media')),
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

  // File upload. There is no type restriction: photographs, drawings, PDFs,
  // spreadsheets and anything else the customer sends are stored as sent. A
  // sidecar JSON keeps the original name and content type for serving.
  app.post('/api/media', uploadBodyLimit, async (c) => {
    const parsed = await readJsonObject(c);
    if (parsed.error) return fail(c, 400, parsed.error);
    const body = parsed.body ?? {};

    let data = typeof body.data === 'string' ? body.data.trim() : '';
    if (data.startsWith('data:')) {
      const comma = data.indexOf(',');
      if (comma === -1) return fail(c, 400, 'The file data is not a valid data URL.');
      data = data.slice(comma + 1);
    }
    if (data === '' || !/^[A-Za-z0-9+/=\s]+$/.test(data)) {
      return fail(c, 400, 'Field "data" must be base64 file data.');
    }
    const bytes = Buffer.from(data, 'base64');
    if (bytes.length === 0) return fail(c, 400, 'The file is empty.');
    if (bytes.length > MAX_UPLOAD_BYTES) {
      return fail(c, 413, `The file is too large. The limit is ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB.`);
    }

    const originalName =
      typeof body.name === 'string' && body.name.trim() !== ''
        ? body.name.trim().slice(0, 200)
        : 'attachment';
    const contentType =
      typeof body.contentType === 'string' && body.contentType.trim() !== ''
        ? body.contentType.trim().toLowerCase().slice(0, 100)
        : 'application/octet-stream';

    const mediaDir = path.join(dataDir, 'media');
    mkdirSync(mediaDir, { recursive: true });
    const id = randomUUID();
    const extension = uploadExtension(originalName, contentType);
    const name = `${id}.${extension}`;
    writeFileSync(path.join(mediaDir, name), bytes);
    writeFileSync(
      path.join(mediaDir, `${id}.json`),
      JSON.stringify({ name: originalName, contentType, bytes: bytes.length }),
    );
    return c.json({ url: `/media/${name}`, contentType, bytes: bytes.length, name: originalName }, 201);
  });

  // Any uploaded file is served back with the type it was uploaded with. Images,
  // PDFs and text open inline, everything else downloads with its own name.
  app.get('/media/:name', (c) => {
    const name = c.req.param('name');
    if (!/^[A-Za-z0-9._-]+$/.test(name) || name.includes('..')) {
      return fail(c, 404, 'File not found.');
    }
    const mediaDir = path.join(dataDir, 'media');
    const extension = path.extname(name).slice(1).toLowerCase();
    const knownType = IMAGE_TYPES.get(extension);
    const sidecarPath = path.join(mediaDir, `${path.basename(name, path.extname(name))}.json`);
    let meta = null;
    try {
      meta = JSON.parse(readFileSync(sidecarPath, 'utf8'));
    } catch {
      meta = null;
    }
    const contentType = knownType ?? meta?.contentType ?? 'application/octet-stream';
    const inline =
      contentType.startsWith('image/') ||
      contentType === 'application/pdf' ||
      contentType.startsWith('text/');
    const headers = inline
      ? {}
      : {
          'Content-Disposition': `attachment; filename="${String(meta?.name ?? name).replace(/["\\\r\n]/g, '_')}"`,
        };
    return sendFile(c, path.join(mediaDir, name), contentType, headers);
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
