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
// The suite keeps its database and its renders in their own directory so a run
// can never touch the studio data or clean up someone else's documents.
const e2eDir = `${root}data/e2e`;
const dbFile = `${e2eDir}/e2e.db`;
const shots = `${root}docs/screenshots/e2e`;
mkdirSync(shots, { recursive: true });
if (existsSync(e2eDir)) rmSync(e2eDir, { recursive: true, force: true });
mkdirSync(e2eDir, { recursive: true });
writeFileSync(
  `${e2eDir}/plan.txt`,
  "Customer plan. Width 2600 mm, height 2100 mm, three shutters. Loft on top."
);

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

async function clickAria(page, label) {
  return page.evaluate((wanted) => {
    const element = document.querySelector(`[aria-label="${wanted}"]`);
    if (!element) return false;
    element.click();
    return true;
  }, label);
}

async function clickFirstText(page, text) {
  return page.evaluate((wanted) => {
    const nodes = [...document.querySelectorAll("div,span,button")].filter(
      (element) => element.textContent.trim() === wanted
    );
    const element = nodes[0];
    if (!element) return false;
    (element.closest('[role="button"],button') || element).click();
    return true;
  }, text);
}

async function waitForUploadedImage(page, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const found = await page.evaluate(() => {
        for (const element of document.querySelectorAll("img,div")) {
          const source =
            element.tagName === "IMG"
              ? element.src
              : getComputedStyle(element).backgroundImage || "";
          if (/\/media\/[0-9a-f-]{36}\.(jpg|jpeg|png|webp)/.test(source)) return true;
        }
        return false;
      });
      if (found) return true;
    } catch {
      // The page was mid render, poll again.
    }
    await sleep(300);
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
  CATALOG_DATA_DIR: e2eDir,
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

  // 1. the studio opens on the chat, history lives one tab over
  await page.goto(WEB, { waitUntil: "networkidle2" });
  check("chat loads", await hasText(page, "Studio chat"));
  check("chat explains what to paste", await hasText(page, "Paste everything the customer told you"));
  check("chat has a message box", (await page.$('textarea[placeholder="Paste the customer\'s requirement"]')) !== null);
  check("chat asks for a cover", await hasText(page, "Choose a cover"));
  check("chat offers starter prompts", await hasText(page, "START WITH WHAT YOU HAVE"));
  check("composer explains the keyboard and drop", await hasText(page, "Enter to send"));
  check("chat offers the existing covers", (await page.$$('[aria-label^="Choose cover "]')).length >= 10);
  check("chat offers no design", (await page.$('[aria-label="Choose no design, let the model design it"]')) !== null);
  check(
    "no design is selected by default",
    await hasText(page, "No design chosen: the model designs the brochure")
  );
  check("cover strip has arrows", (await page.$('[aria-label="Scroll covers right"]')) !== null);
  const firstCover = await page.$('[aria-label^="Choose cover "]');
  if (firstCover) {
    await firstCover.click();
    check("choosing a cover updates the choice", await waitForBodyText(page, "Cover chosen:", 8000));
    await page.screenshot({ path: `${shots}/00b-chat-design.png` });
    const noDesign = await page.$('[aria-label="Choose no design, let the model design it"]');
    if (noDesign) await noDesign.click();
  }
  await page.screenshot({ path: `${shots}/00-chat.png` });

  await page.goto(`${WEB}/orders`, { waitUntil: "networkidle2" });
  check("history loads", await hasText(page, "Grace Wood"));
  check("seeded orders show", await hasText(page, "GWI-2026-001"));
  check("seeded materials show in api", (await (await fetch(`${API}/api/bootstrap`)).json()).materials.length === 4);
  check("history has no manual new order button", await page.evaluate(() => !document.body.innerText.includes("New order")));
  await page.screenshot({ path: `${shots}/01-orders.png` });

  // 2. orders come from the chat. The suite makes one through the API, the same
  // route the chat uses, then checks it appears in history.
  const bootstrap = await (await fetch(`${API}/api/bootstrap`)).json();
  const chatOrder = await (
    await fetch(`${API}/api/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        customerId: bootstrap.customers[0].id,
        title: "E2E Master Wardrobe",
        room: "Master bedroom",
        width: "2600 mm",
        height: "2100 mm",
        depth: "600 mm",
        shutters: "3"
      })
    })
  ).json();
  const orderNo = chatOrder.orderNo;
  check("order number assigned", /^GWI-\d{4}-\d{3}$/.test(orderNo), orderNo);
  await page.goto(`${WEB}/orders`, { waitUntil: "networkidle2" });
  await sleep(2000);
  check("order appears in history", await hasText(page, "E2E Master Wardrobe"));
  check("history card offers the order", await hasText(page, "Open order"));
  await page.goto(`${WEB}/orders/${chatOrder.id}`, { waitUntil: "networkidle2" });
  check("detail screen opens", await hasText(page, "E2E Master Wardrobe", 12000));
  check("width saved", await hasText(page, "2600 mm"));
  await page.screenshot({ path: `${shots}/02-order-detail.png` });

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
  check("thirty design families", families.size === 30, `${families.size} families`);
  const familyVariants = new Map();
  for (const template of catalog) {
    familyVariants.set(template.family, (familyVariants.get(template.family) ?? 0) + 1);
  }
  check(
    "each family is its own design, not a palette twin",
    [...familyVariants.values()].every((count) => count === 1),
    `${catalog.length} designs`
  );
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
  let designRender = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const list = await (await fetch(`${API}/api/renders`)).json();
    designRender = list.find(
      (render) => render.templateId === targetDesign.id && render.orderId === chatOrder.id
    );
    if (designRender) break;
    await sleep(500);
  }
  check(
    "render used the chosen design",
    Boolean(designRender),
    designRender ? designRender.templateId : "no render with the chosen design yet"
  );

  // 4. back to the history, the order and its generated brochure are there
  await page.goto(`${WEB}/orders`, { waitUntil: "networkidle2" });
  await sleep(2500);
  check("order appears in history", await hasText(page, "E2E Master Wardrobe"));
  check("order count updated", await hasText(page, "3 orders"));
  check(
    "history shows the generated brochure",
    await page.evaluate(() => document.body.innerText.toLowerCase().includes("brochure"))
  );
  check("history lists the brochure pages", await hasText(page, "4 pages"));
  check("history offers the pdf", await clickText(page, "Open PDF"));
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
  const attachButton = await page.$('[aria-label="Attach files"]');
  check("chat has an attach button", Boolean(attachButton));
  let attachedFile = false;
  if (attachButton) {
    const attachBox = await attachButton.boundingBox();
    const attachPromise = page.waitForFileChooser({ timeout: 15000 });
    await page.mouse.click(attachBox.x + attachBox.width / 2, attachBox.y + attachBox.height / 2);
    const attachChooser = await attachPromise;
    await attachChooser.accept([`${e2eDir}/plan.txt`]);
    attachedFile = await waitForBodyText(page, "plan.txt", 30000);
  }
  check("chat accepts an uploaded file of any type", attachedFile);
  check(
    "the attachment waits in the composer tray",
    (await page.$('[aria-label="Remove plan.txt"]')) !== null
  );
  await setValueByPlaceholder(
    page,
    chatInput,
    "Need a wardrobe for Anita in the master bedroom, 2400 wide. She wants a loft on top and lighter oak. The plan I attached has the rest."
  );
  check("chat accepts the dump", await clickAria(page, "Send message"));
  check("chat asks for the missing details", await waitForBodyText(page, "what is the height", 90000));
  check("the brief shows its progress", await hasText(page, "of 7 details"));
  check(
    "missing details are named as chips",
    (await page.$$('[aria-label^="Missing "]')).length > 0
  );
  const ordersBeforeChat = (await (await fetch(`${API}/api/orders`)).json()).length;
  await setValueByPlaceholder(page, chatInput, "Height 2100, depth 600, three shutters.");
  check("chat takes the answer", await clickAria(page, "Send message"));
  const cooked = await waitForBodyText(page, "the brochure is ready", 180000);
  check("chat creates the order on its own", cooked);
  const chatPageOk = await page.evaluate(() =>
    [...document.querySelectorAll("img")].some(
      (image) => image.src.includes("/pages/") && image.naturalWidth > 100
    )
  );
  check("chat shows the first page", chatPageOk);
  const ordersAfterChatList = await (await fetch(`${API}/api/orders`)).json();
  check(
    "one chat made one order",
    ordersAfterChatList.length === ordersBeforeChat + 1,
    `${ordersBeforeChat} to ${ordersAfterChatList.length}`
  );
  const chatCreatedOrder = await (await fetch(`${API}/api/orders/${ordersAfterChatList[0].id}`)).json();
  check(
    "the order keeps the uploaded file",
    Array.isArray(chatCreatedOrder.attachments) &&
      chatCreatedOrder.attachments.some((file) => file.name === "plan.txt"),
    `${chatCreatedOrder.attachments?.length ?? 0} files`
  );
  await page.screenshot({ path: `${shots}/06g-chat-brochure.png` });

  // The next message belongs to a new order, so the old conversation is cleared.
  await setValueByPlaceholder(page, chatInput, "Another client needs a wardrobe.");
  check("chat takes the next customer", await clickAria(page, "Send message"));
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
    return text.includes("Chat") && text.includes("History") && text.includes("Settings");
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
  if (failures > 0) {
    const lines = api.dump().split("\n").filter((line) => line.includes('"status":500'));
    console.log("api 500s:", lines.slice(-6).join("\n") || "none");
  }
  process.exit(failures === 0 ? 0 : 1);
}
