// Render retention. Renders are useful for a few weeks, then they are just
// disk usage: the PDF, the page images and the database row are removed once
// they are older than RENDER_RETENTION_DAYS. Orphaned page images (files with
// no render row, for example left behind by a crash) are removed as well.
//
// The sweep is exported so tests and operators can run it directly, and the
// server entry point calls it on boot and then every 24 hours.

import { existsSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

import { DEFAULT_RENDER_RETENTION_DAYS, parseRetentionDays } from './config.mjs';

export const DAY_MS = 24 * 60 * 60 * 1000;
export const RETENTION_INTERVAL_MS = DAY_MS;

const PAGE_IMAGE = /^(.+)-\d+\.png$/;
const PDF_FILE = /^(.+)\.pdf$/;

function normaliseOptions(options) {
  if (options === undefined || options === null) return {};
  if (typeof options === 'string') return { dataDir: options };
  return options;
}

function resolveRendersDir(options) {
  if (typeof options.rendersDir === 'string' && options.rendersDir !== '') {
    return path.resolve(options.rendersDir);
  }
  if (typeof options.dataDir === 'string' && options.dataDir !== '') {
    return path.join(path.resolve(options.dataDir), 'renders');
  }
  return null;
}

function listFiles(directory) {
  if (!directory || !existsSync(directory)) return [];
  try {
    return readdirSync(directory);
  } catch {
    return [];
  }
}

/**
 * Delete every render older than the retention window, plus orphaned page
 * images. Returns a summary and never throws for individual file failures.
 *
 * Accepted call shapes:
 *   sweepRenders(db, { dataDir, retentionDays, now, protectedRenderIds })
 *   sweepRenders(db, dataDir)
 *   sweepRenders({ db, dataDir, retentionDays })
 *
 * `retentionDays: 0` means keep renders forever and makes the sweep a no-op.
 * `protectedRenderIds` keeps files belonging to renders that are still being
 * written by the process.
 */
export function sweepRenders(dbOrOptions, maybeOptions) {
  let db;
  let rawOptions;
  if (dbOrOptions && typeof dbOrOptions.prepare === 'function') {
    db = dbOrOptions;
    rawOptions = maybeOptions;
  } else {
    rawOptions = dbOrOptions;
    db = rawOptions?.db;
  }
  const options = normaliseOptions(rawOptions);
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('sweepRenders needs an open SQLite database as the first argument.');
  }

  const retentionDays = parseRetentionDays(
    options.retentionDays ?? process.env.RENDER_RETENTION_DAYS,
    DEFAULT_RENDER_RETENTION_DAYS,
  );
  const rendersDir = resolveRendersDir(options);
  const result = {
    retentionDays,
    skipped: retentionDays === 0,
    cutoff: null,
    deletedRenders: 0,
    deletedRenderIds: [],
    deletedFiles: 0,
    deletedOrphanPages: 0,
    keptRenders: 0,
  };

  const rows = db.prepare('SELECT id, createdAt FROM renders').all();
  if (retentionDays === 0) {
    result.keptRenders = rows.length;
    return result;
  }

  const nowValue = options.now ?? new Date();
  const nowMs = nowValue instanceof Date ? nowValue.getTime() : Number(nowValue);
  const referenceMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const cutoffMs = referenceMs - retentionDays * DAY_MS;
  result.cutoff = new Date(cutoffMs).toISOString();

  const expired = [];
  for (const row of rows) {
    const createdMs = Date.parse(String(row.createdAt ?? ''));
    if (Number.isFinite(createdMs) && createdMs < cutoffMs) expired.push(row.id);
  }

  if (expired.length > 0) {
    const remove = db.prepare('DELETE FROM renders WHERE id = ?');
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const renderId of expired) remove.run(renderId);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  const protectedIds = new Set(options.protectedRenderIds ?? []);
  const liveRows = db.prepare('SELECT id FROM renders').all();
  const liveIds = new Set(liveRows.map((row) => row.id));
  result.keptRenders = liveIds.size;
  result.deletedRenderIds = expired;
  result.deletedRenders = expired.length;

  const expiredIds = new Set(expired);
  const files = listFiles(rendersDir);
  if (files.length === 0) return result;

  for (const name of files) {
    const pageMatch = PAGE_IMAGE.exec(name);
    const pdfMatch = pageMatch ? null : PDF_FILE.exec(name);
    const ownerId = pageMatch ? pageMatch[1] : pdfMatch ? pdfMatch[1] : null;
    if (!ownerId) continue;

    const ownedByExpiredRender = expiredIds.has(ownerId);
    const orphanedPage = Boolean(pageMatch) && !liveIds.has(ownerId) && !protectedIds.has(ownerId);
    if (!ownedByExpiredRender && !orphanedPage) continue;

    try {
      rmSync(path.join(rendersDir, name), { force: true });
      if (ownedByExpiredRender) result.deletedFiles += 1;
      else result.deletedOrphanPages += 1;
    } catch {
      // Best effort: a locked file is retried by the next sweep.
    }
  }

  return result;
}

/**
 * Run the sweep and swallow errors. Used by the entry point on a timer: a
 * failed sweep must never take the API down.
 */
export function runRetentionSweep(db, options = {}) {
  try {
    return { ok: true, ...sweepRenders(db, options) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

