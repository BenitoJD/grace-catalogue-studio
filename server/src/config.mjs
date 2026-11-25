import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_LOG_LEVEL, parseLogLevel } from './logger.mjs';

// Walk up from server/src to the repository root.
export const rootDir = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

export const DEFAULT_PORT = 8787;
export const DEFAULT_CORS_ORIGINS = Object.freeze([
  'http://localhost:8081',
  'http://localhost:8082',
  'http://localhost:19006',
]);
export const DEFAULT_RATE_LIMIT_PER_MIN = 120;
export const DEFAULT_RENDER_LIMIT_PER_MIN = 12;
export const DEFAULT_NOTE_LIMIT_PER_MIN = 30;
export const DEFAULT_RENDER_RETENTION_DAYS = 30;
export const DEFAULT_LLM_CACHE_TTL_HOURS = 168;

// Windows finds an executable by its PATHEXT suffix, so "weasyprint" is really
// weasyprint.exe. POSIX has executable files with no suffix, and returns the
// name unchanged. Kept in step with isExecutable() in http.mjs.
const WINDOWS_PATHEXT = Object.freeze(
  (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((extension) => extension.trim().toLowerCase())
    .filter(Boolean),
);

function executableNames(command) {
  if (process.platform !== 'win32' || path.extname(command) !== '') return [command];
  return [command, ...WINDOWS_PATHEXT.map((extension) => `${command}${extension}`)];
}

function findOnPath(command) {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of executableNames(command)) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

// A virtualenv puts console scripts in bin/ on POSIX and Scripts/ with an .exe
// suffix on Windows, so the same checkout works on both without a hard coded
// path.
function venvExecutable(root, name) {
  if (process.platform === 'win32') {
    return path.join(root, '.venv', 'Scripts', `${name}.exe`);
  }
  return path.join(root, '.venv', 'bin', name);
}

// A checkout may keep WeasyPrint in a local virtualenv, and a container or CI
// installs it on PATH. Try the repository virtualenvs first, then PATH, so the
// same code works for both without a hard coded path. Exported so the test
// suite resolves it exactly like the server does.
export function resolveWeasyprint(root = rootDir, env = process.env) {
  if (env.WEASYPRINT_BIN) return env.WEASYPRINT_BIN;
  const candidates = [
    venvExecutable(root, 'weasyprint'),
    venvExecutable(path.join(root, 'specimen'), 'weasyprint'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return findOnPath('weasyprint') ?? candidates[0];
}

// Positive integers only. Anything else falls back to the default so a bad
// environment variable cannot disable a protection or crash boot.
export function parsePositiveInt(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const parsed = Number.parseInt(String(value).trim(), 10);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : fallback;
}

// Cache TTL allows 0, which means "do not cache at all".
export function parseCacheTtlHours(value, fallback = DEFAULT_LLM_CACHE_TTL_HOURS) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const parsed = Number.parseInt(String(value).trim(), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

// Retention days allow 0, which means "keep forever".
export function parseRetentionDays(value, fallback = DEFAULT_RENDER_RETENTION_DAYS) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const parsed = Number.parseInt(String(value).trim(), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

// CORS_ORIGINS is a comma separated allowlist. A single "*" allows every
// origin; an empty or malformed value falls back to the built in local list.
export function parseCorsOrigins(value, fallback = DEFAULT_CORS_ORIGINS) {
  if (value === undefined || value === null) return [...fallback];
  const text = String(value).trim();
  if (text === '') return [...fallback];
  if (text === '*') return ['*'];
  const origins = text
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  return origins.length > 0 ? origins : [...fallback];
}

export function loadConfig(env = process.env) {
  const dataDir = path.resolve(env.CATALOG_DATA_DIR ?? path.join(rootDir, 'data'));
  const templatesDir = path.resolve(env.CATALOG_TEMPLATES_DIR ?? path.join(rootDir, 'templates'));
  const dbPath = path.resolve(env.CATALOG_DB ?? path.join(dataDir, 'catalog.db'));
  const port = Number.parseInt(env.PORT ?? String(DEFAULT_PORT), 10);

  return {
    rootDir,
    dataDir,
    templatesDir,
    dbPath,
    port: Number.isFinite(port) ? port : DEFAULT_PORT,
    weasyprintBin: resolveWeasyprint(rootDir, env),
    pdftoppmBin: env.PDFTOPPM_BIN ?? 'pdftoppm',
    logLevel: env.LOG_LEVEL === undefined ? DEFAULT_LOG_LEVEL : parseLogLevel(env.LOG_LEVEL),
    corsOrigins: parseCorsOrigins(env.CORS_ORIGINS),
    rateLimitPerMin: parsePositiveInt(env.RATE_LIMIT_PER_MIN, DEFAULT_RATE_LIMIT_PER_MIN),
    renderLimitPerMin: parsePositiveInt(
      env.RENDER_LIMIT_PER_MIN,
      DEFAULT_RENDER_LIMIT_PER_MIN,
    ),
    noteLimitPerMin: parsePositiveInt(env.NOTE_LIMIT_PER_MIN, DEFAULT_NOTE_LIMIT_PER_MIN),
    retentionDays: parseRetentionDays(env.RENDER_RETENTION_DAYS),
    llmCacheTtlHours: parseCacheTtlHours(env.LLM_CACHE_TTL_HOURS),
  };
}
