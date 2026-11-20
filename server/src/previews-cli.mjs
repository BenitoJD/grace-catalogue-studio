// Generate the template thumbnails ahead of time: node src/previews-cli.mjs [--force]
// The API also builds a missing preview on demand, so this is only a warm up.
import { loadConfig } from './config.mjs';
import { createPreviewStore } from './previews.mjs';
import { createRenderer } from './render.mjs';
import { loadVariants } from './variants.mjs';

const config = loadConfig();
const force = process.argv.includes('--force');
const variants = loadVariants(config.templatesDir);
const renderer = createRenderer({
  templatesDir: config.templatesDir,
  dataDir: config.dataDir,
  weasyprintBin: config.weasyprintBin,
  pdftoppmBin: config.pdftoppmBin,
});
const store = createPreviewStore({
  variants,
  templatesDir: config.templatesDir,
  dataDir: config.dataDir,
  renderer,
});

const total = variants.variants.length;
console.log(`Generating ${total} template previews in ${store.previewsDir}`);
const started = Date.now();
const result = await store.warmAll({
  force,
  onProgress: ({ templateId, generated }) => {
    process.stdout.write(`  [${String(generated).padStart(2, ' ')}/${total}] ${templateId}\n`);
  },
});
const seconds = ((Date.now() - started) / 1000).toFixed(1);
console.log(`Done in ${seconds}s: ${result.generated} generated, ${result.failed.length} failed.`);
for (const failure of result.failed) {
  console.error(`FAILED ${failure.templateId}: ${failure.message}`);
}
process.exit(result.failed.length === 0 ? 0 : 1);
