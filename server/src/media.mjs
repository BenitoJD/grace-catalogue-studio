import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

// Images copied from templates/assets/company into data/media on boot so the
// app can load material swatches from /media/<name>.
export const MEDIA_FILES = [
  'bedroom-wardrobe.jpg',
  'beige-wardrobe.jpg',
  'grey-detail.jpg',
  'tex-band.jpg',
  'tex-cream.jpg',
  'tex-grey.jpg',
  'tex-walnut.jpg',
  'walk-in.jpg',
];

export function ensureMedia(templatesDir, dataDir) {
  const sourceDir = path.join(templatesDir, 'assets', 'company');
  const mediaDir = path.join(dataDir, 'media');
  mkdirSync(mediaDir, { recursive: true });

  for (const name of MEDIA_FILES) {
    const source = path.join(sourceDir, name);
    const destination = path.join(mediaDir, name);
    if (existsSync(source) && !existsSync(destination)) {
      copyFileSync(source, destination);
    }
  }
  return mediaDir;
}
