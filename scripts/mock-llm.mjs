// Minimal OpenAI compatible mock provider. Useful for local testing and for the
// browser suite, so the product can be exercised without spending credits.
//
//   node scripts/mock-llm.mjs [port]
//
// Then point the studio at http://127.0.0.1:<port>/v1 with any key.
import { createServer } from 'node:http';

const port = Number.parseInt(process.argv[2] ?? '8793', 10);

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
    const user = messages.find((message) => message.role === 'user')?.content ?? '';
    const isConnectionTest = String(user).includes('single word ok');
    const content = isConnectionTest ? 'ok' : NOTE;

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
