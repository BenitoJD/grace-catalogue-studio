// Picture reading with a vision model. The studio's models are vision capable,
// so this is the normal path: one batched call reads the uploaded pictures and
// returns the room, the piece, the colours and the joinery details. A text only
// model never breaks the app: the call fails softly and the deterministic
// reading takes over.
import { thumbnailDataUri } from './image-detail.mjs';

// Models that are known to accept image content on an OpenAI compatible
// endpoint. Used only in "auto" mode; "on" mode always attempts the call.
const VISION_PATTERNS = [
  /gpt-4o/i,
  /gpt-4\.1/i,
  /gpt-4\.5/i,
  /gpt-5/i,
  /o[34]-/i,
  /claude/i,
  /gemini/i,
  /qwen.*(vl|vision)/i,
  /llama.*vision/i,
  /pixtral/i,
  /mistral.*(vision|small)/i,
  /glm-.*v/i,
  /internvl/i,
  /minicpm.*v/i,
  /deepseek.*(vl|vision)/i,
];

export function supportsVisionModel(model) {
  const text = String(model ?? '');
  return VISION_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * The studio says its models can all see, so vision is on by default. `auto`
 * keeps the name check, `off` forces the deterministic reading. The value is
 * read from the environment so a test or a machine can choose.
 */
export function visionMode(env = process.env) {
  const value = String(env.LLM_VISION_MODE ?? 'on').trim().toLowerCase();
  return value === 'auto' || value === 'off' ? value : 'on';
}

export function visionEnabled(config, env = process.env) {
  const mode = visionMode(env);
  if (mode === 'off') return false;
  if (mode === 'auto') return supportsVisionModel(config?.model);
  return true;
}

const VISION_PROMPT = [
  'You are the picture analyst at Jacob Design Studio, an interior and joinery workshop.',
  'You receive one or more photographs of one customer project, in order.',
  'Reply with strict JSON only, exactly this shape:',
  '{"pictures": [{"summary": "one short sentence on what this picture shows", "piece": "the joinery piece, for example Wardrobe, TV Unit, Modular Kitchen", "room": "the room, for example Master Bedroom, Living Room, Kitchen", "colours": ["three to five colour names you actually see"], "details": [{"label": "two or three joinery details worth magnifying, for example brass handle, shutter edge, edge banding", "x": 55, "y": 40}]}]}',
  'One entry per picture, in the same order. x and y are percentages of the picture, pointing at the middle of that detail.',
  'The details must be the joinery, never the floor, the ceiling, a fan or a light fitting.',
  'No markdown and no prose outside the JSON.',
].join(' ');

function parseBatch(content, count) {
  const text = String(content ?? '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed.pictures)) return null;
  const clean = (value, max = 140) =>
    typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
  const pictures = parsed.pictures.slice(0, count).map((entry) => {
    const details = Array.isArray(entry?.details)
      ? entry.details
          .map((detail) => {
            if (typeof detail === 'string') return { label: clean(detail, 60), x: null, y: null };
            return {
              label: clean(detail?.label, 60),
              x: Number.isFinite(detail?.x) ? Math.min(96, Math.max(4, detail.x)) : null,
              y: Number.isFinite(detail?.y) ? Math.min(92, Math.max(8, detail.y)) : null,
            };
          })
          .filter((detail) => detail.label !== '')
          .slice(0, 4)
      : [];
    return {
      summary: clean(entry?.summary, 240),
      piece: clean(entry?.piece, 60),
      room: clean(entry?.room, 60),
      colours: Array.isArray(entry?.colours)
        ? entry.colours.map((colour) => clean(colour, 30)).filter(Boolean).slice(0, 5)
        : [],
      details,
    };
  });
  return pictures.length > 0 ? pictures : null;
}

// Vision calls are cached per model and picture set, so the review, the intake
// confirmation and the designer brief share one call instead of three.
const cache = new Map();
const CACHE_LIMIT = 40;
// A model that rejects image content once does not get retried for every order.
const unsupportedModels = new Set();

function cacheKey(config, filePaths) {
  return `${config?.model ?? ''}|${filePaths.join('|')}`;
}

/**
 * Read up to four pictures in one call. Resolves with one insight per picture,
 * or null when the model cannot see or the reply is unusable.
 */
export async function readPicturesWithVision({ config, requestChat, filePaths, logger }) {
  const paths = (Array.isArray(filePaths) ? filePaths : []).slice(0, 4);
  if (paths.length === 0) return null;
  if (unsupportedModels.has(String(config?.model ?? ''))) return null;
  const key = cacheKey(config, paths);
  if (cache.has(key)) return cache.get(key);

  const promise = (async () => {
    const images = paths.map((filePath) => thumbnailDataUri(filePath, 640)).filter(Boolean);
    if (images.length === 0) return null;
    try {
      const result = await requestChat({
        provider: config.provider,
        endpoint: config.endpoint,
        model: config.model,
        apiKey: config.apiKey,
        messages: [
          { role: 'system', content: VISION_PROMPT },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Read these customer project pictures and reply with the JSON.' },
              ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
            ],
          },
        ],
        maxTokens: 900,
        temperature: 0.2,
        timeoutMs: 60_000,
      });
      return parseBatch(result.content, images.length);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A model that cannot take image content is remembered, so the rest of
      // the session falls back to the deterministic reading without cost.
      if (/image|vision|multimodal|content|unsupported/i.test(message)) {
        unsupportedModels.add(String(config?.model ?? ''));
      }
      logger?.warn?.('The vision pass could not read the pictures.', { reason: message });
      return null;
    }
  })();

  cache.set(key, promise);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  return promise;
}

/** One picture, for callers that only need the first. */
export async function readPictureWithVision({ config, requestChat, filePath, logger }) {
  const pictures = await readPicturesWithVision({
    config,
    requestChat,
    filePaths: filePath ? [filePath] : [],
    logger,
  });
  return pictures?.[0] ?? null;
}
