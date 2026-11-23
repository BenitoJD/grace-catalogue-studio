// One optional vision pass, used only when the configured model can actually
// see pictures. It reads the first photograph of the order and returns a
// short, structured description the intake assistant can confirm with the
// customer. When the model cannot see images, nothing here is called.
import { thumbnailDataUri } from './image-detail.mjs';

// Model ids known to accept image content on their OpenAI compatible endpoint.
const VISION_PATTERNS = [
  /gpt-4o/i,
  /gpt-4\.1/i,
  /gpt-4\.5/i,
  /gpt-5/i,
  /o[34]-/i,
  /claude-(3|4|sonnet|opus|haiku)/i,
  /gemini/i,
  /qwen.*(vl|vision)/i,
  /llama.*vision/i,
  /pixtral/i,
  /mistral.*(vision|small)/i,
  /glm-.*v/i,
  /internvl/i,
  /minicpm.*v/i,
];

export function supportsVisionModel(model) {
  const text = String(model ?? '');
  return VISION_PATTERNS.some((pattern) => pattern.test(text));
}

const VISION_PROMPT = [
  'You are the picture analyst at Jacob Design Studio, an interior and joinery workshop.',
  'Read the photograph of the customer project. Reply with strict JSON only:',
  '{"summary": "one short sentence on what this room shows", "piece": "the joinery piece, for example Wardrobe, TV Unit, Modular Kitchen", "room": "the room, for example Master Bedroom, Living Room, Kitchen", "colours": ["three to five colour names you actually see"], "details": ["two or three joinery details worth magnifying, for example brass handle, shutter edge, panel joint, edge banding"]}',
  'No markdown and no prose outside the JSON.',
].join(' ');

function parseInsight(content) {
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
  const clean = (value, max = 140) =>
    typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
  const summary = clean(parsed.summary, 220);
  const piece = clean(parsed.piece, 60);
  const room = clean(parsed.room, 60);
  if (!summary && !piece && !room) return null;
  const colours = Array.isArray(parsed.colours)
    ? parsed.colours.map((value) => clean(value, 30)).filter(Boolean).slice(0, 5)
    : [];
  const details = Array.isArray(parsed.details)
    ? parsed.details.map((value) => clean(value, 60)).filter(Boolean).slice(0, 4)
    : [];
  return { summary, piece, room, colours, details };
}

/**
 * Ask the configured model to read one picture. Returns null on any failure so
 * the deterministic picture reading always remains available.
 */
export async function readPictureWithVision({ config, requestChat, filePath, logger }) {
  if (!supportsVisionModel(config?.model)) return null;
  const image = filePath ? thumbnailDataUri(filePath, 640) : null;
  if (!image) return null;
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
            { type: 'text', text: 'Read this customer project picture and reply with the JSON.' },
            { type: 'image_url', image_url: { url: image } },
          ],
        },
      ],
      maxTokens: 500,
      temperature: 0.2,
      timeoutMs: 45_000,
    });
    return parseInsight(result.content);
  } catch (error) {
    logger?.warn?.('The vision pass could not read the picture.', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
