// Static file server for the exported web app, with SPA fallback so deep links work.
// Usage: node scripts/serve-web.mjs [port]
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

const root = new URL("../app/dist/", import.meta.url).pathname;
const port = Number.parseInt(process.argv[2] ?? "8081", 10);

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2"
};

createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  let filePath = join(root, normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, ""));

  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    const index = join(filePath, "index.html");
    filePath = existsSync(index) ? index : join(root, "index.html");
  }

  const type = types[extname(filePath).toLowerCase()] ?? "application/octet-stream";
  response.writeHead(200, { "content-type": type });
  createReadStream(filePath).pipe(response);
}).listen(port, () => {
  console.log(`web build served at http://localhost:${port}`);
});
