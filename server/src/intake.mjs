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

export const INTAKE_ESSENTIALS = [
  ['customerName', 'customer name'],
  ['title', 'the piece, for example a wardrobe or a bench'],
  ['room', 'the room'],
  ['width', 'width'],
  ['height', 'height'],
  ['depth', 'depth'],
  ['shutters', 'number of shutters'],
];

const FIELD_LIMITS = Object.fromEntries(INTAKE_FIELDS.map((field) => [field, field === 'brief' ? 2000 : 120]));

const INTAKE_SYSTEM_PROMPT = [
  'You are the order intake assistant at Grace Wood Industry, a wardrobe and furniture workshop in Nagercoil, Tamil Nadu.',
  'The customer types their requirement in one or more messages. They may paste a list, a WhatsApp forward, or a rough description. Extract the order facts and keep a short conversation going.',
  'Reply with strict JSON only, exactly this shape:',
  '{"reply": "what you say next", "order": {"customerName": "...", "title": "...", "room": "...", "width": "...", "height": "...", "depth": "...", "shutters": "...", "carcass": "...", "backPanel": "...", "shuttersMat": "...", "drawers": "...", "exterior": "...", "interior": "...", "edgeShutter": "...", "edgeCarcass": "...", "edgeNote": "...", "handle": "...", "handleNote": "...", "finishExt": "...", "finishInt": "...", "brief": "..."}, "ready": false}',
  'Rules for order:',
  '- Include a field only when the customer stated it. Never invent, guess or convert a value.',
  '- Copy numbers with their unit as written, for example "2400 mm". If a dimension is a bare number, write it as "N mm", the workshop works in millimetres.',
  '- Write counts as digits, for example 3 shutters, 2 drawers.',
  '- title is the piece, for example "Master Bedroom Wardrobe". room is where it goes.',
  '- brief is a short summary of anything else useful the customer said, in their words where possible. It must describe the piece, never the deal.',
  '- Never put a price, budget, discount, date, festival or deadline in any field, including brief, or in reply. Leave those words out entirely.',
  'Rules for reply:',
  '- One to three short sentences, warm and plain, British Indian English. No em dashes, no exclamation marks, no questions other than the ones allowed below.',
  '- Ask at most two questions, and only about essentials that are still empty in the draft: customer name, the piece, the room, width, height, depth, number of shutters.',
  '- When ready is true, do not ask a question at all.',
  '- Never ask about materials or finishes. The workshop has standard choices for those.',
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

export function missingEssentials(order) {
  return INTAKE_ESSENTIALS.filter(([field]) => clean(order?.[field]) === '').map(
    ([, label]) => label,
  );
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

export function buildIntakeMessages(messages, draft = {}) {
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
    { role: 'user', content: draftLine },
  ];
}
