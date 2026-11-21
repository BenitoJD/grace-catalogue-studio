// Cache for language model replies.
//
// The same order, the same brief and the same prompt always produce the same
// request. Asking the provider twice for it is waste: it costs money and it
// makes a repeat click slow. Responses are keyed by a hash of the endpoint,
// the model and every message, so a prompt change or a new brief produces a
// new key and can never return stale words.
import { createHash } from 'node:crypto';

import { trimEndpoint } from './llm.mjs';

// Bump this when the meaning of a cached entry changes, for example if the
// stored value stops being the same JSON shape.
export const CACHE_FORMAT_VERSION = '1';

export function buildLlmCacheKey({ endpoint, model, messages }) {
  const material = JSON.stringify({
    format: CACHE_FORMAT_VERSION,
    endpoint: trimEndpoint(endpoint).toLowerCase(),
    model: String(model ?? '').trim(),
    messages: (messages ?? []).map((message) => [message.role, String(message.content ?? '')])
  });
  return createHash('sha256').update(material).digest('hex');
}

export function cacheExpiryCutoff(ttlHours, nowMs = Date.now()) {
  if (!Number.isFinite(ttlHours) || ttlHours <= 0) return null;
  return new Date(nowMs - ttlHours * 60 * 60 * 1000).toISOString();
}
