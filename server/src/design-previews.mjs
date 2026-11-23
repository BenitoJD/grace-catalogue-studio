// The preview engine: every design reference proves itself.
//
// A reference is only a promise until a real brochure is printed in its spirit.
// For each reference this module designs, typesets and renders a complete four
// page brochure from one fixed sample order, using the same prompt path, the
// same print checks and the same renderer as a customer brochure. Only a
// document that passes every check earns its preview image; anything else is
// retried once and then left for a later run, never shown.
//
// The work runs in the background, one reference at a time, and every finished
// preview is saved immediately: the cover page image and the full PDF live in
// data/design-previews, and the reference entry records that it is ready. A
// restart resumes where it left off, so one hundred references cost patience,
// not attention.
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

import {
  DESIGNER_MAX_TOKENS,
  DESIGNER_TEMPERATURE,
  DESIGNER_TRIES,
  MAX_DESIGN_PAGES,
  MIN_DESIGN_PAGES,
  buildDesignerMessages,
  buildDesignerRepairMessages,
  compileGenerativeBrochure,
  defaultPhotoUrls,
  parseDesignerReply,
  photoProfiles,
} from './ai-brochure.mjs';
import { referenceForDesigner } from './design-catalog.mjs';
import { getDesignCatalog, putDesignCatalog } from './db.mjs';
import { buildCopyMessages, buildCopyRepairMessages, copyQualityIssues, parseCopyReply } from './llm.mjs';

// The one order every preview is printed from. Fixed, so every reference is
// judged on the same facts, the same photographs and the same words.
export const SAMPLE_ORDER = Object.freeze({
  id: 'preview-sample',
  orderNo: 'SAMPLE-001',
  title: 'Sample Master Wardrobe',
  room: 'Master bedroom',
  customerName: 'Sample Customer',
  width: '2400 mm',
  height: '2100 mm',
  depth: '600 mm',
  shutters: '3',
  carcass: '18 mm BWP plywood',
  backPanel: '6 mm plywood',
  shuttersMat: '18 mm BWP plywood',
  drawers: 'Two drawers',
  exterior: 'Warm oak laminate',
  interior: '0.8 mm white laminate',
  hinges: 'Soft-close',
  channels: 'Soft-close telescopic',
  edgeShutter: '2 mm PVC',
  edgeCarcass: '0.8 mm PVC',
  edgeNote: 'Colour matched',
  handle: 'Matte black aluminium',
  handleNote: 'Vertical, one set per shutter',
  finishExt: 'Matte outside, white inside',
  finishInt: 'No painting',
  brief: 'A calm master bedroom with warm wood and generous hanging space.',
  design_direction: '',
});

function sampleCopyFromDb(db) {
  const catalog = getDesignCatalog(db);
  const raw = catalog.sampleCopy;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.headline === 'string' && typeof parsed.body === 'string') return parsed;
    return null;
  } catch {
    return null;
  }
}

/**
 * The words every preview is set in. Written once by the model from the sample
 * order, repaired once if the quality rules complain, then kept in settings so
 * one hundred previews share one voice and cost one call.
 */
export async function ensureSampleCopy({ db, config, requestChat, logger }) {
  const stored = sampleCopyFromDb(db);
  if (stored) return { copy: stored, cached: true };
  const baseMessages = buildCopyMessages(SAMPLE_ORDER, SAMPLE_ORDER.brief);
  let result = await requestChat({
    provider: config.provider,
    endpoint: config.endpoint,
    model: config.model,
    apiKey: config.apiKey,
    messages: baseMessages,
    maxTokens: 4000,
    temperature: 0.5,
    timeoutMs: 120_000,
  });
  let copy = parseCopyReply(result.content);
  if (copyQualityIssues(copy, SAMPLE_ORDER).length > 0) {
    result = await requestChat({
      provider: config.provider,
      endpoint: config.endpoint,
      model: config.model,
      apiKey: config.apiKey,
      messages: buildCopyRepairMessages(SAMPLE_ORDER, SAMPLE_ORDER.brief, copy, copyQualityIssues(copy, SAMPLE_ORDER)),
      maxTokens: 4000,
      temperature: 0.5,
      timeoutMs: 120_000,
    });
    copy = parseCopyReply(result.content);
  }
  const refreshed = getDesignCatalog(db);
  putDesignCatalog(db, {
    version: refreshed.version,
    expected: refreshed.expected,
    designs: refreshed.designs,
    sampleCopy: JSON.stringify(copy),
  });
  logger?.info?.('Design preview words written.', {});
  return { copy, cached: false };
}

function previewPaths(dataDir, designId) {
  const directory = path.join(dataDir, 'design-previews');
  return {
    directory,
    png: path.join(directory, `${designId}.png`),
    pdf: path.join(directory, `${designId}.pdf`),
  };
}

export function previewReadyOnDisk(dataDir, designId) {
  const paths = previewPaths(dataDir, designId);
  try {
    return existsSync(paths.png);
  } catch {
    return false;
  }
}

/**
 * Design, check, render and save the preview for one reference. Returns true
 * when the preview is ready, false when the model could not produce a
 * printable document this run. Throws only on infrastructure failures.
 */
export async function buildPreviewForDesign(deps, design) {
  const { db, renderer, templatesDir, dataDir, materials, config, requestChat, newRenderId, logger } = deps;
  const photos = defaultPhotoUrls(templatesDir);
  const photoShapes = photoProfiles(photos, templatesDir);
  const { copy } = await ensureSampleCopy({ db, config, requestChat, logger });
  const reference = referenceForDesigner(design);
  const messages = buildDesignerMessages({
    order: SAMPLE_ORDER,
    brief: SAMPLE_ORDER.brief,
    direction: '',
    copy,
    photos,
    photoShapes,
    reference,
  });

  let html = null;
  let previousReply = '';
  let lastIssues = '';
  for (let attempt = 1; attempt <= DESIGNER_TRIES && !html; attempt += 1) {
    const requestMessages =
      attempt === 1 ? messages : buildDesignerRepairMessages(messages, previousReply, lastIssues);
    const result = await requestChat({
      provider: config.provider,
      endpoint: config.endpoint,
      model: config.model,
      apiKey: config.apiKey,
      messages: requestMessages,
      maxTokens: DESIGNER_MAX_TOKENS,
      temperature: DESIGNER_TEMPERATURE,
      timeoutMs: 300_000,
    });
    previousReply = result.content;
    try {
      const document = parseDesignerReply(result.content, photos.length);
      html = compileGenerativeBrochure({
        order: SAMPLE_ORDER,
        materials,
        templatesDir,
        attachmentImages: [],
        copy,
        pages: document.pages,
        styles: document.styles,
      });
    } catch (error) {
      if (error?.type !== 'invalid_reply') throw error;
      lastIssues = error.message;
      logger?.warn?.('Design preview failed the print checks, asking once more.', {
        design: design.id,
        attempt,
        reason: String(lastIssues).slice(0, 300),
      });
    }
  }
  if (!html) return false;

  const renderId = newRenderId();
  const rendered = await renderer.renderHtml({ html, renderId });
  if (!rendered || rendered.pageCount < MIN_DESIGN_PAGES || rendered.pageCount > MAX_DESIGN_PAGES) return false;
  const paths = previewPaths(dataDir, design.id);
  mkdirSync(paths.directory, { recursive: true });
  const rendersDir = path.join(dataDir, 'renders');
  copyFileSync(path.join(rendersDir, `${renderId}.pdf`), paths.pdf);
  copyFileSync(path.join(rendersDir, `${renderId}-1.png`), paths.png);
  rmSync(path.join(rendersDir, `${renderId}.pdf`), { force: true });
  for (let index = 1; index <= rendered.pageCount; index += 1) {
    rmSync(path.join(rendersDir, `${renderId}-${index}.png`), { force: true });
  }
  logger?.info?.('Design preview printed.', { design: design.id });
  return true;
}

/**
 * Work through every reference that has no preview yet, saving after each
 * one. Resolves with the count of newly finished previews. Sequential by
 * choice: one model call and one render at a time, resumable on restart.
 */
export async function buildPendingPreviews(deps, { limit = Infinity } = {}) {
  const { db, dataDir, logger } = deps;
  let finished = 0;
  for (;;) {
    const catalog = getDesignCatalog(db);
    const next = catalog.designs.find(
      (design) => !design.previewReady && !previewReadyOnDisk(dataDir, design.id),
    );
    if (!next || finished >= limit) break;
    let ready = false;
    try {
      ready = await buildPreviewForDesign(deps, next);
    } catch (error) {
      logger?.warn?.('Design preview failed with an infrastructure error, stopping this run.', {
        design: next.id,
        reason: error instanceof Error ? error.message : String(error),
      });
      break;
    }
    if (ready) {
      const refreshed = getDesignCatalog(db);
      putDesignCatalog(db, {
        version: refreshed.version,
        expected: refreshed.expected,
        designs: refreshed.designs.map((design) =>
          design.id === next.id ? { ...design, previewReady: true, previewUpdatedAt: new Date().toISOString() } : design,
        ),
      });
      finished += 1;
    } else {
      const refreshed = getDesignCatalog(db);
      putDesignCatalog(db, {
        version: refreshed.version,
        expected: refreshed.expected,
        designs: refreshed.designs.map((design) =>
          design.id === next.id ? { ...design, previewAttempts: (design.previewAttempts ?? 0) + 1 } : design,
        ),
      });
    }
  }
  return finished;
}

export function countReadyPreviews(db, dataDir) {
  const catalog = getDesignCatalog(db);
  let ready = 0;
  for (const design of catalog.designs) {
    if (design.previewReady || previewReadyOnDisk(dataDir, design.id)) ready += 1;
  }
  return ready;
}
