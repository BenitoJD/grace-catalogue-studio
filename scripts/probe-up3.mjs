import puppeteer from 'puppeteer-core';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 1000 });
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
await sleep(5000);
const result = await page.evaluate(() => {
  const sources = [];
  for (const element of document.querySelectorAll("img,div")) {
    const source = element.tagName === "IMG" ? element.src : getComputedStyle(element).backgroundImage || "";
    if (source.includes("/media/")) sources.push(source);
  }
  const predicate = [...document.querySelectorAll("img,div")].some((element) => {
    const source = element.tagName === "IMG" ? element.src : getComputedStyle(element).backgroundImage || "";
    return /\/media\/[0-9a-f-]{36}\.(jpg|jpeg|png|webp)/.test(source);
  });
  return { predicate, sources: sources.slice(-4) };
});
console.log(JSON.stringify(result, null, 1));
await browser.close();
