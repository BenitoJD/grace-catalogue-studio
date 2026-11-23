import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb, putDesignCatalog, getDesignCatalog } from "./server/src/db.mjs";
import { buildPendingPreviews } from "./server/src/design-previews.mjs";
import { createRenderer, newRenderId } from "./server/src/render.mjs";
import { CATALOG_VERSION } from "./server/src/design-catalog.mjs";

const dataDir = mkdtempSync(path.join(tmpdir(), "prev-debug-"));
const db = openDb(path.join(dataDir, "t.db"));
const designs = [0, 1].map((n) => ({
  id: `dbg-${n}`, name: `Debug ${n}`, family: "Ledger", mood: "quiet", summary: "calm look",
  palette: { paper: "#FBF3E4", ink: "#2A1512", deep: "#4A1116", accent: "#7C2A22", gold: "#C79A3A", hair: "#E3D2B8", muted: "#6B4A3E", onDark: "#FBF3E4" },
  displayFont: "Instrument Serif", bodyFont: "Barlow", coverIdea: "tall photo", ornament: "lotus",
}));
putDesignCatalog(db, { version: CATALOG_VERSION, expected: 2, designs });
const DESIGNER = readFileSync("scripts/fixtures/designer-reply.html", "utf8");
const COPY = JSON.stringify({
  headline: 'Room for the calm to settle',
  body: 'The bedroom had the wall and not much else, so this wardrobe takes the full run and leaves the floor clear. Three shutters open on soft close hinges, and the hanging section is deep enough for a full season of clothes. Warm wood on the outside keeps the light gentle, and the white interior makes the shelves easy to read when the doors are open. The drawers sit low, where the folded things go, and the handles are matte so the front stays quiet. It is a piece built to disappear into the room and let the calm do the rest.',
  closing: 'Measured for the room, made in Nagercoil.',
});
let calls = 0;
const replies = [COPY, DESIGNER, DESIGNER];
const deps = {
  db, dataDir, templatesDir: path.resolve("templates"), materials: [],
  renderer: createRenderer({ templatesDir: path.resolve("templates"), dataDir, weasyprintBin: "specimen/.venv/bin/weasyprint", pdftoppmBin: "pdftoppm" }),
  config: { provider: "mock", endpoint: "http://x/v1", model: "m", apiKey: "k" },
  requestChat: async () => { calls += 1; return { content: replies.shift() ?? DESIGNER, model: "m", latencyMs: 1 }; },
  newRenderId,
  logger: { info: (m, d) => console.log("INFO", m, JSON.stringify(d ?? {}).slice(0,200)), warn: (...a) => console.log("WARN", JSON.stringify(a).slice(0, 400)), error: () => {} },
};
console.log("finished:", await buildPendingPreviews(deps), "calls:", calls);
console.log("states:", getDesignCatalog(db).designs.map((d) => [d.id, d.previewReady]));
