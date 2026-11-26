import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PAGE,
  columnX,
  fitCopy,
  layoutStudioBook,
  lineCapacity,
  spanWidth,
} from '../src/layout-engine.mjs';

const boxesOf = (page) => {
  const boxes = [];
  for (const match of page.matchAll(/style="([^"]*)"/g)) {
    const style = match[1];
    if (!/position\s*:\s*absolute/.test(style)) continue;
    const left = /(?:^|;)\s*left\s*:\s*([0-9.]+)mm/.exec(style);
    const top = /(?:^|;)\s*top\s*:\s*([0-9.]+)mm/.exec(style);
    const width = /(?:^|;)\s*width\s*:\s*([0-9.]+)mm/.exec(style);
    const height = /(?:^|;)\s*height\s*:\s*([0-9.]+)mm/.exec(style);
    if (!left || !top || !width) continue;
    if (Number(width[1]) < 6) continue;
    if (Number(top[1]) > 270) continue;
    boxes.push({
      x: Number(left[1]),
      y: Number(top[1]),
      w: Number(width[1]),
      h: height ? Number(height[1]) : 8,
    });
  }
  return boxes;
};

const book = () =>
  layoutStudioBook({
    order: { title: 'Wardrobe', room: 'Master Bedroom' },
    copy: {
      headline: 'A quiet wardrobe in warm oak',
      body: 'Cream shutters run to the ceiling while walnut frames each opening. The interior is white laminate, the handles are brushed brass, and the window seat folds the light back into the room. '.repeat(8),
      closing: 'Thank you for letting us build your rooms in colour.',
    },
    photos: ['{{photo1}}', '{{photo2}}', '{{photo3}}'],
    photoPalettes: {
      photo1: ['#F8F2E7', '#C9B996', '#794617', '#1AA3C8'],
      photo2: ['#EDE5C8', '#AC9B84', '#5C3A21', '#B98A55'],
      photo3: ['#F2EEE6', '#D4C7B2', '#3B3A36', '#9C6B43'],
    },
    pictureAnalysis: [{ summary: 'Wardrobe wall' }, { summary: 'Window seat' }, { summary: 'Vanity' }],
  });

test('the layout engine composes a complete book from content alone', () => {
  const pages = book();
  assert.ok(pages.length >= 5, `expected at least five pages, got ${pages.length}`);
  for (const page of pages) assert.match(page, /class="page"/);
  const all = pages.join('\n');
  assert.match(all, /<img src="\{\{photo1\}\}"/);
  assert.match(all, /<img src="\{\{photo3\}\}"/);
  assert.match(all, /\{\{headline\}\}/);
  assert.match(all, /\{\{closing\}\}/);
});

test('every laid out block sits inside the live area', () => {
  for (const page of book()) {
    for (const box of boxesOf(page)) {
      assert.ok(box.x >= PAGE.liveLeft - 0.01, `left ${box.x} outside live area`);
      assert.ok(box.x + box.w <= PAGE.liveLeft + PAGE.liveWidth + 0.5, `right ${box.x + box.w} outside live area`);
      assert.ok(box.y >= PAGE.liveTop - 0.01, `top ${box.y} outside live area`);
      assert.ok(box.y + box.h <= PAGE.height - 6, `bottom ${box.y + box.h} outside live area`);
    }
  }
});

test('no two blocks in the laid out pages overlap', () => {
  for (const [index, page] of book().entries()) {
    const boxes = boxesOf(page);
    for (let a = 0; a < boxes.length; a += 1) {
      for (let b = a + 1; b < boxes.length; b += 1) {
        const one = boxes[a];
        const two = boxes[b];
        const overlapX = Math.min(one.x + one.w, two.x + two.w) - Math.max(one.x, two.x);
        const overlapY = Math.min(one.y + one.h, two.y + two.h) - Math.max(one.y, two.y);
        assert.ok(
          overlapX <= 1 || overlapY <= 1,
          `page ${index + 1}: boxes overlap by ${overlapX.toFixed(1)} x ${overlapY.toFixed(1)} mm`,
        );
      }
    }
  }
});

test('copy is measured so no chunk can overflow its column', () => {
  const width = spanWidth(6);
  const capacity = lineCapacity(width, 9.2) * 24;
  const chunks = fitCopy('word '.repeat(4000), { widthMm: width, fontPt: 9.2, maxLines: 24 });
  for (const chunk of chunks) assert.ok(chunk.length <= capacity);
  assert.equal(chunks.join(' ').split(/\s+/).length, 4000);
});

test('column geometry stays on the 12 column grid', () => {
  for (let column = 1; column <= 12; column += 1) {
    assert.ok(Math.abs(columnX(column) - (21 + (column - 1) * (PAGE.column + PAGE.gutter))) < 0.01);
  }
  assert.ok(Math.abs(columnX(12) + PAGE.column - 195) < 0.05);
});
