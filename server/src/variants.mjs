import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { buildVoucherValues } from './render.mjs';
import { buildTitleMarkup } from './title.mjs';

// The 30 brochure templates are ten complete document families crossed with
// three palettes each. templates/variants.json is the catalogue; every family
// is a full four page HTML document under templates/voucher/families, and the
// palette reaches it through CSS variables.

const VARIANTS_FILE = 'variants.json';

const FALLBACK_PALETTE = {
  id: 'copper',
  name: 'Copper',
  accent: '#A65E22',
  accentOnDark: '#D08A4E',
  accentSoft: '#F0E2D3',
  paper: '#FFFFFF',
  coverPaper: '#FBF7F1',
  ink: '#14100C',
  muted: '#6E6259',
  faint: '#A2938A',
  hair: '#E6DED2',
  onDark: '#FFFFFF',
  dark: '#14100C',
};

const FALLBACK_FAMILY = {
  id: 'atelier',
  name: 'Atelier',
  cover: 'editorial',
  file: 'voucher/families/atelier.html',
  summary: 'Editorial paper cover, labelled specification tables, four up finish grid',
  title: { widthMm: 174, availableHeightMm: 46, maxSizePt: 46, lineHeight: 0.98 },
};

const FALLBACK_DATA = {
  version: 0,
  pageCount: 4,
  palettes: [FALLBACK_PALETTE],
  families: [FALLBACK_FAMILY],
  variants: [
    {
      id: 'atelier-copper',
      name: 'Copper Atelier',
      family: 'atelier',
      palette: 'copper',
    },
  ],
};

const HEX = /^#[0-9a-fA-F]{6}$/;
const SAFE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const COVER_ID = /^[a-z][A-Za-z0-9]*$/;
const TEMPLATE_FILE = /^voucher\/families\/[a-z0-9-]+\.html$/;

const PALETTE_COLOR_KEYS = [
  'accent',
  'accentOnDark',
  'accentSoft',
  'paper',
  'coverPaper',
  'ink',
  'muted',
  'faint',
  'hair',
  'onDark',
  'dark',
];

function validateVariantData(data) {
  const problems = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return ['the file must contain a JSON object'];
  }

  const palettes = Array.isArray(data.palettes) ? data.palettes : [];
  const families = Array.isArray(data.families) ? data.families : [];
  const variants = Array.isArray(data.variants) ? data.variants : [];

  if (palettes.length === 0) problems.push('palettes must be a non empty array');
  if (families.length === 0) problems.push('families must be a non empty array');
  if (variants.length === 0) problems.push('variants must be a non empty array');

  const paletteIds = new Set();
  for (const palette of palettes) {
    if (!palette || typeof palette !== 'object') {
      problems.push('every palette must be an object');
      continue;
    }
    if (!SAFE_ID.test(String(palette.id ?? ''))) problems.push(`palette id "${palette.id}" is not a safe id`);
    if (paletteIds.has(palette.id)) problems.push(`palette id "${palette.id}" is duplicated`);
    paletteIds.add(palette.id);
    if (typeof palette.name !== 'string' || palette.name.trim() === '') {
      problems.push(`palette "${palette.id}" needs a name`);
    }
    for (const key of PALETTE_COLOR_KEYS) {
      if (!HEX.test(String(palette[key] ?? ''))) {
        problems.push(`palette "${palette.id}" has an invalid ${key} colour`);
      }
    }
  }

  const familyIds = new Set();
  for (const family of families) {
    if (!family || typeof family !== 'object') {
      problems.push('every family must be an object');
      continue;
    }
    if (!SAFE_ID.test(String(family.id ?? ''))) problems.push(`family id "${family.id}" is not a safe id`);
    if (familyIds.has(family.id)) problems.push(`family id "${family.id}" is duplicated`);
    familyIds.add(family.id);
    if (typeof family.name !== 'string' || family.name.trim() === '') {
      problems.push(`family "${family.id}" needs a name`);
    }
    if (!COVER_ID.test(String(family.cover ?? ''))) {
      problems.push(`family "${family.id}" needs a cover descriptor`);
    }
    if (!TEMPLATE_FILE.test(String(family.file ?? ''))) {
      problems.push(`family "${family.id}" needs a file like voucher/families/${family.id}.html`);
    }
    const scale = family.title;
    if (!scale || typeof scale !== 'object') {
      problems.push(`family "${family.id}" needs a title fitting block`);
    } else {
      for (const key of ['widthMm', 'availableHeightMm', 'maxSizePt', 'lineHeight']) {
        if (!(Number(scale[key]) > 0)) problems.push(`family "${family.id}" needs a positive title.${key}`);
      }
    }
  }

  const variantIds = new Set();
  const combinations = new Set();
  const palettesUsedByFamily = new Map();
  for (const variant of variants) {
    if (!variant || typeof variant !== 'object') {
      problems.push('every variant must be an object');
      continue;
    }
    if (!SAFE_ID.test(String(variant.id ?? ''))) problems.push(`variant id "${variant.id}" is not a safe id`);
    if (variantIds.has(variant.id)) problems.push(`variant id "${variant.id}" is duplicated`);
    variantIds.add(variant.id);
    if (typeof variant.name !== 'string' || variant.name.trim() === '') {
      problems.push(`variant "${variant.id}" needs a name`);
    }
    if (!familyIds.has(variant.family)) {
      problems.push(`variant "${variant.id}" points at unknown family "${variant.family}"`);
    }
    if (!paletteIds.has(variant.palette)) {
      problems.push(`variant "${variant.id}" points at unknown palette "${variant.palette}"`);
    }
    const combination = `${variant.family}/${variant.palette}`;
    if (combinations.has(combination)) {
      problems.push(`variant combination "${combination}" is duplicated`);
    }
    combinations.add(combination);
    if (!palettesUsedByFamily.has(variant.family)) palettesUsedByFamily.set(variant.family, new Set());
    const used = palettesUsedByFamily.get(variant.family);
    if (used.has(variant.palette)) {
      problems.push(`family "${variant.family}" uses palette "${variant.palette}" twice`);
    }
    used.add(variant.palette);
  }

  return problems;
}

function indexData(data, source) {
  const palettesById = new Map(data.palettes.map((palette) => [palette.id, palette]));
  const familiesById = new Map(data.families.map((family) => [family.id, family]));
  const variants = data.variants.map((variant) => ({ ...variant }));
  const byId = new Map(variants.map((variant) => [variant.id, variant]));
  return {
    version: data.version ?? 1,
    pageCount: Number.isInteger(data.pageCount) ? data.pageCount : 4,
    palettes: data.palettes,
    families: data.families,
    variants,
    palettesById,
    familiesById,
    byId,
    defaultTemplateId: variants[0].id,
    source,
  };
}

export function loadVariants(templatesDir) {
  const file = path.join(templatesDir, VARIANTS_FILE);
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return indexData({ ...FALLBACK_DATA }, 'fallback');
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Could not parse ${file}: ${error.message}`);
  }

  const problems = validateVariantData(data);
  if (problems.length > 0) {
    throw new Error(`${file} is not valid:\n- ${problems.join('\n- ')}`);
  }

  for (const family of data.families) {
    const templateFile = path.join(templatesDir, family.file);
    if (!existsSync(templateFile)) {
      problems.push(`family "${family.id}" template was not found at ${templateFile}`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`${file} is not valid:\n- ${problems.join('\n- ')}`);
  }

  return indexData(data, file);
}

export function resolveVariant(variants, templateId) {
  const raw = templateId === undefined || templateId === null ? '' : String(templateId).trim();
  const id = raw === '' ? variants.defaultTemplateId : raw;
  return variants.byId.get(id) ?? null;
}

// Everything a render or a preview needs for one variant: the family document,
// its title fitting rules and the palette tokens.
export function resolveTemplateSelection(variants, templateId) {
  const variant = resolveVariant(variants, templateId);
  if (!variant) return null;
  const family = variants.familiesById.get(variant.family);
  const palette = variants.palettesById.get(variant.palette);
  return { variant, family, palette, templateFile: family.file };
}

export function templateCatalog(variants) {
  return variants.variants.map((variant) => {
    const palette = variants.palettesById.get(variant.palette);
    const family = variants.familiesById.get(variant.family);
    return {
      id: variant.id,
      name: variant.name,
      palette: variant.palette,
      cover: family.cover,
      family: family.id,
      paletteName: palette.name,
      familyName: family.name,
      accent: palette.accent,
      previewUrl: `/previews/${variant.id}.png`,
      pageCount: variants.pageCount,
    };
  });
}

function paletteVariables(palette) {
  const lines = PALETTE_COLOR_KEYS.map((key) => {
    const cssKey = key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    return `--${cssKey}: ${palette[key]};`;
  });
  return lines.join('\n    ');
}

// Order data plus the raw palette CSS and the fitted cover title markup.
export function buildVoucherDocumentValues({
  order,
  materials = [],
  templatesDir,
  variants,
  templateId,
  logger,
}) {
  const selection = resolveTemplateSelection(variants, templateId);
  if (!selection) {
    throw new Error(`Unknown template "${templateId}".`);
  }
  const values = buildVoucherValues({ order, materials, templatesDir, logger });

  return {
    ...values,
    paletteCss: { raw: paletteVariables(selection.palette) },
    title: { raw: buildTitleMarkup(values.title, selection.family.title) },
  };
}

// A fixed order used for the template thumbnails so previews are comparable
// between variants and do not depend on customer data.
export const SAMPLE_ORDER = {
  id: 'preview',
  orderNo: 'GWI-2026-001',
  customerName: 'Arun Kumar',
  title: 'Master Bedroom Wardrobe',
  room: 'Master bedroom',
  width: '2400 mm',
  height: '2100 mm',
  depth: '600 mm',
  shutters: '3 · 800 mm',
  carcass: '18 mm BWP plywood',
  backPanel: '6 mm plywood',
  shuttersMat: '18 mm BWP plywood',
  drawers: '12 mm plywood',
  exterior: '1 mm laminate',
  interior: '0.8 mm white laminate',
  hinges: 'Soft-close',
  channels: 'Soft-close telescopic',
  edgeShutter: '2 mm PVC',
  edgeCarcass: '0.8 mm PVC',
  edgeNote: 'Colour matched',
  handle: 'Matte black aluminium',
  handleNote: 'Vertical · three sets',
  finishExt: 'Matte outside, white inside',
  finishInt: 'No painting',
};

export const SAMPLE_MATERIALS = [
  { name: 'Dark Walnut', kind: 'laminate', hex: '#3F2A1D', imageUrl: '/media/tex-walnut.jpg' },
  { name: 'Cream', kind: 'laminate', hex: '#E8DCC8', imageUrl: '/media/tex-cream.jpg' },
  { name: 'Ash Grey', kind: 'laminate', hex: '#9A9A94', imageUrl: '/media/tex-grey.jpg' },
  { name: 'Edge band', kind: 'edge band', hex: '#8B5A2B', imageUrl: '/media/tex-band.jpg' },
];
