import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { serve } from '@hono/node-server';

import { loadConfig } from './config.mjs';
import { openDb } from './db.mjs';
import { isExecutable } from './http.mjs';
import { createLogger } from './logger.mjs';
import { ensureMedia } from './media.mjs';
import { createRenderer } from './render.mjs';
import { RETENTION_INTERVAL_MS, runRetentionSweep } from './retention.mjs';
import { createApp } from './routes.mjs';

// How long shutdown waits for in flight renders before closing the database.
const SHUTDOWN_RENDER_TIMEOUT_MS = 20_000;
const SHUTDOWN_HTTP_TIMEOUT_MS = 2_000;

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

const config = loadConfig();
const logger = createLogger({ level: config.logLevel });

mkdirSync(config.dataDir, { recursive: true });
mkdirSync(path.join(config.dataDir, 'renders'), { recursive: true });
ensureMedia(config.templatesDir, config.dataDir);

const db = openDb(config.dbPath);

const renderer = createRenderer({
  templatesDir: config.templatesDir,
  dataDir: config.dataDir,
  weasyprintBin: config.weasyprintBin,
  pdftoppmBin: config.pdftoppmBin,
});

const app = createApp({
  db,
  dataDir: config.dataDir,
  templatesDir: config.templatesDir,
  weasyprintBin: config.weasyprintBin,
  pdftoppmBin: config.pdftoppmBin,
  renderer,
  logger,
  corsOrigins: config.corsOrigins,
  rateLimitPerMin: config.rateLimitPerMin,
  renderLimitPerMin: config.renderLimitPerMin,
  noteLimitPerMin: config.noteLimitPerMin,
  onReady: ({ previewStore }) => {
    // Warm template thumbnails after boot. Cached previews return immediately;
    // on a fresh data directory this fills the cache in the background while
    // the API keeps serving. Rendering is queued, so a render request only
    // waits for the preview currently being built. A failure here is logged and
    // never allowed to crash the process.
    setTimeout(() => {
      previewStore
        .warmAll()
        .then(({ generated, failed, total }) => {
          if (generated > 0) {
            logger.info('Template previews generated.', { generated, total });
          }
          if (failed.length > 0) {
            logger.warn('Some template previews could not be generated.', {
              failed: failed.length,
              total,
            });
          }
        })
        .catch((error) => {
          logger.warn('Template previews could not be generated.', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }, 0);
  },
});

// Retention runs once on boot and then daily. It never throws into boot.
function sweepRetention(reason) {
  const result = runRetentionSweep(db, {
    dataDir: config.dataDir,
    retentionDays: config.retentionDays,
    protectedRenderIds: renderer.activeRenderIds(),
  });
  if (!result.ok) {
    logger.warn('Render retention sweep failed.', { reason, error: result.error });
    return;
  }
  if (result.skipped) {
    logger.info('Render retention is disabled (RENDER_RETENTION_DAYS=0).', { reason });
    return;
  }
  if (result.deletedRenders > 0 || result.deletedOrphanPages > 0) {
    logger.info('Render retention sweep finished.', {
      reason,
      retentionDays: result.retentionDays,
      deletedRenders: result.deletedRenders,
      deletedFiles: result.deletedFiles,
      deletedOrphanPages: result.deletedOrphanPages,
    });
  } else {
    logger.debug('Render retention sweep found nothing to delete.', { reason });
  }
}

sweepRetention('boot');

let retentionTimer = null;
if (config.retentionDays > 0) {
  retentionTimer = setInterval(() => sweepRetention('scheduled'), RETENTION_INTERVAL_MS);
  retentionTimer.unref?.();
}

if (!isExecutable(config.weasyprintBin)) {
  logger.warn('WeasyPrint was not found or is not executable. Renders and GET /ready will fail until it is installed.', {
    weasyprintBin: config.weasyprintBin,
  });
}

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  logger.info('Grace catalogue API listening.', {
    url: `http://localhost:${info.port}`,
    database: config.dbPath,
    logLevel: logger.level,
  });
});

server.once('error', (error) => {
  logger.error('HTTP server failed to start.', {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exit(1);
});

let shuttingDown = false;

function flushAndExit(code) {
  process.exitCode = code;
  const finish = () => process.exit(code);
  try {
    process.stdout.write('', finish);
  } catch {
    finish();
  }
  setTimeout(finish, 1_000).unref?.();
}

async function shutdown(signal) {
  if (shuttingDown) {
    logger.warn('Second shutdown signal received, exiting immediately.', { signal });
    process.exit(0);
  }
  shuttingDown = true;
  const startedAt = Date.now();

  // Stop accepting new work immediately; in flight requests keep running.
  app.lifecycle.shuttingDown = true;
  if (retentionTimer) {
    clearInterval(retentionTimer);
    retentionTimer = null;
  }

  logger.info('Shutdown started.', { signal });
  let httpClosed = false;
  const serverClosed = new Promise((resolve) => {
    server.close(() => {
      httpClosed = true;
      resolve(true);
    });
  });
  server.closeIdleConnections?.();
  logger.info('Shutdown: stopped accepting new connections.', { signal });

  const rendersIdle = await renderer.whenRendersIdle(SHUTDOWN_RENDER_TIMEOUT_MS);
  if (rendersIdle) {
    logger.info('Shutdown: in flight renders finished.');
  } else {
    logger.warn('Shutdown: timed out waiting for in flight renders.', {
      timeoutMs: SHUTDOWN_RENDER_TIMEOUT_MS,
      pendingRenders: renderer.pendingRenderCount(),
    });
  }

  // Let the responses of the renders that just finished flush, then let the
  // remaining connections close. Anything still open after the grace period is
  // force closed so shutdown always completes.
  const httpDeadline = Date.now() + SHUTDOWN_HTTP_TIMEOUT_MS;
  while (!httpClosed && Date.now() < httpDeadline) {
    await delay(50);
    server.closeIdleConnections?.();
  }
  if (!httpClosed) {
    logger.warn('Shutdown: forcing remaining connections closed.', {
      timeoutMs: SHUTDOWN_HTTP_TIMEOUT_MS,
    });
    server.closeAllConnections?.();
    await Promise.race([serverClosed, delay(500)]);
  }
  logger.info('Shutdown: HTTP server closed.');

  try {
    db.close();
    logger.info('Shutdown: database closed.');
  } catch (error) {
    logger.warn('Shutdown: database was already closed.', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  logger.info('Shutdown complete.', { durationMs: Date.now() - startedAt });
  flushAndExit(0);
}

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
