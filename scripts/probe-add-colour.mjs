import puppeteer from 'puppeteer-core';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new', protocolTimeout: 120000, args: ['--no-sandbox']
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 1000, deviceScaleFactor: 1 });
async function setValue(placeholder, text) {
  return page.evaluate((ph, value) => {
    const el = document.querySelector(`input[placeholder="${ph}"], textarea[placeholder="${ph}"]`);
    if (!el) return false;
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }, placeholder, text);
}
async function clickText(label) {
  return page.evaluate((wanted) => {
    const nodes = [...document.querySelectorAll('div,span,button')].filter((el) => el.textContent.trim() === wanted);
    const el = nodes[nodes.length - 1];
    if (!el) return false;
    (el.closest('[role="button"],button') || el).click();
    return true;
  }, label);
}
async function waitText(needle, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const body = (await page.evaluate(() => document.body.innerText)).toLowerCase();
    if (body.includes(needle.toLowerCase())) return true;
    await sleep(300);
  }
  return false;
}
await page.goto('http://localhost:8081/materials', { waitUntil: 'networkidle2' });
await sleep(3000);
await page.screenshot({ path: '/tmp/materials-before.png' });
console.log('add button:', await clickText('Add colour'));
await sleep(1200);
await page.screenshot({ path: '/tmp/materials-sheet.png' });
console.log('name:', await setValue('e.g. Teak Natural', 'Teak Natural'));
console.log('kind veneer:', await clickText('veneer'));
console.log('hex:', await setValue('#A65E22', '#B08A63'));
console.log('image:', await setValue('/media/tex-walnut.jpg', '/media/tex-walnut.jpg'));
console.log('rate:', await setValue('1240', '1350'));
console.log('sku:', await setValue('GW-WAL-06', 'GW-TEK-01'));
await page.screenshot({ path: '/tmp/materials-filled.png' });
console.log('save:', await clickText('Save colour'));
const added = await waitText('teak natural', 20000);
console.log('appears in grid:', added);
await page.screenshot({ path: '/tmp/materials-after.png' });
const materials = await (await fetch('http://localhost:8787/api/materials')).json();
console.log('materials in api:', materials.length, '| new:', JSON.stringify(materials.find((m) => m.sku === 'GW-TEK-01')));
await browser.close();
