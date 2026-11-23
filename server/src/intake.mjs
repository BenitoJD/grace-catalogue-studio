// Conversational order intake.
//
// The customer never fills a form. They dump what they know into a chat, in any
// order, with gaps and contradictions, and this module turns that into a draft
// order. The model extracts only what was said, asks for essentials that are
// still missing, and says when it has enough to cook the brochure.
import { ORDER_TEXT_FIELDS } from './db.mjs';
import { LlmError, clean, parseJsonObject } from './llm.mjs';

export const INTAKE_MAX_TOKENS = 1600;
export const INTAKE_TEMPERATURE = 0.2;
export const INTAKE_MAX_MESSAGES = 30;
export const INTAKE_MAX_MESSAGE_CHARS = 4000;

export const INTAKE_FIELDS = ['customerName', 'brief', ...ORDER_TEXT_FIELDS];

// Human phrases for the sentence the assistant must say when something is
// missing, and the words that count as already saying it.
export const MISSING_PHRASES = {
  customerName: 'the customer name',
  title: 'the piece',
  room: 'the room',
  width: 'the width',
  height: 'the height',
  depth: 'the depth',
  shutters: 'the number of shutters',
};

const MISSING_MATCHERS = {
  customerName: /\b(name|customer)\b/i,
  title: /\b(piece|wardrobe|furniture|bench|cabinet|shelving|shelf|unit)\b/i,
  room: /\broom\b/i,
  width: /\b(width|wide)\b/i,
  height: /\b(height|high)\b/i,
  depth: /\b(depth|deep)\b/i,
  shutters: /\b(shutter|shutters|door|doors)\b/i,
};

// Dimensions, size and shape are no longer part of the product. A brochure is
// a colour study built from the client's photographs; the piece, the room and
// the customer are the only facts intake must have.
export const INTAKE_ESSENTIALS = [
  ['customerName', 'customer name'],
  ['title', 'the piece, for example a wardrobe or a bench'],
  ['room', 'the room'],
];

const FIELD_LIMITS = Object.fromEntries(INTAKE_FIELDS.map((field) => [field, field === 'brief' ? 2000 : 120]));

const INTAKE_SYSTEM_PROMPT = [
  'You are the order intake assistant at Jacob Design Studio, a wardrobe and furniture workshop in Nagercoil, Tamil Nadu.',
  'The customer types their requirement in one or more messages. They may paste a list, a WhatsApp forward, or a rough description. Extract the order facts and keep a short conversation going.',
  'Reply with strict JSON only, exactly this shape:',
  '{"reply": "what you say next", "order": {"customerName": "...", "title": "...", "room": "...", "brief": "..."}, "ready": false}',
  'Rules for order:',
  '- Include a field only when the customer stated it. Never invent or guess a value. The studio can mark an unknown detail as to be confirmed.',
  '- title is the piece, for example "Master Bedroom Wardrobe". If the customer names the kind but no title, use that kind, for example "Wardrobe" or "Dining Bench". room is where it goes.',
  '- brief is a short summary of anything else useful the customer said, in their words where possible. It must describe the piece, never the deal.',
  '- Never put a price, budget, discount, date, festival or deadline in any field, including brief, or in reply. Leave those words out entirely.',
  'Rules for reply:',
  '- One to three short sentences, warm and plain, British Indian English. No em dashes, no exclamation marks, no questions other than the ones allowed below.',
  '- When any essential is missing, say exactly what is missing and leave nothing out, in one short sentence, for example "I still need the customer name and the room."',
  '- You may put at most two questions to the customer. If more than two things are missing, state the full list instead of asking question after question.',
  '- Never say "more information", "more details", "a few details", "some details" or "additional information". Name the fields.',
  '- When ready is true, confirm what you have and stop. Never ask for anything, and never ask for materials or finishes.',
  '- When photographs are attached and the customer has not named a detail to magnify (a handle, an edge, a grain, a colour palette, a finish), ask one short question about which detail to show in the magnifier. This is the only materials or finish question allowed.',
  '- Never ask about any other materials or finishes. The workshop has standard choices for those.',
  '- If nothing essential is missing, set ready true and say the brochure can be made.',
  'No prose, markdown or code fences around the JSON.',
].join(' ');

function limit(value, field) {
  const text = clean(value);
  const max = FIELD_LIMITS[field] ?? 120;
  return text.length > max ? text.slice(0, max) : text;
}

const DIMENSION_FIELDS = new Set(['width', 'height', 'depth']);

const MONEY_OR_DATE = /(₹|\brs\.?\b|\brupees?\b|\blakhs?\b|\bcrores?\b|\bbudget\b|\bprice\b|\bcost\b|\bquote\b|\bdiscount\b|deepavali|diwali|pongal|\bfestival\b|\bdeadline\b|before\s+\w+day|\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b|\b(january|february|march|april|may|june|july|august|september|october|november|december)\b|\bweek(end)?\b)/i;

/** The brief describes the piece, never the deal or the deadline. */
export function scrubBrief(text) {
  const sentences = String(text ?? '')
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== '' && !MONEY_OR_DATE.test(sentence));
  return sentences.join(' ').trim();
}

/**
 * The workshop works in millimetres, so a dimension given in feet, inches or
 * centimetres is converted with plain arithmetic and rounded to 5 mm. This is a
 * unit change, not a guess: the customer's number is kept exactly, only the
 * unit is made consistent for the printed specification.
 */
function normaliseDimension(text) {
  const value = text.replace(',', '.').trim();
  if (/^\d+(\.\d+)?$/.test(value)) return `${value} mm`;

  const feetInches = /^(\d+)\s*(?:'|ft|feet|foot)\s*(?:(\d+)\s*(?:"|in|inch|inches)?)?$/i.exec(value);
  if (feetInches) {
    const decimal = Number(feetInches[1]) + Number(feetInches[2] ?? 0) / 12;
    return `${roundToFive(decimal * 304.8)} mm`;
  }
  const feet = /^(\d+(?:\.\d+)?)\s*(?:ft|feet|foot)$/i.exec(value);
  if (feet) return `${roundToFive(Number(feet[1]) * 304.8)} mm`;
  const inches = /^(\d+(?:\.\d+)?)\s*(?:in|inch|inches)$/i.exec(value);
  if (inches) return `${roundToFive(Number(inches[1]) * 25.4)} mm`;
  const cm = /^(\d+(?:\.\d+)?)\s*(?:cm|cms|centimetres?|centimeters?)$/i.exec(value);
  if (cm) return `${roundToFive(Number(cm[1]) * 10)} mm`;
  return text;
}

function roundToFive(value) {
  return Math.round(value / 5) * 5;
}

export { normaliseDimension, roundToFive };

/** House formatting so the printed specification always reads correctly. */
export function normaliseFieldValue(field, value) {
  const text = limit(value, field);
  if (text === '') return '';
  if (field === 'brief') {
    return scrubBrief(text);
  }
  if (field === 'shutters') {
    // "3 shutters" and "three" both become "3": the table supplies the noun.
    const digits = /^(\d+)\s*shutters?$/i.exec(text);
    if (digits) return digits[1];
    const words = { one: '1', two: '2', three: '3', four: '4', five: '5', six: '6' };
    if (words[text.toLowerCase()]) return words[text.toLowerCase()];
    return text;
  }
  if (DIMENSION_FIELDS.has(field)) {
    return normaliseDimension(text);
  }
  return text;
}

/** Keep only known fields, trimmed and capped. Anything else is dropped. */
export function normaliseIntakeOrder(raw) {
  const order = {};
  if (!raw || typeof raw !== 'object') return order;
  for (const field of INTAKE_FIELDS) {
    const value = normaliseFieldValue(field, raw[field]);
    if (value !== '') order[field] = value;
  }
  return order;
}

export function missingFields(order) {
  return INTAKE_ESSENTIALS.filter(([field]) => clean(order?.[field]) === '').map(
    ([field]) => field,
  );
}

/** When everything is present, never ask for anything on top of it. */
export function cleanReadyReply(reply) {
  const asked = /\b(still need|please also share|please share|more details|more information|can you (?:share|provide|send)|what is the|how many)\b/i;
  const kept = String(reply ?? '')
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== '' && !sentence.includes('?') && !asked.test(sentence));
  return kept.join(' ').trim();
}

/** "a, b and c" so the sentence reads like a person wrote it. */
export function humanList(items) {
  const list = items.filter(Boolean);
  if (list.length === 0) return '';
  if (list.length === 1) return list[0];
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

// The phrases the customer should never be handed: they name nothing.
const VAGUE_PHRASE = /\b(?:need|require|want)\b[^.!?]*\b(?:more|some|a few|additional|further)\s+(?:information|details|info|inputs?)\b|\b(?:could|can|would)\s+you\s+(?:please\s+)?(?:share|provide|give|send)\s+(?:some\s+|a few\s+|more\s+)?(?:information|details|info)\b/i;

/** Drop sentences that only ask vaguely. They say nothing and read like a bot. */
export function stripVaguePhrases(reply) {
  const kept = String(reply ?? '')
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== '' && !VAGUE_PHRASE.test(sentence));
  return kept.join(' ').trim();
}

/**
 * The assistant must name what is missing, every time. Vague asks are removed
 * and any essential the reply did not mention is added, so the client always
 * reads exactly which details are needed.
 */
export function ensureMissingMentioned(reply, fields) {
  const cleaned = stripVaguePhrases(reply);
  const unmentioned = (fields ?? []).filter((field) => {
    const matcher = MISSING_MATCHERS[field];
    return matcher ? !matcher.test(cleaned) : true;
  });
  if (unmentioned.length === 0) return cleaned;
  const phrases = humanList(unmentioned.map((field) => MISSING_PHRASES[field] ?? field));
  const base = cleaned === '' ? 'Noted' : cleaned;
  const prefix = /[.!?]$/.test(base) ? '' : '.';
  // If the model already started a "I still need" list, continue it politely
  // instead of starting the same sentence twice.
  const leadIn = /\bi still need\b/i.test(base) ? 'Please also share' : 'I still need';
  return `${base}${prefix} ${leadIn} ${phrases}.`;
}

export function missingEssentials(order) {
  return INTAKE_ESSENTIALS.filter(([field]) => clean(order?.[field]) === '').map(
    ([, label]) => label,
  );
}

// A customer often does not know a detail yet. The studio can mark it as to be
// confirmed instead of inventing a number, and the brochure prints that honestly.
export const SKIP_VALUES = Object.freeze({
  customerName: 'Customer',
  title: 'Wardrobe',
  room: 'Room to confirm',
  width: 'To be measured',
  height: 'To be measured',
  depth: 'To be measured',
  shutters: 'To be confirmed',
});

const SKIP_FIELD_WORDS = [
  ['customerName', /\b(customer|client|name)\b/i],
  ['title', /\b(piece|wardrobe|bench|cabinet|furniture|title)\b/i],
  ['room', /\broom\b/i],
  ['width', /\bwidth\b/i],
  ['height', /\bheight\b/i],
  ['depth', /\bdepth\b/i],
  ['shutters', /\bshutters?\b/i],
];

/** Field keys for the labels the app sends when the Skip button is pressed. */
export function fieldsFromSkipRequest(request) {
  if (!Array.isArray(request)) return [];
  const fields = [];
  for (const entry of request) {
    const text = clean(entry).toLowerCase();
    for (const [field, label] of INTAKE_ESSENTIALS) {
      if (text === field.toLowerCase() || text === label.toLowerCase()) {
        fields.push(field);
      }
    }
  }
  return [...new Set(fields)];
}

/** Skip only the details named in the message, or all missing ones for "I don't know". */
export function skipRequestFromMessage(message, draft) {
  const text = clean(message);
  if (text === '' || text.length > 200 || /\d/.test(text)) return null;
  const understandsSkip = /\b(i\s*(?:don'?t|do not)\s*know|i'?m not sure|not sure|no idea|skip|can'?t remember|cannot remember|tbd|to be confirmed|unknown|not known)\b/i;
  if (!understandsSkip.test(text)) return null;
  const missing = INTAKE_ESSENTIALS.filter(([field]) => clean(draft?.[field]) === '').map(
    ([field]) => field,
  );
  if (missing.length === 0) return null;
  const named = SKIP_FIELD_WORDS.filter(([field, pattern]) => missing.includes(field) && pattern.test(text)).map(
    ([field]) => field,
  );
  return named.length > 0 ? named : missing;
}

/** Apply the to be confirmed values to a draft. */
export function skipDraftFields(draft, fields) {
  const next = { ...(draft && typeof draft === 'object' ? draft : {}) };
  for (const field of fields) {
    if (field in SKIP_VALUES) next[field] = SKIP_VALUES[field];
  }
  return next;
}

/** The exact sentence the chat shows after a skip. */
export function skipReply(draft, fields) {
  const labels = INTAKE_ESSENTIALS.filter(([field]) => fields.includes(field)).map(
    ([, label]) => label,
  );
  const missing = missingEssentials(draft);
  const marked = humanList(labels);
  if (missing.length === 0) {
    return `No problem. I marked ${marked} as to be confirmed, and the order can be made now.`;
  }
  return `No problem. I marked ${marked} as to be confirmed. Still needed: ${humanList(missing)}.`;
}

/**
 * Parse the model reply. A reply that is not a JSON object, or has no usable
 * order object, is a hard failure so the route can surface it instead of
 * guessing at a customer's order.
 */
export function parseIntakeReply(content) {
  const parsed = parseJsonObject(content);
  if (!parsed) {
    throw new LlmError('The intake reply could not be read. Send the message again.', {
      type: 'invalid_reply',
    });
  }
  const order = normaliseIntakeOrder(parsed.order);
  const reply = limit(parsed.reply, 'brief') || 'Received.';
  const ready = parsed.ready === true && missingEssentials(order).length === 0;
  return { reply, order, ready };
}

export function mergeDraft(previous, next) {
  return { ...normaliseIntakeOrder(previous), ...normaliseIntakeOrder(next) };
}

export function buildIntakeMessages(messages, draft = {}, attachmentContext = '') {
  const history = (messages ?? []).map((message) => ({
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content: clean(message.content).slice(0, 4000),
  }));
  const currentDraft = normaliseIntakeOrder(draft);
  const draftLine =
    Object.keys(currentDraft).length === 0
      ? 'Order so far: nothing yet.'
      : `Order so far, update it with anything new and keep what is still true:\n${JSON.stringify(currentDraft)}`;
  return [
    { role: 'system', content: INTAKE_SYSTEM_PROMPT },
    ...history,
    ...(attachmentContext.trim() === ''
      ? []
      : [
          {
            role: 'user',
            content: `Files the customer attached from the chat. Read them and use any order facts in them:\n${attachmentContext}`,
          },
        ]),
    { role: 'user', content: draftLine },
  ];
}
