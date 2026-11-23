import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

// The bundle ships no photography: only the brand logo, the house motifs and
// the fonts. Every other image reaches the studio through a customer upload,
// so data/media holds uploads only and nothing is ever copied in.
export const MEDIA_FILES = [];

// Stock photography removed from the bundle. Existing data directories may
// still hold copies from older installs; they are deleted on boot so no
// customer document can ever print them again.
const RETIRED_STOCK_FILES = Object.freeze([
  'bedroom-wardrobe.jpg',
  'beige-wardrobe.jpg',
  'grey-detail.jpg',
  'walk-in.jpg',
  'tex-band.jpg',
  'tex-cream.jpg',
  'tex-grey.jpg',
  'tex-walnut.jpg',
]);

export function removeStockMedia(db, dataDir) {
  const mediaDir = path.join(dataDir, 'media');
  for (const name of RETIRED_STOCK_FILES) {
    try {
      rmSync(path.join(mediaDir, name), { force: true });
    } catch {
      // A missing file is the desired end state.
    }
    try {
      db.prepare('UPDATE materials SET imageUrl = NULL WHERE imageUrl = ?').run(`/media/${name}`);
    } catch {
      // Older databases predate the materials image column.
    }
  }
}

export function ensureMedia(templatesDir, dataDir) {
  const mediaDir = path.join(dataDir, 'media');
  mkdirSync(mediaDir, { recursive: true });
  return mediaDir;
}
