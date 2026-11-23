import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { RenderError } from './render.mjs';
import {
  SAMPLE_MATERIALS,
  SAMPLE_ORDER,
  buildVoucherDocumentValues,
  resolveTemplateSelection,
} from './variants.mjs';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MIN_PREVIEW_BYTES = 1024;

export function isPngFile(filePath) {
  try {
    const data = readFileSync(filePath);
    return data.length > MIN_PREVIEW_BYTES && data.subarray(0, 8).equals(PNG_SIGNATURE);
  } catch {
    return false;
  }
}

// Template thumbnails. Each variant gets one PNG at data/previews/<id>.png,
// built once from a fixed sample order and cached on disk. Generation is lazy:
// asking for a missing preview builds exactly that preview on the render queue.
export function createPreviewStore({ variants, templatesDir, dataDir, renderer, log = console }) {
  const previewsDir = path.join(dataDir, 'previews');
  const inflight = new Map();
  const ready = new Set();

  function previewPath(templateId) {
    return path.join(previewsDir, `${templateId}.png`);
  }

  function hasPreview(templateId) {
    return ready.has(templateId) || isPngFile(previewPath(templateId));
  }

  function ensure(templateId, { force = false } = {}) {
    if (!variants.byId.has(templateId)) {
      return Promise.reject(new RenderError(`Unknown template id "${templateId}".`, 400));
    }
    if (force) ready.delete(templateId);
    if (!force && hasPreview(templateId)) {
      ready.add(templateId);
      return Promise.resolve(previewPath(templateId));
    }

    let pending = inflight.get(templateId);
    if (!pending) {
      pending = (async () => {
        mkdirSync(previewsDir, { recursive: true });
        const selection = resolveTemplateSelection(variants, templateId);
        const attachmentImages = (SAMPLE_ORDER.attachments ?? [])
          .filter((file) => /^image\//i.test(String(file.contentType ?? '')))
          .map((file) => path.join(dataDir, 'media', path.basename(file.url)))
          .filter((filePath) => {
            try {
              return readFileSync(filePath).length > 0;
            } catch {
              return false;
            }
          })
          .map((filePath) => pathToFileURL(filePath).href);
        const values = buildVoucherDocumentValues({
          order: SAMPLE_ORDER,
          materials: SAMPLE_MATERIALS,
          templatesDir,
          dataDir,
          variants,
          templateId,
          attachmentImages,
        });
        const filePath = await renderer.renderPreview({
          templateId,
          values,
          templateFile: selection.templateFile,
          builtDir: 'voucher',
        });
        ready.add(templateId);
        return filePath;
      })().finally(() => {
        inflight.delete(templateId);
      });
      inflight.set(templateId, pending);
    }
    return pending;
  }

  // Generate every preview that is not cached yet. Used in the background on
  // boot and by the previews CLI so the API never waits on the first request.
  async function warmAll({ force = false, onProgress } = {}) {
    let generated = 0;
    const failed = [];
    const total = variants.variants.length;

    for (const variant of variants.variants) {
      if (!force && hasPreview(variant.id)) continue;
      try {
        await ensure(variant.id, { force });
        generated += 1;
        if (typeof onProgress === 'function') {
          onProgress({ templateId: variant.id, generated, total });
        }
      } catch (error) {
        failed.push({ templateId: variant.id, message: error.message });
        log.warn?.(`[previews] ${variant.id}: ${error.message}`);
      }
    }

    return { generated, failed, total };
  }

  return {
    previewsDir,
    previewPath,
    hasPreview,
    ensure,
    warmAll,
  };
}
