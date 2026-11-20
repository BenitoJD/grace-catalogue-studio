import { readFileSync } from 'node:fs';
import path from 'node:path';

import { buildCoverBlock } from './covers.mjs';
import { buildVoucherValues } from './render.mjs';

// The 30 brochure variants live in templates/variants.json as data: six cover
// layouts crossed with five palettes. The base template in templates/voucher
// receives palette CSS variables and a generated cover block, so a variant is a
// real four page voucher rather than a separate HTML file.

const VARIANTS_FILE = 'variants.json';

// Used when the template directory has no variants.json (for example a minimal
// test fixture). It keeps the render pipeline working without the catalogue.
const FALLBACK_DATA = {
  version: 0,
  pageCount: 4,
  palettes: [
    {
      id: 'copper',
      name: 'Copper',
      accent: '#A65E22',
      coverPaper: '#FBF7F1',
      coverInk: '#14100C',
      coverMuted: '#6E6259',
      onPhoto: '#FFFFFF',
      gradientTop: 'rgba(18,13,9,0.20)',
      gradientBottom: 'rgba(18,13,9,0.80)',
      bandScrim: 'rgba(18,13,9,0.55)',
    },
  ],
  covers: [
    {
      id: 'fullBleed',
      name: 'Full Bleed',
      typeScale: { titleMaxPt: 58, titleLineHeight: 0.98, kickerPt: 5.1 },
    },
  ],
  variants: [{ id: 'copper-full-bleed', name: 'Copper Full Bleed', palette: 'copper', cover: 'fullBleed' }],
};

const HEX = /^#[0-9a-fA-F]{6}$/;
const COLOR_FUNCTION = /^rgba?\([0-9.,\s%]+\)$/;
const SAFE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const COVER_ID = /^[a-z][A-Za-z0-9]*$/;

function validateVariantData(data) {
  const problems = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return ['the file must contain a JSON object'];
  }

  const palettes = Array.isArray(data.palettes) ? data.palettes : [];
  const covers = Array.isArray(data.covers) ? data.covers : [];
  const variants = Array.isArray(data.variants) ? data.variants : [];

  if (palettes.length === 0) problems.push('palettes must be a non empty array');
  if (covers.length === 0) problems.push('covers must be a non empty array');
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
    if (!HEX.test(String(palette.accent ?? ''))) {
      problems.push(`palette "${palette.id}" needs a six digit hex accent`);
    }
    for (const key of ['coverPaper', 'coverInk', 'coverMuted', 'onPhoto']) {
      if (!HEX.test(String(palette[key] ?? ''))) {
        problems.push(`palette "${palette.id}" has an invalid ${key}`);
      }
    }
    for (const key of ['gradientTop', 'gradientBottom', 'bandScrim']) {
      if (!COLOR_FUNCTION.test(String(palette[key] ?? ''))) {
        problems.push(`palette "${palette.id}" has an invalid ${key}`);
      }
    }
  }

  const coverIds = new Set();
  for (const cover of covers) {
    if (!cover || typeof cover !== 'object') {
      problems.push('every cover must be an object');
      continue;
    }
    if (!COVER_ID.test(String(cover.id ?? ''))) problems.push(`cover id "${cover.id}" is not a safe id`);
    if (coverIds.has(cover.id)) problems.push(`cover id "${cover.id}" is duplicated`);
    coverIds.add(cover.id);
    if (typeof cover.name !== 'string' || cover.name.trim() === '') {
      problems.push(`cover "${cover.id}" needs a name`);
    }
    const scale = cover.typeScale;
    if (!scale || typeof scale !== 'object') {
      problems.push(`cover "${cover.id}" needs a typeScale`);
    } else {
      if (!(Number(scale.titleMaxPt) > 0)) problems.push(`cover "${cover.id}" needs a positive titleMaxPt`);
      if (!(Number(scale.titleLineHeight) > 0)) problems.push(`cover "${cover.id}" needs a positive titleLineHeight`);
      if (!(Number(scale.kickerPt) > 0)) problems.push(`cover "${cover.id}" needs a positive kickerPt`);
    }
  }

  const variantIds = new Set();
  const combinations = new Set();
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
    if (!paletteIds.has(variant.palette)) {
      problems.push(`variant "${variant.id}" points at unknown palette "${variant.palette}"`);
    }
    if (!coverIds.has(variant.cover)) {
      problems.push(`variant "${variant.id}" points at unknown cover "${variant.cover}"`);
    }
    const combination = `${variant.palette}/${variant.cover}`;
    if (combinations.has(combination)) {
      problems.push(`variant combination "${combination}" is duplicated`);
    }
    combinations.add(combination);
  }

  return problems;
}

function indexData(data, source) {
  const palettesById = new Map(data.palettes.map((palette) => [palette.id, palette]));
  const coversById = new Map(data.covers.map((cover) => [cover.id, cover]));
  const variants = data.variants.map((variant) => ({ ...variant }));
  const byId = new Map(variants.map((variant) => [variant.id, variant]));
  return {
    version: data.version ?? 1,
    pageCount: Number.isInteger(data.pageCount) ? data.pageCount : 4,
    palettes: data.palettes,
    covers: data.covers,
    variants,
    palettesById,
    coversById,
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
  return indexData(data, file);
}

export function resolveTemplate(variants, templateId) {
  const raw = templateId === undefined || templateId === null ? '' : String(templateId).trim();
  const id = raw === '' ? variants.defaultTemplateId : raw;
  return variants.byId.get(id) ?? null;
}

export function templateCatalog(variants) {
  return variants.variants.map((variant) => {
    const palette = variants.palettesById.get(variant.palette);
    const cover = variants.coversById.get(variant.cover);
    return {
      id: variant.id,
      name: variant.name,
      palette: variant.palette,
      cover: variant.cover,
      paletteName: palette.name,
      coverName: cover.name,
      accent: palette.accent,
      previewUrl: `/previews/${variant.id}.png`,
      pageCount: variants.pageCount,
    };
  });
}

function paletteVariables(palette) {
  return {
    paletteCss: {
      raw:
        `--accent: ${palette.accent};\n` +
        `    --cover-paper: ${palette.coverPaper};\n` +
        `    --cover-ink: ${palette.coverInk};\n` +
        `    --cover-muted: ${palette.coverMuted};`,
    },
  };
}

function typeScaleVariables(cover) {
  return {
    typeScaleCss: {
      raw:
        `--cover-title-size: ${cover.typeScale.titleMaxPt}pt;\n` +
        `    --cover-title-line: ${cover.typeScale.titleLineHeight};\n` +
        `    --cover-kicker-size: ${cover.typeScale.kickerPt}pt;`,
    },
  };
}

// Values for a voucher rendered with a variant: the order data plus the raw CSS
// variables and the generated cover block for page one.
export function buildVoucherDocumentValues({ order, materials = [], templatesDir, variants, templateId }) {
  const variant = resolveTemplate(variants, templateId);
  if (!variant) {
    throw new Error(`Unknown template "${templateId}".`);
  }
  const palette = variants.palettesById.get(variant.palette);
  const cover = variants.coversById.get(variant.cover);
  const values = buildVoucherValues({ order, materials, templatesDir });

  return {
    ...values,
    ...paletteVariables(palette),
    ...typeScaleVariables(cover),
    coverBlock: {
      raw: buildCoverBlock({ cover: cover.id, palette, values, typeScale: cover.typeScale }),
    },
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
