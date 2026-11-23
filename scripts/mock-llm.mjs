// Minimal OpenAI compatible mock provider. Useful for local testing and for the
// browser suite, so the product can be exercised without spending credits.
//
//   node scripts/mock-llm.mjs [port]
//
// Then point the studio at http://127.0.0.1:<port>/v1 with any key.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const port = Number.parseInt(process.argv[2] ?? '8793', 10);
const here = path.dirname(fileURLToPath(import.meta.url));
const DESIGNER_HTML = readFileSync(path.join(here, 'fixtures', 'designer-reply.html'), 'utf8');

const CATALOG_PALETTES = [
  { paper: '#FBF3E4', ink: '#2A1512', deep: '#4A1116', accent: '#7C2A22', gold: '#C79A3A', hair: '#E3D2B8', muted: '#6B4A3E', onDark: '#FBF3E4' },
  { paper: '#F8F3E6', ink: '#142A28', deep: '#123B3A', accent: '#1E5C5A', gold: '#D9B76A', hair: '#D9D2BC', muted: '#4C615C', onDark: '#F8F3E6' },
  { paper: '#FBF4E7', ink: '#2B1A0F', deep: '#5A2A1E', accent: '#A65E22', gold: '#E8C27A', hair: '#E4D3B8', muted: '#6B4E36', onDark: '#FBF4E7' },
  { paper: '#F8F2E3', ink: '#12222E', deep: '#0D3350', accent: '#16537E', gold: '#E8C27A', hair: '#D8D0BC', muted: '#4A5B66', onDark: '#F8F2E3' },
  { paper: '#FAF4E8', ink: '#241B10', deep: '#3F3218', accent: '#5C6B3C', gold: '#B9A46A', hair: '#E2D8C2', muted: '#5F6651', onDark: '#FAF4E8' }
];
const CATALOG_FAMILIES = ['Atelier', 'Ledger', 'Jaali', 'Monsoon', 'Kolam', 'Verandah', 'Bazaar', 'Manuscript', 'Courtyard', 'Silk Route', 'Laterite', 'Palm Court'];
const CATALOG_ORNAMENTS = ['jaali', 'paisley', 'lotus', 'rangoli', 'arch', 'none'];

function catalogReply(prompt) {
  const count = Math.min(25, Number.parseInt(/Write (\d+) new design references/.exec(prompt)?.[1] ?? '25', 10) || 25);
  const existing = /These references already exist[\s\S]*?:\n([^\n]+)/.exec(prompt)?.[1] ?? '';
  const start = existing === '' ? 0 : existing.split(',').length;
  const designs = Array.from({ length: count }, (_, index) => {
    const number = start + index + 1;
    return {
      id: `look-${number}`,
      name: `Quiet Paper ${number}`,
      family: CATALOG_FAMILIES[number % CATALOG_FAMILIES.length],
      mood: 'quiet, warm, measured',
      summary: 'A calm printed look with warm paper and one precise accent',
      palette: CATALOG_PALETTES[number % CATALOG_PALETTES.length],
      displayFont: number % 2 === 0 ? 'Barlow' : 'Instrument Serif',
      bodyFont: 'Barlow',
      coverIdea: 'A tall photograph with the title low and the brand at the head',
      ornament: CATALOG_ORNAMENTS[number % CATALOG_ORNAMENTS.length]
    };
  });
  return JSON.stringify({ designs });
}

const COPY = {
  headline: 'Built to the millimetre',
  body:
    'This wardrobe is made for the master bedroom, 2400 by 2100 mm, with three shutters in warm oak ' +
    'and a matching edge band so the grain runs unbroken across the front. Inside, white laminate keeps ' +
    'the interior bright, with hanging on the left, adjustable shelves and two drawers in the middle, ' +
    'and long hanging on the right. The matte black handles sit vertically so the line of the shutters ' +
    'stays quiet. Every panel is cut, banded and bored in our workshop before assembly.',
  closing: 'Drawings follow for your approval before we cut.'
};

const NOTE = [
  'Good morning Mr. Kumar. Your master bedroom wardrobe is drafted at 2400 by 2100 mm,',
  'three shutters in warm oak with a matching edge band. The inside is white laminate,',
  'matte black handles. We will send the shop drawing for your approval this week.'
].join(' ');

function readBody(request) {
  return new Promise((resolve) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 200000) {
        request.destroy();
      }
    });
    request.on('end', () => resolve(body));
  });
}

function send(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body)
  });
  response.end(body);
}

createServer(async (request, response) => {
  if (request.method === 'GET' && request.url?.endsWith('/models')) {
    send(response, 200, {
      object: 'list',
      data: [{ id: 'mock-flash', object: 'model', owned_by: 'mock' }]
    });
    return;
  }

  if (request.method === 'POST' && request.url?.endsWith('/chat/completions')) {
    const raw = await readBody(request);
    let body = {};
    try {
      body = JSON.parse(raw);
    } catch {
      send(response, 400, { error: { message: 'Body was not JSON.' } });
      return;
    }
    if (!request.headers.authorization?.startsWith('Bearer ')) {
      send(response, 401, { error: { message: 'Missing bearer token.' } });
      return;
    }

    const messages = Array.isArray(body.messages) ? body.messages : [];
    const prompt = messages.map((message) => String(message.content ?? '')).join('\n').toLowerCase();
    const isConnectionTest = prompt.includes('single word ok');
    const isCatalogRequest = prompt.includes('house library of printed brochure design references');
    const isDesignRequest = prompt.includes('art director, typographer and print designer');
    const isEditRequest = prompt.includes('you edit one existing furniture order');
    const isIntakeRequest = prompt.includes('order intake assistant');
    const isCopyRequest = !isIntakeRequest && !isCatalogRequest && !isDesignRequest && prompt.includes('headline') && prompt.includes('json');

    const EDIT = {
      reply: 'Done. I changed the shutters to dark walnut and updated the brochure.',
      order: { handle: 'Matte black aluminium', finishExt: 'Dark walnut laminate outside' },
      copy: {
        headline: 'A walnut wardrobe for the guest room',
        body:
          'The guest room keeps one long wall for storage, and the wardrobe takes it from end to end without crowding the bed. Three shutters divide the face into equal parts, so the eye reads proportion before hardware. Dark walnut laminate outside settles the wall, while the interior stays white so a folded shirt is easy to find. Lower drawers take the bedding, and the hanging space above takes the suitcases that arrive with visitors. The handles run vertically, one set to each shutter, a thin dark line against the warm front. At 600 mm deep the wardrobe holds what a guest brings and still leaves the floor clear. Nothing about the piece asks for attention; it simply keeps the room ready.',
        closing: 'Drawn to the wall it stands against.'
      },
      rerender: true
    };

    let intake = null;
    if (isIntakeRequest) {
      const transcript = messages
        .filter((message) => message.role === 'user')
        .map((message) => String(message.content ?? ''))
        .filter((content) => !content.startsWith('Order so far'));
      const said = transcript.join(' ').toLowerCase();
      const complete =
        /(width|wide)/.test(said) &&
        /(height|high)/.test(said) &&
        /(depth|deep)/.test(said) &&
        /(shutter|door)/.test(said);
      intake = complete
        ? {
            reply: 'Noted. The brochure can be made.',
            order: {
              customerName: 'Anita Kumar',
              title: 'Master Bedroom Wardrobe',
              room: 'Master bedroom',
              width: '2400 mm',
              height: '2100 mm',
              depth: '600 mm',
              shutters: '3',
              brief: 'loft storage and a lighter oak finish'
            },
            ready: true
          }
        : {
            reply: 'Noted. What is the height and how many shutters?',
            order: {
              customerName: 'Anita Kumar',
              title: 'Master Bedroom Wardrobe',
              room: 'Master bedroom',
              width: '2400 mm'
            },
            ready: false
          };
    }

    const content = isConnectionTest
      ? 'ok'
      : isCatalogRequest
        ? catalogReply(messages.map((message) => String(message.content ?? '')).join('\n'))
        : isEditRequest
          ? JSON.stringify(EDIT)
          : isDesignRequest
            ? DESIGNER_HTML
            : isIntakeRequest
              ? JSON.stringify(intake)
              : isCopyRequest
                ? JSON.stringify(COPY)
                : NOTE;

    // A small delay so latency numbers look real in the UI.
    setTimeout(() => {
      send(response, 200, {
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        model: body.model ?? 'mock-flash',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 20, completion_tokens: 40, total_tokens: 60 }
      });
    }, isConnectionTest ? 60 : 350);
    return;
  }

  send(response, 404, { error: { message: 'Not found.' } });
}).listen(port, '127.0.0.1', () => {
  console.log(`mock llm provider on http://127.0.0.1:${port}/v1`);
});
