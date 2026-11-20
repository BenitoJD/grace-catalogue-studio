import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { serve } from '@hono/node-server';

import { loadConfig } from './config.mjs';
import { openDb } from './db.mjs';
import { ensureMedia } from './media.mjs';
import { createApp } from './routes.mjs';

const config = loadConfig();

mkdirSync(config.dataDir, { recursive: true });
mkdirSync(path.join(config.dataDir, 'renders'), { recursive: true });
ensureMedia(config.templatesDir, config.dataDir);

const db = openDb(config.dbPath);
const app = createApp({
  db,
  dataDir: config.dataDir,
  templatesDir: config.templatesDir,
  weasyprintBin: config.weasyprintBin,
  pdftoppmBin: config.pdftoppmBin,
  onReady: ({ previewStore }) => {
    // Warm template thumbnails after boot. Cached previews return immediately;
    // on a fresh data directory this fills the cache in the background while
    // the API keeps serving. Rendering is queued, so a render request only
    // waits for the preview currently being built.
    setTimeout(() => {
      previewStore
        .warmAll()
        .then(({ generated, failed, total }) => {
          if (generated > 0) {
            console.log(`Template previews: ${generated} of ${total} generated.`);
          }
          if (failed.length > 0) {
            console.warn(`Template previews: ${failed.length} could not be generated.`);
          }
        })
        .catch((error) => {
          console.warn(`Template previews could not be generated: ${error.message}`);
        });
    }, 0);
  },
});

if (!existsSync(config.weasyprintBin)) {
  console.warn(`WeasyPrint was not found at ${config.weasyprintBin}. Renders will fail until it is installed.`);
}

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Grace catalogue API listening on http://localhost:${info.port}`);
  console.log(`Database: ${config.dbPath}`);
});

function shutdown() {
  server.close(() => {
    try {
      db.close();
    } catch {
      // Already closed.
    }
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
