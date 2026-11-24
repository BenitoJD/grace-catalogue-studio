import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Every order column the API accepts. title, room, width, height, depth and
// shutters are also required on create; the rest default to an empty string.
// brief stores the customer's loose notes for the brochure copy writer.
// A quick order may omit materials. The printed voucher must never show a blank
// specification row, so blanks fall back to the house standard.
export const ORDER_DEFAULTS = Object.freeze({
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
  handleNote: 'Vertical, one set per shutter',
  finishExt: 'Matte outside, white inside',
  finishInt: 'No painting',
});

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
  'brief',
  'design_direction',
];

// The schema is versioned with PRAGMA user_version. Version 1 is the original
// catalogue schema, version 2 adds the runtime settings table, version 3 adds
// the order brief and generated brochure copy and version 4 adds the material
// trade rates and lets a render stand on its own without an order (the rate
// card). Every change is appended as a new migration so an existing data
// directory upgrades in place. Never edit an applied migration.
export const SCHEMA_VERSION = 13;

// orders.customerId and renders.orderId are RESTRICT: a customer with orders is
// never deleted behind the API's back, so orders can not be orphaned. Deleting
// an order explicitly deletes its renders first (see deleteOrder).
const INITIAL_SCHEMA = `
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
  customerId TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
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
  orderId TEXT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL,
  pageCount INTEGER NOT NULL,
  pdfUrl TEXT NOT NULL,
  pageUrls TEXT NOT NULL,
  templateId TEXT,
  createdAt TEXT NOT NULL
);
`;

const INITIAL_INDEXES = `
CREATE INDEX IF NOT EXISTS orders_customer_idx ON orders (customerId);
CREATE INDEX IF NOT EXISTS orders_created_idx ON orders (createdAt);
CREATE INDEX IF NOT EXISTS renders_order_created_idx ON renders (orderId, createdAt);
CREATE INDEX IF NOT EXISTS renders_created_idx ON renders (createdAt);
`;

// Version 2: runtime configuration the office can change from the app instead
// of redeploying. A tiny key/value table keeps the values together and leaves
// room for future settings without another migration.
const SETTINGS_SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

function tableColumns(db, table) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((column) => column.name);
}

function addColumnIfMissing(db, table, column, definition) {
  if (tableColumns(db, table).includes(column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return true;
}

// Ordered migrations. Version 1 is written to also repair a database created
// before versioning existed (user_version 0): CREATE IF NOT EXISTS leaves the
// old tables alone, then missing columns and indices are added.
export const MIGRATIONS = Object.freeze([
  {
    version: 1,
    name: 'catalogue schema with indices',
    up(db) {
      db.exec(INITIAL_SCHEMA);
      // Older data directories predate selectable brochure templates.
      addColumnIfMissing(db, 'renders', 'templateId', 'TEXT');
      db.exec(INITIAL_INDEXES);
    },
  },
  {
    version: 2,
    name: 'runtime settings',
    up(db) {
      // Only the table is created: a version 1 database deliberately starts
      // with no settings so the environment variables keep working until an
      // administrator saves values from the app.
      db.exec(SETTINGS_SCHEMA);
    },
  },
  {
    version: 3,
    name: 'order brief and generated brochure copy',
    up(db) {
      // brief is the customer's own wording for the brochure copy writer.
      addColumnIfMissing(db, 'orders', 'brief', "TEXT NOT NULL DEFAULT ''");
      // copy_json holds the validated { headline, body, closing } reply as JSON
      // text. It stays nullable: an order without generated copy has no value.
      addColumnIfMissing(db, 'orders', 'copy_json', 'TEXT');
    },
  },
  {
    version: 4,
    name: 'material trade rates and order independent renders',
    // The renders table is rebuilt below so orderId may be NULL: the rate card
    // is a catalogue document and belongs to no order. SQLite can only relax a
    // NOT NULL constraint by copying the table.
    foreignKeys: 'off',
    up(db) {
      // A material can carry a trade rate for the printed rate card.
      addColumnIfMissing(db, 'materials', 'price_amount', 'REAL NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'materials', 'price_unit', "TEXT NOT NULL DEFAULT ''");
      addColumnIfMissing(db, 'materials', 'sku', "TEXT NOT NULL DEFAULT ''");

      const orderIdColumn = db
        .prepare('PRAGMA table_info(renders)')
        .all()
        .find((column) => column.name === 'orderId');
      if (!orderIdColumn || Number(orderIdColumn.notnull) === 0) return false;

      const renderColumns = tableColumns(db, 'renders');
      const templateExpression = renderColumns.includes('templateId') ? 'templateId' : 'NULL';
      db.exec(`
        CREATE TABLE renders_v4 (
          id TEXT PRIMARY KEY,
          orderId TEXT REFERENCES orders(id) ON DELETE RESTRICT,
          kind TEXT NOT NULL,
          pageCount INTEGER NOT NULL,
          pdfUrl TEXT NOT NULL,
          pageUrls TEXT NOT NULL,
          templateId TEXT,
          createdAt TEXT NOT NULL
        );
      `);
      db.exec(`
        INSERT INTO renders_v4 (id, orderId, kind, pageCount, pdfUrl, pageUrls, templateId, createdAt)
        SELECT id, orderId, kind, pageCount, pdfUrl, pageUrls, ${templateExpression}, createdAt
        FROM renders;
      `);
      db.exec('DROP TABLE renders');
      db.exec('ALTER TABLE renders_v4 RENAME TO renders');
      db.exec('CREATE INDEX IF NOT EXISTS renders_order_created_idx ON renders (orderId, createdAt)');
      db.exec('CREATE INDEX IF NOT EXISTS renders_created_idx ON renders (createdAt)');
      return true;
    },
  },
  {
    version: 5,
    name: 'language model response cache',
    up(db) {
      // Generated copy and notes are deterministic for a given prompt. Caching
      // them saves provider spend and makes repeat clicks instant. Expiry is
      // enforced on read, so no sweeper has to run for correctness.
      db.exec(`
        CREATE TABLE IF NOT EXISTS llm_cache (
          key TEXT PRIMARY KEY,
          endpoint TEXT NOT NULL,
          model TEXT NOT NULL,
          response_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          last_used_at TEXT NOT NULL,
          hits INTEGER NOT NULL DEFAULT 0
        );
      `);
      db.exec('CREATE INDEX IF NOT EXISTS llm_cache_created_idx ON llm_cache (created_at)');
    },
  },
  {
    version: 6,
    name: 'order attachments',
    up(db) {
      // Customer photos, drawings and documents uploaded in the chat stay with
      // the order as metadata: [{ url, name, contentType, bytes }].
      addColumnIfMissing(db, 'orders', 'attachments_json', 'TEXT');
    },
  },
  {
    version: 7,
    name: 'generated brochure design',
    up(db) {
      // The AI designed documents keep the composition and labels they used,
      // so the studio can show how each brochure was made.
      addColumnIfMissing(db, 'renders', 'design_json', 'TEXT');
    },
  },
  {
    version: 8,
    name: 'design direction',
    up(db) {
      // Free text from the studio on how the brochure should feel. The model
      // reads it before it designs, and the next generation remembers it.
      addColumnIfMissing(db, 'orders', 'design_direction', 'TEXT');
    },
  },
  {
    version: 9,
    name: 'model authored brochure document',
    up(db) {
      // The model now writes the brochure itself. The document is kept so the
      // next chat edit can change one thing without losing the design.
      addColumnIfMissing(db, 'renders', 'html', 'TEXT');
    },
  },
  {
    version: 10,
    name: 'model written design reference library',
    up(db) {
      // The gallery is a library of design directions the model writes, not
      // hand made templates. One row keeps the whole library together.
      db.exec(`
        CREATE TABLE IF NOT EXISTS design_catalog (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          version INTEGER NOT NULL,
          expected INTEGER NOT NULL,
          designs_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 11,
    name: 'sample words for design previews',
    up(db) {
      // One shared copy for every preview brochure, kept with the library.
      addColumnIfMissing(db, 'design_catalog', 'sample_copy_json', 'TEXT');
    },
  },
  {
    version: 12,
    name: 'pi assistant sessions',
    up(db) {
      // One Pi transcript per chat session, so the agent keeps the order, the
      // tool results and the decisions across turns and restarts.
      db.exec(`
        CREATE TABLE IF NOT EXISTS assistant_sessions (
          id TEXT PRIMARY KEY,
          order_id TEXT REFERENCES orders(id) ON DELETE SET NULL,
          messages_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      db.exec('CREATE INDEX IF NOT EXISTS assistant_sessions_order ON assistant_sessions(order_id);');
    },
  },
  {
    version: 13,
    name: 'studio marked details on orders',
    up(db) {
      // Areas the studio marked on the pictures, with the colour they want
      // printed for each one.
      addColumnIfMissing(db, 'orders', 'annotations_json', 'TEXT');
    },
  },
]);

function assistantSessionFromRow(row) {
  if (!row) return null;
  let messages = [];
  try {
    const parsed = JSON.parse(row.messages_json);
    messages = Array.isArray(parsed) ? parsed : [];
  } catch {
    messages = [];
  }
  return { id: row.id, orderId: row.order_id ?? null, messages, updatedAt: row.updated_at };
}

export function getAssistantSession(db, id) {
  return assistantSessionFromRow(
    db.prepare('SELECT * FROM assistant_sessions WHERE id = ?').get(String(id ?? '')),
  );
}

export function putAssistantSession(db, { id, orderId = null, messages = [] }) {
  const safeId = String(id ?? '').trim().slice(0, 120);
  if (safeId === '') throw new Error('An assistant session needs an id.');
  const payload = JSON.stringify(Array.isArray(messages) ? messages : []).slice(0, 2_000_000);
  db.prepare(
    `INSERT INTO assistant_sessions (id, order_id, messages_json, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       order_id = excluded.order_id,
       messages_json = excluded.messages_json,
       updated_at = excluded.updated_at`,
  ).run(safeId, orderId, payload, now());
  return getAssistantSession(db, safeId);
}

export function deleteAssistantSession(db, id) {
  const result = db.prepare('DELETE FROM assistant_sessions WHERE id = ?').run(String(id ?? ''));
  return Number(result.changes) > 0;
}

export function getLlmCache(db, key, expiryCutoffIso = null) {
  const row = db.prepare('SELECT * FROM llm_cache WHERE key = ?').get(key);
  if (!row) return null;
  if (expiryCutoffIso && row.created_at < expiryCutoffIso) {
    db.prepare('DELETE FROM llm_cache WHERE key = ?').run(key);
    return null;
  }
  db.prepare('UPDATE llm_cache SET hits = hits + 1, last_used_at = ? WHERE key = ?').run(now(), key);
  return row;
}

export function putLlmCache(db, entry) {
  const timestamp = now();
  db.prepare(
    `INSERT INTO llm_cache (key, endpoint, model, response_json, created_at, last_used_at, hits)
     VALUES (?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(key) DO UPDATE SET
       response_json = excluded.response_json,
       last_used_at = excluded.last_used_at`,
  ).run(entry.key, entry.endpoint, entry.model, entry.responseJson, timestamp, timestamp);
}

export function pruneLlmCache(db, beforeIso) {
  return db.prepare('DELETE FROM llm_cache WHERE created_at < ?').run(beforeIso).changes;
}

export function llmCacheStats(db) {
  const row = db
    .prepare('SELECT COUNT(*) AS entries, COALESCE(SUM(hits), 0) AS hits, MIN(created_at) AS oldest FROM llm_cache')
    .get();
  return { entries: Number(row.entries), hits: Number(row.hits), oldest: row.oldest ?? null };
}

export function schemaVersion(db) {
  return Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
}

/**
 * Apply every migration newer than the database's PRAGMA user_version, each in
 * its own transaction. Returns the version the database is on afterwards.
 */
export function migrate(db) {
  let current = schemaVersion(db);
  for (const migration of [...MIGRATIONS].sort((left, right) => left.version - right.version)) {
    if (migration.version <= current) continue;
    // SQLite can not relax a NOT NULL constraint in place. A migration that
    // rebuilds a table sets foreignKeys: 'off'; the pragma is a no-op inside a
    // transaction, so it is switched around the transaction, not inside it.
    const foreignKeysOff = migration.foreignKeys === 'off';
    if (foreignKeysOff) db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN IMMEDIATE');
    try {
      migration.up(db);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec('COMMIT');
      current = migration.version;
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(
        `Database migration ${migration.version} (${migration.name}) failed: ${error.message}`,
        { cause: error },
      );
    } finally {
      if (foreignKeysOff) db.exec('PRAGMA foreign_keys = ON');
    }
  }
  return current;
}

export function openDb(dbPath = ':memory:') {
  if (dbPath !== ':memory:') mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);

  // Durability and concurrency settings for a small always-on service.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');

  migrate(db);
  return db;
}

function plain(row) {
  return row ? { ...row } : null;
}

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

// The route validates the amount; this only keeps a broken direct call from
// writing a negative or non numeric rate into the database.
function normalisePriceAmount(value) {
  const amount = Number(value ?? 0);
  return Number.isFinite(amount) && amount >= 0 ? amount : 0;
}

function withDefault(field, value) {
  const trimmed = text(value);
  if (trimmed !== '') return trimmed;
  return ORDER_DEFAULTS[field] ?? '';
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

/**
 * Delete a customer, but never leave its orders behind. The foreign key is
 * ON DELETE RESTRICT, and this helper checks explicitly so callers get a clear
 * error instead of a raw constraint failure. Returns true when a row was
 * deleted, false when the customer did not exist.
 */
export function deleteCustomer(db, id) {
  const row = db.prepare('SELECT COUNT(*) AS count FROM orders WHERE customerId = ?').get(id);
  const orderCount = Number(row?.count ?? 0);
  if (orderCount > 0) {
    const error = new Error(
      `Customer has ${orderCount} order${orderCount === 1 ? '' : 's'} and can not be deleted. ` +
        'Delete the orders first so no order is orphaned.',
    );
    error.code = 'CUSTOMER_HAS_ORDERS';
    error.orderCount = orderCount;
    throw error;
  }
  const result = db.prepare('DELETE FROM customers WHERE id = ?').run(id);
  return Number(result.changes) > 0;
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

function nextOrderNo(db) {
  const year = new Date().getFullYear();
  const prefix = `JDS-${year}-`;
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

// copy_json is JSON text in the row, but the API and renderer work with the
// parsed object. A malformed value is treated as "no copy": the order must
// still load, and a render must still succeed without the copy block.
export function parseOrderCopy(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function parseOrderAttachments(value) {
  if (typeof value !== 'string' || value.trim() === '') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Internal order shape: every database column plus the parsed copy and the raw
// copy_json (so the renderer can warn about a value that did not parse). Json
// responses strip copy_json; see orderPayload in routes.mjs.
function orderFromRow(row) {
  const order = plain(row);
  if (!order) return null;
  order.copy = parseOrderCopy(order.copy_json);
  order.attachments = parseOrderAttachments(order.attachments_json);
  order.annotations = (() => {
    try {
      const parsed = JSON.parse(order.annotations_json ?? '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  })();
  order.designDirection = typeof order.design_direction === 'string' ? order.design_direction : '';
  delete order.design_direction;
  return order;
}

// The list stays small: lists carry the brief but not the generated copy.
export function listOrders(db) {
  return db
    .prepare(`${ORDER_SELECT} ORDER BY o.createdAt DESC, o.orderNo DESC`)
    .all()
    .map((row) => {
      const order = orderFromRow(row);
      delete order.copy;
      delete order.copy_json;
      return order;
    });
}

export function setOrderAnnotations(db, id, annotations) {
  const json = JSON.stringify(Array.isArray(annotations) ? annotations : []);
  db.prepare('UPDATE orders SET annotations_json = ? WHERE id = ?').run(json, id);
  return getOrder(db, id);
}

export function getOrder(db, id) {
  return orderFromRow(db.prepare(`${ORDER_SELECT} WHERE o.id = ?`).get(id));
}

export function createOrder(db, input) {
  const order = {
    id: randomUUID(),
    orderNo: nextOrderNo(db),
    customerId: input.customerId,
    status: input.status === 'approved' ? 'approved' : 'draft',
    createdAt: now(),
  };
  for (const field of ORDER_TEXT_FIELDS) {
    order[field] = withDefault(field, input[field]);
  }

  const attachments = Array.isArray(input.attachments) ? input.attachments : [];
  const columns = ['id', 'orderNo', 'customerId', ...ORDER_TEXT_FIELDS, 'status', 'createdAt', 'attachments_json'];
  const placeholders = columns.map(() => '?').join(', ');
  db.prepare(`INSERT INTO orders (${columns.join(', ')}) VALUES (${placeholders})`).run(
    ...columns.map((column) =>
      column === 'attachments_json'
        ? attachments.length > 0
          ? JSON.stringify(attachments)
          : null
        : order[column],
    ),
  );
  return getOrder(db, order.id);
}

const ORDER_PATCH_FIELDS = new Set(['customerId', 'status', ...ORDER_TEXT_FIELDS]);

export function updateOrder(db, id, patch) {
  const keys = Object.keys(patch).filter((key) => ORDER_PATCH_FIELDS.has(key));
  if (keys.length === 0) return getOrder(db, id);
  const assignments = keys.map((key) => `${key} = ?`).join(', ');
  db.prepare(`UPDATE orders SET ${assignments} WHERE id = ?`).run(
    ...keys.map((key) => (ORDER_TEXT_FIELDS.includes(key) ? withDefault(key, patch[key]) : patch[key])),
    id,
  );
  return getOrder(db, id);
}

/**
 * Store the generated brochure copy for an order. The caller passes the three
 * validated strings; they are serialised as one JSON object in copy_json.
 */
export function setOrderCopy(db, id, copy) {
  const json = copy === null || copy === undefined ? null : JSON.stringify(copy);
  db.prepare('UPDATE orders SET copy_json = ? WHERE id = ?').run(json, id);
  return getOrder(db, id);
}

/**
 * Replace the file list kept on an order. The caller passes validated
 * attachment metadata; an empty list clears the column.
 */
export function setOrderAttachments(db, id, files) {
  const json = Array.isArray(files) && files.length > 0 ? JSON.stringify(files) : null;
  db.prepare('UPDATE orders SET attachments_json = ? WHERE id = ?').run(json, id);
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

// The API speaks camelCase while the columns are snake_case. price_amount and
// sku are the trade rate card values; listMaterials is the one place that maps
// them back to the API spelling.
const MATERIAL_SELECT = `
  SELECT id, name, kind, hex, imageUrl,
         price_amount AS priceAmount, price_unit AS priceUnit, sku, createdAt
  FROM materials
`;

export function createMaterial(db, input) {
  const material = {
    id: randomUUID(),
    name: text(input.name),
    kind: text(input.kind),
    hex: text(input.hex),
    imageUrl: input.imageUrl === undefined || input.imageUrl === null ? null : text(input.imageUrl),
    priceAmount: normalisePriceAmount(input.priceAmount),
    priceUnit: text(input.priceUnit),
    sku: text(input.sku),
    createdAt: now(),
  };
  db.prepare(
    `INSERT INTO materials
       (id, name, kind, hex, imageUrl, price_amount, price_unit, sku, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    material.id,
    material.name,
    material.kind,
    material.hex,
    material.imageUrl,
    material.priceAmount,
    material.priceUnit,
    material.sku,
    material.createdAt,
  );
  return plain(material);
}

export function listMaterials(db) {
  return db.prepare(`${MATERIAL_SELECT} ORDER BY createdAt ASC, rowid ASC`).all().map(plain);
}

export function getMaterial(db, id) {
  return plain(db.prepare(`${MATERIAL_SELECT} WHERE id = ?`).get(id));
}

const MATERIAL_PATCH_FIELDS = new Set([
  'name',
  'kind',
  'hex',
  'imageUrl',
  'priceAmount',
  'priceUnit',
  'sku',
]);

export function updateMaterial(db, id, patch) {
  const keys = Object.keys(patch).filter((key) => MATERIAL_PATCH_FIELDS.has(key));
  if (keys.length === 0) return getMaterial(db, id);
  const columns = { priceAmount: 'price_amount', priceUnit: 'price_unit' };
  const assignments = keys.map((key) => `${columns[key] ?? key} = ?`).join(', ');
  const values = keys.map((key) => {
    if (key === 'priceAmount') return normalisePriceAmount(patch[key]);
    if (key === 'imageUrl') return patch[key] === null ? null : text(patch[key]);
    return text(patch[key]);
  });
  db.prepare(`UPDATE materials SET ${assignments} WHERE id = ?`).run(...values, id);
  return getMaterial(db, id);
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
  if (typeof render.design_json === 'string' && render.design_json.trim() !== '') {
    try {
      render.design = JSON.parse(render.design_json);
    } catch {
      render.design = null;
    }
  } else {
    render.design = null;
  }
  delete render.design_json;
  // The document can be large; it is read on demand by getRenderHtml and never
  // sent to the app in a render list.
  delete render.html;
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
    design: input.design ?? null,
    html: input.html ?? null,
    createdAt: input.createdAt ?? now(),
  };
  db.prepare(
    'INSERT INTO renders (id, orderId, kind, pageCount, pdfUrl, pageUrls, templateId, design_json, html, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    render.id,
    render.orderId,
    render.kind,
    render.pageCount,
    render.pdfUrl,
    JSON.stringify(render.pageUrls),
    render.templateId,
    render.design === null ? null : JSON.stringify(render.design),
    render.html,
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

/**
 * The model authored document behind a render, used to carry one design into
 * the next chat edit. Read separately so render lists stay small.
 */
export function getRenderHtml(db, id) {
  const row = db.prepare('SELECT html FROM renders WHERE id = ?').get(id);
  return row && typeof row.html === 'string' && row.html.trim() !== '' ? row.html : null;
}

// ---------------------------------------------------------------------------
// Design reference library
// ---------------------------------------------------------------------------

export function getDesignCatalog(db) {
  const row = db.prepare('SELECT * FROM design_catalog WHERE id = 1').get();
  if (!row) return { version: 0, expected: 0, designs: [], createdAt: null, sampleCopy: null };
  let designs = [];
  try {
    const parsed = JSON.parse(row.designs_json);
    if (Array.isArray(parsed)) designs = parsed;
  } catch {
    designs = [];
  }
  return {
    version: Number(row.version) || 0,
    expected: Number(row.expected) || 0,
    designs,
    createdAt: row.created_at ?? null,
    sampleCopy: typeof row.sample_copy_json === 'string' ? row.sample_copy_json : null,
  };
}

export function putDesignCatalog(db, { version, expected, designs, sampleCopy }) {
  const previous = getDesignCatalog(db);
  const kept = sampleCopy === undefined ? previous.sampleCopy : sampleCopy;
  db.prepare(
    `INSERT INTO design_catalog (id, version, expected, designs_json, sample_copy_json, created_at)
     VALUES (1, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       version = excluded.version,
       expected = excluded.expected,
       designs_json = excluded.designs_json,
       sample_copy_json = excluded.sample_copy_json`,
  ).run(version, expected, JSON.stringify(designs), kept, now());
  return getDesignCatalog(db);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

// The runtime configuration keys this build knows about. Keeping the list here
// means a typo can not quietly create a setting nothing ever reads.
export const SETTING_KEYS = Object.freeze(['llm_provider', 'llm_endpoint', 'llm_model', 'llm_api_key']);
const SETTING_KEY_SET = new Set(SETTING_KEYS);

function settingFromRow(row) {
  if (!row) return null;
  return { key: row.key, value: row.value, updatedAt: row.updated_at };
}

export function listSettings(db) {
  return db
    .prepare('SELECT key, value, updated_at FROM settings ORDER BY key ASC')
    .all()
    .map(settingFromRow);
}

export function getSetting(db, key) {
  return settingFromRow(
    db.prepare('SELECT key, value, updated_at FROM settings WHERE key = ?').get(key),
  );
}

/**
 * Insert or replace one setting. The caller passes only validated values; the
 * database layer just persists them with the current timestamp.
 */
export function setSetting(db, key, value) {
  if (!SETTING_KEY_SET.has(key)) throw new Error(`Unknown setting "${key}".`);
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, String(value), now());
  return getSetting(db, key);
}

/** Remove a setting so it falls back to the environment. Returns true if a row was deleted. */
export function deleteSetting(db, key) {
  const result = db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  return Number(result.changes) > 0;
}

// The retention sweep lives in its own module; re-exported here so the data
// layer is the one obvious import for anything that touches render rows.
export { sweepRenders } from './retention.mjs';
