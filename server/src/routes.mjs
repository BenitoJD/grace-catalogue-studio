import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
  getAssistantSession,
  getOrder,
  getRender,
  getRenderHtml,
  llmCacheStats,
  pruneLlmCache,
  putAssistantSession,
  putLlmCache,
  listCustomers,
  listMaterials,
  listOrders,
  listRenders,
  listRendersForOrder,
  setOrderAttachments,
  setOrderAnnotations,
  setOrderCopy,
  setSetting,
  updateMaterial,
  updateOrder,
} from './db.mjs';
import { publicProviders } from './providers.mjs';
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
  DESIGNER_MAX_TOKENS,
  DESIGNER_TEMPERATURE,
  DESIGNER_TRIES,
  buildDesignerMessages,
  buildDesignerRepairMessages,
  buildPolishMessages,
  buildQaMessages,
  buildQualityMessages,
  parseQualityReview,
  QUALITY_THRESHOLD,
  compileGenerativeBrochure,
  samplePhotoPlates,
  designLabel,
  parseDesignerReply,
  photoProfiles,
  readCopyOverride,
  themeFromPalettes,
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
  LlmError,
  llmFailureBody,
  parseCopyReply,
  parseJsonObject,
  publicLlmSettings,
  readStoredLlmSettings,
  requestChat,
  resolveLlmConfig,
  validateApiKey,
  validateEndpoint,
  validateModel,
  validateProvider,
} from './llm.mjs';
import { createLogger, parseLogLevel } from './logger.mjs';
import { colourName, photoPalette } from './image-palette.mjs';
import { analyseImage } from './image-analysis.mjs';
import { detailPlatesFor } from './image-detail.mjs';
import { readPicturesWithVision, visionEnabled } from './vision.mjs';
import { runAssistantTurn } from './assistant.mjs';
import {
  finishAssistantProgress,
  getAssistantProgress,
  setAssistantProgress,
} from './assistant-progress.mjs';
import {
  ensurePdfPages,
  isPdf,
  orderPhotoPaths,
  pdfPreviewDir,
} from './pdf-preview.mjs';
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
// The pictures decide the piece and the room, and measurements are not part of
// the product any more, so no order text field is mandatory.
const REQUIRED_ORDER_FIELDS = new Set();

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
  const { copy_json: _copyJson, attachments_json: _attachmentsJson, annotations_json: _annotationsJson, ...payload } = order;
  return payload;
}

const MAX_ORDER_ATTACHMENTS = 20;

function colourLineFallback(colours) {
  return colours.length > 0 ? colours.join(', ') : 'warm neutrals';
}

// The words printed on a customer's PDF sheet, which usually name the room
// and the piece far better than the file name does.
async function pdfSheetText(mediaDir, mediaUrl) {
  const filePath = path.join(mediaDir, path.basename(String(mediaUrl)));
  try {
    const { stdout } = await execFileAsync('pdftotext', ['-l', '1', filePath, '-'], {
      timeout: 15000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return capText(String(stdout ?? '').replace(/\s+/g, ' ').trim(), 1200);
  } catch {
    return '';
  }
}

// Reading the piece and the room from the customer's own words and file names.
function inferOrderFacts(attachments, brief = '', sheetText = '') {
  const names = (attachments ?? []).map((file) => String(file.name ?? '')).join(' ');
  const text = `${names} ${brief} ${sheetText}`.toLowerCase();
  const room =
    /master.*(bed|room)|(bed|room).*master/.test(text)
      ? 'Master Bedroom'
      : /guest.*(bed|room)|(bed|room).*guest/.test(text)
        ? 'Guest Bedroom'
        : /kids|children/.test(text)
          ? 'Kids Room'
          : /bedroom|bed room/.test(text)
            ? 'Bedroom'
            : /tv|television|living|hall/.test(text)
              ? 'Living Room'
              : /kitchen/.test(text)
                ? 'Kitchen'
                : /dining/.test(text)
                  ? 'Dining Room'
                  : /study|office/.test(text)
                    ? 'Study'
                    : /pooja|puja/.test(text)
                      ? 'Pooja Room'
                      : 'Interior';
  const title =
    /tv|television/.test(text)
      ? 'TV Unit'
      : /kitchen/.test(text)
        ? 'Modular Kitchen'
        : /wardrobe|almirah|cupboard/.test(text)
          ? 'Wardrobe'
          : /bed/.test(text)
            ? 'Bedroom Set'
            : /dining/.test(text)
              ? 'Dining Set'
              : /pooja|puja/.test(text)
                ? 'Pooja Unit'
                : /study|office/.test(text)
                  ? 'Study Unit'
                  : /panel|panelling/.test(text)
                    ? 'Wall Panelling'
                    : 'Interior Project';
  return { title, room };
}

/**
 * What the pictures show, in words the intake assistant can repeat back for a
 * confirmation question: colour names read from the frames plus the likely
 * piece and room taken from the file names.
 */
async function pictureReadingFor(
  attachments,
  { mediaDir, dataDir, pdftoppmBin, config, logger },
) {
  const list = Array.isArray(attachments) ? attachments : [];
  if (list.length === 0) return null;
  let sheetText = '';
  for (const file of list) {
    if (/pdf/i.test(String(file.contentType ?? '')) || /\.pdf$/i.test(String(file.url ?? ''))) {
      sheetText += ` ${await pdfSheetText(mediaDir, file.url)}`;
    }
  }
  const facts = inferOrderFacts(list, '', sheetText);
  const colours = [];
  try {
    const paths = await orderPhotoPaths({ attachments: list }, { mediaDir, dataDir, pdftoppmBin });
    for (const filePath of paths.slice(0, 6)) {
      const analysis = analyseImage(filePath);
      for (const swatch of analysis?.palette ?? []) {
        if (colours.length < 6 && !colours.includes(swatch.name)) colours.push(swatch.name);
      }
      for (const candidate of analysis?.candidates ?? []) {
        if (colours.length < 6 && !colours.includes(candidate.name)) colours.push(candidate.name);
      }
    }
  } catch {
    // A picture that cannot be read simply gives a shorter reading.
  }
  const sheetLine = sheetText.trim() !== ''
    ? ` The sheet itself reads: "${capText(sheetText.trim(), 140)}".`
    : '';

  // If the configured model can see, let it read the first picture. This is
  // what makes the confirmation question describe the actual project.
  let paths = [];
  try {
    paths = await orderPhotoPaths({ attachments: list }, { mediaDir, dataDir, pdftoppmBin });
  } catch {
    paths = [];
  }
  const visionInsights = visionEnabled(config)
    ? await readPicturesWithVision({
        config,
        requestChat,
        filePaths: paths,
        logger,
      })
    : null;
  const insight = visionInsights?.[0] ?? null;
  if (insight) {
    const summary = insight.summary || `a ${facts.title.toLowerCase()} in the ${facts.room.toLowerCase()}`;
    const pieceLine = insight.piece || facts.title;
    const roomLine = insight.room || facts.room;
    const seenColours = insight.colours.length > 0 ? insight.colours.join(', ') : colourLineFallback(colours);
    const detailNames = insight.details
      .map((detail) => (typeof detail === 'string' ? detail : detail?.label))
      .filter(Boolean);
    const detailLine = detailNames.length > 0
      ? ` Details worth magnifying: ${detailNames.join(', ')}.`
      : '';
    return {
      title: pieceLine,
      room: roomLine,
      text: `Picture reading: ${summary} The piece looks like ${pieceLine.toLowerCase()} in the ${roomLine.toLowerCase()}. Colours seen: ${seenColours}.${detailLine}${sheetLine}`,
    };
  }

  const colourLine = colourLineFallback(colours);
  // The same per picture reading the designer receives, so the pages and the
  // magnifier captions are composed from what was actually seen.
  const photos = paths.slice(0, 6).map((filePath, index) => {
    const analysis = analyseImage(filePath);
    const pictureInsight = visionInsights?.[index] ?? null;
    return {
      photo: `photo${index + 1}`,
      summary: pictureInsight?.summary ?? '',
      piece: pictureInsight?.piece ?? facts.title,
      room: pictureInsight?.room ?? facts.room,
      colours: (pictureInsight?.colours?.length ? pictureInsight.colours : (analysis?.palette ?? []).map((swatch) => swatch.name)).slice(0, 5),
      details: (pictureInsight?.details?.length
        ? pictureInsight.details.map((detail) => (typeof detail === 'string' ? detail : detail?.label))
        : (analysis?.candidates ?? []).map((candidate) => candidate.label)
      )
        .filter(Boolean)
        .slice(0, 4),
      palette: (analysis?.palette ?? []).slice(0, 4),
      candidates: (analysis?.candidates ?? []).map((candidate) => candidate.label),
    };
  });
  return {
    title: facts.title,
    room: facts.room,
    photos,
    text: `Picture reading: likely a ${facts.title.toLowerCase()} in the ${facts.room.toLowerCase()}. Colours read from the pictures: ${colourLine}.${sheetLine}`,
  };
}

// The name the customer gave an uploaded file, read from its sidecar.
function uploadedFileName(mediaDir, mediaUrl) {
  try {
    const meta = JSON.parse(
      readFileSync(
        path.join(mediaDir, `${path.basename(String(mediaUrl), path.extname(String(mediaUrl)))}.json`),
        'utf8',
      ),
    );
    return typeof meta.name === 'string' && meta.name.trim() !== ''
      ? meta.name.trim()
      : path.basename(String(mediaUrl));
  } catch {
    return path.basename(String(mediaUrl));
  }
}
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

  // The Pi agent loop for the studio chat. Tests replace `run` with a scripted
  // runner; production uses the real one.
  const assistantEnabled = String(process.env.PI_ASSISTANT ?? 'on').toLowerCase() !== 'off';
  const assistantRuntime = { run: options.assistantRunner ?? runAssistantTurn };
  app.assistantRuntime = assistantRuntime;
  // One turn at a time per chat session, so two sends cannot fight over the
  // same transcript or create two orders.
  const assistantLocks = new Map();
  app.assistantEnabled = assistantEnabled;
  const lifecycle = { shuttingDown: false };

  /**
   * Write the brochure words with the model, then repair them once if the
   * quality rules are broken. The copy route and the brochure route share this
   * so a printed brochure always carries the approved copy.
   */
  async function writeCopyWithModel(order, config) {
    let result = await requestChat({
      provider: config.provider,
      endpoint: config.endpoint,
      model: config.model,
      apiKey: config.apiKey,
      messages: buildCopyMessages(order, order.brief ?? ''),
      maxTokens: COPY_MAX_TOKENS,
      temperature: COPY_TEMPERATURE,
      timeoutMs: 120_000,
    });
    let copy = parseCopyReply(result.content);
    let issues = copyQualityIssues(copy, order);
    if (issues.length > 0) {
      logger.warn('Brochure copy needed a repair pass.', { issues });
      result = await requestChat({
        provider: config.provider,
        endpoint: config.endpoint,
        model: config.model,
        apiKey: config.apiKey,
        messages: buildCopyRepairMessages(order, order.brief ?? '', copy, issues),
        maxTokens: COPY_MAX_TOKENS,
        temperature: COPY_TEMPERATURE,
        timeoutMs: 120_000,
      });
      copy = parseCopyReply(result.content);
      issues = copyQualityIssues(copy, order);
      if (issues.length > 0) {
        logger.warn('Brochure copy still has issues after the repair pass.', { issues });
      }
    }
    return { copy, model: result.model, latencyMs: result.latencyMs };
  }

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
  app.get('/health', (c) =>
    c.json({ ok: true, version: API_VERSION, assistant: assistantEnabled }),
  );

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

    let order = createOrder(db, {
      ...fields,
      customerId: customerId.value,
      attachments: attachments.value,
    });
    // The pictures and the words tell us the piece and the room; the studio is
    // never asked for them.
    if (!order.title.trim() || !order.room.trim()) {
      let sheetText = '';
      for (const file of attachments.value) {
        const isPdf =
          /pdf/i.test(String(file.contentType ?? '')) || /\.pdf$/i.test(String(file.url ?? ''));
        if (isPdf) sheetText += ` ${await pdfSheetText(path.join(dataDir, 'media'), file.url)}`;
      }
      const inferred = inferOrderFacts(
        attachments.value,
        fields.brief ?? '',
        capText(sheetText, 2000),
      );
      order = updateOrder(db, order.id, {
        ...(order.title.trim() ? {} : { title: inferred.title }),
        ...(order.room.trim() ? {} : { room: inferred.room }),
      });
    }
    return c.json(orderPayload(order), 201);
  });

  app.get('/api/orders/:id', (c) => {
    const order = getOrder(db, c.req.param('id'));
    if (!order) return fail(c, 404, 'Order not found.');
    return c.json(orderPayload(order));
  });

  // The colours read from this order's own photographs. The brochure prints
  // them, and the studio wants to see the same chips on screen.
  app.get('/api/orders/:id/palettes', async (c) => {
    const order = getOrder(db, c.req.param('id'));
    if (!order) return fail(c, 404, 'Order not found.');
    const paths = await orderPhotoPaths(order, {
      mediaDir: path.join(dataDir, 'media'),
      dataDir,
      pdftoppmBin,
    });
    const palettes = paths
      .map((filePath, index) => ({ photo: `photo${index + 1}`, colors: photoPalette(filePath) }))
      .filter((entry) => Array.isArray(entry.colors) && entry.colors.length > 0);
    return c.json({
      palettes: palettes.map((entry) => ({
        photo: entry.photo,
        colors: entry.colors,
        names: entry.colors.map((hex) => colourName(hex)),
      })),
    });
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

    if ('annotations' in parsed.body) {
      const annotations = parsed.body.annotations;
      if (!Array.isArray(annotations) || annotations.length > 40) {
        return fail(c, 400, 'Field "annotations" must be a list of up to 40 marked areas.');
      }
      const clean = [];
      for (const mark of annotations) {
        if (!mark || typeof mark !== 'object') return fail(c, 400, 'Every mark must be an object.');
        const photo = String(mark.photo ?? '').trim();
        if (!/^photo\d+$/.test(photo)) return fail(c, 400, 'Every mark needs a photo token like "photo1".');
        const x = Number(mark.x);
        const y = Number(mark.y);
        if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 100 || y < 0 || y > 100) {
          return fail(c, 400, 'Mark positions must be percentages between 0 and 100.');
        }
        const label = String(mark.label ?? '').trim().slice(0, 80);
        const colourName = String(mark.colourName ?? '').trim().slice(0, 40);
        const colourHex = String(mark.colourHex ?? '').trim().toUpperCase();
        if (label === '' || colourName === '') return fail(c, 400, 'A mark needs a detail label and a colour name.');
        if (!/^#[0-9A-F]{6}$/.test(colourHex)) return fail(c, 400, 'A mark colour must look like #B98A55.');
        clean.push({ photo, x, y, label, colourName, colourHex });
      }
      setOrderAnnotations(db, id, clean);
      return c.json(orderPayload(getOrder(db, id)));
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
      debugStack: error instanceof Error ? String(error.stack).slice(0, 600) : String(error).slice(0, 200),
    });
    return c.json(llmFailureBody(error), 502);
  }

  // The provider catalog is public: presets, their default models and where to
  // create a key. No secrets are involved.
  app.get('/api/llm/providers', (c) => c.json({ providers: publicProviders() }));

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
    const allowedFields = new Set(['provider', 'endpoint', 'model', 'apiKey']);
    for (const key of Object.keys(body)) {
      if (!allowedFields.has(key)) {
        return fail(
          c,
          400,
          `Unknown field "${key}". Allowed fields are provider, endpoint, model and apiKey.`,
        );
      }
    }
    let provider;
    if ('provider' in body) {
      const result = validateProvider(body.provider);
      if (result.error) return fail(c, 400, result.error);
      provider = result.value;
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

    if (provider !== undefined) {
      const previous = readStoredLlmSettings(db).provider ?? '';
      setSetting(db, LLM_SETTING_KEYS.provider, provider);
      // Switching provider without naming an endpoint or model drops the old
      // ones, so the new provider's defaults apply instead of a stale URL.
      if (provider !== previous) {
        if (endpoint === undefined) deleteSetting(db, LLM_SETTING_KEYS.endpoint);
        if (model === undefined) deleteSetting(db, LLM_SETTING_KEYS.model);
      }
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
        provider: config.provider,
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
      ? buildLlmCacheKey({ provider: config.provider, endpoint: config.endpoint, model: config.model, messages })
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
        provider: config.provider,
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
          provider: config.provider,
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
      ? buildLlmCacheKey({ provider: config.provider, endpoint: config.endpoint, model: config.model, messages: baseMessages })
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
      const generated = await writeCopyWithModel(order, config);
      const copy = generated.copy;
      setOrderCopy(db, id, copy);
      if (cacheKey) {
        putLlmCache(db, {
          key: cacheKey,
          provider: config.provider,
          endpoint: config.endpoint,
          model: config.model,
          responseJson: JSON.stringify({ copy, model: generated.model }),
        });
      }
      return c.json({ copy, model: generated.model, latencyMs: generated.latencyMs, cached: false });
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
      let attachmentContext = await describeAttachments(
        attachments.value,
        path.join(dataDir, 'media'),
      );
      // What the pictures show, so the assistant can propose it and ask for a
      // confirmation instead of asking the customer for the room or the piece.
      const reading = await pictureReadingFor(attachments.value, {
        mediaDir: path.join(dataDir, 'media'),
        dataDir,
        pdftoppmBin,
        config,
        logger,
      });
      if (reading) {
        attachmentContext = `${attachmentContext}\n${reading.text}\nThe customer has not been asked for the room or the piece: read them from this and ask for a short confirmation. If the customer name is unknown, ask "Who is the customer?"`;
      }
      const intakeMessages = buildIntakeMessages(
        cleanMessages,
        body.draft ?? {},
        attachmentContext,
      );
      let result = await requestChat({
        provider: config.provider,
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
          provider: config.provider,
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

  // One chat turn, driven by the Pi agent. The agent reads pictures, creates
  // the order, designs the brochure and applies edits through studio tools, so
  // the chat is conversational instead of a fixed form.
  app.post('/api/assistant', async (c) => {
    if (!assistantEnabled) {
      return fail(c, 503, 'The studio assistant is switched off on this machine.');
    }
    const parsed = await readJsonObject(c);
    if (parsed.error) return fail(c, 400, parsed.error);
    const config = resolveLlmConfig(db, llmEnv);
    if (!config.configured) return fail(c, 400, NOT_CONFIGURED_MESSAGE);

    const messages = Array.isArray(parsed.body.messages) ? parsed.body.messages : [];
    if (messages.length === 0) return fail(c, 400, 'Field "messages" must hold the conversation.');
    const cleanMessages = [];
    for (const message of messages) {
      const role = message?.role === 'assistant' ? 'assistant' : 'user';
      const content = typeof message?.content === 'string' ? message.content.trim() : '';
      if (content === '') continue;
      if (content.length > 4000) return fail(c, 400, 'A chat message is too long.');
      cleanMessages.push({ role, content });
    }
    if (cleanMessages.length === 0) return fail(c, 400, 'There is nothing to answer yet.');

    let orderId =
      typeof parsed.body.orderId === 'string' ? parsed.body.orderId.trim().slice(0, 100) : '';
    if (orderId !== '' && !getOrder(db, orderId)) return fail(c, 404, 'Order not found.');

    const requestedSession =
      typeof parsed.body.sessionId === 'string' ? parsed.body.sessionId.trim().slice(0, 120) : '';
    const sessionId = requestedSession !== '' ? requestedSession : randomUUID();
    const storedSession = getAssistantSession(db, sessionId);
    if (orderId === '' && storedSession?.orderId) orderId = storedSession.orderId;
    if (assistantLocks.has(sessionId)) {
      return fail(c, 409, 'The assistant is still working on the previous message.');
    }
    assistantLocks.set(sessionId, true);
    const progressUpdate = (update) => setAssistantProgress(sessionId, update);
    progressUpdate({ stage: 'start', label: 'Understanding your request' });

    const attachments = readAttachments(parsed.body);
    if (attachments.error) return fail(c, 400, attachments.error);

    // Files sent with an existing order are attached before the agent runs.
    if (orderId !== '' && attachments.value.length > 0) {
      const request = new Request(`http://studio.local/api/orders/${encodeURIComponent(orderId)}/edit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          message: 'New pictures arrived for this order. Use them in the brochure.',
          attachments: attachments.value,
        }),
      });
      const response = await app.fetch(request);
      if (!response.ok) {
        return fail(c, 400, 'The new files could not be attached to the order.');
      }
    }

    const callApi = (path, init) => app.fetch(new Request(`http://studio.local${path}`, init));
    try {
      const result = await assistantRuntime.run({
        config,
        messages: cleanMessages,
        attachments: attachments.value,
        orderId: orderId === '' ? null : orderId,
        previousMessages: storedSession?.messages ?? [],
        callApi,
        logger,
        onProgress: progressUpdate,
      });
      const finalOrderId = result.orderId ?? (orderId === '' ? null : orderId);
      const order = finalOrderId ? getOrder(db, finalOrderId) : null;
      try {
        putAssistantSession(db, {
          id: sessionId,
          orderId: finalOrderId ?? null,
          messages: result.transcript ?? storedSession?.messages ?? [],
        });
      } catch (error) {
        logger.warn('The assistant session could not be saved.', {
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      finishAssistantProgress(sessionId, {
        label: result.render ? 'Brochure printed' : finalOrderId ? 'Order ready' : 'Answered',
      });
      return c.json({
        assistant: true,
        sessionId,
        reply: result.reply,
        order: order ? orderPayload(order) : null,
        orderId: finalOrderId,
        orderNo: result.orderNo ?? order?.orderNo ?? null,
        render: result.render ?? null,
        review: result.review ?? null,
        toolCalls: Array.isArray(result.toolCalls) ? result.toolCalls : [],
        usage: result.usage ?? null,
        failed: result.failed === true,
        failure: result.failure ?? null,
      });
    } catch (error) {
      finishAssistantProgress(sessionId, { label: 'The assistant stopped', stage: 'error' });
      return llmFailureResponse(c, error);
    } finally {
      assistantLocks.delete(sessionId);
    }
  });

  // Every page of every picture or PDF attachment, in order, for the viewer.
  async function orderPageFiles(order) {
    const mediaDir = path.join(dataDir, 'media');
    const pages = [];
    for (const file of order.attachments ?? []) {
      const url = String(file.url ?? '');
      if (!/^\/media\/[A-Za-z0-9._-]+$/.test(url)) continue;
      const mediaFile = path.join(mediaDir, path.basename(url));
      if (!existsSync(mediaFile)) continue;
      let signature = Buffer.alloc(0);
      try {
        signature = readFileSync(mediaFile).subarray(0, 8);
      } catch {
        signature = Buffer.alloc(0);
      }
      const isPdfFile =
        signature.subarray(0, 4).toString('ascii') === '%PDF' || /\.pdf$/i.test(url);
      const isImageFile =
        (signature[0] === 0x89 && signature[1] === 0x50) ||
        (signature[0] === 0xff && signature[1] === 0xd8) ||
        /\.(png|jpe?g|webp)$/i.test(url);
      if (isPdfFile) {
        try {
          const pageFiles = await ensurePdfPages(dataDir, mediaDir, url, pdftoppmBin);
          pageFiles.forEach((pageFile, pageIndex) => {
            pages.push({
              filePath: pageFile,
              name: file.name ?? path.basename(url),
              label: `${file.name ?? 'Sheet'} page ${pageIndex + 1}`,
              pageIndex,
              pageCount: pageFiles.length,
            });
          });
        } catch (error) {
          logger.warn('A PDF could not be unpacked for the viewer.', {
            reason: error instanceof Error ? error.message : String(error),
          });
        }
        continue;
      }
      if (!isImageFile) continue;
      pages.push({
        filePath: mediaFile,
        name: file.name ?? path.basename(url),
        label: file.name ?? path.basename(url),
        pageIndex: 0,
        pageCount: 1,
      });
    }
    return pages;
  }

  app.get('/api/orders/:id/pages', async (c) => {
    const order = getOrder(db, c.req.param('id'));
    if (!order) return fail(c, 404, 'Order not found.');
    const files = await orderPageFiles(order);
    return c.json({
      pages: files.map((page, index) => ({
        url: page.filePath.split('/').pop(),
        pageUrl: `/api/orders/${order.id}/pages/${index}/image`,
        name: page.name,
        label: page.label,
        pageIndex: index,
        pageCount: files.length,
      })),
      annotations: order.annotations ?? [],
    });
  });

  app.get('/api/orders/:id/pages/:index/image', async (c) => {
    const order = getOrder(db, c.req.param('id'));
    if (!order) return fail(c, 404, 'Order not found.');
    const files = await orderPageFiles(order);
    const index = Number.parseInt(c.req.param('index'), 10);
    const page = files[index];
    if (!page) return fail(c, 404, 'Page not found.');
    const type = /\.png$/i.test(page.filePath) ? 'image/png' : 'image/jpeg';
    return sendFile(c, page.filePath, type, { 'Cache-Control': 'private, max-age=300' });
  });

  // Reopen the conversation for an order in History. Returns the stored Pi
  // session and the plain text messages, so the chat can be rehydrated.
  app.get('/api/orders/:id/assistant-session', (c) => {
    const order = getOrder(db, c.req.param('id'));
    if (!order) return fail(c, 404, 'Order not found.');
    const row = db
      .prepare('SELECT id, messages_json, updated_at FROM assistant_sessions WHERE order_id = ? ORDER BY updated_at DESC LIMIT 1')
      .get(order.id);
    if (!row) return c.json({ sessionId: null, messages: [], updatedAt: null });
    let stored = [];
    try {
      stored = JSON.parse(row.messages_json);
    } catch {
      stored = [];
    }
    const text = (content) =>
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content
              .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
              .map((block) => block.text)
              .join(' ')
          : '';
    const messages = (Array.isArray(stored) ? stored : [])
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      .map((message) => ({ role: message.role, content: text(message.content) }))
      .filter((message) => message.content.trim() !== '')
      .slice(-40);
    return c.json({ sessionId: row.id, messages, updatedAt: row.updated_at });
  });

  // The live step the chat shows while an agent turn runs.
  app.get('/api/assistant/progress/:sessionId', (c) => {
    const progress = getAssistantProgress(c.req.param('sessionId'));
    if (!progress) return c.json({ progress: null });
    return c.json({ progress });
  });

  // The model designs and typesets the brochure. No template is chosen: the
  // order, the photographs, the approved copy and the studio direction go to
  // the model, which authors the four pages itself. A chat edit carries the
  // last document in so the model changes only what the studio asked for.
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

    let editNote = '';
    if (body.edit !== undefined) {
      if (typeof body.edit !== 'string') {
        return fail(c, 400, 'Field "edit" must be a sentence.');
      }
      editNote = body.edit.trim().slice(0, 1200);
    }

    let copyOverride = null;
    if (body.copy !== undefined) {
      try {
        copyOverride = readCopyOverride(body.copy);
      } catch (error) {
        return fail(c, 400, error.message, 'invalid_reply');
      }
    }

    const config = resolveLlmConfig(db, llmEnv);
    if (!config.configured) return fail(c, 400, NOT_CONFIGURED_MESSAGE);

    const photoPaths = await orderPhotoPaths(order, {
      mediaDir: path.join(dataDir, 'media'),
      dataDir,
      pdftoppmBin: config.pdftoppmBin,
    });
    const attached = photoPaths.map((filePath) => pathToFileURL(filePath).href);
    if (attached.length === 0) {
      return fail(
        c,
        400,
        'Attach at least one photograph or PDF page to this order before designing the brochure. Customer photography always comes from the chat, never from a stock library.',
      );
    }
    const photoShapes = photoProfiles(attached, templatesDir);
    const photoPalettes = {};
    const photoDetails = {};
    photoPaths.forEach((filePath, index) => {
      const palette = photoPalette(filePath);
      if (palette) photoPalettes[`photo${index + 1}`] = palette;
      const analysis = analyseImage(filePath);
      if (analysis?.candidates?.length) {
        const plates = detailPlatesFor(filePath, analysis.candidates);
        if (plates.length > 0) photoDetails[`photo${index + 1}`] = plates;
      }
    });

    try {
      // 1. Words. Studio edited copy wins, then the stored copy, then a fresh
      // pass with the usual quality repair.
      let copy = copyOverride ?? order.copy ?? null;
      let usedModel = null;
      let latencyMs = 0;
      if (!copy) {
        const generated = await writeCopyWithModel(order, config);
        copy = generated.copy;
        usedModel = generated.model;
        latencyMs = generated.latencyMs;
      }

      // 2. The document the studio already has, so an edit changes one thing
      // instead of throwing the design away.
      let previousHtml = '';
      if (editNote !== '') {
        const latest = listRendersForOrder(db, order.id)
          .filter((render) => render.kind === 'ai')
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
        if (latest) previousHtml = getRenderHtml(db, latest.id) ?? '';
      }

      // 3. Design and typeset, then ask again with the exact print problems.
      // The vision reading names the room, the piece and the joinery details,
      // so the model composes for the actual project.
      const reading = await pictureReadingFor(order.attachments ?? [], {
        mediaDir: path.join(dataDir, 'media'),
        dataDir,
        pdftoppmBin,
        config,
        logger,
      });
      const messages = buildDesignerMessages({
        order,
        brief,
        direction,
        copy,
        photos: attached,
        photoShapes,
        photoPalettes,
        pictureReading: reading?.text ?? '',
        pictureAnalysis: reading?.photos ?? [],
        annotations: order.annotations ?? [],
        previousHtml,
        editNote,
      });
      const palettePhotos = Object.keys(photoPalettes)
        .map((key) => Number.parseInt(key.replace('photo', ''), 10))
        .filter((index) => Number.isInteger(index));
      let html = null;
      let acceptedReply = '';
      let bestHtml = null;
      let bestReply = '';
      let bestScore = 0;
      let previousReply = '';
      let lastIssues = '';
      for (let attempt = 1; attempt <= DESIGNER_TRIES && !html; attempt += 1) {
        const requestMessages =
          attempt === 1 ? messages : buildDesignerRepairMessages(messages, previousReply, lastIssues);
        const result = await requestChat({
          provider: config.provider,
          endpoint: config.endpoint,
          model: config.model,
          apiKey: config.apiKey,
          messages: requestMessages,
          maxTokens: DESIGNER_MAX_TOKENS,
          temperature: DESIGNER_TEMPERATURE,
          timeoutMs: 300_000,
        });
        usedModel = result.model;
        latencyMs = result.latencyMs;
        previousReply = result.content;
        try {
          const designTheme = themeFromPalettes(photoPalettes);
          const document = parseDesignerReply(
            result.content,
            attached.length,
            palettePhotos,
            designTheme,
            order.annotations ?? [],
            Object.keys(photoDetails).length,
          );
          acceptedReply = result.content;
          html = compileGenerativeBrochure({
            order,
            materials: listMaterials(db),
            templatesDir,
            dataDir,
            attachmentImages: attached,
            photoPalettes,
            photoDetails,
            copy,
            pages: document.pages,
            styles: document.styles,
          });
          if (html && String(process.env.DESIGN_QUALITY ?? 'on').toLowerCase() !== 'off') {
            try {
              const judged = await requestChat({
                provider: config.provider,
                endpoint: config.endpoint,
                model: config.model,
                apiKey: config.apiKey,
                messages: buildQualityMessages({ html: result.content, round: attempt }),
                maxTokens: 1200,
                temperature: 0.2,
                timeoutMs: 180_000,
              });
              const verdict = parseQualityReview(judged.content);
              if (verdict) {
                logger.info('The art director judged the pamphlet.', {
                  attempt,
                  score: verdict.score,
                });
                if (verdict.score > bestScore) {
                  bestScore = verdict.score;
                  bestHtml = html;
                  bestReply = result.content;
                }
                if (verdict.score < QUALITY_THRESHOLD) {
                  lastIssues = `The art director scored this ${verdict.score}/10, below the ${QUALITY_THRESHOLD}/10 world class gate. Apply these fixes: ${verdict.fixes.join('; ') || 'raise the art direction and composition'}`;
                  logger.info('The art director asked for another design round.', {
                    attempt,
                    score: verdict.score,
                  });
                  html = null;
                  continue;
                }
              }
            } catch (error) {
              logger.warn('The quality review could not run; accepting the valid design.', {
                reason: error instanceof Error ? error.message : String(error),
              });
            }
          }
        } catch (error) {
          if (error?.type !== 'invalid_reply') throw error;
          lastIssues = error.message;
          logger.warn('The brochure design did not pass the print checks, asking once more.', {
            attempt,
            reason: capText(lastIssues, 240),
          });
        }
      }
      if (!html && bestHtml) {
        html = bestHtml;
        acceptedReply = bestReply;
        logger.info('Accepting the best art directed round after the quality loop.', {
          score: bestScore,
          threshold: QUALITY_THRESHOLD,
        });
      }
      if (html && acceptedReply !== '' && String(process.env.DESIGN_POLISH ?? 'on').toLowerCase() !== 'off') {
        try {
          const polished = await requestChat({
            provider: config.provider,
            endpoint: config.endpoint,
            model: config.model,
            apiKey: config.apiKey,
            messages: buildPolishMessages({ html: acceptedReply }),
            maxTokens: DESIGNER_MAX_TOKENS,
            temperature: 0.5,
            timeoutMs: 300_000,
          });
          const polishedTheme = themeFromPalettes(photoPalettes);
          const document = parseDesignerReply(
            polished.content,
            attached.length,
            palettePhotos,
            polishedTheme,
            order.annotations ?? [],
            Object.keys(photoDetails).length,
          );
          html = compileGenerativeBrochure({
            order,
            materials: listMaterials(db),
            templatesDir,
            dataDir,
            attachmentImages: attached,
            photoPalettes,
            photoDetails,
            copy,
            pages: document.pages,
            styles: document.styles,
          });
          logger.info('The art director pass refined the brochure.');
        } catch (error) {
          // A polish pass must never lose a valid document.
          logger.warn('The art director pass was skipped.', {
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const qaPasses = Number.parseInt(process.env.DESIGN_QA_PASSES ?? '2', 10);
      if (html && acceptedReply !== '' && Number.isFinite(qaPasses) && qaPasses > 0) {
        let reviewed = acceptedReply;
        for (let pass = 1; pass <= Math.min(qaPasses, 4); pass += 1) {
          try {
            const result = await requestChat({
              provider: config.provider,
              endpoint: config.endpoint,
              model: config.model,
              apiKey: config.apiKey,
              messages: buildQaMessages({ html: reviewed, pass }),
              temperature: 0.35,
              timeoutMs: 300_000,
            });
            const reviewedTheme = themeFromPalettes(photoPalettes);
            const document = parseDesignerReply(
              result.content,
              attached.length,
              palettePhotos,
              reviewedTheme,
              order.annotations ?? [],
              Object.keys(photoDetails).length,
            );
            html = compileGenerativeBrochure({
              order,
              materials: listMaterials(db),
              templatesDir,
              dataDir,
              attachmentImages: attached,
              photoPalettes,
              photoDetails,
              copy,
              pages: document.pages,
              styles: document.styles,
            });
            reviewed = result.content;
            logger.info('The print review pass refined the brochure.', { pass });
          } catch (error) {
            logger.warn('The print review pass was skipped.', {
              pass,
              reason: error instanceof Error ? error.message : String(error),
            });
            break;
          }
        }
      }

      if (!html) {
        throw new LlmError(`The model could not produce a printable brochure. ${lastIssues}`, {
          type: 'invalid_reply',
        });
      }

      // 4. Print it and remember the document for the next chat edit.
      const renderId = newRenderId();
      const rendered = await renderer.renderHtml({ html, renderId });
      const design = {
        label: designLabel({ direction }),
        designed: true,
        direction,
      };
      const render = createRender(db, {
        id: renderId,
        orderId: order.id,
        kind: 'ai',
        pageCount: rendered.pageCount,
        pdfUrl: rendered.pdfUrl,
        pageUrls: rendered.pageUrls,
        templateId: null,
        design,
        html,
      });
      setOrderCopy(db, order.id, copy);
      return c.json({ render, design, copy, direction, model: usedModel, latencyMs }, 201);
    } catch (error) {
      return llmFailureResponse(c, error);
    }
  });

  // Plain language edits to an order that already has a brochure. The model
  // turns the sentence into order fields or new copy; the same sentence is then
  // handed to the brochure designer, which changes the pages it already has.
  app.post('/api/orders/:id/edit', async (c) => {
    let order = getOrder(db, c.req.param('id'));
    if (!order) return fail(c, 404, 'Order not found.');
    const parsed = await readOptionalJsonObject(c);
    if (parsed.error) return fail(c, 400, parsed.error);
    const body = parsed.body ?? {};
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (message.length > 1200) {
      return fail(c, 400, 'Field "message" must be a sentence under 1200 characters.');
    }
    const attachments = readAttachments(body);
    if (attachments.error) return fail(c, 400, attachments.error);
    if (message === '' && attachments.value.length === 0) {
      return fail(c, 400, 'Send a sentence, a file, or both.');
    }
    // New files join the order so the next brochure prints them. Duplicates
    // by URL are ignored; over the cap the whole edit is rejected.
    let attachmentsAdded = 0;
    if (attachments.value.length > 0) {
      const current = Array.isArray(order.attachments) ? order.attachments : [];
      const known = new Set(current.map((file) => file.url));
      const merged = [...current];
      for (const file of attachments.value) {
        if (!known.has(file.url)) {
          merged.push(file);
          known.add(file.url);
        }
      }
      if (merged.length > MAX_ORDER_ATTACHMENTS) {
        return fail(c, 400, `An order may hold at most ${MAX_ORDER_ATTACHMENTS} attachments.`);
      }
      attachmentsAdded = merged.length - current.length;
      if (attachmentsAdded > 0) order = setOrderAttachments(db, order.id, merged);
    }
    const config = resolveLlmConfig(db, llmEnv);
    if (!config.configured) return fail(c, 400, NOT_CONFIGURED_MESSAGE);
    const prompt = [
      'You edit one existing furniture order and its brochure for Jacob Design Studio, Nagercoil.',
      'The studio will speak naturally about a change. Reply with strict JSON only:',
      '{"reply":"one or two natural sentences saying what you changed","order":{...only changed order fields...},"copy":{...only changed copy fields, headline body closing...},"rerender":true}',
      'Order fields: title room width height depth shutters carcass backPanel shuttersMat drawers exterior interior hinges channels edgeShutter edgeCarcass edgeNote handle handleNote finishExt finishInt brief.',
      'Rules:',
      '- Change only what the studio asked for. Never invent a dimension, material, price, date or claim.',
      '- If the sentence is about the design, cover, colour, type, layout, photograph or mood, leave order and copy empty and set rerender true. The brochure designer reads the same sentence and changes the pages itself.',
      '- If the sentence only asks a question, or is too unclear to apply, answer it briefly, set rerender false, and return empty order and copy objects.',
      '- Do not rewrite the copy unless the studio asks for new words.',
      '- No em dashes. No markdown.',
      `Current order: ${JSON.stringify(order)}`,
      `Current copy: ${JSON.stringify(order.copy ?? {})}`,
      `Studio says: ${message !== '' ? message : `[The studio attached ${attachments.value.length} new file(s) to this order: ${attachments.value.map((file) => file.name).join(', ')}. Acknowledge them briefly and note anything they change.]`}`,
    ].join('\n');
    try {
      const result = await requestChat({
        provider: config.provider,
        endpoint: config.endpoint,
        model: config.model,
        apiKey: config.apiKey,
        messages: [
          { role: 'system', content: 'You edit orders and brochure copy. Reply with JSON only.' },
          { role: 'user', content: prompt },
        ],
        maxTokens: 1200,
        temperature: 0.2,
      });
      const reply = parseJsonObject(result.content);
      if (!reply || typeof reply !== 'object') throw new LlmError('The edit reply could not be read.', { type: 'invalid_reply' });
      const orderPatch = {};
      const allowedOrder = new Set(['title','room','width','height','depth','shutters','carcass','backPanel','shuttersMat','drawers','exterior','interior','hinges','channels','edgeShutter','edgeCarcass','edgeNote','handle','handleNote','finishExt','finishInt','brief']);
      for (const [key, value] of Object.entries(reply.order && typeof reply.order === 'object' ? reply.order : {})) {
        if (allowedOrder.has(key) && typeof value === 'string' && value.length <= 300) orderPatch[key] = value;
      }
      let copy = null;
      if (reply.copy && typeof reply.copy === 'object') {
        copy = { ...(order.copy ?? { headline: '', body: '', closing: '' }) };
        for (const key of ['headline','body','closing']) {
          if (typeof reply.copy[key] === 'string') copy[key] = capText(reply.copy[key], key === 'body' ? 2400 : 200);
        }
      }
      let updated = order;
      if (Object.keys(orderPatch).length > 0) updated = updateOrder(db, order.id, orderPatch);
      if (copy) updated = setOrderCopy(db, order.id, copy);
      const assistantReply = typeof reply.reply === 'string' && reply.reply.trim() !== ''
        ? capText(reply.reply.trim(), 400)
        : 'Done, I updated the order.';
      const changed =
        Object.keys(orderPatch).length > 0 || copy !== null || attachmentsAdded > 0;
      return c.json({
        reply: assistantReply,
        order: updated,
        copy: copy ?? order.copy ?? null,
        attachmentsAdded,
        rerender: reply.rerender === false ? false : changed || reply.rerender === true,
        changedOrder: Object.keys(orderPatch).length > 0,
      });
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

    if (kind === 'voucher') {
      const attachedFiles = voucherPhotoFiles(order, path.join(dataDir, 'media'));
      if (attachedFiles.length === 0) {
        return fail(
          c,
          400,
          'Attach at least one photograph to this order before rendering the voucher. Customer photography always comes from the chat, never from a stock library.',
        );
      }
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
                dataDir,
                variants,
                templateId,
                logger,
                attachmentImages: voucherPhotoFiles(order, path.join(dataDir, 'media')),
              })
            : buildKitValues(listMaterials(db));
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
  // The picture review the chat shows before any brochure exists: the busy
  // details worth magnifying, with a circle centre and the picture palette, so
  // the studio can pick what to magnify instead of guessing.
  app.post('/api/analyze-images', async (c) => {
    const parsed = await readJsonObject(c);
    if (parsed.error) return fail(c, 400, parsed.error);
    const images = parsed.body.images;
    if (!Array.isArray(images) || images.length === 0) {
      return fail(c, 400, 'Field "images" must be a list of uploaded media paths.');
    }
    const mediaDir = path.join(dataDir, 'media');
    const config = resolveLlmConfig(db, llmEnv);
    const photos = [];
    for (const image of images) {
      if (typeof image !== 'string' || !/^\/media\/[A-Za-z0-9._-]+$/.test(image)) {
        return fail(c, 400, 'Every picture must be an uploaded media path.');
      }
      const mediaFile = path.join(mediaDir, path.basename(image));
      if (!existsSync(mediaFile)) return fail(c, 404, `The picture "${image}" was not found.`);
      // Trust the bytes, so a file sent without a useful name still works.
      let signature = Buffer.alloc(0);
      try {
        signature = readFileSync(mediaFile).subarray(0, 8);
      } catch {
        signature = Buffer.alloc(0);
      }
      const isPng = signature[0] === 0x89 && signature[1] === 0x50;
      const isJpeg = signature[0] === 0xff && signature[1] === 0xd8;
      const isPdfFile =
        signature.subarray(0, 4).toString('ascii') === '%PDF' || /\.pdf$/i.test(image);
      const isImageFile =
        isPng || isJpeg || /\.(png|jpe?g)$/i.test(image) || /^image\//i.test('');
      if (!isPdfFile && !isImageFile) {
        return fail(c, 400, 'Only PNG, JPEG and PDF pages can be reviewed.');
      }
      const displayName = uploadedFileName(mediaDir, image);
      if (isPdfFile) {
        let pages;
        try {
          pages = await ensurePdfPages(dataDir, mediaDir, image, pdftoppmBin);
        } catch (error) {
          return fail(c, 400, error instanceof Error ? error.message : 'The PDF could not be read.');
        }
        pages.forEach((pagePath, pageIndex) => {
          const analysis = analyseImage(pagePath);
          if (!analysis) return;
          const plates = detailPlatesFor(pagePath, analysis.candidates ?? []);
          plates.forEach((plate) => {
            const candidate = analysis.candidates[plate.index - 1];
            if (candidate) {
              candidate.hex = plate.colour;
              candidate.name = plate.name;
            }
          });
          photos.push({
            url: image,
            previewUrl: `/pdf-previews/${path.basename(pagePath)}`,
            name: path.basename(pagePath),
            label: `${displayName} · page ${pageIndex + 1} of ${pages.length}`,
            analysis,
          });
        });
        continue;
      }
      const analysis = analyseImage(mediaFile);
      if (!analysis) return fail(c, 400, `The picture "${image}" could not be read.`);
      // Name the colour of the actual magnified crop, so the review and the
      // brochure agree on the colour.
      const plates = detailPlatesFor(mediaFile, analysis.candidates ?? []);
      plates.forEach((plate) => {
        const candidate = analysis.candidates[plate.index - 1];
        if (candidate) {
          candidate.hex = plate.colour;
          candidate.name = plate.name;
        }
      });
      photos.push({
        url: image,
        previewUrl: image,
        name: path.basename(image),
        label: displayName,
        analysis,
      });
    }
    // One batched vision call names the joinery details on the chosen circles.
    if (visionEnabled(config) && photos.length > 0) {
      const prepared = photos
        .map((photo) => {
          const pagePath = photo.previewUrl?.startsWith('/pdf-previews/')
            ? path.join(pdfPreviewDir(dataDir), path.basename(photo.previewUrl))
            : path.join(mediaDir, path.basename(photo.url));
          return { photo, pagePath };
        })
        .filter((entry) => existsSync(entry.pagePath));
      const insights = await readPicturesWithVision({
        config,
        requestChat,
        filePaths: prepared.map((entry) => entry.pagePath),
        logger,
      });
      if (insights) {
        prepared.slice(0, insights.length).forEach((entry, index) => {
          const insight = insights[index];
          if (!insight) return;
          entry.photo.insight = {
            summary: insight.summary,
            piece: insight.piece,
            room: insight.room,
            colours: insight.colours,
          };
          const candidates = entry.photo.analysis.candidates ?? [];
          const used = new Set();
          for (const detail of insight.details) {
            let match = null;
            if (Number.isFinite(detail.x) && Number.isFinite(detail.y)) {
              let best = Infinity;
              candidates.forEach((candidate, candidateIndex) => {
                if (used.has(candidateIndex)) return;
                const distance = Math.hypot(candidate.x - detail.x, candidate.y - detail.y);
                if (distance < best) {
                  best = distance;
                  match = candidateIndex;
                }
              });
            } else {
              const next = candidates.findIndex((_, candidateIndex) => !used.has(candidateIndex));
              if (next !== -1) match = next;
            }
            if (match !== null && match >= 0) {
              used.add(match);
              candidates[match].label = detail.label;
            }
          }
        });
      }
    }
    return c.json({ photos });
  });

  // The cached first page of an uploaded PDF, used by the picture review and
  // available to anything that needs a picture of the PDF.
  app.get('/pdf-previews/:file', (c) => {
    const name = c.req.param('file');
    if (!/^[A-Za-z0-9._-]+\.(png|jpg)$/i.test(name) || name.includes('..')) {
      return fail(c, 404, 'File not found.');
    }
    const filePath = path.join(pdfPreviewDir(dataDir), name);
    if (!existsSync(filePath)) return fail(c, 404, 'File not found.');
    return sendFile(c, filePath, /\.png$/i.test(name) ? 'image/png' : 'image/jpeg');
  });

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
