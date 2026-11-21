import puppeteer from 'puppeteer-core';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const API = 'http://localhost:8787';
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--no-sandbox'], protocolTimeout: 240000 });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 1100 });
async function waitText(needle, timeout = 180000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const body = (await page.evaluate(() => document.body.innerText)).toLowerCase();
    if (body.includes(needle.toLowerCase())) return true;
    await sleep(400);
  }
  return false;
}
async function clickAria(label) {
  return page.evaluate((wanted) => {
    const el = document.querySelector(`[aria-label="${wanted}"]`);
    if (!el) return false;
    el.click();
    return true;
  }, label);
}
async function setInput(text) {
  return page.evaluate((value) => {
    const el = document.querySelector('textarea[placeholder="Paste the customer\'s requirement"], textarea[placeholder="Paste the next customer\'s requirement"]');
    if (!el) return false;
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }, text);
}
const before = (await (await fetch(`${API}/api/orders`)).json()).length;
await page.goto('http://localhost:8081/', { waitUntil: 'networkidle2' });
await sleep(4000);
const attach = await page.$('[aria-label="Attach files"]');
const box = await attach.boundingBox();
const chooserPromise = page.waitForFileChooser({ timeout: 15000 });
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
const chooser = await chooserPromise;
await chooser.accept(['/tmp/net-images/closet-1.jpg', '/tmp/net-images/closet-2.jpg', '/tmp/net-images/room-1.jpg']);
console.log('images attached:', await waitText('room-1.jpg', 40000));
await page.screenshot({ path: '/tmp/demo-attached.png' });
await setInput('Customer name Ravi Kumar. Guest bedroom wardrobe, 2400 wide, 2100 high, 600 deep, three shutters. The three attached photos are from the room, use them in the brochure.');
await clickAria('Send message');
const created = await waitText('is created and the brochure is ready', 240000);
console.log('brochure created:', created);
await sleep(4000);
await page.screenshot({ path: '/tmp/demo-created.png' });
const orders = await (await fetch(`${API}/api/orders`)).json();
const order = orders[0];
const detail = await (await fetch(`${API}/api/orders/${order.id}`)).json();
const renders = await (await fetch(`${API}/api/renders`)).json();
const render = renders.filter((r) => r.orderId === order.id && r.kind === 'voucher').sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
console.log(JSON.stringify({ newOrders: orders.length - before, orderNo: order.orderNo, id: order.id, attachments: detail.attachments?.map((f) => f.name), renderId: render?.id, pdf: render?.pdfUrl }, null, 1));
await browser.close();
