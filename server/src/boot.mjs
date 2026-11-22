// Boot the catalogue server without owning the process lifecycle.
//
// The command line entry point (src/index.mjs) and the desktop application both
// call this. It returns the listening server, the database and a close()
// function so an embedder can shut it down cleanly.
import path from 'node:path';
import { mkdirSync } from 'node:fs';

import { serve } from '@hono/node-server';

import { loadConfig } from './config.mjs';
import { openDb, pruneLlmCache } from './db.mjs';
import { isExecutable } from './http.mjs';
import { createLogger } from './logger.mjs';
import { ensureMedia } from './media.mjs';
import { createRenderer } from './render.mjs';
import { runRetentionSweep } from './retention.mjs';
import { createApp } from './routes.mjs';
import { installEgressGuard } from './egress.mjs';
import { resolveLlmConfig } from './llm.mjs';

const SHUTDOWN_RENDER_TIMEOUT_MS = 20_000;

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * Start the API and the render queue.
 *
 * @param {object} [options]
 * @param {number} [options.port] 0 asks the OS for a free port.
 * @param {string} [options.host] defaults to loopback only.
 * @param {object} [options.pdfEngine] desktop print engine; WeasyPrint otherwise.
 * @param {object} [options.logger] custom logger.
 * @param {string} [options.dataDir] override CATALOG_DATA_DIR.
 * @param {string} [options.templatesDir] override CATALOG_TEMPLATES_DIR.
 */
export async function startCatalogServer(options = {}) {
  const config = loadConfig();
  const dataDir = options.dataDir ?? config.dataDir;
  const templatesDir = options.templatesDir ?? config.templatesDir;
  const dbPath = options.dbPath ?? (options.dataDir ? path.join(dataDir, 'catalog.db') : config.dbPath);
  const logger = options.logger ?? createLogger({ level: config.logLevel });

  mkdirSync(dataDir, { recursive: true });
  mkdirSync(path.join(dataDir, 'renders'), { recursive: true });
  ensureMedia(templatesDir, dataDir);

  const db = openDb(dbPath);

  // Only the configured model provider (and loopback) may receive traffic.
  // This is the in-code promise behind "the app works offline except for the
  // model". CATALOG_ALLOWED_EGRESS_ORIGINS can add a specific origin later.
  const restoreEgress = installEgressGuard({
    resolveConfig: () => resolveLlmConfig(db),
  });
  logger.info('Network egress guard active.', { rule: 'configured model provider and loopback only' });

  const renderer = createRenderer({
    templatesDir,
    dataDir,
    weasyprintBin: config.weasyprintBin,
    pdftoppmBin: config.pdftoppmBin,
    pdfEngine: options.pdfEngine ?? null,
  });

  if (config.llmCacheTtlHours > 0) {
    const cutoff = new Date(Date.now() - config.llmCacheTtlHours * 3600 * 1000).toISOString();
    const removed = pruneLlmCache(db, cutoff);
    if (removed > 0) logger.info('Pruned expired language model cache entries.', { removed });
  }

  const app = createApp({
    db,
    dataDir,
    templatesDir,
    weasyprintBin: config.weasyprintBin,
    pdftoppmBin: config.pdftoppmBin,
    renderer,
    logger,
    corsOrigins: config.corsOrigins,
    rateLimitPerMin: config.rateLimitPerMin,
    renderLimitPerMin: config.renderLimitPerMin,
    noteLimitPerMin: config.noteLimitPerMin,
    llmCacheTtlHours: config.llmCacheTtlHours,
    onReady: ({ previewStore }) => {
      setTimeout(() => {
        previewStore
          .warmAll()
          .then(({ generated, failed, total }) => {
            if (generated > 0) logger.info('Template previews generated.', { generated, total });
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

  function sweepRetention(reason) {
    const result = runRetentionSweep(db, {
      dataDir,
      retentionDays: config.retentionDays,
      protectedRenderIds: renderer.activeRenderIds(),
    });
    if (!result.ok) {
      logger.warn('Render retention sweep failed.', { reason, error: result.error });
    }
  }
  sweepRetention('boot');
  let retentionTimer = null;
  if (config.retentionDays > 0) {
    retentionTimer = setInterval(() => sweepRetention('scheduled'), 24 * 60 * 60 * 1000);
    retentionTimer.unref?.();
  }

  if (!options.pdfEngine && !isExecutable(config.weasyprintBin)) {
    logger.warn(
      'WeasyPrint was not found or is not executable. Renders and GET /ready will fail until it is installed.',
      { weasyprintBin: config.weasyprintBin },
    );
  }

  const port = options.port ?? config.port;
  const host = options.host ?? '127.0.0.1';
  const server = serve({ fetch: app.fetch, port, hostname: host });
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  const actualPort = address && typeof address === 'object' ? address.port : port;
  const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${actualPort}`;

  let shuttingDown = false;
  async function close() {
    if (shuttingDown) return;
    shuttingDown = true;
    if (retentionTimer) clearInterval(retentionTimer);
    app.lifecycle.shuttingDown = true;
    await renderer.whenRendersIdle(SHUTDOWN_RENDER_TIMEOUT_MS);
    await new Promise((resolve) => server.close(resolve));
    server.closeIdleConnections?.();
    await Promise.race([Promise.resolve(), delay(2_000)]);
    try {
      db.close();
    } catch {
      // Already closed.
    } finally {
      restoreEgress();
    }
  }

  logger.info('Grace catalogue API listening.', {
    url,
    database: dbPath,
    mode: options.pdfEngine ? 'desktop print engine' : 'weasyprint',
  });

  return { app, server, db, renderer, logger, config, port: actualPort, url, close };
}
