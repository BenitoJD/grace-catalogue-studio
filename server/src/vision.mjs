// Picture reading with a vision model. The studio's models are vision capable,
// so this is the normal path: one batched call reads the uploaded pictures and
// returns the room, the piece, the colours and the joinery details. A text only
// model never breaks the app: the call fails softly and the deterministic
// reading takes over.
import { thumbnailDataUri } from './image-detail.mjs';
import { resolvePrompt } from './prompts.mjs';

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

export const VISION_PROMPT = [
  'You are the picture analyst at Jacob Design Studio, an interior and joinery workshop.',
  'You receive one or more photographs of one customer project, in order.',
  'Reply with strict JSON only, exactly this shape:',
  '{"pictures": [{"summary": "one short sentence on what this picture shows", "piece": "the joinery piece, for example Wardrobe, TV Unit, Modular Kitchen", "room": "the room, for example Master Bedroom, Living Room, Kitchen", "colours": ["three to five colour names you actually see"], "details": [{"label": "two or three joinery details worth magnifying, for example brass handle, shutter edge, edge banding", "x": 55, "y": 40}], "style": {"mood": "two or three words for the mood of the room, for example quiet minimal, warm traditional, dark cinematic", "materials": ["the visible materials, for example matte laminate, fluted oak, marble, brass"], "light": "how the room is lit, for example soft daylight, warm evening, low moody light", "composition": "how the picture is composed, for example strong vertical lines, centred symmetry, long horizontal", "styling": ["two or three styling words a designer should take from this picture"]}]}]}',
  'One entry per picture, in the same order. x and y are percentages of the picture, pointing at the middle of that detail.',
  'The details must be the joinery, never the floor, the ceiling, a fan or a light fitting.',
  'The style block must describe what the picture actually shows, never a generic category.',
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
    const style = entry?.style && typeof entry.style === 'object' ? entry.style : {};
    const styleList = (value, max = 40, limit = 4) =>
      Array.isArray(value)
        ? value.map((item) => clean(item, max)).filter(Boolean).slice(0, limit)
        : [];
    return {
      summary: clean(entry?.summary, 240),
      piece: clean(entry?.piece, 60),
      room: clean(entry?.room, 60),
      colours: Array.isArray(entry?.colours)
        ? entry.colours.map((colour) => clean(colour, 30)).filter(Boolean).slice(0, 5)
        : [],
      details,
      style: {
        mood: clean(style.mood, 60),
        materials: styleList(style.materials, 30, 5),
        light: clean(style.light, 60),
        composition: clean(style.composition, 80),
        styling: styleList(style.styling, 30, 5),
      },
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
  return `${config?.model ?? ''}|${resolvePrompt('vision', VISION_PROMPT)}|${filePaths.join('|')}`;
}

// Every picture is read, in batches of four per model call, so a project with
// one hundred pages is analysed page by page instead of only the first four.
const VISION_BATCH = 4;

async function readBatch({ config, requestChat, filePaths, logger }) {
  const paths = filePaths;
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
          { role: 'system', content: resolvePrompt('vision', VISION_PROMPT) },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Read these customer project pictures and reply with the JSON.' },
              ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
            ],
          },
        ],
        maxTokens: Math.min(4000, 900 * images.length),
        temperature: 0.2,
        timeoutMs: 120_000,
      });
      return parseBatch(result.content, images.length);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
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

/** Read every picture, batching four per call. Returns one insight per picture. */
const LAYOUT_INSPECTOR_PROMPT = [
  'You are the pre-press inspector of a premium print studio looking at the actual rendered pages of a brochure, not at HTML.',
  'For every page, find real visual defects: two text blocks overlapping; text running under an image; clipped or hidden text; a block floating out of alignment with the page grid; margins that change from page to page; a large empty band; a stray mark, ring, arrow or colour chip; a caption that does not belong to its picture; any element that looks unfinished.',
  'Ignore taste, wording, colour choices and photography quality. Report only layout and alignment defects you can actually see.',
  'Reply with strict JSON only: {"pages":[{"page":1,"issues":["short concrete problem"]}]}. Include only pages with issues. If every page is clean reply {"pages":[]}.',
].join(' ');

export async function inspectRenderedPages({ config, requestChat, filePaths = [], logger }) {
  if (!visionEnabled(config) || filePaths.length === 0) return null;
  const images = filePaths.map((filePath) => thumbnailDataUri(filePath, 900)).filter(Boolean);
  if (images.length === 0) return null;
  try {
    const result = await requestChat({
      provider: config.provider,
      endpoint: config.endpoint,
      model: config.model,
      apiKey: config.apiKey,
      messages: [
        { role: 'system', content: LAYOUT_INSPECTOR_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: `Inspect all ${images.length} rendered pages and reply with the JSON only.` },
            ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
          ],
        },
      ],
      maxTokens: 1800,
      temperature: 0.1,
      timeoutMs: 180_000,
    });
    const text = String(result?.content ?? '').trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(parsed?.pages)) return null;
    return parsed.pages
      .map((entry) => ({
        page: Number.isFinite(entry?.page) ? Number(entry.page) : 0,
        issues: Array.isArray(entry?.issues)
          ? entry.issues.map((issue) => String(issue).replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 4)
          : [],
      }))
      .filter((entry) => entry.issues.length > 0);
  } catch (error) {
    logger?.warn?.('The rendered page inspector could not run.', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function readPicturesWithVision({ config, requestChat, filePaths, logger }) {
  const all = Array.isArray(filePaths) ? filePaths.filter(Boolean) : [];
  if (all.length === 0) return null;
  if (unsupportedModels.has(String(config?.model ?? ''))) return null;
  const batches = [];
  for (let index = 0; index < all.length; index += VISION_BATCH) {
    batches.push(all.slice(index, index + VISION_BATCH));
  }
  const results = await Promise.all(
    batches.map((batch) => readBatch({ config, requestChat, filePaths: batch, logger })),
  );
  const flat = [];
  batches.forEach((batch, index) => {
    const found = results[index];
    for (let offset = 0; offset < batch.length; offset += 1) {
      flat.push(found?.[offset] ?? null);
    }
  });
  return flat;
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
