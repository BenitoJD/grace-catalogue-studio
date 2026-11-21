// Drives the real web app in Chrome and behaves like a person using it.
// Run with: node scripts/e2e.mjs
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import puppeteer from "puppeteer-core";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const API = "http://localhost:8787";
const WEB = "http://localhost:8081";
const root = new URL("..", import.meta.url).pathname;
const dbFile = `${root}data/e2e.db`;
const shots = `${root}docs/screenshots/e2e`;
mkdirSync(shots, { recursive: true });
if (existsSync(dbFile)) rmSync(dbFile);

let failures = 0;
const results = [];
function check(label, ok, detail = "") {
  results.push({ label, ok, detail });
  if (!ok) failures += 1;
  process.stdout.write(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `  (${detail})` : ""}\n`);
}

function startProcess(command, args, env = {}) {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (c) => (output += c));
  child.stderr.on("data", (c) => (output += c));
  return { child, dump: () => output };
}

async function waitFor(url, attempts = 80) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {}
    await sleep(250);
  }
  return false;
}

// helpers that work with react-native-web output
function textNodes() {
  return [...document.querySelectorAll("div,span,a,button,p")];
}

async function hasText(page, text, timeout = 8000) {
  try {
    await page.waitForFunction(
      (needle) => document.body.innerText.includes(needle),
      { timeout },
      text
    );
    return true;
  } catch {
    return false;
  }
}

async function waitForBodyText(page, needle, timeout = 30000) {
  const deadline = Date.now() + timeout;
  const wanted = needle.toLowerCase();
  while (Date.now() < deadline) {
    const text = (await page.evaluate(() => document.body.innerText)).toLowerCase();
    if (text.includes(wanted)) return true;
    await sleep(400);
  }
  return false;
}

async function clickText(page, text) {
  const clicked = await page.evaluate((needle) => {
    const nodes = [...document.querySelectorAll("div,span,a,button")].filter(
      (el) => el.textContent.trim() === needle
    );
    const target = nodes[nodes.length - 1];
    if (!target) return false;
    const actionable = target.closest('[role="button"],button') ?? target;
    actionable.click();
    return true;
  }, text);
  if (clicked) await sleep(350);
  return clicked;
}

async function setValueByPlaceholder(page, placeholder, value) {
  return page.evaluate(
    (needle, next) => {
      const element = document.querySelector(`[placeholder="${needle}"]`);
      if (!element) return false;
      const prototype =
        element.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value").set;
      setter.call(element, next);
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    },
    placeholder,
    value
  );
}

async function fillByPlaceholder(page, placeholder, value) {
  const handle = await page.$(`[placeholder="${placeholder}"]`);
  if (!handle) return false;
  await handle.click();
  const replaced = await page.evaluate(
    (needle, next) => {
      const element = document.querySelector(`[placeholder="${needle}"]`);
      if (!element) return false;
      const prototype =
        element.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value").set;
      setter.call(element, next);
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    },
    placeholder,
    value
  );
  return replaced;
}

import { spawnSync } from "node:child_process";
const seeded = spawnSync("node", ["server/src/seed.mjs"], {
  cwd: root,
  env: { ...process.env, CATALOG_DB: dbFile },
  encoding: "utf8"
});
if (seeded.status !== 0) {
  console.error("seed failed", seeded.stderr);
  process.exit(1);
}

const api = startProcess("node", ["server/src/index.mjs"], {
  PORT: "8787",
  CATALOG_DB: dbFile,
  // The suite drives a whole browser and uploads many page images from one IP.
  RATE_LIMIT_PER_MIN: "100000",
  RENDER_LIMIT_PER_MIN: "10000",
  NOTE_LIMIT_PER_MIN: "10000"
});
const web = startProcess("node", ["scripts/serve-web.mjs", "8081"]);
const mock = startProcess("node", ["scripts/mock-llm.mjs", "8793"]);
let browser;

try {
  const apiUp = await waitFor(`${API}/health`);
  const webUp = await waitFor(WEB);
  check("api reachable", apiUp, apiUp ? "" : api.dump().slice(-300));
  check("web build served", webUp, webUp ? "" : web.dump().slice(-300));
  if (!apiUp || !webUp) throw new Error("servers did not start");

  // seed a customer so the order flow can pick one
  await fetch(`${API}/api/customers`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Anitha Selvam", phone: "98430 12001", address: "Vadasery" })
  });

  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    protocolTimeout: 240000,
    args: ["--no-sandbox", "--disable-gpu"]
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(40000);
  page.setDefaultNavigationTimeout(40000);
  await page.setViewport({ width: 1400, height: 1000 });
  const consoleErrors = [];
  page.on("pageerror", (error) => consoleErrors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  // 1. the studio opens on the chat, the order book lives one tab over
  await page.goto(WEB, { waitUntil: "networkidle2" });
  check("chat loads", await hasText(page, "Studio chat"));
  check("chat explains what to paste", await hasText(page, "Paste everything the customer told you"));
  check("chat has a message box", (await page.$('textarea[placeholder="Paste the customer\'s requirement"]')) !== null);
  await page.screenshot({ path: `${shots}/00-chat.png` });

  await page.goto(`${WEB}/orders`, { waitUntil: "networkidle2" });
  check("order book loads", await hasText(page, "Grace Wood"));
  check("seeded orders show", await hasText(page, "GWI-2026-001"));
  check("seeded materials show in api", (await (await fetch(`${API}/api/bootstrap`)).json()).materials.length === 4);
  await page.screenshot({ path: `${shots}/01-orders.png` });

  // 2. create an order like a person
  check("new order button exists", await clickText(page, "New order"));
  check("intake screen opens", await hasText(page, "New order"));
  await page.screenshot({ path: `${shots}/02-new-order.png` });

  check("customer picker shows customer", await clickText(page, "Arun Kumar"));
  check("title field editable", await fillByPlaceholder(page, "Master Bedroom Wardrobe", "E2E Master Wardrobe"));
  check("width field editable", await fillByPlaceholder(page, "2400 mm", "2600 mm"));
  await page.screenshot({ path: `${shots}/03-filled-form.png` });

  check("create order submits", await clickText(page, "Create order"));
  check("detail screen opens", await hasText(page, "E2E Master Wardrobe", 12000));
  const orderNo = await page.evaluate(() => (document.body.innerText.match(/GWI-\d{4}-\d{3}/) ?? [])[0] ?? "");
  check("order number assigned", /^GWI-\d{4}-\d{3}$/.test(orderNo), orderNo);
  check("width saved", await hasText(page, "2600 mm"));
  await page.screenshot({ path: `${shots}/04-order-detail.png` });

  // 3. render the voucher
  check("generate button present", await clickText(page, "Generate voucher"));
  check("render reports four pages", await hasText(page, "4 pages", 60000));
  const previewOk = await page.waitForFunction(
    () => [...document.querySelectorAll("img")].some((image) => image.src.includes("/pages/") && image.naturalWidth > 200),
    { timeout: 60000 }
  ).then(() => true).catch(() => false);
  check("page preview image painted", previewOk);
  await page.screenshot({ path: `${shots}/05-voucher-preview.png` });

  const renderInfo = await (await fetch(`${API}/api/renders`)).json();
  const newest = Array.isArray(renderInfo) ? renderInfo[0] : null;
  check("render recorded in api", Boolean(newest && newest.pageCount === 4));
  if (newest) {
    const pdf = await fetch(`${API}${newest.pdfUrl}`);
    const type = pdf.headers.get("content-type") ?? "";
    const bytes = (await pdf.arrayBuffer()).byteLength;
    check("pdf downloads", pdf.ok && type.includes("pdf") && bytes > 20000, `${type}, ${bytes} bytes`);
  }

  // 3b. the actions around the document
  const rendersBefore = (await (await fetch(`${API}/api/renders`)).json()).length;
  check("open pdf button present", await clickText(page, "Open PDF"));
  await page.evaluate(() => {
    window.__lastOpen = null;
    const original = window.open;
    window.open = (url) => {
      window.__lastOpen = url;
      return null;
    };
    window.__restoreOpen = () => {
      window.open = original;
    };
  });
  await clickText(page, "Open PDF");
  const opened = await page.evaluate(() => window.__lastOpen);
  check("open pdf targets the pdf url", Boolean(opened && opened.includes(".pdf")), String(opened).slice(-40));

  await clickText(page, "Share");
  await sleep(1200);
  const shareFeedback = await page.evaluate(() =>
    ["Link copied", "Voucher link shared", "Sharing is not available", "Sharing cancelled"].some((text) =>
      document.body.innerText.includes(text)
    )
  );
  check("share gives feedback", shareFeedback);

  check("generate again button present", await clickText(page, "Generate voucher again"));
  let rendersAfter = rendersBefore;
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const list = await (await fetch(`${API}/api/renders`)).json();
    rendersAfter = list.length;
    if (rendersAfter > rendersBefore) break;
    await sleep(500);
  }
  check("re-render creates a new document", rendersAfter > rendersBefore, `${rendersBefore} then ${rendersAfter}`);

  // 3c. choose a different cover design and render with it
  check("change design button present", await clickText(page, "Change design"));
  check("design gallery opens", await hasText(page, "Designs", 15000));
  check("thirty designs offered", await hasText(page, "30 designs", 20000));
  const catalog = await (await fetch(`${API}/api/templates`)).json();
  check("design ids are unique", new Set(catalog.map((t) => t.id)).size === catalog.length, `${catalog.length} entries`);
  const families = new Set(catalog.map((t) => t.family ?? t.cover));
  check("at least ten design families", families.size >= 10, `${families.size} families`);
  check("every design has its own preview", new Set(catalog.map((t) => t.previewUrl)).size === catalog.length);
  const previewsLoaded = await page
    .waitForFunction(
      () =>
        [...document.querySelectorAll("img")].filter(
          (image) => image.src.includes("/previews/") && image.naturalWidth > 50
        ).length >= 6,
      { timeout: 25000 }
    )
    .then(() => true)
    .catch(() => false);
  check("design previews load", previewsLoaded);
  await page.screenshot({ path: `${shots}/06-designs.png` });

  const targetDesign = catalog.find((item) => item.id === "swiss-ink") ?? catalog[1];
  check("design can be chosen", await clickText(page, targetDesign.name));
  check("order shows the chosen design", await hasText(page, targetDesign.name, 15000));
  await clickText(page, "Generate voucher again");
  const designed = await page
    .waitForFunction(async () => true, { timeout: 1000 })
    .then(() => true)
    .catch(() => true);
  await sleep(3000);
  const rendersAfterDesign = await (await fetch(`${API}/api/renders`)).json();
  check("render used the chosen design", rendersAfterDesign[0]?.templateId === targetDesign.id, String(rendersAfterDesign[0]?.templateId));

  // 4. back to the order book, the order is there
  await page.goto(`${WEB}/orders`, { waitUntil: "networkidle2" });
  check("order appears in book", await hasText(page, "E2E Master Wardrobe"));
  check("order count updated", await hasText(page, "3 orders"));
  await page.screenshot({ path: `${shots}/06-orders-with-data.png` });

  // 4b. language model settings and a drafted customer note
  const providerUp = await waitFor("http://127.0.0.1:8793/v1/models", 40);
  check("mock model provider is up", providerUp);
  const saved = await fetch(`${API}/api/llm/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint: "http://127.0.0.1:8793/v1", model: "mock-flash", apiKey: "test-key" })
  }).then((response) => response.json());
  check("model settings save", saved.hasKey === true && saved.endpoint.includes("8793"));
  check("api never returns the key", !JSON.stringify(saved).includes("test-key"));

  await page.goto(`${WEB}/settings`, { waitUntil: "networkidle2" });
  await sleep(2000);
  const endpointValue = await page.evaluate(
    () => document.querySelector('input[placeholder="https://provider.example.com/v1"]')?.value ?? ""
  );
  check("settings shows the endpoint", endpointValue.includes("8793"), endpointValue.slice(0, 40));
  check("test connection button present", await clickText(page, "Test connection"));
  const connected = await page
    .waitForFunction(() => document.body.innerText.includes("Connected to"), { timeout: 30000 })
    .then(() => true)
    .catch(() => false);
  check("test connection reports success", connected);
  await page.screenshot({ path: `${shots}/06b-model-settings.png` });

  // 4c. the chat interface: dump the requirement, answer the gap, cook
  await page.goto(WEB, { waitUntil: "networkidle2" });
  await sleep(2500);
  const chatInput = "Paste the customer's requirement";
  await setValueByPlaceholder(
    page,
    chatInput,
    "Need a wardrobe for Anita in the master bedroom, 2400 wide. She wants a loft on top and lighter oak."
  );
  check("chat accepts the dump", await clickText(page, "Send"));
  check("chat asks for the missing details", await waitForBodyText(page, "what is the height", 90000));
  const ordersBeforeChat = (await (await fetch(`${API}/api/orders`)).json()).length;
  await setValueByPlaceholder(page, chatInput, "Height 2100, depth 600, three shutters.");
  check("chat takes the answer", await clickText(page, "Send"));
  const cooked = await waitForBodyText(page, "the brochure is ready", 180000);
  check("chat creates the order on its own", cooked);
  const chatPageOk = await page.evaluate(() =>
    [...document.querySelectorAll("img")].some(
      (image) => image.src.includes("/pages/") && image.naturalWidth > 100
    )
  );
  check("chat shows the first page", chatPageOk);
  const ordersAfterChat = (await (await fetch(`${API}/api/orders`)).json()).length;
  check("one chat made one order", ordersAfterChat === ordersBeforeChat + 1, `${ordersBeforeChat} to ${ordersAfterChat}`);
  await page.screenshot({ path: `${shots}/06g-chat-brochure.png` });

  // The next message belongs to a new order, so the old conversation is cleared.
  await setValueByPlaceholder(page, chatInput, "Another client needs a wardrobe.");
  check("chat takes the next customer", await clickText(page, "Send"));
  const freshChat = await waitForBodyText(page, "what is the height", 90000);
  check("a new chat starts after an order", freshChat);
  const cleared = await page.evaluate(
    () => document.body.innerText.includes("Paste everything the customer told you")
  );
  check("the old conversation is cleared", cleared);

  const noteOrders = await (await fetch(`${API}/api/orders`)).json();
  // The chat flow above created its own order. The note and copy steps belong to
  // the order this run created, so pick it by title rather than by newest.
  const noteOrder = noteOrders.find((order) => order.title === "E2E Master Wardrobe") ?? noteOrders[0];
  const noteOrderId = noteOrder.id;
  await page.goto(`${WEB}/orders/${noteOrderId}`, { waitUntil: "networkidle2" });
  await sleep(2500);
  check("draft note button present", await clickText(page, "Draft customer note"));
  const noteShown = await waitForBodyText(page, "three shutters in warm oak", 45000);
  check("drafted note appears", noteShown);
  check("copy note button present", await clickText(page, "Copy note"));
  await sleep(600);
  const copied = await page.evaluate(() =>
    document.body.innerText.includes("copied") || document.body.innerText.includes("Could not copy")
  );
  check("copy gives feedback", copied);
  await page.screenshot({ path: `${shots}/06c-customer-note.png` });

  // 4c. the model writes the brochure body, and the voucher picks it up
  await page.goto(`${WEB}/orders/${noteOrderId}`, { waitUntil: "networkidle2" });
  await sleep(2500);
  await sleep(2500);
  check(
    "brief field present",
    await setValueByPlaceholder(
      page,
      "Anything the customer added, changed or dropped",
      "Client wants extra loft storage and a lighter oak for the shutters."
    )
  );
  check("write copy button present", await clickText(page, "Write the brochure copy"));
  await sleep(2000);
  const storedOrder = await (await fetch(`${API}/api/orders/${noteOrderId}`)).json();
  check(
    "server stored the copy",
    Boolean(storedOrder.copy && storedOrder.copy.headline),
    JSON.stringify(storedOrder.copy ? Object.keys(storedOrder.copy) : storedOrder.copy)
  );

  const copyReady = await page
    .waitForFunction(() => document.body.innerText.includes("Write it again"), { timeout: 45000 })
    .then(() => true)
    .catch(() => false);
  const copyText = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, " ").toLowerCase();
  check("generated headline appears", copyReady && copyText.includes("built to the millimetre"));
  check("generated body appears", copyText.includes("white laminate keeps the interior bright"));
  await page.screenshot({ path: `${shots}/06d-brochure-copy.png` });

  check("generate voucher after copy", await clickText(page, "Generate voucher again"));
  await sleep(4000);

  // the voucher should have re-rendered with the copy inside the PDF
  let bodyInPdf = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const renders = await (await fetch(`${API}/api/renders`)).json();
    const target = renders.find((item) => item.kind === "voucher");
    if (target) {
      const pdf = Buffer.from(await (await fetch(`${API}${target.pdfUrl}`)).arrayBuffer());
      writeFileSync("/tmp/e2e-copy.pdf", pdf);
      const text = execFileSync("pdftotext", ["/tmp/e2e-copy.pdf", "-"], { encoding: "utf8" }).replace(/\s+/g, " ");
      if (text.includes("millimetre") && text.includes("white laminate keeps")) {
        bodyInPdf = true;
        break;
      }
    }
    await sleep(1000);
  }
  check("brochure body is printed in the voucher", bodyInPdf);

  // 4d. the info kit renders from the same order
  await page.goto(`${WEB}/orders/${noteOrderId}`, { waitUntil: "networkidle2" });
  await sleep(2500);
  check("info kit button present", await clickText(page, "Render info kit"));
  const kitReady = await waitForBodyText(page, "5 pages", 60000);
  check("info kit renders five pages", kitReady);
  const kitImages = await page.evaluate(
    () => [...document.querySelectorAll("img")].filter((image) => image.src.includes("/pages/") && image.naturalWidth > 100).length
  );
  check("info kit page preview loads", kitImages >= 1, `${kitImages} page images`);
  await page.screenshot({ path: `${shots}/06e-info-kit.png` });

  // 5. materials tab
  await page.goto(`${WEB}/materials`, { waitUntil: "networkidle2" });
  check("materials screen opens", await hasText(page, "Materials"));
  const swatchesLoaded = await page.waitForFunction(
    () => [...document.querySelectorAll("img")].filter((i) => i.src.includes("/media/") && i.naturalWidth > 50).length >= 4,
    { timeout: 15000 }
  ).then(() => true).catch(() => false);
  check("material images load", swatchesLoaded);
  const rateShown = await page.evaluate(() => document.body.innerText.includes("per sheet"));
  check("materials show their rates", rateShown);
  check("print rate card button present", await clickText(page, "Print rate card"));
  const rateOpened = await page
    .waitForFunction(() => window.__rateOpen === undefined || true, { timeout: 1000 })
    .then(() => true)
    .catch(() => true);
  await sleep(4000);
  const rateRender = (await (await fetch(`${API}/api/catalogue/templates`)).json()).length;
  check("rate card templates available", rateRender >= 1, `${rateRender} templates`);
  const catalogueRenders = await (await fetch(`${API}/api/renders`)).json();
  check(
    "rate card rendered a document",
    catalogueRenders.some((item) => item.kind === "catalogue" && item.pageCount >= 1)
  );

  // 5b. adding a colour from the studio, the form the workshop asked for
  check("add colour button present", await clickText(page, "Add colour"));
  check("add colour sheet opens", await hasText(page, "Add a colour"));
  check("colour name accepts input", await setValueByPlaceholder(page, "e.g. Teak Natural", "Teak Natural"));
  check("colour code accepts input", await setValueByPlaceholder(page, "#A65E22", "#B08A63"));
  check("colour rate accepts input", await setValueByPlaceholder(page, "1240", "1350"));
  check("colour code accepts a code", await setValueByPlaceholder(page, "GW-WAL-06", "GW-TEK-01"));
  await page.screenshot({ path: `${shots}/06h-add-colour.png` });
  check("colour saves", await clickText(page, "Save colour"));
  const colourAdded = await waitForBodyText(page, "teak natural", 20000);
  check("new colour appears in the grid", colourAdded);
  const materialsAfter = await (await fetch(`${API}/api/materials`)).json();
  check(
    "api stored the new colour with its rate",
    materialsAfter.length === 5 &&
      materialsAfter.some((material) => material.sku === "GW-TEK-01" && material.priceAmount === 1350),
    `${materialsAfter.length} materials`,
  );
  await page.screenshot({ path: `${shots}/06i-colour-added.png` });

  // 6. settings tab
  await page.goto(`${WEB}/settings`, { waitUntil: "networkidle2" });
  check("settings screen opens", await hasText(page, "Settings"));
  check("settings shows api base", await hasText(page, "8787"));

  // 7. deep link straight into an order
  const orders = await (await fetch(`${API}/api/orders`)).json();
  const orderId = orders[0].id;
  await page.goto(`${WEB}/orders/${orderId}`, { waitUntil: "networkidle2" });
  check("deep link to order works", await hasText(page, orders[0].orderNo, 12000));

  // 8. mobile viewport
  const mobile = await browser.newPage();
  await mobile.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await mobile.goto(`${WEB}/orders`, { waitUntil: "networkidle2" });
  await sleep(1500);
  check("mobile renders the order book", await hasText(mobile, "Grace Wood"));
  const tabBar = await mobile.evaluate(() => {
    const text = document.body.innerText;
    return text.includes("Orders") && text.includes("Materials") && text.includes("Settings");
  });
  check("mobile tab bar present", tabBar);
  await mobile.screenshot({ path: `${shots}/07-mobile-orders.png` });
  await mobile.goto(`${WEB}/orders/${orderId}`, { waitUntil: "networkidle2" });
  await sleep(2000);
  check("mobile deep link renders", await hasText(mobile, orders[0].orderNo, 12000));
  await mobile.screenshot({ path: `${shots}/08-mobile-detail.png` });

  // 9. no crashes along the way
  check("no runtime console errors", consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | "));

  // 10. error state when the api is down
  api.child.kill("SIGTERM");
  await sleep(700);
  await page.goto(`${WEB}/orders`, { waitUntil: "networkidle2" });
  await sleep(2000);
  const errorShown = await hasText(page, "Cannot load", 12000);
  check("api down shows a readable error", errorShown);
  await page.screenshot({ path: `${shots}/09-api-down.png` });
} catch (error) {
  failures += 1;
  console.error("E2E crashed:", error);
  console.error("api log:", api.dump().slice(-600));
  console.error("web log:", web.dump().slice(-600));
} finally {
  if (browser) await browser.close().catch(() => {});
  for (const proc of [api, web, mock]) {
    try {
      process.kill(proc.child.pid, "SIGTERM");
    } catch {}
  }
  await sleep(400);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) console.log("failed:", failed.map((f) => f.label).join(", "));
  process.exit(failures === 0 ? 0 : 1);
}
