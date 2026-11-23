import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { loadConfig } from './config.mjs';
import {
  createCustomer,
  createMaterial,
  createOrder,
  listCustomers,
  listMaterials,
  listOrders,
  openDb,
} from './db.mjs';
import { ensureMedia } from './media.mjs';

const DEMO_CUSTOMER = {
  name: 'Arun Kumar',
  phone: '+91 63740 43346',
  address: '26J, Rajjakamangalam Road, Chettikulam, Nagercoil',
};

const DEMO_ORDERS = [
  {
    title: 'Master Bedroom Wardrobe',
    room: 'Master bedroom',
    width: '2400 mm',
    height: '2100 mm',
    depth: '600 mm',
    shutters: '3 · 800 mm',
    carcass: '18 mm BWP plywood',
    backPanel: '6 mm plywood',
    shuttersMat: '18 mm BWP plywood',
    drawers: '12 mm plywood, two drawers',
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
    status: 'approved',
  },
  {
    title: 'Guest Bedroom Wardrobe',
    room: 'Guest bedroom',
    width: '1800 mm',
    height: '2100 mm',
    depth: '600 mm',
    shutters: '2 · 900 mm',
    carcass: '18 mm BWR plywood',
    backPanel: '6 mm plywood',
    shuttersMat: '18 mm BWR plywood',
    drawers: '12 mm plywood, two drawers',
    exterior: 'Ash Grey laminate',
    interior: '0.8 mm white laminate',
    hinges: 'Soft-close',
    channels: 'Soft-close telescopic',
    edgeShutter: '2 mm PVC',
    edgeCarcass: '0.8 mm PVC',
    edgeNote: 'Colour matched',
    handle: 'Antique brass pull',
    handleNote: 'Two sets',
    finishExt: 'Matte finish',
    finishInt: 'No painting',
    status: 'draft',
  },
];

const DEMO_MATERIALS = [
  {
    name: 'Dark Walnut',
    kind: 'laminate',
    hex: '#3F2A1D',
    imageUrl: null,
    priceAmount: 1240,
    priceUnit: 'sheet',
    sku: 'GW-WAL-06',
  },
  {
    name: 'Cream',
    kind: 'laminate',
    hex: '#E8DCC8',
    imageUrl: null,
    priceAmount: 980,
    priceUnit: 'sheet',
    sku: 'GW-CRM-04',
  },
  {
    name: 'Ash Grey',
    kind: 'laminate',
    hex: '#9A9A94',
    imageUrl: null,
    priceAmount: 1120,
    priceUnit: 'sheet',
    sku: 'GW-ASH-07',
  },
  {
    name: 'Edge band',
    kind: 'edge band',
    hex: '#8B5A2B',
    imageUrl: null,
    priceAmount: 18,
    priceUnit: 'metre',
    sku: 'GW-EDG-02',
  },
];

const config = loadConfig();

mkdirSync(config.dataDir, { recursive: true });
ensureMedia(config.templatesDir, config.dataDir);

const db = openDb(config.dbPath);

let seededCustomers = 0;
let seededOrders = 0;

if (listCustomers(db).length === 0 && listOrders(db).length === 0) {
  const customer = createCustomer(db, DEMO_CUSTOMER);
  seededCustomers = 1;
  for (const order of DEMO_ORDERS) {
    createOrder(db, { ...order, customerId: customer.id });
    seededOrders += 1;
  }
  console.log('Inserted demo customer and orders.');
} else {
  console.log('Demo customers and orders already exist. Left them untouched.');
}

let seededMaterials = 0;
if (listMaterials(db).length === 0) {
  for (const material of DEMO_MATERIALS) {
    createMaterial(db, material);
    seededMaterials += 1;
  }
  console.log('Inserted demo materials.');
} else {
  console.log('Demo materials already exist. Left them untouched.');
}

const counts = {
  customers: listCustomers(db).length,
  orders: listOrders(db).length,
  materials: listMaterials(db).length,
};

console.log(`Database: ${config.dbPath}`);
console.log(
  `Demo data: ${counts.customers} customers, ${counts.orders} orders, ${counts.materials} materials.`,
);
console.log('Media images are ready in ' + path.join(config.dataDir, 'media') + '.');

db.close();
