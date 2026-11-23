// The design reference library.
//
// The gallery is not a set of hand drawn templates. It is a library of design
// directions the model writes for us: 100 distinct looks, each one a palette,
// a type voice, a mood and a cover idea. A customer or salesperson points at a
// reference to say "like this", and the brochure designer composes real pages
// for the actual order in that spirit.
//
// The library is generated in the background, in four volumes, and stored in
// the database after every volume so the gallery fills up while the person is
// already browsing.
import { LlmError, clean, parseJsonObject } from './llm.mjs';

export const CATALOG_VERSION = 1;
export const CATALOG_SIZE = 100;
export const CATALOG_BATCH = 25;

const FONTS = new Set(['Instrument Serif', 'Barlow']);
const ORNAMENTS = new Set(['jaali', 'paisley', 'lotus', 'rangoli', 'arch', 'none']);
const PALETTE_KEYS = ['paper', 'ink', 'deep', 'accent', 'gold', 'hair', 'muted', 'onDark'];
const HEX = /^#[0-9a-fA-F]{6}$/;

const VOLUMES = [
  {
    title: 'warm traditional',
    brief:
      'Warm traditional: deep maroon, muted gold, cream paper, a temple quiet. Festive but restrained, the kind of book a family keeps.',
  },
  {
    title: 'modern editorial',
    brief:
      'Modern editorial: cream and charcoal, enormous photographs, wide quiet margins, small caps labels. A design magazine look with an Indian hand.',
  },
  {
    title: 'colour and craft',
    brief:
      'Colour and craft: teal, indigo, olive and copper, led by the finish samples and the grain. Calm colour fields, one strong accent, very few words.',
  },
  {
    title: 'ornament and celebration',
    brief:
      'Ornament and celebration: jaali, lotus, rangoli and temple arches, wedding and festival moods, gold used like jewellery. Still quiet and expensive.',
  },
];

const SYSTEM = [
  'You are the design director of Grace Wood Industry, a wardrobe and furniture workshop in Nagercoil, Tamil Nadu.',
  'You are writing the house library of printed brochure design references. Each reference is a look a customer can point at to say "like this": a palette, a type voice, a mood and a cover idea.',
  'A reference is a feeling, never a finished layout. Another designer will compose the real four page brochure from the order, the photographs and this reference.',
  'The house is Indian and modern: cream paper, deep maroon, muted gold, Tamil and English together, ornament used like jewellery, generous margins, large type, few words.',
  'Reply with strict JSON only, in exactly this shape:',
  '{"designs":[{"id":"kebab-case-id","name":"Two or three words","family":"Atelier","mood":"three to five adjectives","summary":"at most 16 words describing the feel","palette":{"paper":"#FBF3E4","ink":"#2A1512","deep":"#4A1116","accent":"#7C2A22","gold":"#C79A3A","hair":"#E3D2B8","muted":"#6B4A3E","onDark":"#FBF3E4"},"displayFont":"Instrument Serif","bodyFont":"Barlow","coverIdea":"at most 18 words on the cover mood, not a template","ornament":"jaali"}]}',
  'Rules for every reference:',
  '- The palette must be a complete set of the eight keys above, with real six digit hex values. paper is always a light warm paper (between #F7EFE0 and #FDFBF6), ink is dark (luminance below #333), and gold is a muted metal (not bright yellow).',
  '- The accent and deep colours carry the mood. Warm maroons, teals, indigos, olives, coppers, sandal and peacock blues are the house range.',
  '- family is the genre of the look. Choose from: Atelier, Ledger, Jaali, Monsoon, Kolam, Verandah, Bazaar, Manuscript, Courtyard, Silk Route, Laterite, Palm Court. Use a genre when the look truly belongs to it, and spread the genres across the library; do not put every reference in Atelier.',
  '- displayFont is exactly "Instrument Serif" or "Barlow". bodyFont is always "Barlow".',
  '- ornament is exactly one of: jaali, paisley, lotus, rangoli, arch, none. The house is Indian, so at least three of every four references use a motif; none is only for the most severe minimal looks.',
  '- coverIdea describes the mood and where the picture and type might sit, for example "A tall photograph with the title low across it and the brand at the head". It must not prescribe a fixed template.',
  '- summary is a fresh line, not a marketing sentence. No hyped words: premium, luxury, elegant, timeless, bespoke, stunning, perfect, crafted, transform, elevate, seamless.',
  '- Names are short, evocative and specific to the palette and mood. No two names may repeat.',
  '- ids are lowercase letters, digits and single hyphens, unique across the whole library.',
  '- No em dashes, en dashes, exclamation marks, questions or emoji anywhere.',
  'No prose, markdown or code fences around the JSON.',
].join('\n');

export function buildCatalogMessages({ volumeIndex = 0, count = CATALOG_BATCH, existingNames = [] } = {}) {
  const volume = VOLUMES[Math.abs(volumeIndex) % VOLUMES.length];
  const avoid = existingNames.slice(-120);
  return [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: [
        `Write ${count} new design references for volume ${Math.abs(volumeIndex) % VOLUMES.length + 1} of 4: ${volume.title}.`,
        `This volume: ${volume.brief}`,
        'Make the references genuinely different from each other in palette, type and mood. Vary the paper, the accent, the depth of ink, the ornament and how much the photograph leads.',
        avoid.length > 0
          ? `These references already exist. Do not repeat their names, moods or palettes:\n${avoid.join(', ')}`
          : 'This is the first volume, so set the range for the whole library.',
        `Reply with exactly ${count} references as strict JSON.`,
      ].join('\n\n'),
    },
  ];
}

function slug(value) {
  return clean(value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function paletteOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const palette = {};
  for (const key of PALETTE_KEYS) {
    const value = clean(raw[key]).toUpperCase();
    if (!HEX.test(value)) return null;
    palette[key] = value;
  }
  return palette;
}

/**
 * Read one volume of references. Anything that would make a bad gallery card
 * or a bad design brief is rejected with a readable reason, for one retry.
 */
export function parseCatalogReply(content, { count = CATALOG_BATCH, existingIds = [], existingNames = [] } = {}) {
  const payload = parseJsonObject(content);
  if (!payload || !Array.isArray(payload.designs)) {
    throw new LlmError('The design references came back in an unreadable shape.', { type: 'invalid_reply' });
  }
  const ids = new Set(existingIds);
  const names = new Set(existingNames.map((name) => String(name).toLowerCase()));
  const designs = [];
  const issues = [];
  for (const raw of payload.designs) {
    if (designs.length >= count) break;
    if (!raw || typeof raw !== 'object') continue;
    const name = clean(raw.name).slice(0, 40);
    const family = clean(raw.family).slice(0, 30);
    const mood = clean(raw.mood).slice(0, 70);
    const summary = clean(raw.summary).slice(0, 120);
    const coverIdea = clean(raw.coverIdea).slice(0, 160);
    const ornament = clean(raw.ornament).toLowerCase();
    const displayFont = FONTS.has(clean(raw.displayFont)) ? clean(raw.displayFont) : 'Instrument Serif';
    const id = slug(raw.id) || slug(name);
    const palette = paletteOf(raw.palette);
    if (!name || !id) continue;
    if (names.has(name.toLowerCase())) {
      issues.push(`duplicate name "${name}"`);
      continue;
    }
    if (ids.has(id)) {
      issues.push(`duplicate id "${id}"`);
      continue;
    }
    if (!palette) {
      issues.push(`"${name}" has an incomplete palette`);
      continue;
    }
    if (!ORNAMENTS.has(ornament)) {
      issues.push(`"${name}" chose an unknown ornament "${ornament}"`);
      continue;
    }
    if (summary === '' || coverIdea === '') {
      issues.push(`"${name}" is missing a summary or a cover idea`);
      continue;
    }
    ids.add(id);
    names.add(name.toLowerCase());
    designs.push({
      id,
      name,
      family: family || name.split(' ')[0],
      mood: mood || 'quiet, warm',
      summary,
      palette,
      displayFont,
      bodyFont: 'Barlow',
      coverIdea,
      ornament,
    });
  }
  if (designs.length < count) {
    throw new LlmError(
      `The design references were incomplete: ${count} were asked for, ${designs.length} were usable. ${[
        ...new Set(issues),
      ]
        .slice(0, 6)
        .join('; ')}`,
      { type: 'invalid_reply' },
    );
  }
  return designs;
}

/** The text a design reference contributes to the brochure designer prompt. */
export function referenceForDesigner(design) {
  if (!design) return null;
  const palette = design.palette ?? {};
  return {
    id: design.id,
    name: design.name,
    family: design.family,
    mood: design.mood,
    summary: design.summary,
    palette,
    displayFont: design.displayFont,
    bodyFont: design.bodyFont,
    coverIdea: design.coverIdea,
    ornament: design.ornament,
  };
}

export function designReferenceHint(design) {
  return design ? `${design.name} · ${design.mood}` : '';
}
