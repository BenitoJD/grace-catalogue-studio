import { rmSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Hono } from 'hono';
import { cors } from 'hono/cors';

import {
  ORDER_TEXT_FIELDS,
  createCustomer,
  createMaterial,
  createOrder,
  createRender,
  deleteOrder,
  getCustomer,
  getOrder,
  getRender,
  listCustomers,
  listMaterials,
  listOrders,
  listRenders,
  listRendersForOrder,
  updateOrder,
} from './db.mjs';
import {
  RenderError,
  buildKitValues,
  createRenderer,
  newRenderId,
} from './render.mjs';
import { createPreviewStore } from './previews.mjs';
import {
  buildVoucherDocumentValues,
  loadVariants,
  resolveTemplateSelection,
  templateCatalog,
} from './variants.mjs';

const API_VERSION = '1.0.0';

// Only these fields must be present on create. The rest start empty and can be
// filled in with PATCH, which keeps the mobile form forgiving.
const REQUIRED_ORDER_FIELDS = new Set(['title', 'room', 'width', 'height', 'depth', 'shutters']);

const IMAGE_TYPES = new Map([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['webp', 'image/webp'],
  ['gif', 'image/gif'],
  ['svg', 'image/svg+xml'],
]);

async function readJsonObject(c) {
  let body;
  try {
    body = await c.req.json();
  } catch {
    return { error: 'Request body must be valid JSON.' };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Request body must be a JSON object.' };
  }
  return { body };
}

function readTextField(body, key, required = false, maxLength = 4000) {
  const raw = body[key];
  if (raw === undefined || raw === null || raw === '') {
    if (required) return { error: `Field "${key}" is required.` };
    return { value: '' };
  }
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    return { error: `Field "${key}" must be text.` };
  }
  const value = String(raw).trim();
  if (required && value === '') return { error: `Field "${key}" is required.` };
  if (value.length > maxLength) return { error: `Field "${key}" is too long.` };
  return { value };
}

function readOptionalText(body, key, maxLength = 4000) {
  const raw = body[key];
  if (raw === undefined || raw === null) return { value: '' };
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    return { error: `Field "${key}" must be text.` };
  }
  const value = String(raw).trim();
  if (value.length > maxLength) return { error: `Field "${key}" is too long.` };
  return { value };
}

async function sendFile(c, filePath, contentType) {
  try {
    const data = await readFile(filePath);
    return c.body(data, 200, {
      'Content-Type': contentType,
      'Content-Length': String(data.length),
    });
  } catch {
    return c.json({ error: 'File not found.' }, 404);
  }
}

function removeRenderFiles(rendersDir, renderId) {
  try {
    rmSync(path.join(rendersDir, `${renderId}.pdf`), { force: true });
    for (const name of readdirSync(rendersDir)) {
      if (name.startsWith(`${renderId}-`) && name.endsWith('.png')) {
        rmSync(path.join(rendersDir, name), { force: true });
      }
    }
  } catch {
    // Best effort cleanup only.
  }
}

export function createApp(options) {
  const { db, dataDir, templatesDir } = options;
  const rendersDir = path.join(dataDir, 'renders');
  const variants = loadVariants(templatesDir);
  const renderer =
    options.renderer ??
    createRenderer({
      templatesDir,
      dataDir,
      weasyprintBin: options.weasyprintBin ?? 'weasyprint',
      pdftoppmBin: options.pdftoppmBin ?? 'pdftoppm',
    });
  const previewStore = createPreviewStore({ variants, templatesDir, dataDir, renderer });

  const app = new Hono();

  app.use(
    '*',
    cors({
      origin: '*',
      allowMethods: ['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type'],
      maxAge: 86400,
    }),
  );

  app.onError((error, c) => {
    if (error instanceof RenderError) {
      return c.json({ error: error.message }, error.status);
    }
    console.error(error);
    return c.json({ error: 'The server hit an unexpected error.' }, 500);
  });

  app.notFound((c) => c.json({ error: 'Not found.' }, 404));

  // -------------------------------------------------------------------------
  // Health and bootstrap
  // -------------------------------------------------------------------------

  app.get('/health', (c) => c.json({ ok: true, version: API_VERSION }));

  app.get('/api/bootstrap', (c) =>
    c.json({
      customers: listCustomers(db),
      orders: listOrders(db),
      materials: listMaterials(db),
    }),
  );

  // -------------------------------------------------------------------------
  // Brochure templates and their thumbnails
  // -------------------------------------------------------------------------

  app.get('/api/templates', (c) => c.json(templateCatalog(variants)));

  app.get('/previews/:file', async (c) => {
    const match = /^([a-z0-9]+(?:-[a-z0-9]+)*)\.png$/.exec(c.req.param('file'));
    if (!match || !variants.byId.has(match[1])) {
      return c.json({ error: 'Preview not found.' }, 404);
    }
    const filePath = await previewStore.ensure(match[1]);
    return sendFile(c, filePath, 'image/png');
  });

  // -------------------------------------------------------------------------
  // Customers
  // -------------------------------------------------------------------------

  app.get('/api/customers', (c) => c.json(listCustomers(db)));

  app.post('/api/customers', async (c) => {
    const parsed = await readJsonObject(c);
    if (parsed.error) return c.json({ error: parsed.error }, 400);

    const name = readTextField(parsed.body, 'name', true, 200);
    if (name.error) return c.json({ error: name.error }, 400);
    const phone = readOptionalText(parsed.body, 'phone', 100);
    if (phone.error) return c.json({ error: phone.error }, 400);
    const address = readOptionalText(parsed.body, 'address', 1000);
    if (address.error) return c.json({ error: address.error }, 400);

    const customer = createCustomer(db, {
      name: name.value,
      phone: phone.value,
      address: address.value,
    });
    return c.json(customer, 201);
  });

  // -------------------------------------------------------------------------
  // Orders
  // -------------------------------------------------------------------------

  app.get('/api/orders', (c) => c.json(listOrders(db)));

  app.post('/api/orders', async (c) => {
    const parsed = await readJsonObject(c);
    if (parsed.error) return c.json({ error: parsed.error }, 400);

    const customerId = readTextField(parsed.body, 'customerId', true, 200);
    if (customerId.error) return c.json({ error: customerId.error }, 400);
    if (!getCustomer(db, customerId.value)) {
      return c.json({ error: 'Customer not found. Create the customer first.' }, 400);
    }

    const fields = {};
    for (const field of ORDER_TEXT_FIELDS) {
      const result = readTextField(parsed.body, field, REQUIRED_ORDER_FIELDS.has(field));
      if (result.error) return c.json({ error: result.error }, 400);
      fields[field] = result.value;
    }

    const order = createOrder(db, { ...fields, customerId: customerId.value });
    return c.json(order, 201);
  });

  app.get('/api/orders/:id', (c) => {
    const order = getOrder(db, c.req.param('id'));
    if (!order) return c.json({ error: 'Order not found.' }, 404);
    return c.json(order);
  });

  app.patch('/api/orders/:id', async (c) => {
    const id = c.req.param('id');
    if (!getOrder(db, id)) return c.json({ error: 'Order not found.' }, 404);

    const parsed = await readJsonObject(c);
    if (parsed.error) return c.json({ error: parsed.error }, 400);

    const patch = {};

    if ('customerId' in parsed.body) {
      const customerId = readTextField(parsed.body, 'customerId', true, 200);
      if (customerId.error) return c.json({ error: customerId.error }, 400);
      if (!getCustomer(db, customerId.value)) {
        return c.json({ error: 'Customer not found.' }, 400);
      }
      patch.customerId = customerId.value;
    }

    if ('status' in parsed.body) {
      if (parsed.body.status !== 'draft' && parsed.body.status !== 'approved') {
        return c.json({ error: 'Field "status" must be "draft" or "approved".' }, 400);
      }
      patch.status = parsed.body.status;
    }

    for (const field of ORDER_TEXT_FIELDS) {
      if (!(field in parsed.body)) continue;
      const result = readTextField(parsed.body, field, false);
      if (result.error) return c.json({ error: result.error }, 400);
      patch[field] = result.value;
    }

    if (Object.keys(patch).length === 0) {
      return c.json({ error: 'No order fields to update.' }, 400);
    }

    const order = updateOrder(db, id, patch);
    return c.json(order);
  });

  app.delete('/api/orders/:id', (c) => {
    const id = c.req.param('id');
    const renders = listRendersForOrder(db, id);
    if (!deleteOrder(db, id)) return c.json({ error: 'Order not found.' }, 404);
    for (const render of renders) removeRenderFiles(rendersDir, render.id);
    return c.json({ ok: true });
  });

  // -------------------------------------------------------------------------
  // Materials
  // -------------------------------------------------------------------------

  app.post('/api/materials', async (c) => {
    const parsed = await readJsonObject(c);
    if (parsed.error) return c.json({ error: parsed.error }, 400);

    const name = readTextField(parsed.body, 'name', true, 200);
    if (name.error) return c.json({ error: name.error }, 400);
    const kind = readTextField(parsed.body, 'kind', true, 100);
    if (kind.error) return c.json({ error: kind.error }, 400);
    const hex = readTextField(parsed.body, 'hex', true, 20);
    if (hex.error) return c.json({ error: hex.error }, 400);
    if (!/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(hex.value)) {
      return c.json({ error: 'Field "hex" must be a colour like #A65E22.' }, 400);
    }

    let imageUrl = null;
    if (parsed.body.imageUrl !== undefined && parsed.body.imageUrl !== null) {
      if (typeof parsed.body.imageUrl !== 'string') {
        return c.json({ error: 'Field "imageUrl" must be text.' }, 400);
      }
      imageUrl = parsed.body.imageUrl.trim() || null;
    }

    const material = createMaterial(db, {
      name: name.value,
      kind: kind.value,
      hex: hex.value,
      imageUrl,
    });
    return c.json(material, 201);
  });

  // -------------------------------------------------------------------------
  // Renders
  // -------------------------------------------------------------------------

  app.post('/api/orders/:id/render', async (c) => {
    const order = getOrder(db, c.req.param('id'));
    if (!order) return c.json({ error: 'Order not found.' }, 404);

    const parsed = await readJsonObject(c);
    if (parsed.error) return c.json({ error: parsed.error }, 400);

    const kind = parsed.body.kind;
    if (kind !== 'voucher' && kind !== 'kit') {
      return c.json({ error: 'Field "kind" must be "voucher" or "kit".' }, 400);
    }

    // templateId is optional. Missing means the first template in the
    // catalogue; an unknown id is a client error, not a fallback.
    let templateId = variants.defaultTemplateId;
    const requestedTemplateId = parsed.body.templateId;
    if (requestedTemplateId !== undefined && requestedTemplateId !== null) {
      if (typeof requestedTemplateId !== 'string') {
        return c.json({ error: 'Field "templateId" must be a template id.' }, 400);
      }
      const requested = requestedTemplateId.trim();
      if (requested === '') {
        return c.json({ error: 'Field "templateId" must be a template id.' }, 400);
      }
      if (!variants.byId.has(requested)) {
        return c.json(
          {
            error:
              `Unknown templateId "${requested}". ` +
              'GET /api/templates lists the available templates.',
          },
          400,
        );
      }
      templateId = requested;
    }

    const selection =
      kind === 'voucher' ? resolveTemplateSelection(variants, templateId) : null;
    const values =
      kind === 'voucher'
        ? buildVoucherDocumentValues({
            order,
            materials: listMaterials(db),
            templatesDir,
            variants,
            templateId,
          })
        : buildKitValues();
    const renderId = newRenderId();
    const result = await renderer.render({
      kind,
      values,
      renderId,
      templateFile: selection?.templateFile,
      builtDir: kind === 'voucher' ? 'voucher' : undefined,
    });

    const render = createRender(db, {
      id: renderId,
      orderId: order.id,
      kind,
      pageCount: result.pageCount,
      pdfUrl: result.pdfUrl,
      pageUrls: result.pageUrls,
      templateId: kind === 'voucher' ? templateId : null,
    });
    return c.json(render, 201);
  });

  app.get('/api/renders', (c) => c.json(listRenders(db)));

  app.get('/api/renders/:id', (c) => {
    const render = getRender(db, c.req.param('id'));
    if (!render) return c.json({ error: 'Render not found.' }, 404);
    return c.json(render);
  });

  // -------------------------------------------------------------------------
  // Files
  // -------------------------------------------------------------------------

  app.get('/files/:name', (c) => {
    const name = c.req.param('name');
    if (!/^[A-Za-z0-9_-]+\.pdf$/.test(name)) {
      return c.json({ error: 'File not found.' }, 404);
    }
    return sendFile(c, path.join(rendersDir, name), 'application/pdf');
  });

  app.get('/pages/:renderId/:file', (c) => {
    const renderId = c.req.param('renderId');
    if (!/^[A-Za-z0-9_-]+$/.test(renderId)) {
      return c.json({ error: 'Page not found.' }, 404);
    }
    const match = /^(\d+)\.png$/.exec(c.req.param('file'));
    if (!match) return c.json({ error: 'Page not found.' }, 404);
    const page = Number.parseInt(match[1], 10);
    if (!Number.isInteger(page) || page < 1) {
      return c.json({ error: 'Page not found.' }, 404);
    }
    return sendFile(c, path.join(rendersDir, `${renderId}-${page}.png`), 'image/png');
  });

  app.get('/media/:name', (c) => {
    const name = c.req.param('name');
    if (!/^[A-Za-z0-9._-]+$/.test(name) || name.includes('..')) {
      return c.json({ error: 'File not found.' }, 404);
    }
    const extension = path.extname(name).slice(1).toLowerCase();
    const contentType = IMAGE_TYPES.get(extension);
    if (!contentType) return c.json({ error: 'File not found.' }, 404);
    return sendFile(c, path.join(dataDir, 'media', name), contentType);
  });

  // Optional hook for the server entry point: it uses this to warm the
  // template previews in the background without blocking boot.
  if (typeof options.onReady === 'function') {
    options.onReady({ variants, renderer, previewStore });
  }

  return app;
}
