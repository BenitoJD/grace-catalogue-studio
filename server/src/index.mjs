// Command line entry point for the catalogue API.
//
// The desktop application embeds the same server through src/boot.mjs, so all
// behaviour lives there. This file only owns process signals.
import { startCatalogServer } from './boot.mjs';

const SHUTDOWN_HTTP_TIMEOUT_MS = 2_000;

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

let instance = null;
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
    instance?.logger.warn('Second shutdown signal received, exiting immediately.', { signal });
    process.exit(0);
  }
  shuttingDown = true;
  const startedAt = Date.now();
  const logger = instance?.logger;

  logger?.info('Shutdown started.', { signal });
  if (instance) {
    instance.app.lifecycle.shuttingDown = true;
    logger?.info('Shutdown: stopped accepting new connections.', { signal });
    const closed = await Promise.race([
      instance.close().then(() => true),
      delay(SHUTDOWN_HTTP_TIMEOUT_MS).then(() => false),
    ]);
    if (!closed) logger?.warn('Shutdown: timed out waiting for in flight work.');
  }
  logger?.info('Shutdown complete.', { durationMs: Date.now() - startedAt });
  flushAndExit(0);
}

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

startCatalogServer()
  .then((started) => {
    instance = started;
  })
  .catch((error) => {
    console.error('The catalogue server could not start:', error);
    process.exit(1);
  });
