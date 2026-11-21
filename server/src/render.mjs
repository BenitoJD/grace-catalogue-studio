import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  COPY_BODY_MAX_CHARS,
  COPY_CLOSING_MAX_CHARS,
  COPY_HEADLINE_MAX_CHARS,
} from './llm.mjs';

const execFileAsync = promisify(execFile);

const COMMAND_TIMEOUT_MS = 120_000;
const COMMAND_BUFFER = 16 * 1024 * 1024;

// Grace Wood Industry details used by the kit template and the voucher footer.
const COMPANY = {
  addressLine1: '26J, Rajjakamangalam Road',
  addressLine2: 'Chettikulam, Nagercoil',
  cityLine: 'Nagercoil',
  phone: '+91 63740 43346',
  email: 'info.gracewoodindustry@gmail.com',
  shopLine: 'Chettikulam · Nagercoil · +91 63740 43346',
};

// Image paths are relative to the template directory, see CONTRACT.md.
const VOUCHER_IMAGES = {
  coverImage: '../assets/company/bedroom-wardrobe.jpg',
  detailImage: '../assets/company/grey-detail.jpg',
  insideImage: '../assets/company/walk-in.jpg',
  insideImage2: '../assets/company/beige-wardrobe.jpg',
};

const LAYOUT_LINES = [
  'Left · hanging',
  'Middle · shelves, two drawers',
  'Right · long hanging, low shelf',
];

const FALLBACK_MATERIALS = [
  { name: 'Dark Walnut', image: '../assets/company/tex-walnut.jpg' },
  { name: 'Cream', image: '../assets/company/tex-cream.jpg' },
  { name: 'Ash Grey', image: '../assets/company/tex-grey.jpg' },
  { name: 'Edge band', image: '../assets/company/tex-band.jpg' },
];

const TEMPLATE_FILE = 'index.html';

export class RenderError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = 'RenderError';
    this.status = status;
  }
}

export function newRenderId() {
  return `r-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}

export function formatOrderDate(date = new Date()) {
  return new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(date);
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

// Material images are stored as app paths such as /media/tex-walnut.jpg. The
// template needs a path relative to its own directory.
function materialImagePath(imageUrl, templatesDir) {
  if (typeof imageUrl !== 'string' || imageUrl === '') return null;
  if (imageUrl.startsWith('../assets/')) return imageUrl;
  if (!imageUrl.startsWith('/media/')) return null;

  const name = path.basename(imageUrl.slice('/media/'.length));
  if (!name || name.includes('..')) return null;
  const source = path.join(templatesDir, 'assets', 'company', name);
  return existsSync(source) ? `../assets/company/${name}` : null;
}

// Dimensions arrive as strings such as "2400 mm". The blueprint family prints a
// value and a unit column, so expose the split as extra template values.
function splitMeasure(value) {
  const raw = String(value ?? '').trim();
  const match = /^([0-9]+(?:[.,][0-9]+)?)\s*([A-Za-z]+)$/.exec(raw);
  if (!match) return { value: raw, unit: '' };
  return { value: match[1], unit: match[2].toLowerCase() };
}

// Generated brochure copy reaches the family templates through three tokens.
// No copy is not an error: the tokens become empty strings so the copy blocks
// disappear. A malformed copy_json must never break a render either; it also
// falls back to empty strings, with a warning so operations can spot it.
export function noteCopyValues(order, logger) {
  const empty = { noteHeadline: '', noteBody: '', noteClosing: '' };
  if (!order || typeof order !== 'object') return empty;

  let copy = order.copy ?? null;
  if (copy === null && typeof order.copy_json === 'string' && order.copy_json.trim() !== '') {
    try {
      copy = JSON.parse(order.copy_json);
    } catch (error) {
      logger?.warn?.('Order copy could not be read; rendering the brochure without it.', {
        orderId: order.id ?? null,
        error: error instanceof Error ? error.message : String(error),
      });
      return empty;
    }
  }
  if (copy === null) return empty;
  if (typeof copy !== 'object' || Array.isArray(copy)) {
    logger?.warn?.('Order copy is malformed; rendering the brochure without it.', {
      orderId: order.id ?? null,
    });
    return empty;
  }

  const fields = ['headline', 'body', 'closing'];
  if (!fields.every((field) => typeof copy[field] === 'string')) {
    logger?.warn?.('Order copy is malformed; rendering the brochure without it.', {
      orderId: order.id ?? null,
    });
    return empty;
  }

  const cap = (value, maxChars) => value.trim().slice(0, maxChars).trimEnd();
  return {
    noteHeadline: cap(copy.headline, COPY_HEADLINE_MAX_CHARS),
    noteBody: cap(copy.body, COPY_BODY_MAX_CHARS),
    noteClosing: cap(copy.closing, COPY_CLOSING_MAX_CHARS),
  };
}

export function buildVoucherValues({ order, materials = [], templatesDir, logger }) {
  const materialSlots = FALLBACK_MATERIALS.map((fallback, index) => {
    const material = materials[index];
    const image = materialImagePath(material?.imageUrl, templatesDir);
    return {
      name: material?.name?.trim() || fallback.name,
      image: image ?? fallback.image,
    };
  });

  const widthMeasure = splitMeasure(order.width);
  const heightMeasure = splitMeasure(order.height);
  const depthMeasure = splitMeasure(order.depth);

  return {
    orderNo: order.orderNo,
    title: order.title,
    date: formatOrderDate(),
    customerName: order.customerName,
    width: order.width,
    height: order.height,
    depth: order.depth,
    widthValue: widthMeasure.value,
    widthUnit: widthMeasure.unit,
    heightValue: heightMeasure.value,
    heightUnit: heightMeasure.unit,
    depthValue: depthMeasure.value,
    depthUnit: depthMeasure.unit,
    shutters: order.shutters,
    room: order.room,
    carcass: order.carcass,
    backPanel: order.backPanel,
    shuttersMat: order.shuttersMat,
    drawers: order.drawers,
    exterior: order.exterior,
    interior: order.interior,
    hinges: order.hinges,
    channels: order.channels,
    layoutLeft: LAYOUT_LINES[0],
    layoutMiddle: LAYOUT_LINES[1],
    layoutRight: LAYOUT_LINES[2],
    edgeShutter: order.edgeShutter,
    edgeCarcass: order.edgeCarcass,
    edgeNote: order.edgeNote,
    handle: order.handle,
    handleNote: order.handleNote,
    finishExt: order.finishExt,
    finishInt: order.finishInt,
    shopLine: COMPANY.shopLine,
    ...VOUCHER_IMAGES,
    mat1Name: materialSlots[0].name,
    mat2Name: materialSlots[1].name,
    mat3Name: materialSlots[2].name,
    mat4Name: materialSlots[3].name,
    mat1Image: materialSlots[0].image,
    mat2Image: materialSlots[1].image,
    mat3Image: materialSlots[2].image,
    mat4Image: materialSlots[3].image,
    ...noteCopyValues(order, logger),
  };
}

export function buildKitValues() {
  return {
    addressLine1: COMPANY.addressLine1,
    addressLine2: COMPANY.addressLine2,
    cityLine: COMPANY.cityLine,
    phone: COMPANY.phone,
    email: COMPANY.email,
    shopLine: COMPANY.shopLine,
  };
}

// Replace {{key}} tokens and fail loudly if any token is left over. A value of
// the shape { raw: "..." } is inserted as markup or CSS without escaping; this
// is how the server passes the palette variables and the fitted title markup
// into a family template.
export function fillTemplate(template, values, kind) {
  const filled = template.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (token, key) => {
    const value = values[key];
    if (value === undefined || value === null) return token;
    if (typeof value === 'object' && typeof value.raw === 'string') return value.raw;
    return escapeHtml(value);
  });

  const leftover = [
    ...new Set([...filled.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map((match) => match[1].trim())),
  ];
  if (leftover.length > 0) {
    throw new RenderError(
      `Unfilled placeholder in the ${kind} template: ${leftover.join(', ')}. A value must be provided for every placeholder.`,
      500,
    );
  }
  return filled;
}

function errorTail(error, fallback) {
  if (!error) return fallback;
  if (error.code === 'ENOENT') return '';
  const stderr = typeof error.stderr === 'string' ? error.stderr.trim() : '';
  const raw = stderr || error.message || fallback;
  return raw.replace(/\s+/g, ' ').trim().slice(0, 400);
}

function pageImageFiles(rendersDir, renderId) {
  const prefix = `${renderId}-`;
  return readdirSync(rendersDir).filter(
    (name) => name.startsWith(prefix) && name.endsWith('.png'),
  );
}

function pageImageNumber(name, renderId) {
  const match = new RegExp(`^${renderId}-(\\d+)\\.png$`).exec(name);
  return match ? Number.parseInt(match[1], 10) : null;
}

function removePageImages(rendersDir, renderId) {
  for (const name of pageImageFiles(rendersDir, renderId)) {
    rmSync(path.join(rendersDir, name), { force: true });
  }
}

async function runWeasyPrint(weasyprintBin, builtFile, pdfPath) {
  try {
    await execFileAsync(weasyprintBin, [builtFile, pdfPath], {
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: COMMAND_BUFFER,
    });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new RenderError(`WeasyPrint was not found at ${weasyprintBin}. Install it before rendering.`, 500);
    }
    const tail = errorTail(error, 'Unknown error.');
    throw new RenderError(`WeasyPrint could not build the PDF. ${tail}`, 500);
  }

  if (!existsSync(pdfPath)) {
    throw new RenderError('WeasyPrint finished but no PDF file was written.', 500);
  }
}

async function runPdftoppm(pdftoppmBin, args) {
  try {
    await execFileAsync(pdftoppmBin, args, {
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: COMMAND_BUFFER,
    });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new RenderError('pdftoppm was not found. Install poppler before rendering.', 500);
    }
    const tail = errorTail(error, 'Unknown error.');
    throw new RenderError(`pdftoppm could not build the page images. ${tail}`, 500);
  }
}

async function rasterisePdf(pdftoppmBin, pdfPath, outputPrefix, rendersDir, renderId) {
  await runPdftoppm(pdftoppmBin, ['-png', '-r', '96', pdfPath, outputPrefix]);

  const files = pageImageFiles(rendersDir, renderId)
    .map((name) => ({ name, page: pageImageNumber(name, renderId) }))
    .filter((file) => Number.isInteger(file.page))
    .sort((left, right) => left.page - right.page);

  if (files.length === 0) {
    throw new RenderError('The PDF was built but no page images were produced.', 500);
  }

  // Canonical names are <renderId>-<n>.png with no padding, so /pages/<id>/<n>.png
  // keeps working even when pdftoppm zero pads a longer document.
  for (let index = 0; index < files.length; index += 1) {
    const source = path.join(rendersDir, files[index].name);
    const target = path.join(rendersDir, `${renderId}-${index + 1}.png`);
    if (source !== target) renameSync(source, target);
  }
  return files.length;
}

export function createRenderer({
  templatesDir,
  dataDir,
  weasyprintBin = 'weasyprint',
  pdftoppmBin = 'pdftoppm',
}) {
  const rendersDir = path.join(dataDir, 'renders');
  const previewsDir = path.join(dataDir, 'previews');

  // One in process queue: builds never share the template directory at once.
  let tail = Promise.resolve();
  let pendingTasks = 0;
  let pendingRenders = 0;
  const idleWaiters = new Set();
  const renderIdleWaiters = new Set();
  // Render ids that are currently being written to disk. The retention sweep
  // uses this so it never deletes page images of a render still in progress.
  const activeRenderIds = new Set();

  function notifyIdle() {
    if (pendingTasks === 0) {
      for (const resolve of idleWaiters) resolve(true);
      idleWaiters.clear();
    }
    if (pendingRenders === 0) {
      for (const resolve of renderIdleWaiters) resolve(true);
      renderIdleWaiters.clear();
    }
  }

  function enqueue(task) {
    pendingTasks += 1;
    const result = tail.then(task);
    const settled = result.finally(() => {
      pendingTasks -= 1;
      notifyIdle();
    });
    tail = settled.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function waitForIdle(idleWhen, waiters, timeoutMs) {
    if (idleWhen()) return Promise.resolve(true);
    return new Promise((resolve) => {
      let timer = null;
      function finish(idle) {
        if (timer !== null) clearTimeout(timer);
        waiters.delete(finish);
        resolve(idle);
      }
      waiters.add(finish);
      timer = setTimeout(() => finish(false), timeoutMs);
    });
  }

  // Resolve true once the whole queue is empty (renders and previews), or
  // false after the timeout.
  function whenIdle(timeoutMs = 20_000) {
    return waitForIdle(() => pendingTasks === 0, idleWaiters, timeoutMs);
  }

  // Graceful shutdown only needs to wait for real render jobs, not for the
  // background preview cache warmup.
  function whenRendersIdle(timeoutMs = 20_000) {
    return waitForIdle(() => pendingRenders === 0, renderIdleWaiters, timeoutMs);
  }

  // Voucher documents can live in sub directories (templates/voucher/families),
  // so a render may pass its template file and the directory the built HTML
  // must be written into. The built file always sits inside templates/voucher
  // or templates/kit so the ../assets and ../fonts paths resolve.
  function templatePathFor(kind, templateFile) {
    if (templateFile === undefined || templateFile === null || templateFile === '') {
      return path.join(templatesDir, kind, TEMPLATE_FILE);
    }
    return path.isAbsolute(templateFile) ? templateFile : path.join(templatesDir, templateFile);
  }

  function builtDirFor(templatePath, builtDir) {
    if (builtDir === undefined || builtDir === null || builtDir === '') {
      return path.dirname(templatePath);
    }
    return path.isAbsolute(builtDir) ? builtDir : path.join(templatesDir, builtDir);
  }

  function loadTemplate(templatePath, kind) {
    try {
      return readFileSync(templatePath, 'utf8');
    } catch {
      throw new RenderError(`The ${kind} template was not found at ${templatePath}.`, 500);
    }
  }

  async function renderOnce({ kind, values, renderId, templateFile, builtDir }) {
    if (kind !== 'voucher' && kind !== 'kit' && kind !== 'catalogue') {
      throw new RenderError(`Unknown template kind "${kind}".`, 400);
    }

    const templatePath = templatePathFor(kind, templateFile);
    const outputDir = builtDirFor(templatePath, builtDir);
    const html = fillTemplate(loadTemplate(templatePath, kind), values, kind);

    mkdirSync(rendersDir, { recursive: true });
    const builtFile = path.join(outputDir, `built-${renderId}.html`);
    const pdfPath = path.join(rendersDir, `${renderId}.pdf`);
    const pagePrefix = path.join(rendersDir, renderId);

    writeFileSync(builtFile, html, 'utf8');
    let succeeded = false;
    try {
      await runWeasyPrint(weasyprintBin, builtFile, pdfPath);
      const pageCount = await rasterisePdf(
        pdftoppmBin,
        pdfPath,
        pagePrefix,
        rendersDir,
        renderId,
      );
      succeeded = true;
      return {
        pageCount,
        pdfUrl: `/files/${renderId}.pdf`,
        pageUrls: Array.from({ length: pageCount }, (_, index) => `/pages/${renderId}/${index + 1}.png`),
      };
    } finally {
      rmSync(builtFile, { force: true });
      if (!succeeded) {
        rmSync(pdfPath, { force: true });
        removePageImages(rendersDir, renderId);
      }
    }
  }

  // Build page one of a voucher as a PNG thumbnail. Runs on the same queue as
  // full renders so a preview and a voucher never share the template directory.
  async function renderPreviewOnce({ templateId, values, templateFile, builtDir }) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(templateId ?? ''))) {
      throw new RenderError(`Invalid template id "${templateId}".`, 400);
    }

    const templatePath = templatePathFor('voucher', templateFile);
    const outputDir = builtDirFor(templatePath, builtDir);
    const html = fillTemplate(loadTemplate(templatePath, 'voucher'), values, 'voucher');
    mkdirSync(previewsDir, { recursive: true });

    const nonce = randomBytes(4).toString('hex');
    const builtFile = path.join(outputDir, `built-preview-${templateId}-${nonce}.html`);
    const pdfPath = path.join(previewsDir, `.tmp-${templateId}-${nonce}.pdf`);
    const outputPrefix = path.join(previewsDir, `.tmp-${templateId}-${nonce}`);
    const outputPng = `${outputPrefix}.png`;
    const target = path.join(previewsDir, `${templateId}.png`);

    writeFileSync(builtFile, html, 'utf8');
    try {
      await runWeasyPrint(weasyprintBin, builtFile, pdfPath);
      await runPdftoppm(pdftoppmBin, [
        '-png',
        '-r',
        '96',
        '-f',
        '1',
        '-l',
        '1',
        '-singlefile',
        pdfPath,
        outputPrefix,
      ]);
      if (!existsSync(outputPng)) {
        throw new RenderError('The preview PDF was built but no preview image was written.', 500);
      }
      // Rename last so a partly written preview is never served.
      renameSync(outputPng, target);
      return target;
    } finally {
      rmSync(builtFile, { force: true });
      rmSync(pdfPath, { force: true });
      rmSync(outputPng, { force: true });
    }
  }

  return {
    render(input) {
      pendingRenders += 1;
      return enqueue(async () => {
        activeRenderIds.add(input.renderId);
        try {
          return await renderOnce(input);
        } finally {
          activeRenderIds.delete(input.renderId);
          pendingRenders -= 1;
          notifyIdle();
        }
      });
    },
    renderPreview(input) {
      return enqueue(() => renderPreviewOnce(input));
    },
    /** Number of builds (renders and previews) waiting or running. */
    pendingCount() {
      return pendingTasks;
    },
    /** Number of real render jobs waiting or running. */
    pendingRenderCount() {
      return pendingRenders;
    },
    /** Resolves true when every build drained, false on timeout. */
    whenIdle,
    /** Resolves true when only the render jobs drained, false on timeout. */
    whenRendersIdle,
    /** Snapshot of render ids whose files are being written right now. */
    activeRenderIds() {
      return new Set(activeRenderIds);
    },
  };
}
