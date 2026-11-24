import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";
const WEB = process.env.WEB;
const browser = await puppeteer.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: "new", args: ["--no-sandbox", "--disable-gpu"] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
await page.goto(`http://jacob-studio.localhost:${WEB}/`, { waitUntil: "networkidle2" });
await new Promise((r) => setTimeout(r, 4000));
const attach = await page.$('[aria-label="Attach files"]');
const box = await attach.boundingBox();
const chooserPromise = page.waitForFileChooser({ timeout: 20000 });
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
const chooser = await chooserPromise;
await chooser.accept([
  "/Users/benito/Downloads/Mrs.MEENA TV UNIT DESIGN CRCT.pdf",
  "/Users/benito/Downloads/Mr.SEBASTIN LIVING CUM DINING.pdf",
  "/Users/benito/Downloads/Mr.SAJIN KITCHEN & LIVING INTERIOR.pdf",
  "/Users/benito/Downloads/Mrs.MEENA GF MASTER BEDROOM.pdf",
]);
await new Promise((r) => setTimeout(r, 20000));
const tray = await page.evaluate(() => document.body.innerText.slice(-400));
writeFileSync("/tmp/realpdf-status.txt", `tray after upload:\n${tray}\n`);
const input = 'textarea[placeholder="Paste the customer\'s requirement"]';
await page.click(input);
await page.type(input, "The customer is Meena. Create one showroom brochure from these four project sheets. Use every page, read the real colours from each sheet, and magnify the best interior detail on each project.");
await page.click('[aria-label="Send message"]');
let pages = 0;
for (let i = 0; i < 560; i += 1) {
  await new Promise((r) => setTimeout(r, 3000));
  pages = await page.evaluate(() => [...document.querySelectorAll("img")].filter((image) => image.src.includes("/pages/")).length);
  if (pages > 0) break;
  if (i % 60 === 0) writeFileSync("/tmp/realpdf-status.txt", `waiting ${i * 3}s pages=${pages}\n`);
}
const final = await page.evaluate(() => ({
  text: document.body.innerText.slice(-1600),
  orderNo: (document.body.innerText.match(/JDS-\d{4}-\d{3}/) || [null])[0],
}));
writeFileSync("/tmp/realpdf-status.txt", `pages=${pages} order=${final.orderNo}\n${final.text}\n`);
await page.screenshot({ path: "/tmp/realpdf-final.png", fullPage: false });
await browser.close().catch(() => {});
