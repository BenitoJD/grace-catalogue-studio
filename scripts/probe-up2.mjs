import puppeteer from 'puppeteer-core';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 200)); });
await page.setViewport({ width: 1100, height: 950 });
await page.goto('http://localhost:8081/materials', { waitUntil: 'networkidle2' });
await sleep(2500);
await page.evaluate(() => {
  const nodes = [...document.querySelectorAll('div,span,button')].filter((el) => el.textContent.trim() === 'Add colour');
  (nodes[nodes.length - 1].closest('[role="button"],button') || nodes[nodes.length - 1]).click();
});
await sleep(1000);
const uploadButton = await page.$('[aria-label="Upload image"]');
const box = await uploadButton.boundingBox();
const chooserPromise = page.waitForFileChooser({ timeout: 15000 });
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
const chooser = await chooserPromise;
await chooser.accept(['/Users/benito/Desktop/Dovetail/templates/assets/company/tex-cream.jpg']);
await sleep(6000);
const info = await page.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll('img,div')) {
    const bg = getComputedStyle(el).backgroundImage || '';
    if ((el.tagName === 'IMG' && el.src.includes('/media/')) || bg.includes('/media/')) {
      out.push({ tag: el.tagName, src: el.src?.slice(-50), bg: bg.slice(-60) });
    }
  }
  return out;
});
console.log('media elements:', JSON.stringify(info));
const text = await page.evaluate(() => document.body.innerText);
console.log('error text:', text.includes('could not be uploaded') ? 'upload error shown' : 'no upload error');
await page.screenshot({ path: '/tmp/upload-probe.png' });
await browser.close();
