// Runs the live model over a set of realistic orders and scores the copy it
// writes, so prompt changes can be judged against evidence instead of taste.
//
//   LLM_ENDPOINT=https://opencode.ai/zen/go/v1 \
//   LLM_MODEL=deepseek-v4.1-flash \
//   LLM_API_KEY=... \
//   node scripts/ai-quality.mjs
//
// Add --json to print results as JSON, --save <file> to keep them.
import { writeFileSync } from 'node:fs';

import {
  COPY_CLOSING_MAX_CHARS,
  COPY_HEADLINE_MAX_CHARS,
  buildCopyMessages,
  parseCopyReply,
  requestChat,
} from '../server/src/llm.mjs';

const endpoint = process.env.LLM_ENDPOINT ?? '';
const model = process.env.LLM_MODEL ?? '';
const apiKey = process.env.LLM_API_KEY ?? '';

const BRIEF_LEAK_WORDS = ['lakh', 'rupee', 'rs.', '₹', 'deepavali', 'diwali', 'pongal', 'festival', 'before the', 'deadline', 'price', 'cost', 'budget'];

const CLAIM_WORDS = [
  'fingerprint',
  'does not show',
  'without a stool',
  'stain',
  'scratch',
  'moisture proof',
  'heat resistant',
  'scratch proof',
  'easy to clean',
  'lasts for years',
  'made to last',
  'holds its finish',
  'waterproof',
  'termite proof',
  'lifetime'
];

const BANNED_PHRASES = [
  'elevate',
  'seamless',
  'unleash',
  'crafted to perfection',
  'bespoke',
  'luxurious',
  'state of the art',
  'state-of-the-art',
  'game changer',
  'cutting edge',
  'cutting-edge',
  'dream',
  'oasis',
  'timeless elegance',
  'transform your',
  'nestled',
  'boasts'
];

const ORDERS = [
  {
    label: 'master bedroom, detailed brief',
    brief:
      'They added a loft on top and want a lighter oak because the room is small. Two of the drawers should lock.',
    order: {
      customerName: 'Anitha Selvam',
      title: 'Master Bedroom Wardrobe',
      room: 'Master bedroom',
      width: '2400 mm',
      height: '2100 mm',
      depth: '600 mm',
      shutters: '3',
      carcass: '18 mm BWP plywood',
      backPanel: '6 mm plywood',
      shuttersMat: '18 mm BWP plywood',
      drawers: '12 mm plywood, four drawers',
      exterior: 'warm oak laminate',
      interior: 'white laminate',
      edgeShutter: '2 mm PVC',
      edgeCarcass: '0.8 mm PVC',
      edgeNote: 'colour matched',
      handle: 'matte black aluminium',
      handleNote: 'vertical, three sets',
      finishExt: 'matte outside, white inside',
      finishInt: 'no painting'
    }
  },
  {
    label: 'guest bedroom, storage brief',
    brief: 'Compact guest room. It has to store suitcases and spare bedding.',
    order: {
      customerName: 'Rajesh Kumar',
      title: 'Guest Bedroom Wardrobe',
      room: 'Guest bedroom',
      width: '1800 mm',
      height: '2100 mm',
      depth: '600 mm',
      shutters: '2',
      carcass: '18 mm BWP plywood',
      backPanel: '6 mm plywood',
      shuttersMat: '18 mm BWP plywood',
      drawers: '12 mm plywood, two drawers',
      exterior: 'cream laminate',
      interior: 'white laminate',
      edgeShutter: '2 mm PVC',
      edgeCarcass: '0.8 mm PVC',
      edgeNote: 'colour matched',
      handle: 'antique brass',
      handleNote: 'vertical, two sets',
      finishExt: 'matte outside, white inside',
      finishInt: 'no painting'
    }
  },
  {
    label: 'kitchen, terse brief',
    brief: 'Standard. Nothing fancy.',
    order: {
      customerName: 'Meena Ravi',
      title: 'Kitchen Modular Units',
      room: 'Kitchen',
      width: '3000 mm',
      height: '900 mm',
      depth: '600 mm',
      shutters: '6',
      carcass: '18 mm BWP plywood',
      backPanel: '6 mm plywood',
      shuttersMat: '18 mm BWP plywood',
      drawers: '12 mm plywood, six baskets',
      exterior: 'ash grey laminate',
      interior: 'white laminate',
      edgeShutter: '2 mm PVC',
      edgeCarcass: '0.8 mm PVC',
      edgeNote: 'colour matched',
      handle: 'slim profile aluminium',
      handleNote: 'horizontal',
      finishExt: 'matte outside, white inside',
      finishInt: 'no painting'
    }
  },
  {
    label: 'no brief at all',
    brief: '',
    order: {
      customerName: 'Sundar Moorthy',
      title: 'Study Room Shelving',
      room: 'Study',
      width: '1500 mm',
      height: '2400 mm',
      depth: '350 mm',
      shutters: '0',
      carcass: '18 mm BWP plywood',
      backPanel: '6 mm plywood',
      shuttersMat: 'open shelves',
      drawers: 'none',
      exterior: 'dark walnut laminate',
      interior: 'walnut laminate',
      edgeShutter: '2 mm PVC',
      edgeCarcass: '0.8 mm PVC',
      edgeNote: 'colour matched',
      handle: 'none',
      handleNote: 'push to open',
      finishExt: 'matte',
      finishInt: 'no painting'
    }
  },
  {
    label: 'client asks for luxury wording',
    brief: 'Make it sound really premium and luxurious, like a five star hotel.',
    order: {
      customerName: 'Farida Begum',
      title: 'Walk In Wardrobe',
      room: 'Dressing room',
      width: '3600 mm',
      height: '2400 mm',
      depth: '600 mm',
      shutters: '4',
      carcass: '18 mm BWP plywood',
      backPanel: '6 mm plywood',
      shuttersMat: '18 mm BWP plywood',
      drawers: '12 mm plywood, eight drawers',
      exterior: 'smoked glass and walnut laminate',
      interior: 'warm white laminate',
      edgeShutter: '2 mm PVC',
      edgeCarcass: '0.8 mm PVC',
      edgeNote: 'colour matched',
      handle: 'brushed nickel',
      handleNote: 'vertical, four sets',
      finishExt: 'matte outside, warm white inside',
      finishInt: 'no painting'
    }
  },
  {
    label: 'brief mentions money and dates',
    brief: 'They asked to keep it under one lakh and want it before Deepavali.',
    order: {
      customerName: 'Karthik Sundaram',
      title: 'Dining Area Storage Bench',
      room: 'Dining room',
      width: '2000 mm',
      height: '450 mm',
      depth: '450 mm',
      shutters: '3',
      carcass: '18 mm BWP plywood',
      backPanel: '6 mm plywood',
      shuttersMat: '18 mm BWP plywood',
      drawers: '12 mm plywood, three drawers',
      exterior: 'teak laminate',
      interior: 'white laminate',
      edgeShutter: '2 mm PVC',
      edgeCarcass: '0.8 mm PVC',
      edgeNote: 'colour matched',
      handle: 'wicker pulls',
      handleNote: 'front mounted',
      finishExt: 'matte outside, white inside',
      finishInt: 'no painting'
    }
  }
];

function wordCount(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function digitsIn(text) {
  return new Set((text.match(/\d[\d,.]*/g) ?? []).map((token) => token.replace(/[,.]$/, '')));
}

function scoreCopy(order, copy, scenarioBrief = '') {
  const body = copy.body;
  const words = wordCount(body);
  const lower = `${copy.headline} ${body} ${copy.closing}`.toLowerCase();
  const bodyLower = body.toLowerCase();
  // How much of the specification is echoed verbatim. A brochure body should
  // choose a few telling facts, not recite the table.
  const materialFields = ['carcass', 'backPanel', 'shuttersMat', 'drawers', 'exterior', 'interior', 'edgeShutter', 'edgeCarcass', 'handle'];
  const echoed = materialFields.filter((field) => {
    const value = String(order[field] ?? '').toLowerCase().split(',')[0].trim();
    return value.length > 4 && bodyLower.includes(value);
  });
  const nameParts = String(order.customerName ?? '').toLowerCase().split(' ').filter(Boolean);
  const opensWithName = bodyLower.startsWith(`for ${nameParts[0]}`) || bodyLower.startsWith(`this ${order.title.toLowerCase()} for`);
  const claims = CLAIM_WORDS.filter((phrase) => lower.includes(phrase));
  const metaWords = ['the specification', 'the order', 'the brief', 'the document'].filter((phrase) => lower.includes(phrase));
  const exampleEchoes = ['rarely has a spare wall', 'somewhere warm to land', 'storage first', 'does not look like a cupboard'].filter((phrase) => lower.includes(phrase));
  const shutterCount = Number.parseInt(String(order.shutters ?? '').replace(/\D/g, ''), 10);
  const noShutters = Number.isFinite(shutterCount) && shutterCount === 0;
  const phantomComponents = noShutters
    ? ['hinge', 'handle', 'shutter'].filter((word) => lower.includes(word))
    : [];
  const briefLower = String(scenarioBrief ?? '').toLowerCase();
  const briefLeak = BRIEF_LEAK_WORDS.filter(
    (word) => briefLower.includes(word) && lower.includes(word)
  );
  const verbCounts = ['keeps', 'gives', 'holds', 'makes'].map((verb) => ({
    verb,
    count: (bodyLower.match(new RegExp(`\\b${verb}\\b`, 'g')) ?? []).length
  }));
  const repeatedVerbs = verbCounts.filter((entry) => entry.count > 1).map((entry) => entry.verb);
  const firstName = nameParts[0] ?? '';
  const nameBeforeComma = new RegExp(`(^|[.!?]\\s)${firstName},`, 'i').test(body);
  const headlineFormula = /^a .+ (that|built|made)\b/i.test(copy.headline);
  const orderFacts = [
    ...Object.values(order).map((value) => String(value).toLowerCase()),
    order.customerName.split(' ')[0].toLowerCase()
  ];
  const mentionsFact = orderFacts.some((fact) => fact.length > 2 && lower.includes(fact));
  const banned = BANNED_PHRASES.filter((phrase) => lower.includes(phrase));
  const hasDash = /[\u2013\u2014]/.test(`${copy.headline}${body}${copy.closing}`);

  // Numbers the text uses must already exist in the order or the brief.
  const allowedDigits = digitsIn(JSON.stringify(order));
  const inventedNumbers = [...digitsIn(body)].filter((token) => !allowedDigits.has(token));

  const checks = {
    noBriefLeak: briefLeak.length === 0,
    noVerbRepetition: repeatedVerbs.length === 0,
    noNameBeforeComma: firstName === '' || !nameBeforeComma,
    headlineLength: copy.headline.length <= COPY_HEADLINE_MAX_CHARS,
    closingLength: copy.closing.length <= COPY_CLOSING_MAX_CHARS,
    bodyInRange: words >= 90 && words <= 160,
    noDashes: !hasDash,
    noBannedPhrases: banned.length === 0,
    mentionsOrderFact: mentionsFact,
    noInventedNumbers: inventedNumbers.length === 0,
    notSpecDump: echoed.length <= 3,
    noNameOpener: !opensWithName,
    noPerformanceClaims: claims.length === 0,
    noMetaTalk: metaWords.length === 0,
    noExampleEcho: exampleEchoes.length === 0,
    noPhantomComponents: phantomComponents.length === 0,
    headlineNotFormula: !headlineFormula
  };

  const passed = Object.values(checks).filter(Boolean).length;
  return {
    words,
    headlineChars: copy.headline.length,
    closingChars: copy.closing.length,
    banned,
    inventedNumbers,
    echoed,
    claims,
    metaWords,
    exampleEchoes,
    briefLeak,
    phantomComponents,
    repeatedVerbs,
    checks,
    score: passed,
    maxScore: Object.keys(checks).length
  };
}

const apiIndex = process.argv.indexOf('--api');
const apiBase = apiIndex !== -1 ? process.argv[apiIndex + 1] : null;

if (!apiBase && (!endpoint || !model || !apiKey)) {
  console.error('Set LLM_ENDPOINT, LLM_MODEL and LLM_API_KEY first, or pass --api <base url>.');
  process.exit(1);
}

async function copyViaApi(scenario) {
  const post = async (path, body) => {
    const response = await fetch(`${apiBase}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`${path} returned ${response.status}: ${JSON.stringify(data).slice(0, 200)}`);
    return data;
  };
  const customer = await post('/api/customers', { name: scenario.order.customerName });
  const order = await post('/api/orders', { customerId: customer.id, ...scenario.order });
  const started = Date.now();
  const result = await post(`/api/orders/${order.id}/copy`, { brief: scenario.brief });
  return { copy: result.copy, model: result.model, latencyMs: Date.now() - started };
}

const results = [];
for (const scenario of ORDERS) {
  const messages = buildCopyMessages(scenario.order, scenario.brief);
  try {
    if (apiBase) {
      const produced = await copyViaApi(scenario);
      const score = scoreCopy(scenario.order, produced.copy, scenario.brief);
      results.push({ label: scenario.label, copy: produced.copy, score, ok: true });
      console.log(`\n### ${scenario.label}  ${score.score}/${score.maxScore}  (${produced.latencyMs} ms)`);
      console.log(`headline (${score.headlineChars}): ${produced.copy.headline}`);
      console.log(`body (${score.words} words): ${produced.copy.body}`);
      console.log(`closing (${score.closingChars}): ${produced.copy.closing}`);
      const failedChecks = Object.entries(score.checks).filter(([, ok]) => !ok).map(([name]) => name);
      if (score.echoed.length) console.log(`spec echoed: ${score.echoed.join(', ')}`);
      if (score.claims.length) console.log(`claims: ${score.claims.join(', ')}`);
      if (score.metaWords.length) console.log(`meta talk: ${score.metaWords.join(', ')}`);
    if (score.phantomComponents.length) console.log(`phantom parts: ${score.phantomComponents.join(', ')}`);
      if (failedChecks.length) console.log(`failed checks: ${failedChecks.join(', ')}`);
      continue;
    }
    const reply = await requestChat({
      endpoint,
      model,
      apiKey,
      messages,
      maxTokens: 4000,
      temperature: 0.4
    });
    const copy = parseCopyReply(reply.content);
    const score = scoreCopy(scenario.order, copy, scenario.brief);
    results.push({ label: scenario.label, copy, score, ok: true });
    console.log(`\n### ${scenario.label}  ${score.score}/${score.maxScore}`);
    console.log(`headline (${score.headlineChars}): ${copy.headline}`);
    console.log(`body (${score.words} words): ${copy.body}`);
    console.log(`closing (${score.closingChars}): ${copy.closing}`);
    if (score.banned.length) console.log(`banned: ${score.banned.join(', ')}`);
    if (score.echoed.length) console.log(`spec echoed: ${score.echoed.join(', ')}`);
    if (score.claims.length) console.log(`claims: ${score.claims.join(', ')}`);
    if (score.metaWords.length) console.log(`meta talk: ${score.metaWords.join(', ')}`);
    if (score.phantomComponents.length) console.log(`phantom parts: ${score.phantomComponents.join(', ')}`);
    if (score.inventedNumbers.length) console.log(`invented numbers: ${score.inventedNumbers.join(', ')}`);
    const failed = Object.entries(score.checks).filter(([, ok]) => !ok).map(([name]) => name);
    if (failed.length) console.log(`failed checks: ${failed.join(', ')}`);
  } catch (error) {
    results.push({ label: scenario.label, ok: false, error: error.message });
    console.log(`\n### ${scenario.label}  ERROR: ${error.message}`);
  }
}

const totals = results.reduce(
  (acc, item) => {
    if (!item.ok) {
      acc.errors += 1;
      return acc;
    }
    acc.score += item.score.score;
    acc.max += item.score.maxScore;
    acc.words.push(item.score.words);
    return acc;
  },
  { score: 0, max: 0, errors: 0, words: [] }
);

console.log('\n=== summary ===');
console.log(`scenarios: ${results.length}, errors: ${totals.errors}`);
console.log(`quality checks: ${totals.score}/${totals.max}`);
if (totals.words.length) {
  const avg = Math.round(totals.words.reduce((a, b) => a + b, 0) / totals.words.length);
  console.log(`average body words: ${avg}`);
}

const WATCH_PHRASES = ['nothing here', 'quiet', 'simple', 'warm', 'earns', 'keeps the', 'it is', 'gives the', 'holds'];
const corpus = results.filter((item) => item.ok).map((item) => item.copy.body.toLowerCase());
const repeated = WATCH_PHRASES.map((phrase) => ({
  phrase,
  scenarios: corpus.filter((body) => body.includes(phrase)).length
})).filter((entry) => entry.scenarios > 1);
if (repeated.length) {
  console.log(`repeated across scenarios: ${repeated.map((entry) => `${entry.phrase} (${entry.scenarios})`).join(', ')}`);
}

const saveIndex = process.argv.indexOf('--save');
if (saveIndex !== -1 && process.argv[saveIndex + 1]) {
  writeFileSync(process.argv[saveIndex + 1], JSON.stringify(results, null, 2));
  console.log(`saved to ${process.argv[saveIndex + 1]}`);
}
