// Optional language model support: resolve a runtime configurable
// OpenAI compatible provider and call its chat completions endpoint.
//
// The provider is never hard coded. Values saved in the settings table win over
// the process environment (LLM_ENDPOINT, LLM_MODEL, LLM_API_KEY), so the office
// can point the product at a different provider from the app without a
// redeploy. The API key is only ever held in memory for the duration of one
// request: it is never logged, never returned to a client and never put in an
// error message.

import { randomUUID } from 'node:crypto';

import { listSettings } from './db.mjs';

export const LLM_SETTING_KEYS = Object.freeze({
  endpoint: 'llm_endpoint',
  model: 'llm_model',
  apiKey: 'llm_api_key',
});

export const LLM_ENV_VARS = Object.freeze({
  endpoint: 'LLM_ENDPOINT',
  model: 'LLM_MODEL',
  apiKey: 'LLM_API_KEY',
});

export const ENDPOINT_MAX_CHARS = 300;
export const MODEL_MAX_CHARS = 120;
export const API_KEY_MAX_CHARS = 400;

export const DEFAULT_LLM_TIMEOUT_MS = 20_000;
export const TEST_MAX_TOKENS = 64;
export const NOTE_MAX_TOKENS = 900;
export const NOTE_TEMPERATURE = 0.4;
export const SAMPLE_MAX_CHARS = 200;
export const PROVIDER_ERROR_MAX_CHARS = 300;
// The provider type/code is also echoed to the client, so cap it as well.
const PROVIDER_TYPE_MAX_CHARS = 80;

// Brochure copy caps: the prompt asks for tighter limits, these are the hard
// defensive caps applied to whatever the model actually sends back. render.mjs
// uses the same values when it puts the copy into the family templates.
export const COPY_HEADLINE_MAX_CHARS = 80;
export const COPY_BODY_MAX_CHARS = 1200;
export const COPY_CLOSING_MAX_CHARS = 140;
export const COPY_MAX_TOKENS = 4000;
export const COPY_TEMPERATURE = 0.5;
export const COPY_READ_ERROR_MESSAGE =
  'The model reply could not be read. Generate the copy again.';

export const NOT_CONFIGURED_MESSAGE =
  'No language model is configured. Save the endpoint, model and API key in Settings first.';

// The exact messages a connection test sends. Exported so the test suite can
// assert the request body without duplicating the wording.
export const CONNECTION_TEST_MESSAGES = Object.freeze([
  Object.freeze({ role: 'system', content: 'You are a connection test.' }),
  Object.freeze({ role: 'user', content: 'Reply with the single word ok.' }),
]);

const NOTE_SYSTEM_PROMPT = [
  'You are a salesperson at Grace Wood Industry, a custom wardrobe and furniture workshop in Nagercoil, Tamil Nadu.',
  'Write a short WhatsApp message to the customer about their order.',
  'Rules:',
  '- Warm, clear and concrete, in British Indian English.',
  '- Under 60 words.',
  '- No em dashes.',
  '- Mention only facts listed in the order. Never invent dimensions, materials, prices, dates or promises.',
  '- One short paragraph with no subject line, no bullet points and no quotation marks.',
].join(' ');

const COPY_SYSTEM_PROMPT = [
  'You write the brochure copy for a single custom wardrobe or furniture order at Grace Wood Industry, a workshop in Nagercoil, Tamil Nadu.',
  'The reader is a discerning customer holding a printed document. The specification page already lists every dimension and material, so your job is to make the piece feel considered, not to repeat the list.',
  'Voice: the quiet confidence of a design house catalogue, never a sales page. Precise nouns and verbs, restrained adjectives, a measured rhythm of short declarative sentences and one longer line. Say what a person would notice in the room. Never flatter, never hurry, never sell.',
  'Reply with strict JSON only, in exactly this shape:',
  '{"headline": "...", "body": "...", "closing": "..."}',
  'Headline: at most 56 characters, understated and specific, a phrase a design magazine would print. Name a place, a use or a constraint. Do not use a relative clause with that, which or who. Do not start with "A" or "This". No question marks, no exclamation marks, no colon.',
  'Body: 95 to 145 words. Open with one precise observation about the room or the way the piece is used. Develop it through proportion, light, line or one telling detail, and include at least one sentence of fifteen words or more. Close on a restrained line of fact or feeling, never a pitch. Use at most two facts from the order and name no more than two materials. Do not lean on a favourite image: the words quiet, calm and plane may each appear only once in the whole piece, and the piece is never called a plane.',
  'Closing: at most 80 characters. Understated, specific, no call to action.',
  'Hard rules:',
  'Use only facts present in the order and the customer brief.',
  'Never invent certifications, prices, dates, brands, warranties or performance claims. That includes moisture proof, heat resistant, scratch proof, easy to clean, does not show fingerprints or marks, lasts for years, made to last, holds its finish, and reachable without a stool, unless the order states them.',
  'Never mention money, currency, discounts, dates, festivals or deadlines, even when the brief does. Do not repeat the brief back, answer it.',
  'Do not address the reader. No "you", "your", "we" or "our". The piece is described, not sold.',
  `Never put the customer's name before a comma. If the name appears at all, use it once as a possessive, for example "Anitha's bedroom".`,
  'No em dashes or en dashes. No exclamation marks. No questions. No emojis.',
  'Do not repeat a verb or a sentence opening. Keep, give, hold and make may each appear only once in the body; check every sentence before you answer.',
  'British Indian English. Plain words, exact adjectives, no filler.',
  'Banned words: elevate, seamless, luxurious, luxury, bespoke, premium, crafted, timeless, oasis, dream, transform, nestled, boasts, state of the art, cutting edge, game changer, must have, stunning, gorgeous, beautiful, perfect, amazing, exceptional, ultimate, world class, top notch, elegant, high end, very, really.',
  'Do not name the carcass, the back panel or the plywood thickness. Those belong in the specification table, not in the story.',
  'A thickness is not a count: "12 mm plywood" is a material, not twelve drawers. Never turn a material figure into a number of drawers, shelves or shutters.',
  'Only mention a component the order actually includes. If there are no shutters, do not mention hinges or handles. If there are no drawers, do not mention channels.',
  'Never mention the order, the brief, the specification or the document, not even to say what the brief asked for. The customer is reading copy, not a note about the process.',
  'No prose, markdown, code fences or explanation around the JSON object.',
  'Voice example for a different product. Never reuse its headline, opening, sentences, phrases or shape. Match only the register:',
  '{"headline":"A desk that faces the window","body":"The study is narrow, so the desk runs under the window and leaves the back wall free. At 1500 mm it holds a screen, a lamp and the papers that collect by the end of the week. The drawer sits on the left, where the hand falls. The surface is pale, which keeps the window light in the room rather than against it. There is nothing on it that does not earn its place. Proportion and light do the rest, and the room stays a room to work in.","closing":"One line, one surface, the work in front of you."}'
].join(' ');

// ---------------------------------------------------------------------------
// Small text helpers
// ---------------------------------------------------------------------------

export function trimEndpoint(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\/+$/, '');
}

export function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Collapse whitespace and cut a string to `maxChars`, ending with an ellipsis
 * when it was shortened. Used for provider samples and error messages so a
 * broken provider can not flood the app with unbounded text.
 */
export function capText(value, maxChars) {
  if (typeof value !== 'string') return '';
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, Math.max(0, maxChars - 1))}…`;
}

function formatTimeout(timeoutMs) {
  if (timeoutMs % 1000 === 0) return `${timeoutMs / 1000} seconds`;
  return `${timeoutMs} ms`;
}

// ---------------------------------------------------------------------------
// Configuration resolution
// ---------------------------------------------------------------------------

/**
 * Read the stored language model settings. Each field is optional: only keys
 * present in the settings table take part in resolution.
 */
export function readStoredLlmSettings(db) {
  const stored = { endpoint: undefined, model: undefined, apiKey: undefined, updatedAt: null };
  for (const row of listSettings(db)) {
    if (
      row.key !== LLM_SETTING_KEYS.endpoint &&
      row.key !== LLM_SETTING_KEYS.model &&
      row.key !== LLM_SETTING_KEYS.apiKey
    ) {
      continue;
    }
    if (row.key === LLM_SETTING_KEYS.endpoint) stored.endpoint = row.value;
    if (row.key === LLM_SETTING_KEYS.model) stored.model = row.value;
    if (row.key === LLM_SETTING_KEYS.apiKey) stored.apiKey = row.value;
    if (!stored.updatedAt || row.updatedAt > stored.updatedAt) stored.updatedAt = row.updatedAt;
  }
  stored.present =
    stored.endpoint !== undefined || stored.model !== undefined || stored.apiKey !== undefined;
  return stored;
}

/**
 * Resolve the effective provider config: stored settings first, environment
 * second. The returned object holds the API key, so it must stay on the server;
 * use publicLlmSettings before sending anything to a client.
 */
export function resolveLlmConfig(db, env = process.env) {
  const stored = readStoredLlmSettings(db);
  const envEndpoint = trimEndpoint(env?.LLM_ENDPOINT);
  const envModel = clean(env?.LLM_MODEL);
  const envApiKey = clean(env?.LLM_API_KEY);

  const endpoint = trimEndpoint(stored.endpoint !== undefined ? stored.endpoint : envEndpoint);
  const model = clean(stored.model !== undefined ? stored.model : envModel);
  const apiKey = clean(stored.apiKey !== undefined ? stored.apiKey : envApiKey);

  const hasEnv = envEndpoint !== '' || envModel !== '' || envApiKey !== '';
  const source = stored.present ? 'settings' : hasEnv ? 'env' : 'none';

  return {
    endpoint,
    model,
    apiKey,
    hasKey: apiKey !== '',
    configured: endpoint !== '' && model !== '' && apiKey !== '',
    source,
    updatedAt: stored.updatedAt,
  };
}

/**
 * The only shape any route may return: never includes the key, only whether one
 * is available.
 */
export function publicLlmSettings(config) {
  return {
    endpoint: config?.endpoint ?? '',
    model: config?.model ?? '',
    hasKey: Boolean(config?.apiKey),
    source: config?.source ?? 'none',
    updatedAt: config?.updatedAt ?? null,
  };
}

// ---------------------------------------------------------------------------
// Input validation, mirroring the caps in the app form
// ---------------------------------------------------------------------------

export function validateEndpoint(value) {
  if (typeof value !== 'string') return { error: 'Field "endpoint" must be text.' };
  const trimmed = value.trim();
  if (trimmed.length > ENDPOINT_MAX_CHARS) {
    return { error: `Field "endpoint" must be ${ENDPOINT_MAX_CHARS} characters or fewer.` };
  }
  if (trimmed === '') {
    return { error: 'Field "endpoint" must be an http or https URL.' };
  }
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return { error: 'Field "endpoint" must be an http or https URL.' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { error: 'Field "endpoint" must be an http or https URL.' };
  }
  return { value: trimEndpoint(trimmed) };
}

export function validateModel(value) {
  if (typeof value !== 'string') return { error: 'Field "model" must be text.' };
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > MODEL_MAX_CHARS) {
    return { error: `Field "model" must be 1 to ${MODEL_MAX_CHARS} characters.` };
  }
  return { value: trimmed };
}

// An empty apiKey is valid: it means "forget the stored key" so resolution can
// fall back to the environment (or report that nothing is configured).
export function validateApiKey(value) {
  if (typeof value !== 'string') return { error: 'Field "apiKey" must be text.' };
  const trimmed = value.trim();
  if (trimmed.length > API_KEY_MAX_CHARS) {
    return { error: `Field "apiKey" must be ${API_KEY_MAX_CHARS} characters or fewer.` };
  }
  return { value: trimmed };
}

// ---------------------------------------------------------------------------
// Provider errors
// ---------------------------------------------------------------------------

/**
 * Turn a provider response body into a safe message. Understands the OpenAI
 * style { error: { message, type } } and falls back to the plain text body.
 * Everything is capped so a broken provider can not flood the client.
 */
export function extractProviderError(text, status) {
  const raw = typeof text === 'string' ? text : '';
  if (raw.trim() !== '') {
    try {
      const payload = JSON.parse(raw);
      const message = payload?.error?.message;
      if (typeof message === 'string' && message.trim() !== '') {
        const providerType = payload?.error?.type ?? payload?.error?.code;
        return {
          message: capText(message, PROVIDER_ERROR_MAX_CHARS),
          type:
            typeof providerType === 'string' && providerType.trim() !== ''
              ? capText(providerType, PROVIDER_TYPE_MAX_CHARS)
              : 'provider_error',
          status: Number.isInteger(status) ? status : undefined,
        };
      }
    } catch {
      // Not JSON: the whole body is the provider's message.
    }
    return {
      message: capText(raw, PROVIDER_ERROR_MAX_CHARS),
      type: 'provider_error',
      status: Number.isInteger(status) ? status : undefined,
    };
  }
  return {
    message: 'The provider returned an empty error response.',
    type: 'provider_error',
    status: Number.isInteger(status) ? status : undefined,
  };
}

/**
 * A provider call failure that is safe to show to the user. Only the fields
 * below are ever serialised, so a stack trace or request header can not leak.
 */
export class LlmError extends Error {
  constructor(message, { status, type, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'LlmError';
    if (Number.isInteger(status)) this.status = status;
    if (typeof type === 'string' && type !== '') this.type = type;
  }

  toPublicError() {
    const error = { message: this.message };
    if (Number.isInteger(this.status)) error.status = this.status;
    if (typeof this.type === 'string' && this.type !== '') error.type = this.type;
    return error;
  }
}

/** Body for a failed /api/llm/test or /api/orders/:id/note response. */
export function llmFailureBody(error) {
  if (error instanceof LlmError) return { ok: false, error: error.toPublicError() };
  return {
    ok: false,
    error: { message: 'The model request could not be completed.', type: 'server' },
  };
}

function transportError(error, timeoutMs) {
  const name = error?.name ?? '';
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new LlmError(
      `The provider did not respond in time (timeout after ${formatTimeout(timeoutMs)}).`,
      { type: 'timeout', cause: error },
    );
  }
  const detail = capText(
    error?.cause?.message ?? error?.message ?? 'the connection failed',
    200,
  );
  return new LlmError(`Could not reach the provider: ${detail}`, { type: 'network', cause: error });
}

async function readResponseText(response, timeoutMs) {
  try {
    return await response.text();
  } catch (error) {
    throw transportError(error, timeoutMs);
  }
}

// ---------------------------------------------------------------------------
// Chat completions
// ---------------------------------------------------------------------------

/**
 * POST <endpoint>/chat/completions with the OpenAI body shape and return the
 * assistant reply. `fetchImpl` is injectable for unit tests; the server uses
 * the global fetch and AbortSignal.timeout for the 20 second budget.
 */
let openCodeSessionId = null;

/**
 * Some providers need a routing header on every call. OpenCode Go requires an
 * x-opencode-session id, which also lets it route a conversation sensibly. The
 * header is only added for OpenCode endpoints, so other providers get a clean
 * OpenAI compatible request.
 */
export function providerHeaders(endpoint, apiKey) {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${clean(apiKey)}`,
  };
  let host = '';
  try {
    host = new URL(trimEndpoint(endpoint)).hostname.toLowerCase();
  } catch {
    host = '';
  }
  if (host === 'opencode.ai' || host.endsWith('.opencode.ai')) {
    openCodeSessionId ??= `studio-${randomUUID()}`;
    headers['x-opencode-session'] = openCodeSessionId;
  }
  return headers;
}

const COPY_META_WORDS = ['the specification', 'the order', 'the brief', 'this document', 'the document'];
const COPY_HYPE_WORDS = [
  'elevate', 'seamless', 'luxurious', 'luxury', 'bespoke', 'premium', 'crafted', 'timeless',
  'oasis', 'dream', 'transform', 'nestled', 'boasts', 'state of the art', 'cutting edge',
  'game changer', 'must have', 'stunning', 'gorgeous', 'beautiful', 'perfect', 'amazing',
  'exceptional', 'ultimate', 'world class', 'top notch', 'elegant', 'high end',
];

const NUMBER_WORDS = {
  one: '1', two: '2', three: '3', four: '4', five: '5', six: '6',
  seven: '7', eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12',
};

function countPhrases(text) {
  const found = new Set();
  const pattern = /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d{1,2})\s+(drawers?|shelves?|shutters?)\b/gi;
  for (const match of String(text).matchAll(pattern)) {
    const number = NUMBER_WORDS[match[1].toLowerCase()] ?? match[1];
    const noun = match[2].toLowerCase().replace(/^shelves$/, 'shelf').replace(/s$/, '');
    found.add(`${number} ${noun}`);
  }
  return found;
}
const COPY_MIN_WORDS = 80;
const COPY_MAX_WORDS = 175;

/**
 * Checks the copy against the rules the customer actually feels: length inside
 * the printed block, and no references to the internal paperwork. Returns an
 * empty array when the copy is good.
 */
export function copyQualityIssues(copy, order = null) {
  const issues = [];
  const body = clean(copy?.body);
  const words = body === '' ? 0 : body.split(/\s+/).filter(Boolean).length;
  if (words < COPY_MIN_WORDS) issues.push(`body too short (${words} words)`);
  if (words > COPY_MAX_WORDS) issues.push(`body too long (${words} words)`);
  const lower = body.toLowerCase();
  for (const phrase of COPY_META_WORDS) {
    if (lower.includes(phrase)) issues.push(`mentions internal paperwork ("${phrase}")`);
  }
  for (const phrase of COPY_HYPE_WORDS) {
    if (lower.includes(phrase)) issues.push(`uses a marketing cliché ("${phrase}")`);
  }
  if (/\byou\b|\byour\b|\bwe\b|\bour\b/i.test(body)) {
    issues.push('addresses the reader instead of describing the piece');
  }
  for (const verb of ['keeps', 'gives', 'holds', 'makes']) {
    const uses = (lower.match(new RegExp(`\\b${verb}\\b`, 'g')) ?? []).length;
    if (uses > 1) issues.push(`repeats "${verb}" ${uses} times`);
  }
  for (const word of ['quiet', 'calm', 'plane']) {
    const uses = (lower.match(new RegExp(`\\b${word}\\b`, 'g')) ?? []).length;
    if (uses > 1) issues.push(`leans on "${word}" ${uses} times`);
  }
  if (order) {
    // Counts are only allowed when the order itself contains them. A material
    // like "12 mm plywood" must never become twelve drawers.
    const allowedCounts = countPhrases(JSON.stringify(order));
    if (clean(order.shutters) !== '') {
      allowedCounts.add(`${clean(order.shutters).replace(/\D.*$/, '')} shutter`);
    }
    const statedCounts = countPhrases(body);
    for (const phrase of statedCounts) {
      if (!allowedCounts.has(phrase)) issues.push(`invents a count ("${phrase}")`);
    }

    const fields = ['carcass', 'backPanel', 'shuttersMat', 'drawers', 'exterior', 'interior', 'edgeShutter', 'edgeCarcass', 'handle'];
    const echoed = fields.filter((field) => {
      const value = clean(order[field]).split(',')[0].trim().toLowerCase();
      return value.length > 4 && lower.includes(value);
    });
    if (echoed.length > 3) issues.push(`walks through the materials (${echoed.length} named)`);
    if (echoed.includes('carcass') || echoed.includes('backPanel')) {
      issues.push('names the carcass or the back panel');
    }
  }
  return issues;
}

/**
 * A single corrective retry. Small models sometimes write a thin body or talk
 * about the brief instead of the wardrobe; asking again with the exact problem
 * fixes it without a second prompt design.
 */
export function buildCopyRepairMessages(order, brief, previous, issues) {
  const messages = buildCopyMessages(order, brief);
  messages.push({ role: 'assistant', content: JSON.stringify(previous) });
  messages.push({
    role: 'user',
    content: `Rewrite the body. Problems: ${issues.join('; ')}. Body 90 to 150 words, 90 is the floor. Name no more than two materials. Never mention the order, the brief or the specification. Reply with the same strict JSON shape only.`,
  });
  return messages;
}

/**
 * Some providers accept extra request fields. DeepSeek on OpenCode Go is a
 * reasoning model: left alone it can spend the entire token budget thinking and
 * return no content at all. For writing work we ask it to answer directly.
 * Other providers get a plain OpenAI compatible body so an unknown field can
 * never make their request fail.
 */
export function providerBodyExtras(endpoint) {
  let host = '';
  try {
    host = new URL(trimEndpoint(endpoint)).hostname.toLowerCase();
  } catch {
    host = '';
  }
  if (host === 'opencode.ai' || host.endsWith('.opencode.ai')) {
    return { reasoning_effort: 'none' };
  }
  return {};
}

export async function requestChat({
  endpoint,
  model,
  apiKey,
  messages,
  maxTokens = 256,
  temperature = 0,
  timeoutMs = DEFAULT_LLM_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
} = {}) {
  const base = trimEndpoint(endpoint);
  if (base === '') {
    throw new LlmError('No provider endpoint is configured.', { type: 'configuration' });
  }
  if (clean(model) === '') {
    throw new LlmError('No provider model is configured.', { type: 'configuration' });
  }
  if (clean(apiKey) === '') {
    throw new LlmError('No provider API key is configured.', { type: 'configuration' });
  }
  if (typeof fetchImpl !== 'function') {
    throw new LlmError('This runtime has no fetch implementation.', { type: 'configuration' });
  }

  const body = {
    model: clean(model),
    messages,
    max_tokens: maxTokens,
    temperature,
    ...providerBodyExtras(base),
  };
  const startedAt = performance.now();
  let response;
  try {
    response = await fetchImpl(`${base}/chat/completions`, {
      method: 'POST',
      headers: providerHeaders(base, apiKey),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw transportError(error, timeoutMs);
  }

  const text = await readResponseText(response, timeoutMs);
  const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));

  if (!response.ok) {
    const provider = extractProviderError(text, response.status);
    throw new LlmError(provider.message, { status: provider.status, type: provider.type });
  }

  let payload;
  try {
    payload = text === '' ? null : JSON.parse(text);
  } catch {
    throw new LlmError('The provider returned a reply that was not valid JSON.', {
      status: response.status,
      type: 'invalid_response',
    });
  }
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim() === '') {
    throw new LlmError('The provider returned an empty reply.', {
      status: response.status,
      type: 'empty_response',
    });
  }

  const replyModel = clean(payload?.model) !== '' ? clean(payload.model) : body.model;
  return { content: content.trim(), model: replyModel, latencyMs, status: response.status };
}

// ---------------------------------------------------------------------------
// Order facts, WhatsApp note and brochure copy prompts
// ---------------------------------------------------------------------------

function pushFact(facts, label, value) {
  const text = clean(value);
  if (text !== '') facts.push(`${label}: ${text}`);
}

/**
 * Flatten an order row into the facts a salesperson may mention. Empty fields
 * are omitted so the model has no excuse to invent a value for them.
 */
export function orderNoteFacts(order) {
  const facts = [];
  pushFact(facts, 'Customer', order?.customerName);
  pushFact(facts, 'Order', order?.title);
  pushFact(facts, 'Room', order?.room);

  const dimensions = [
    ['width', clean(order?.width)],
    ['height', clean(order?.height)],
    ['depth', clean(order?.depth)],
  ]
    .filter(([, value]) => value !== '')
    .map(([label, value]) => `${label} ${value}`);
  if (dimensions.length > 0) facts.push(`Dimensions: ${dimensions.join(', ')}`);

  pushFact(facts, 'Shutters', order?.shutters);
  pushFact(facts, 'Carcass material', order?.carcass);
  pushFact(facts, 'Back panel', order?.backPanel);
  pushFact(facts, 'Shutter material', order?.shuttersMat);
  pushFact(facts, 'Drawers', order?.drawers);
  pushFact(facts, 'Exterior material', order?.exterior);
  pushFact(facts, 'Interior material', order?.interior);
  pushFact(facts, 'Hinges', order?.hinges);
  pushFact(facts, 'Channels', order?.channels);
  pushFact(facts, 'Edge band on shutters', order?.edgeShutter);
  pushFact(facts, 'Edge band on carcass', order?.edgeCarcass);
  pushFact(facts, 'Edge band note', order?.edgeNote);
  pushFact(facts, 'Handles', order?.handle);
  pushFact(facts, 'Handle note', order?.handleNote);
  pushFact(facts, 'Exterior finish', order?.finishExt);
  pushFact(facts, 'Interior finish', order?.finishInt);
  return facts;
}

/** Build the exact chat messages sent for POST /api/orders/:id/note. */
export function buildNoteMessages(order) {
  const facts = orderNoteFacts(order);
  const user = [
    'Order details:',
    ...facts.map((fact) => `- ${fact}`),
    '',
    'Write the WhatsApp note now.',
  ].join('\n');
  return [
    { role: 'system', content: NOTE_SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

// ---------------------------------------------------------------------------
// Brochure copy prompt
// ---------------------------------------------------------------------------

/**
 * Build the exact chat messages sent for POST /api/orders/:id/copy. The order
 * facts are reused from the note builder; the customer brief is passed as the
 * loose wording the brochure body should adapt to.
 */
export function buildCopyMessages(order, brief = '') {
  const facts = orderNoteFacts(order);
  const suppliedBrief = clean(brief);
  const user = [
    'Order details:',
    ...facts.map((fact) => `- ${fact}`),
    '',
    'Customer brief:',
    suppliedBrief === ''
      ? '(No extra brief was supplied. Write from the order details only.)'
      : suppliedBrief,
    '',
    'Write the brochure copy now as strict JSON.',
  ].join('\n');
  return [
    { role: 'system', content: COPY_SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

/**
 * Find the first complete JSON object in a text reply. Tracks strings and
 * escapes so braces inside a headline or body do not end the object early.
 */
function firstJsonObject(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

function capCopyField(value, maxChars) {
  return value.trim().slice(0, maxChars).trimEnd();
}

/**
 * Parse the model's brochure copy reply defensively.
 *
 * Accepts a bare JSON object, a fenced code block (``` or ```json) and JSON
 * with prose around it by extracting the first complete object. Throws an
 * LlmError with COPY_READ_ERROR_MESSAGE when the reply can not be read, so the
 * route returns the standard 502 body without a stack trace.
 */
export function parseCopyReply(reply) {
  const raw = typeof reply === 'string' ? reply : '';
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const source = fenced ? fenced[1] : raw;
  const candidate = firstJsonObject(source);

  let payload = null;
  if (candidate !== null) {
    try {
      payload = JSON.parse(candidate);
    } catch {
      payload = null;
    }
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new LlmError(COPY_READ_ERROR_MESSAGE, { type: 'invalid_reply' });
  }

  const caps = {
    headline: COPY_HEADLINE_MAX_CHARS,
    body: COPY_BODY_MAX_CHARS,
    closing: COPY_CLOSING_MAX_CHARS,
  };
  const copy = {};
  for (const [field, maxChars] of Object.entries(caps)) {
    const value = payload[field];
    if (typeof value !== 'string' || value.trim() === '') {
      throw new LlmError(COPY_READ_ERROR_MESSAGE, { type: 'invalid_reply' });
    }
    copy[field] = capCopyField(value, maxChars);
  }
  return copy;
}


/** Extract the first JSON object from a reply, with or without code fences. */
export function parseJsonObject(reply) {
  const raw = typeof reply === 'string' ? reply : '';
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const source = fenced ? fenced[1] : raw;
  const direct = source.trim();
  if (direct.startsWith('{')) {
    try {
      const value = JSON.parse(direct);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch {
      // fall through to the balanced scan
    }
  }
  const candidate = firstJsonObject(source);
  if (!candidate) return null;
  try {
    const value = JSON.parse(candidate);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}
