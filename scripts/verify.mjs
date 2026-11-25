// End to end check: boot the API, create an order, render a voucher, verify the PDF.
// Run with: node scripts/verify.mjs
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
// A one pixel PNG: the smoke test only needs a real picture file on the order.
const ROOM_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
// fileURLToPath keeps the trailing separator this script relies on, and unlike
// URL.pathname it is a real path on Windows ("C:\..." rather than "/C:/...").
const root = fileURLToPath(new URL("..", import.meta.url));
const dbFile = `${root}data/verify.db`;

let failed = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) failed += 1;
};

if (existsSync(dbFile)) rmSync(dbFile);
mkdirSync(`${root}data`, { recursive: true });

const server = spawn(process.execPath, ["server/src/index.mjs"], {
  cwd: root,
  env: { ...process.env, PORT: String(PORT), CATALOG_DB: dbFile },
  stdio: ["ignore", "pipe", "pipe"]
});
let log = "";
server.stdout.on("data", (c) => (log += c));
server.stderr.on("data", (c) => (log += c));

async function waitForServer() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return true;
    } catch {}
    await sleep(250);
  }
  return false;
}

try {
  const up = await waitForServer();
  check("api boots", up, up ? "" : log.slice(-400));
  if (!up) throw new Error("server did not start");

  const health = await (await fetch(`${BASE}/health`)).json();
  check("health responds", health.ok === true);

  const customer = await (
    await fetch(`${BASE}/api/customers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Verify Customer", phone: "+91 90000 00000" })
    })
  ).json();
  check("customer created", Boolean(customer.id), customer.name ?? JSON.stringify(customer));

  // A voucher prints the customer's own photograph, and the engine refuses an
  // order without one, so the smoke test brings its own picture.
  const photo = await (
    await fetch(`${BASE}/api/media`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        data: ROOM_PNG_BASE64,
        name: "verify-room.png",
        contentType: "image/png"
      })
    })
  ).json();
  check("picture uploaded", Boolean(photo.url), photo.url ?? JSON.stringify(photo));

  const order = await (
    await fetch(`${BASE}/api/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        customerId: customer.id,
        title: "Master Bedroom Wardrobe",
        room: "Master bedroom",
        width: "2400 mm",
        height: "2100 mm",
        depth: "600 mm",
        shutters: "3, 800 mm",
        attachments: [
          { url: photo.url, name: photo.name, contentType: photo.contentType, bytes: photo.bytes }
        ]
      })
    })
  ).json();
  check("order created", Boolean(order.id), order.orderNo ?? JSON.stringify(order));
  check("order number generated", /^JDS-\d{4}-\d{3}$/.test(order.orderNo ?? ""), order.orderNo);

  const renderResponse = await fetch(`${BASE}/api/orders/${order.id}/render`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "voucher" })
  });
  const renderBody = await renderResponse.text();
  let render = {};
  try {
    render = JSON.parse(renderBody);
  } catch {
    render = {};
  }
  check(
    "render returned",
    Boolean(render.id),
    render.id ? `${render.pageCount} pages` : `${renderResponse.status} ${renderBody.slice(0, 300)}`
  );
  check("voucher is four pages", render.pageCount === 4);
  check("page urls present", Array.isArray(render.pageUrls) && render.pageUrls.length === 4);

  const pdfPath = `${root}data/renders/${render.id}.pdf`;
  check("pdf file exists", existsSync(pdfPath));
  if (existsSync(pdfPath)) {
    const info = spawnSync("pdfinfo", [pdfPath], { encoding: "utf8" });
    const pages = (info.stdout.match(/Pages:\s+(\d+)/) ?? [])[1];
    check("pdf reports four pages", pages === "4", `pdfinfo says ${pages}`);
  }

  const pageRes = await fetch(`${BASE}${render.pageUrls[0]}`);
  check("page image served", pageRes.ok, String(pageRes.status));

  const firstPage = await fetch(`${BASE}${render.pageUrls[0]}`);
  const bytes = (await firstPage.arrayBuffer()).byteLength;
  check("page image is a real image", bytes > 5000, `${bytes} bytes`);
} catch (error) {
  console.error(error);
  failed += 1;
} finally {
  server.kill("SIGTERM");
  await sleep(300);
  console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) failed.`);
  process.exit(failed === 0 ? 0 : 1);
}
