import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Walk up from server/src to the repository root.
export const rootDir = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

function defaultWeasyprint(rootDir) {
  const local = path.join(rootDir, '.venv', 'bin', 'weasyprint');
  if (existsSync(local)) return local;
  return path.join(rootDir, 'specimen', '.venv', 'bin', 'weasyprint');
}

export function loadConfig(env = process.env) {
  const dataDir = path.resolve(env.CATALOG_DATA_DIR ?? path.join(rootDir, 'data'));
  const templatesDir = path.resolve(env.CATALOG_TEMPLATES_DIR ?? path.join(rootDir, 'templates'));
  const dbPath = path.resolve(env.CATALOG_DB ?? path.join(dataDir, 'catalog.db'));
  const port = Number.parseInt(env.PORT ?? '8787', 10);

  return {
    rootDir,
    dataDir,
    templatesDir,
    dbPath,
    port: Number.isFinite(port) ? port : 8787,
    weasyprintBin: env.WEASYPRINT_BIN ?? defaultWeasyprint(rootDir),
    pdftoppmBin: env.PDFTOPPM_BIN ?? 'pdftoppm',
  };
}
