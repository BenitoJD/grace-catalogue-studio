'use strict';

/**
 * PDF and page image engine for the desktop app.
 *
 * The studio was designed around WeasyPrint, which needs Python and native
 * libraries that are unreasonable to install on a front desk Windows machine.
 * Electron already ships Chromium, so the desktop build prints through that.
 * The API process asks this module for the PDF and the page PNGs and never
 * touches WeasyPrint or poppler.
 */

const fs = require('node:fs');
const path = require('node:path');
const { BrowserWindow } = require('electron');

// A4 with 3 mm bleed, in CSS pixels at 96 dpi.
const PAGE_WIDTH_MM = 216;
const PAGE_HEIGHT_MM = 303;
const CSS_PX_PER_MM = 96 / 25.4;
const CONTENT_WIDTH = Math.ceil(PAGE_WIDTH_MM * CSS_PX_PER_MM) + 1;
const CONTENT_HEIGHT = Math.ceil(PAGE_HEIGHT_MM * CSS_PX_PER_MM) + 1;

const HIDE_PAGES_CSS = `
  body { margin: 0 !important; }
  body > .page { display: none !important; }
  @media print {
    html, body { margin: 0 !important; }
    body > .page { display: block !important; page-break-after: always; }
  }
`;

function log(message) {
  console.log(`[grace-studio/pdf] ${message}`);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function settle(window) {
  await window.webContents.executeJavaScript(
    'Promise.all([document.fonts ? document.fonts.ready : Promise.resolve(), new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))]).then(() => true)',
  );
  await wait(120);
}

async function openDocument(builtFile) {
  const window = new BrowserWindow({
    show: false,
    width: CONTENT_WIDTH,
    height: CONTENT_HEIGHT,
    useContentSize: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });
  window.setContentSize(CONTENT_WIDTH, CONTENT_HEIGHT);
  await window.loadFile(builtFile);
  await settle(window);
  return window;
}

async function pageCount(window) {
  return window.webContents.executeJavaScript("document.querySelectorAll('body > .page').length");
}

async function showPage(window, number) {
  await window.webContents.executeJavaScript(`
    (() => {
      const style = document.getElementById('__grace_single_page__') || document.createElement('style');
      style.id = '__grace_single_page__';
      style.textContent = ${JSON.stringify(HIDE_PAGES_CSS)} + "body > .page { display: none !important; } body > .page:nth-of-type(" + ${JSON.stringify(number)} + ") { display: block !important; }";
      document.head.appendChild(style);
      return true;
    })()
  `);
  await settle(window);
}

async function capture(window) {
  const image = await window.webContents.capturePage();
  return image.resize({ width: Math.ceil(PAGE_WIDTH_MM * CSS_PX_PER_MM), height: Math.ceil(PAGE_HEIGHT_MM * CSS_PX_PER_MM) });
}

function createPdfEngine() {
  let tail = Promise.resolve();

  function enqueue(task) {
    const result = tail.then(task);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  return {
    /** Print the built HTML to PDF and return the page count. */
    render({ builtFile, pdfPath }) {
      return enqueue(async () => {
        const window = await openDocument(builtFile);
        try {
          const pages = await pageCount(window);
          if (pages < 1) throw new Error('The generated document has no pages.');
          const pdf = await window.webContents.printToPDF({
            // The templates declare `@page { size: 216mm 303mm }`, so let
            // Chromium honour that instead of a synthetic page size.
            preferCSSPageSize: true,
            margins: { marginType: 'none' },
            printBackground: true,
          });
          fs.writeFileSync(pdfPath, pdf);
          log(`printed ${pages} pages`);
          return pages;
        } finally {
          window.destroy();
        }
      });
    },

    /** Write one PNG per page so the app can show page previews. */
    raster({ builtFile, renderId, rendersDir, pageCount: pages }) {
      return enqueue(async () => {
        const window = await openDocument(builtFile);
        try {
          for (let index = 1; index <= pages; index += 1) {
            await showPage(window, index);
            const image = await capture(window);
            fs.writeFileSync(path.join(rendersDir, `${renderId}-${index}.png`), image.toPNG());
          }
          log(`rastered ${pages} pages`);
        } finally {
          window.destroy();
        }
      });
    },

    /** Thumbnail of page one for the design gallery. */
    preview({ builtFile, outPng }) {
      return enqueue(async () => {
        const window = await openDocument(builtFile);
        try {
          await showPage(window, 1);
          const image = await capture(window);
          fs.writeFileSync(outPng, image.toPNG());
        } finally {
          window.destroy();
        }
      });
    },
  };
}

module.exports = { createPdfEngine };
