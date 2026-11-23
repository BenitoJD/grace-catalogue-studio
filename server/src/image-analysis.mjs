// Reads a client photograph before the brochure is designed and proposes the
// details worth magnifying. It finds the busiest, most distinctive areas of
// the picture and returns each one as a circle centre plus a palette, so the
// chat can show the picture back with numbered circles and ask what to magnify.
import path from 'node:path';
import { colourName, decodeImageFile, photoPalette } from './image-palette.mjs';

const GRID = 8;
const DETAILS = 3;

function luminance([r, g, b]) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function distance(a, b) {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

/**
 * Three detail candidates for one photograph, ordered by interest. Interest
 * combines local edge energy with how far the area's colour sits from the
 * picture's average, which is what a person points at in a room photograph:
 * a handle, a window reveal, a change of material.
 */
export function analyseImage(filePath) {
  const decoded = decodeImageFile(filePath);
  if (!decoded) return null;
  const { width, height, pixels } = decoded;

  const cells = Array.from({ length: GRID * GRID }, () => []);
  for (const pixel of pixels) {
    // The decoder samples evenly, so index maps linearly onto the image.
  }
  // Walk the sampled pixel list back through the full frame.
  const columns = Math.max(1, Math.round(Math.sqrt((pixels.length * width) / height)));
  const rows = Math.max(1, Math.round(pixels.length / columns));
  const globalMean = pixels.reduce(
    (acc, pixel) => [acc[0] + pixel[0], acc[1] + pixel[1], acc[2] + pixel[2]],
    [0, 0, 0],
  ).map((value) => value / Math.max(1, pixels.length));

  pixels.forEach((pixel, index) => {
    const gx = Math.min(GRID - 1, Math.floor(((index % columns) / columns) * GRID));
    const gy = Math.min(GRID - 1, Math.floor((Math.floor(index / columns) / rows) * GRID));
    const cell = cells[gy * GRID + gx];
    cell.push({ pixel, index });
  });

  const scored = cells.map((cell, cellIndex) => {
    if (cell.length === 0) return { score: -1, cellIndex };
    const mean = cell.reduce(
      (acc, entry) => [acc[0] + entry.pixel[0], acc[1] + entry.pixel[1], acc[2] + entry.pixel[2]],
      [0, 0, 0],
    ).map((value) => value / cell.length);
    // Edge energy: how much neighbouring sampled pixels differ in brightness.
    let energy = 0;
    for (let step = 1; step < cell.length; step += 1) {
      energy += Math.abs(luminance(cell[step].pixel) - luminance(cell[step - 1].pixel));
    }
    energy /= Math.max(1, cell.length - 1);
    const distinct = distance(mean, globalMean);
    return { score: energy * 1.6 + distinct, cellIndex, mean };
  });

  scored.sort((a, b) => b.score - a.score);
  const chosen = [];
  for (const candidate of scored) {
    if (candidate.score < 0) continue;
    const gx = candidate.cellIndex % GRID;
    const gy = Math.floor(candidate.cellIndex / GRID);
    const tooClose = chosen.some(([cx, cy]) => Math.abs(cx - gx) <= 1 && Math.abs(cy - gy) <= 1);
    if (tooClose) continue;
    chosen.push([gx, gy]);
    if (chosen.length === DETAILS) break;
  }

  // A flat picture, such as a colour chip upload, offers no busy areas. The
  // review still needs circles to offer, so spread a few across the frame.
  const fallback = [
    [30, 32],
    [68, 46],
    [48, 72],
  ];
  for (const [fx, fy] of fallback) {
    if (chosen.length >= DETAILS) break;
    const gx = Math.min(GRID - 1, Math.floor((fx / 100) * GRID));
    const gy = Math.min(GRID - 1, Math.floor((fy / 100) * GRID));
    if (chosen.some(([cx, cy]) => Math.abs(cx - gx) <= 1 && Math.abs(cy - gy) <= 1)) continue;
    chosen.push([gx, gy]);
  }

  // The colour of the magnified area itself, named like a paint chip. This is
  // what the loupe label says, so the client knows what they are looking at.
  const candidateDetails = chosen.map(([gx, gy], index) => {
    const cell = cells[gy * GRID + gx] ?? [];
    let hex = '#000000';
    if (cell.length > 0) {
      const mean = cell.reduce(
        (acc, entry) => [acc[0] + entry.pixel[0], acc[1] + entry.pixel[1], acc[2] + entry.pixel[2]],
        [0, 0, 0],
      ).map((value) => Math.round(value / cell.length));
      hex = `#${mean.map((value) => value.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
    }
    return {
      id: `detail-${index + 1}`,
      label: `Detail ${index + 1}`,
      x: Math.round(((gx + 0.5) / GRID) * 100),
      y: Math.round(((gy + 0.5) / GRID) * 100),
      hex,
      name: colourName(hex),
    };
  });

  const palette = photoPalette(filePath) ?? [];
  return {
    width,
    height,
    orientation: width >= height ? 'landscape' : 'portrait',
    palette: palette.map((hex) => ({ hex, name: colourName(hex) })),
    candidates: candidateDetails,
  };
}

/** Analysis for a list of app media paths such as /media/abc.jpg. */
export function analyseMediaFiles(urls, mediaDir) {
  return urls.map((url) => {
    const name = path.basename(String(url ?? ''));
    return {
      url,
      name,
      analysis: analyseImage(path.join(mediaDir, name)),
    };
  });
}
