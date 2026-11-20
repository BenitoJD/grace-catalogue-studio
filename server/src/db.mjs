import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Every order column the API accepts. title, room, width, height, depth and
// shutters are also required on create; the rest default to an empty string.
export const ORDER_TEXT_FIELDS = [
  'title',
  'room',
  'width',
  'height',
  'depth',
  'shutters',
  'carcass',
  'backPanel',
  'shuttersMat',
  'drawers',
  'exterior',
  'interior',
  'hinges',
  'channels',
  'edgeShutter',
  'edgeCarcass',
  'edgeNote',
  'handle',
  'handleNote',
  'finishExt',
  'finishInt',
];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  orderNo TEXT NOT NULL UNIQUE,
  customerId TEXT NOT NULL REFERENCES customers(id),
  title TEXT NOT NULL,
  room TEXT NOT NULL,
  width TEXT NOT NULL,
  height TEXT NOT NULL,
  depth TEXT NOT NULL,
  shutters TEXT NOT NULL,
  carcass TEXT NOT NULL DEFAULT '',
  backPanel TEXT NOT NULL DEFAULT '',
  shuttersMat TEXT NOT NULL DEFAULT '',
  drawers TEXT NOT NULL DEFAULT '',
  exterior TEXT NOT NULL DEFAULT '',
  interior TEXT NOT NULL DEFAULT '',
  hinges TEXT NOT NULL DEFAULT '',
  channels TEXT NOT NULL DEFAULT '',
  edgeShutter TEXT NOT NULL DEFAULT '',
  edgeCarcass TEXT NOT NULL DEFAULT '',
  edgeNote TEXT NOT NULL DEFAULT '',
  handle TEXT NOT NULL DEFAULT '',
  handleNote TEXT NOT NULL DEFAULT '',
  finishExt TEXT NOT NULL DEFAULT '',
  finishInt TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS orders_customer_idx ON orders (customerId);

CREATE TABLE IF NOT EXISTS materials (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  hex TEXT NOT NULL,
  imageUrl TEXT,
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS renders (
  id TEXT PRIMARY KEY,
  orderId TEXT NOT NULL REFERENCES orders(id),
  kind TEXT NOT NULL,
  pageCount INTEGER NOT NULL,
  pdfUrl TEXT NOT NULL,
  pageUrls TEXT NOT NULL,
  templateId TEXT,
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS renders_order_idx ON renders (orderId);
`;

export function openDb(dbPath = ':memory:') {
  if (dbPath !== ':memory:') mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);

  // Older data directories predate selectable brochure templates. Add the
  // column in place so existing renders and databases keep working.
  const renderColumns = db
    .prepare('PRAGMA table_info(renders)')
    .all()
    .map((column) => column.name);
  if (!renderColumns.includes('templateId')) {
    db.exec('ALTER TABLE renders ADD COLUMN templateId TEXT');
  }

  return db;
}

function plain(row) {
  return row ? { ...row } : null;
}

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function now() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

export function createCustomer(db, input) {
  const customer = {
    id: randomUUID(),
    name: text(input.name),
    phone: text(input.phone),
    address: text(input.address),
    createdAt: now(),
  };
  db.prepare(
    'INSERT INTO customers (id, name, phone, address, createdAt) VALUES (?, ?, ?, ?, ?)',
  ).run(customer.id, customer.name, customer.phone, customer.address, customer.createdAt);
  return customer;
}

export function listCustomers(db) {
  return db
    .prepare('SELECT id, name, phone, address, createdAt FROM customers ORDER BY createdAt ASC, rowid ASC')
    .all()
    .map(plain);
}

export function getCustomer(db, id) {
  return plain(
    db.prepare('SELECT id, name, phone, address, createdAt FROM customers WHERE id = ?').get(id),
  );
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

function nextOrderNo(db) {
  const year = new Date().getFullYear();
  const prefix = `GWI-${year}-`;
  const row = db
    .prepare('SELECT orderNo FROM orders WHERE orderNo LIKE ? ORDER BY orderNo DESC LIMIT 1')
    .get(`${prefix}%`);
  let sequence = 1;
  if (row) {
    const parsed = Number.parseInt(String(row.orderNo).slice(prefix.length), 10);
    if (Number.isInteger(parsed) && parsed >= 1) sequence = parsed + 1;
  }
  return `${prefix}${String(sequence).padStart(3, '0')}`;
}

const ORDER_SELECT = `
  SELECT o.*, c.name AS customerName
  FROM orders o
  JOIN customers c ON c.id = o.customerId
`;

export function listOrders(db) {
  return db
    .prepare(`${ORDER_SELECT} ORDER BY o.createdAt DESC, o.orderNo DESC`)
    .all()
    .map(plain);
}

export function getOrder(db, id) {
  return plain(db.prepare(`${ORDER_SELECT} WHERE o.id = ?`).get(id));
}

export function createOrder(db, input) {
  const order = {
    id: randomUUID(),
    orderNo: nextOrderNo(db),
    customerId: input.customerId,
    status: input.status === 'approved' ? 'approved' : 'draft',
    createdAt: now(),
  };
  for (const field of ORDER_TEXT_FIELDS) order[field] = text(input[field]);

  const columns = ['id', 'orderNo', 'customerId', ...ORDER_TEXT_FIELDS, 'status', 'createdAt'];
  const placeholders = columns.map(() => '?').join(', ');
  db.prepare(`INSERT INTO orders (${columns.join(', ')}) VALUES (${placeholders})`).run(
    ...columns.map((column) => order[column]),
  );
  return getOrder(db, order.id);
}

const ORDER_PATCH_FIELDS = new Set(['customerId', 'status', ...ORDER_TEXT_FIELDS]);

export function updateOrder(db, id, patch) {
  const keys = Object.keys(patch).filter((key) => ORDER_PATCH_FIELDS.has(key));
  if (keys.length === 0) return getOrder(db, id);
  const assignments = keys.map((key) => `${key} = ?`).join(', ');
  db.prepare(`UPDATE orders SET ${assignments} WHERE id = ?`).run(
    ...keys.map((key) => patch[key]),
    id,
  );
  return getOrder(db, id);
}

export function deleteRendersForOrder(db, orderId) {
  const renders = listRendersForOrder(db, orderId);
  db.prepare('DELETE FROM renders WHERE orderId = ?').run(orderId);
  return renders;
}

export function deleteOrder(db, id) {
  deleteRendersForOrder(db, id);
  const result = db.prepare('DELETE FROM orders WHERE id = ?').run(id);
  return Number(result.changes) > 0;
}

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

export function createMaterial(db, input) {
  const material = {
    id: randomUUID(),
    name: text(input.name),
    kind: text(input.kind),
    hex: text(input.hex),
    imageUrl: input.imageUrl === undefined || input.imageUrl === null ? null : text(input.imageUrl),
    createdAt: now(),
  };
  db.prepare(
    'INSERT INTO materials (id, name, kind, hex, imageUrl, createdAt) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(material.id, material.name, material.kind, material.hex, material.imageUrl, material.createdAt);
  return plain(material);
}

export function listMaterials(db) {
  return db
    .prepare('SELECT id, name, kind, hex, imageUrl, createdAt FROM materials ORDER BY createdAt ASC, rowid ASC')
    .all()
    .map(plain);
}

// ---------------------------------------------------------------------------
// Renders
// ---------------------------------------------------------------------------

function renderFromRow(row) {
  const render = plain(row);
  if (!render) return null;
  try {
    render.pageUrls = JSON.parse(render.pageUrls);
  } catch {
    render.pageUrls = [];
  }
  if (!Array.isArray(render.pageUrls)) render.pageUrls = [];
  return render;
}

export function createRender(db, input) {
  const render = {
    id: input.id,
    orderId: input.orderId,
    kind: input.kind,
    pageCount: input.pageCount,
    pdfUrl: input.pdfUrl,
    pageUrls: input.pageUrls,
    templateId: input.templateId ?? null,
    createdAt: now(),
  };
  db.prepare(
    'INSERT INTO renders (id, orderId, kind, pageCount, pdfUrl, pageUrls, templateId, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    render.id,
    render.orderId,
    render.kind,
    render.pageCount,
    render.pdfUrl,
    JSON.stringify(render.pageUrls),
    render.templateId,
    render.createdAt,
  );
  return plain(render);
}

export function listRenders(db) {
  return db
    .prepare('SELECT * FROM renders ORDER BY createdAt DESC, rowid DESC')
    .all()
    .map(renderFromRow);
}

export function listRendersForOrder(db, orderId) {
  return db
    .prepare('SELECT * FROM renders WHERE orderId = ? ORDER BY createdAt ASC, rowid ASC')
    .all(orderId)
    .map(renderFromRow);
}

export function getRender(db, id) {
  return renderFromRow(db.prepare('SELECT * FROM renders WHERE id = ?').get(id));
}
