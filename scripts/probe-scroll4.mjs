import puppeteer from 'puppeteer-core';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844 });
async function scrollers() {
  return page.evaluate(() => [...document.querySelectorAll('*')].filter((el) => {
    const s = getComputedStyle(el);
    return /(auto|scroll)/.test(s.overflowY);
  }).map((el) => ({ sh: el.scrollHeight, ch: el.clientHeight, top: el.scrollTop })).filter((s) => s.ch > 100));
}
await page.goto('http://localhost:8081/', { waitUntil: 'networkidle2' });
await sleep(2500);
console.log('chat scrollers', JSON.stringify(await scrollers()));
await page.goto('http://localhost:8081/materials', { waitUntil: 'networkidle2' });
await sleep(2500);
await page.evaluate(() => {
  const nodes = [...document.querySelectorAll('div,span,button')].filter((el) => el.textContent.trim() === 'Add colour');
  (nodes[nodes.length - 1].closest('[role="button"],button') || nodes[nodes.length - 1]).click();
});
await sleep(1200);
console.log('modal scrollers', JSON.stringify(await scrollers()));
// scroll the modal and confirm the save button becomes visible
const moved = await page.evaluate(() => {
  const el = [...document.querySelectorAll('*')].find((n) => {
    const s = getComputedStyle(n);
    return /(auto|scroll)/.test(s.overflowY) && n.scrollHeight > n.clientHeight + 20;
  });
  if (!el) return null;
  el.scrollTop = el.scrollHeight;
  return el.scrollTop;
});
await sleep(400);
const saveVisible = await page.evaluate(() => {
  const el = [...document.querySelectorAll('*')].find((n) => n.textContent.trim() === 'Save colour');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.top >= 0 && r.bottom <= window.innerHeight;
});
console.log('modal moved', moved, 'save visible after scroll', saveVisible);
await browser.close();
