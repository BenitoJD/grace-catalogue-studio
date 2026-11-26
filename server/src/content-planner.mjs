// The content planner. Given the written copy and what the vision pass saw in
// every picture, it chooses the cover photograph and the order of the picture
// pages, with a caption for each. The studio then lays those choices out on the
// fixed grid; the planner never writes HTML and never touches coordinates.
import { clean } from './llm.mjs';

export const PLANNER_MAX_TOKENS = 1600;

export function buildPlannerMessages({ order = {}, copy = {}, pictureAnalysis = [], format = 'pamphlet' }) {
  const photos = pictureAnalysis.map((picture, index) => ({
    photo: index + 1,
    reading: clean(picture?.summary ?? ''),
    mood: clean(picture?.style?.mood ?? ''),
    materials: Array.isArray(picture?.style?.materials) ? picture.style.materials : [],
    light: clean(picture?.style?.light ?? ''),
  }));
  return [
    {
      role: 'system',
      content: [
        'You are the picture editor of Jacob Design Studio, a premium print studio in Nagercoil.',
        'You receive the written copy of one pamphlet or brochure and a reading of every project photograph.',
        'Choose the cover photograph and the order in which the photographs run as full picture pages.',
        'The strongest single image with the clearest space and the best light leads the cover. The rest run in an order that tells the room as a story: arrival, detail, contrast, rest.',
        'For each picture page write one caption of six to fourteen words, in plain British English, naming what the photograph actually shows and one material or colour note. No em dashes and no en dashes.',
        'Reply with strict JSON only, exactly this shape:',
        '{"coverPhoto": 1, "picturePages": [{"photo": 2, "caption": "..."}, {"photo": 1, "caption": "..."}]}',
        'Every photo number that exists must appear exactly once across coverPhoto and picturePages. Use only the numbers supplied.',
      ].join(' '),
    },
    {
      role: 'user',
      content: JSON.stringify({
        format,
        coverLine: clean(copy.headline ?? ''),
        story: clean(copy.body ?? ''),
        closing: clean(copy.closing ?? ''),
        title: clean(order.title ?? ''),
        room: clean(order.room ?? ''),
        photos,
      }),
    },
  ];
}

export function parseBookPlan(content, photoCount = 0) {
  const text = String(content ?? '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const valid = (value) => {
    const number = Number.parseInt(String(value ?? ''), 10);
    return Number.isInteger(number) && number >= 1 && number <= photoCount ? number : null;
  };
  const coverPhoto = valid(parsed?.coverPhoto);
  if (coverPhoto === null) return null;
  const entries = [];
  const seen = new Set([coverPhoto]);
  for (const entry of Array.isArray(parsed?.picturePages) ? parsed.picturePages : []) {
    const photo = valid(entry?.photo);
    if (photo === null || seen.has(photo)) continue;
    const caption = clean(String(entry?.caption ?? '').replace(/[\u2013\u2014]/g, '-')).slice(0, 180);
    if (caption === '') continue;
    seen.add(photo);
    entries.push({ photo, caption });
  }
  return { coverPhoto, picturePages: entries };
}

export async function planBookWithModel({
  config,
  requestChat,
  order,
  copy,
  pictureAnalysis,
  format = 'pamphlet',
  logger,
}) {
  const photoCount = Array.isArray(pictureAnalysis) ? pictureAnalysis.length : 0;
  if (photoCount === 0) return null;
  try {
    const result = await requestChat({
      provider: config.provider,
      endpoint: config.endpoint,
      model: config.model,
      apiKey: config.apiKey,
      messages: buildPlannerMessages({ order, copy, pictureAnalysis, format }),
      maxTokens: PLANNER_MAX_TOKENS,
      temperature: 0.3,
      timeoutMs: 120_000,
    });
    const plan = parseBookPlan(result?.content, photoCount);
    if (!plan) {
      logger?.warn?.('The content planner reply could not be read.', {
        preview: String(result?.content ?? '').slice(0, 160),
      });
      return null;
    }
    return plan;
  } catch (error) {
    logger?.warn?.('The content planner could not run.', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
