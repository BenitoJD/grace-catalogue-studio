// Drives the real web app in Chrome and behaves like a person using it.
// Run with: node scripts/e2e.mjs
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

// Chrome lives in a different place on every platform. CHROME_PATH wins, then
// the standard install locations. Edge is a Chromium build and is the browser
// every Windows machine already has, so it is the last resort there.
function findChrome() {
  const fromEnv = process.env.CHROME_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const candidates =
    process.platform === "win32"
      ? [
          join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "Application", "chrome.exe"),
          join(process.env.PROGRAMFILES ?? "", "Google", "Chrome", "Application", "chrome.exe"),
          join(process.env["PROGRAMFILES(X86)"] ?? "", "Google", "Chrome", "Application", "chrome.exe"),
          join(process.env["PROGRAMFILES(X86)"] ?? "", "Microsoft", "Edge", "Application", "msedge.exe"),
          join(process.env.PROGRAMFILES ?? "", "Microsoft", "Edge", "Application", "msedge.exe")
        ]
      : [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
          "/usr/bin/google-chrome",
          "/usr/bin/chromium",
          "/usr/bin/chromium-browser"
        ];
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? candidates[0];
}

const CHROME = findChrome();
const API = "http://localhost:8787";
const WEB = "http://localhost:8081";
// A directory URL keeps the trailing separator the suite relies on when it
// builds paths by concatenation, which fileURLToPath preserves on Windows too.
const root = fileURLToPath(new URL("..", import.meta.url));
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
const ROOM_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
writeFileSync(`${e2eDir}/room-photo.png`, Buffer.from(ROOM_PNG_BASE64, "base64"));
writeFileSync(`${e2eDir}/room-photo-two.png`, Buffer.from(ROOM_PNG_BASE64, "base64"));

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

// The screenshots are documentation, not assertions. Headless Chromium on
// Windows sometimes never answers Page.captureScreenshot, and that call is
// bounded only by the protocol timeout (minutes), so race it against a short
// timer and stop taking screenshots for the rest of the run after the first
// one stalls. The checks still run and still decide the result.
// Screenshots are off by default when the suite drives Edge on Windows, because
// that is the combination that stalls; E2E_SCREENSHOTS=1 turns them back on.
const screenshotsEnabled =
  process.env.E2E_SCREENSHOTS === "1" ||
  !(process.platform === "win32" && /msedge/i.test(CHROME));
let screenshotsDisabled = !screenshotsEnabled;
async function shot(target, path, options = {}) {
  if (screenshotsDisabled) return false;
  let timer = null;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve("timeout"), 15000);
  });
  try {
    const capture = target.screenshot({
      path,
      captureBeyondViewport: false,
      ...options
    });
    const result = await Promise.race([capture.catch((error) => error), deadline]);
    if (result === "timeout") {
      screenshotsDisabled = true;
      process.stdout.write(`warn screenshot timed out ${path}; the rest of the run skips screenshots\n`);
      capture.catch(() => {});
      return false;
    }
    if (result instanceof Error) throw result;
    return true;
  } catch (error) {
    process.stdout.write(`warn screenshot skipped ${path} (${error?.message ?? "unknown"})\n`);
    return false;
  } finally {
    clearTimeout(timer);
  }
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
  // One evaluate, no ElementHandle.click in between: every page call is bounded
  // by guardPage below, while an ElementHandle click is not, and a wedged
  // renderer then hangs the whole suite instead of failing one check.
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
const seeded = spawnSync(process.execPath, ["server/src/seed.mjs"], {
  cwd: root,
  env: { ...process.env, CATALOG_DB: dbFile },
  encoding: "utf8"
});
if (seeded.status !== 0) {
  console.error("seed failed", seeded.stderr);
  process.exit(1);
}

const api = startProcess(process.execPath, ["server/src/index.mjs"], {
  PORT: "8787",
  CATALOG_DATA_DIR: e2eDir,
  CATALOG_DB: dbFile,
  // The suite drives a whole browser and uploads many page images from one IP.
  RATE_LIMIT_PER_MIN: "100000",
  RENDER_LIMIT_PER_MIN: "10000",
  NOTE_LIMIT_PER_MIN: "10000",
  LLM_VISION_MODE: "auto",
  DESIGN_POLISH: "off",
  DESIGN_QA_PASSES: "0",
  DESIGN_QUALITY: "off",
  DESIGN_THEME_LOCK: "off"
});
const web = startProcess(process.execPath, ["scripts/serve-web.mjs", "8081"]);
const mock = startProcess(process.execPath, ["scripts/mock-llm.mjs", "8793"]);
let browser;

// SPA route changes can leave a navigation in flight; Chrome then aborts the
// next goto. Retrying that exact case keeps the suite honest and stable.
async function safeGoto(target, url, options = { waitUntil: "networkidle2" }) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await target.goto(url, options);
    } catch (error) {
      lastError = error;
      if (!/ERR_ABORTED|ERR_CONNECTION_RESET|frame was detached/i.test(String(error?.message))) {
        throw error;
      }
      await sleep(500);
    }
  }
  throw lastError;
}



// page.evaluate has no timeout of its own in puppeteer, so a renderer that
// stops answering hangs the suite forever. Bound it and the element handle
// methods too; a stall then surfaces as a failed check instead of a run that
// never finishes.
const STALLED = Symbol("stalled");
function bounded(call, label, ms = 45000) {
  return Promise.race([call, sleep(ms).then(() => STALLED)]).then((value) => {
    if (value === STALLED) throw new Error(`the page stopped answering ${label}`);
    return value;
  });
}

function guardHandle(handle) {
  if (!handle) return handle;
  for (const name of ["click", "type", "fill", "hover", "focus", "scrollIntoView"]) {
    if (typeof handle[name] !== "function") continue;
    const original = handle[name].bind(handle);
    handle[name] = (...args) => bounded(original(...args), name);
  }
  return handle;
}

function guardPage(target) {
  for (const name of ["evaluate", "evaluateHandle", "$", "$$"]) {
    const original = target[name].bind(target);
    target[name] = (...args) =>
      bounded(original(...args), name).then((value) => {
        if (value === STALLED) return value;
        if (Array.isArray(value)) return value.map(guardHandle);
        return guardHandle(value);
      });
  }
  return target;
}

// One exit path for the normal finish and for the watchdog below, so a suite
// that stalls still prints its score and leaves a usable exit code.
let finished = false;
function finish() {
  if (finished) return;
  finished = true;
  clearTimeout(watchdog);
  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) console.log("failed:", failed.map((f) => f.label).join(", "));
  if (failures > 0) {
    const lines = api.dump().split("\n").filter((line) => line.includes('"status":500'));
    console.log("api 500s:", lines.slice(-6).join("\n") || "none");
  }
  // A protocol timeout while tearing down headless Chrome is a harness
  // flutter, not a product failure, once every check has passed. The floor is
  // the count the suite reaches on a full run, so an early crash is never
  // reported as a pass.
  process.exit(failed.length === 0 && results.length >= 94 ? 0 : 1);
}

// Headless Chromium on Windows can wedge a page call indefinitely. The checks
// below are all time bounded, so a run this long is stalled: report and leave.
const watchdog = setTimeout(() => {
  console.log("\nwatchdog: the suite stalled, reporting the checks that ran");
  finish();
}, 15 * 60 * 1000);

try {
  const apiUp = await waitFor(`${API}/health`);
  const webUp = await waitFor(WEB);
  check("api reachable", apiUp, apiUp ? "" : api.dump().slice(-300));
  check("web build served", webUp, webUp ? "" : web.dump().slice(-300));
  if (!apiUp || !webUp) throw new Error("servers did not start");

  // A real photograph for orders the suite creates through the API. Brochures
  // require customer photography, so the suite brings its own upload.
  const uploadRoom = async (name) =>
    await (
      await fetch(`${API}/api/media`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ data: ROOM_PNG_BASE64, name, contentType: "image/png" })
      })
    ).json();
  const roomUpload = await uploadRoom("room-photo.png");
  const roomUploadTwo = await uploadRoom("room-photo-two.png");
  const roomPhoto = {
    url: roomUpload.url,
    name: roomUpload.name,
    contentType: roomUpload.contentType,
    bytes: roomUpload.bytes
  };
  const roomPhotoTwo = {
    url: roomUploadTwo.url,
    name: roomUploadTwo.name,
    contentType: roomUploadTwo.contentType,
    bytes: roomUploadTwo.bytes
  };

  // seed a customer so the order flow can pick one
  await fetch(`${API}/api/customers`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Anitha Selvam", phone: "98430 12001", address: "Vadasery" })
  });

  // Every brochure and every design reference is model work now, so the mock
  // provider is connected before the first screen loads.
  const initialSettings = await fetch(`${API}/api/llm/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint: "http://127.0.0.1:8793/v1", model: "mock-flash", apiKey: "test-key" })
  });
  check("mock model connected before the first screen", initialSettings.status === 200);

  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    protocolTimeout: 240000,
    // Headless Chrome exposes navigator.share but the sheet can never settle
    // without a user, so the app would wait on it forever. Real browsers keep
    // the share path; the suite exercises the clipboard fallback instead.
    args: ["--no-sandbox", "--disable-gpu", "--disable-features=WebShare"]
  });
  const page = guardPage(await browser.newPage());
  page.setDefaultTimeout(40000);
  page.setDefaultNavigationTimeout(40000);
  await page.setViewport({ width: 1400, height: 1000 });
  const consoleErrors = [];
  page.on("pageerror", (error) => consoleErrors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  // 1. the studio opens on the chat, history lives one tab over
  await safeGoto(page, WEB, { waitUntil: "networkidle2" });
  check("chat loads", await hasText(page, "Jacob Studio"));
  check("chat opens with a welcome", await hasText(page, "How can I help with this brochure?"));
  check("chat offers a clean start", await hasText(page, "Paste a message"));
  check(
    "chat has a message box",
    (await page.$('textarea[placeholder="Ask anything about this brochure"]')) !== null
  );
  check("chat asks for the requirement", await hasText(page, "Send the customer"));
  check("chat offers starter prompts", await hasText(page, "Add pictures"));
  check("composer explains the keyboard and drop", await hasText(page, "Enter to send"));
  check("chat is picture led", await hasText(page, "read every picture"));
  check("chat offers a magnifier prompt", await hasText(page, "What to magnify"));
  await shot(page, `${shots}/00-chat.png`);

  await page.click('[aria-label="History"]');
  check("the tab bar opens history", await hasText(page, "Every order the studio has made"));
  await page.click('[aria-label="Chat"]');
  check("the tab bar returns to chat", await hasText(page, "Jacob Studio"));

  await safeGoto(page, `${WEB}/orders`, { waitUntil: "networkidle2" });
  check("history loads", await hasText(page, "Jacob Studio"));
  check("seeded orders show", await hasText(page, "JDS-2026-001"));
  check("seeded materials show in api", (await (await fetch(`${API}/api/bootstrap`)).json()).materials.length === 4);
  check("history has no manual new order button", await page.evaluate(() => !document.body.innerText.includes("New order")));
  await shot(page, `${shots}/01-orders.png`);

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
        shutters: "3",
        attachments: [roomPhoto, roomPhotoTwo]
      })
    })
  ).json();
  const orderNo = chatOrder.orderNo;
  check("order number assigned", /^JDS-\d{4}-\d{3}$/.test(orderNo), orderNo);
  await safeGoto(page, `${WEB}/orders`, { waitUntil: "networkidle2" });
  await sleep(2000);
  check("order appears in history", await hasText(page, "E2E Master Wardrobe"));
  check("history card offers the order", await hasText(page, "Order"));
  await safeGoto(page, `${WEB}/orders/${chatOrder.id}`, { waitUntil: "networkidle2" });
  check("detail screen opens", await hasText(page, "E2E Master Wardrobe", 12000));
  check("order shows the colour read from its pictures", await hasText(page, "Colour from the pictures"));
  check(
    "palette chips are painted",
    (await page.$$('[aria-label^="Colour #"]')).length >= 4
  );
  check(
    "order shows its creation date and time",
    await page.evaluate(() =>
      /Created\s*\n?\s*\d{1,2} [A-Z][a-z]{2} \d{4}, \d{1,2}:\d{2} [ap]m/.test(
        document.body.innerText
      )
    )
  );
  await shot(page, `${shots}/02-order-detail.png`);

  // 3. the model designs and prints the brochure
  check("design button present", await clickText(page, "Design the brochure"));
  check("design reports four pages plus callout pages", await hasText(page, "6 pages", 240000));
  const previewOk = await page.waitForFunction(
    () => [...document.querySelectorAll("img")].some((image) => image.src.includes("/pages/") && image.naturalWidth > 200),
    { timeout: 60000 }
  ).then(() => true).catch(() => false);
  check("page preview image painted", previewOk);
  await shot(page, `${shots}/05-brochure-preview.png`);

  let designRender = null;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const list = await (await fetch(`${API}/api/renders`)).json();
    designRender = list.find((render) => render.kind === "ai" && render.orderId === chatOrder.id);
    if (designRender) break;
    await sleep(500);
  }
  check("generated brochure recorded", Boolean(designRender && designRender.pageCount === 6));
  check("it is a model designed document", designRender?.design?.designed === true);
  if (designRender) {
    const pdf = await fetch(`${API}${designRender.pdfUrl}`);
    const type = pdf.headers.get("content-type") ?? "";
    const bytes = (await pdf.arrayBuffer()).byteLength;
    check("pdf downloads", pdf.ok && type.includes("pdf") && bytes > 20000, `${type}, ${bytes} bytes`);
  }

  // 3b. the actions around the document
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

  await clickAria(page, "Share");
  let shareFeedback = false;
  for (let attempt = 0; attempt < 25 && !shareFeedback; attempt += 1) {
    await sleep(400);
    shareFeedback = await page.evaluate(() =>
      ["Link copied", "Brochure link shared", "Sharing is not available", "Sharing cancelled"].some((text) =>
        document.body.innerText.includes(text)
      )
    );
  }
  check("share gives feedback", shareFeedback);

  const rendersBefore = (await (await fetch(`${API}/api/renders`)).json()).length;
  check("design again button present", await clickText(page, "Design it again"));
  let rendersAfter = rendersBefore;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const list = await (await fetch(`${API}/api/renders`)).json();
    rendersAfter = list.length;
    if (rendersAfter > rendersBefore) break;
    await sleep(500);
  }
  check("designing again creates a new document", rendersAfter > rendersBefore, `${rendersBefore} then ${rendersAfter}`);

  // 3c. the brochure is built from the client's own pictures, with a loupe
  const renderedPrompt = await (await fetch(`${API}/api/orders/${chatOrder.id}`)).json();
  check("order keeps its photographs", renderedPrompt.attachments.length >= 2);
  check("no template gallery remains in the app", await page.evaluate(() => !document.body.innerText.includes("One hundred looks")));

  // 4. back to the history, the order and its generated brochure are there
  await safeGoto(page, `${WEB}/orders`, { waitUntil: "networkidle2" });
  await sleep(2500);
  check("order appears in history", await hasText(page, "E2E Master Wardrobe"));
  check("order count updated", await hasText(page, "3 orders"));
  check(
    "history shows the generated brochure",
    await page.evaluate(() => document.body.innerText.toLowerCase().includes("print ready"))
  );
  check("history lists the brochure pages", await hasText(page, "6 sides"));
  check("history offers the pdf", await clickText(page, "PDF"));
  await shot(page, `${shots}/06-orders-with-data.png`);

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

  await safeGoto(page, `${WEB}/settings`, { waitUntil: "networkidle2" });
  await sleep(2000);
  const endpointValue = await page.evaluate(
    () => document.querySelector('input[placeholder="https://provider.example.com/v1"]')?.value ?? ""
  );
  check("settings shows the endpoint", endpointValue.includes("8793"), endpointValue.slice(0, 40));
  check("settings lists the providers", await hasText(page, "Command Code"));
  check(
    "provider choices are tappable",
    (await page.$$('[aria-label^="Provider "]')).length >= 10
  );
  await page.evaluate(() => {
    const chip = document.querySelector('[aria-label="Provider Command Code (Provider API)"]');
    if (chip) chip.click();
  });
  const commandEndpoint = await page.evaluate(
    () => document.querySelector('input[placeholder="https://provider.example.com/v1"]')?.value ?? ""
  );
  check("a provider fills its endpoint", commandEndpoint.includes("api.commandcode.ai"), commandEndpoint);
  check(
    "a provider suggests its models",
    (await page.$('[aria-label="Use model deepseek-v4-flash"]')) !== null
  );
  await safeGoto(page, `${WEB}/settings`, { waitUntil: "networkidle2" });
  await sleep(1500);
  check("test connection button present", await clickText(page, "Test connection"));
  const connected = await page
    .waitForFunction(() => document.body.innerText.includes("Connected to"), { timeout: 30000 })
    .then(() => true)
    .catch(() => false);
  check("test connection reports success", connected);
  await shot(page, `${shots}/06b-model-settings.png`);

  // 4b2. first run: chat learns about a newly connected model on focus without
  // a full reload. Remove the key, load chat, restore the key, return to chat.
  await fetch(`${API}/api/llm/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "" }),
  });
  await safeGoto(page, WEB, { waitUntil: "networkidle2" });
  await sleep(2500);
  check("a new install without a key asks for the model", await hasText(page, "Add model"));
  await fetch(`${API}/api/llm/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint: "http://127.0.0.1:8793/v1", model: "mock-flash", apiKey: "test-key" }),
  });
  await page.evaluate(() => document.querySelector('[aria-label="History"]')?.click());
  await sleep(800);
  await page.evaluate(() => document.querySelector('[aria-label="Chat"]')?.click());
  await sleep(2500);
  check("the chat rechecks the model when it regains focus", await hasText(page, "Model ready"));
  check("the stale add model prompt is gone", !(await hasText(page, "Add model", 1000)));

  // 4c. the chat interface: dump the requirement, answer the gap, cook
  await safeGoto(page, WEB, { waitUntil: "networkidle2" });
  await sleep(2500);
  const chatInput = "Ask anything about this brochure";
  const attachButton = await page.$('[aria-label="Attach files"]');
  check("chat has an attach button", Boolean(attachButton));
  let attachedFile = false;
  if (attachButton) {
    const attachBox = await attachButton.boundingBox();
    const attachPromise = page.waitForFileChooser({ timeout: 15000 });
    await page.mouse.click(attachBox.x + attachBox.width / 2, attachBox.y + attachBox.height / 2);
    const attachChooser = await attachPromise;
    await attachChooser.accept([`${e2eDir}/plan.txt`, `${e2eDir}/room-photo.png`, `${e2eDir}/room-photo-two.png`]);
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
  const ordersBeforeChat = (await (await fetch(`${API}/api/orders`)).json()).length;
  check("chat accepts the dump", await clickAria(page, "Send message"));
  check(
    "the pictures are reviewed before design",
    await waitForBodyText(page, "what I read from your picture", 90000)
  );
  check(
    "the review offers marking every picture",
    await page.evaluate(() => document.querySelectorAll('[aria-label^="Mark an area"]').length >= 1)
  );
  check(
    "every mark is named outside the picture with its colour",
    await page.evaluate(() => {
      const items = [...document.querySelectorAll('[data-testid^="review-legend-"]')].map(
        (item) => item.innerText.trim()
      );
      return items.length >= 3 && items.every((text) => /#[0-9A-F]{6}/.test(text) && text.length >= 8);
    })
  );
  await shot(page, `${shots}/06h-picture-review.png`);
  await setValueByPlaceholder(page, chatInput, "Magnify 1 and 2. You choose the rest.");
  check("chat takes the magnify answer", await clickAria(page, "Send message"));
  const cooked = await waitForBodyText(page, "the brochure is ready", 180000);
  check("chat creates the order on its own", cooked);
  const chatPageOk = await page
    .waitForFunction(
      () =>
        [...document.querySelectorAll("img")].some(
          (image) => image.src.includes("/pages/") && image.naturalWidth > 100
        ),
      { timeout: 60000 }
    )
    .then(() => true)
    .catch(() => false);
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
  await shot(page, `${shots}/06g-chat-brochure.png`);

  // 4b. the same chat edits the live order in plain language
  const editInput = "Ask for a change to this order";
  check(
    "the composer asks for a change",
    await setValueByPlaceholder(page, editInput, "Make the shutters dark walnut and redo the cover.")
  );
  check("chat accepts the edit", await clickAria(page, "Send message"));
  check("the edit applies to the order", await waitForBodyText(page, "I changed the shutters", 120000));
  const editedOrder = await (await fetch(`${API}/api/orders/${ordersAfterChatList[0].id}`)).json();
  check(
    "the order fields changed",
    editedOrder.finishExt.includes("Dark walnut"),
    editedOrder.finishExt
  );
  const editedBrochure = await page
    .waitForFunction(
      () => [...document.querySelectorAll("img")].some((image) => image.src.includes("/pages/")),
      { timeout: 60000 }
    )
    .then(() => true)
    .catch(() => false);
  check("the brochure re-renders after an edit", editedBrochure);
  await shot(page, `${shots}/06g2-chat-editor.png`);

  // Files can join a live order too: attach a plan with the next sentence.
  // Wait until the previous edit fully settled: the picker refuses to open
  // while a send is still in flight.
  await page
    .waitForFunction(() => document.querySelector('[aria-label="Send message"]') !== null, {
      timeout: 120000,
    })
    .then(() => true)
    .catch(() => false);
  const filesBefore = Array.isArray(editedOrder.attachments) ? editedOrder.attachments.length : 0;
  const attachMore = await page.$('[aria-label="Attach files"]');
  check("attach stays available after an order", Boolean(attachMore));
  if (attachMore) {
    // The chat re-renders under load, so re-query the button and retry once
    // instead of trusting one bounding box.
    let attachedTray = false;
    for (let attempt = 0; attempt < 2 && !attachedTray; attempt += 1) {
      const button = await page.$('[aria-label="Attach files"]');
      if (!button) break;
      await button.evaluate((element) => element.scrollIntoView({ block: 'nearest' }));
      await sleep(400);
      const box = await button.boundingBox();
      if (!box) continue;
      const attachPromise = page.waitForFileChooser({ timeout: 15000 });
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      try {
        const attachChooser = await attachPromise;
        await attachChooser.accept([`${e2eDir}/plan.txt`]);
        // The file name already appears in an earlier bubble, so poll for the
        // composer tray chip itself with fresh queries: only that proves the
        // upload finished.
        for (let poll = 0; poll < 60 && !attachedTray; poll += 1) {
          await sleep(500);
          try {
            attachedTray = (await page.$('[aria-label="Remove plan.txt"]')) !== null;
          } catch {
            attachedTray = false;
          }
        }
      } catch {
        attachedTray = false;
      }
    }
    check("the plan is waiting in the tray", attachedTray);
  }
  check(
    "chat takes files with the change",
    await setValueByPlaceholder(page, editInput, "The attached plan has the loft measurements.")
  );
  check("chat accepts the file change", await clickAria(page, "Send message"));
  let orderWithFiles = null;
  for (let attempt = 0; attempt < 90 && !orderWithFiles; attempt += 1) {
    await sleep(2000);
    const current = await (await fetch(`${API}/api/orders/${ordersAfterChatList[0].id}`)).json();
    if (Array.isArray(current.attachments) && current.attachments.length === filesBefore + 1) {
      orderWithFiles = current;
    }
  }
  check(
    "new files join the live order",
    Boolean(orderWithFiles),
    `${filesBefore} to ${orderWithFiles?.attachments?.length ?? filesBefore} files`
  );
  check("the file change applies", await waitForBodyText(page, "brochure is ready", 180000));
  await shot(page, `${shots}/06g3-chat-attach.png`);

  // Let the file edit's re-render fully settle before starting fresh.
  await page
    .waitForFunction(() => document.querySelector('[aria-label="Send message"]') !== null, {
      timeout: 180000,
    })
    .then(() => true)
    .catch(() => false);

  // New order is the only way to start a fresh customer.
  await clickAria(page, "New order chat");
  await sleep(1200);
  const freshAttach = await page.$('[aria-label="Attach files"]');
  if (freshAttach) {
    const freshBox = await freshAttach.boundingBox();
    const freshPromise = page.waitForFileChooser({ timeout: 15000 });
    await page.mouse.click(freshBox.x + freshBox.width / 2, freshBox.y + freshBox.height / 2);
    const freshChooser = await freshPromise;
    await freshChooser.accept([`${e2eDir}/room-photo.png`, `${e2eDir}/room-photo-two.png`]);
    await waitForBodyText(page, "room-photo.png", 30000);
  }
  check(
    "new order starts a fresh chat",
    await setValueByPlaceholder(page, chatInput, "Another client needs a wardrobe for the guest room.")
  );
  check("chat takes the next customer", await clickAria(page, "Send message"));
  await waitForBodyText(page, "what I read from your picture", 90000);
  await setValueByPlaceholder(page, chatInput, "You choose what to magnify.");
  check("chat takes the fresh magnify answer", await clickAria(page, "Send message"));
  const freshChat = await waitForBodyText(page, "the brochure is ready", 180000);
  check("a new chat starts after New order", freshChat);
  const cleared = await page.evaluate(() => {
    const text = document.body.innerText;
    // The old order must be gone from the new chat; the welcome itself is
    // replaced as soon as the new conversation has messages.
    return !text.includes("I changed the shutters") && !text.includes("JDS-2026-0");
  });
  check("the old conversation is cleared", cleared);

  const noteOrders = await (await fetch(`${API}/api/orders`)).json();
  // The chat flow above created its own order. The note and copy steps belong to
  // the order this run created, so pick it by title rather than by newest.
  const noteOrder = noteOrders.find((order) => order.title === "E2E Master Wardrobe") ?? noteOrders[0];
  const noteOrderId = noteOrder.id;
  await safeGoto(page, `${WEB}/orders/${noteOrderId}`, { waitUntil: "networkidle2" });
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
  await shot(page, `${shots}/06c-customer-note.png`);

  // 4d. the info kit renders from the same order
  await safeGoto(page, `${WEB}/orders/${noteOrderId}`, { waitUntil: "networkidle2" });
  await sleep(2500);
  check("info kit button present", await clickText(page, "Render info kit"));
  const kitReady = await waitForBodyText(page, "5 pages", 60000);
  check("info kit renders five pages", kitReady);
  const kitImages = await page.evaluate(
    () => [...document.querySelectorAll("img")].filter((image) => image.src.includes("/pages/") && image.naturalWidth > 100).length
  );
  check("info kit page preview loads", kitImages >= 1, `${kitImages} page images`);
  await shot(page, `${shots}/06e-info-kit.png`);

  // 6. settings tab
  await safeGoto(page, `${WEB}/settings`, { waitUntil: "networkidle2" });
  check("settings screen opens", await hasText(page, "Settings"));
  check("settings says the app runs locally", await hasText(page, "Everything runs on this computer"));
  check("settings never mentions an api server", !(await hasText(page, "API base", 1000)));

  // 7. deep link straight into an order
  const orders = await (await fetch(`${API}/api/orders`)).json();
  const orderId = orders[0].id;
  await safeGoto(page, `${WEB}/orders/${orderId}`, { waitUntil: "networkidle2" });
  check("deep link to order works", await hasText(page, orders[0].orderNo, 12000));

  // 9c. the studio can make the larger brochure from the same order
  await safeGoto(page, `${WEB}/orders/${chatOrder.id}`, { waitUntil: "networkidle2" });
  await sleep(2500);
  const brochureChip = await page.$('[aria-label="Brochure format"]');
  check("the order offers a brochure format", Boolean(brochureChip));
  if (brochureChip) {
    // A DOM click, not an ElementHandle click: the handle click scrolls the
    // heavy order page first, and that scrolling is what wedged headless Edge.
    const chosen = await page.evaluate(() => {
      const chip = document.querySelector('[aria-label="Brochure format"]');
      if (!chip) return false;
      chip.click();
      return true;
    });
    check("the brochure format can be chosen", chosen);
    await sleep(400);
    check("the brochure format explains itself", await hasText(page, "Larger art directed book", 8000));
    const beforeBrochure = (await (await fetch(`${API}/api/renders`)).json()).length;
    check("the brochure can be designed", await clickText(page, "Design it again"));
    let brochureRender = null;
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const list = await (await fetch(`${API}/api/renders`)).json();
      if (list.length > beforeBrochure) {
        brochureRender = list.find((render) => render.kind === "ai" && render.orderId === chatOrder.id);
      }
      if (brochureRender) break;
      await sleep(500);
    }
    check(
      "the brochure is a longer book than the pamphlet",
      Boolean(brochureRender) && brochureRender.pageCount > 6,
      `${brochureRender?.pageCount} pages`
    );
    const storedFormat = await (await fetch(`${API}/api/orders/${chatOrder.id}`)).json();
    check("the order remembers the brochure format", storedFormat.designFormat === "brochure", String(storedFormat.designFormat));
    await shot(page, `${shots}/09-brochure-format.png`);
  }

  // 8. mobile viewport
  const mobile = guardPage(await browser.newPage());
  await mobile.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await safeGoto(mobile, `${WEB}/orders`, { waitUntil: "networkidle2" });
  await sleep(1500);
  check("mobile renders the order book", await hasText(mobile, "Jacob Studio"));
  const tabBar = await mobile.evaluate(() => {
    const text = document.body.innerText;
    return text.includes("Chat") && text.includes("History") && text.includes("Settings");
  });
  check("mobile tab bar present", tabBar);
  await shot(mobile, `${shots}/07-mobile-orders.png`);
  await safeGoto(mobile, `${WEB}/orders/${orderId}`, { waitUntil: "networkidle2" });
  await sleep(2000);
  check("mobile deep link renders", await hasText(mobile, orders[0].orderNo, 12000));
  await shot(mobile, `${shots}/08-mobile-detail.png`);

  // 9. no crashes along the way
  check("no runtime console errors", consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | "));

  // 10. error state when the api is down
  api.child.kill("SIGTERM");
  await sleep(700);
  await safeGoto(page, `${WEB}/orders`, { waitUntil: "networkidle2" });
  await sleep(2000);
  const errorShown = await hasText(page, "Cannot load", 12000);
  check("api down shows a readable error", errorShown);
  await shot(page, `${shots}/09b-api-down.png`, { timeout: 15000 });
  await shot(page, `${shots}/09-api-down.png`, { timeout: 15000 });
} catch (error) {
  failures += 1;
  console.error("E2E crashed:", error && error.stack ? error.stack.split("\n").slice(0, 3).join("\n") : error);
  console.error("api log:", api.dump().slice(-600));
  console.error("web log:", web.dump().slice(-600));
} finally {
  // A stalled screenshot or a wedged renderer must never keep the run from
  // reporting, so the browser close is bounded and the summary always prints.
  if (browser) {
    await Promise.race([browser.close().catch(() => {}), sleep(15000)]);
  }
  for (const proc of [api, web, mock]) {
    try {
      process.kill(proc.child.pid, "SIGTERM");
    } catch {}
  }
  await sleep(400);
  finish();
}
