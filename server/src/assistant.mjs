// The Pi agent that drives the studio chat. Pi supplies the agent loop, tool
// calling and provider abstraction. This module supplies the studio tools, so
// the assistant can read pictures, create the order, design the brochure and
// edit it, all from one conversation.
import { Agent } from '@earendil-works/pi-agent-core';
import { getCurrentTools } from '@earendil-works/pi-ai';
import { providerHeaders } from './llm.mjs';

const ASSISTANT_TIMEOUT_MS = 900_000;

const SYSTEM_PROMPT = [
  'You are the studio assistant for Jacob Design Studio, an interior and joinery workshop in Nagercoil.',
  'The person in the chat is a salesperson preparing a customer brochure.',
  '',
  'WORKFLOW',
  '1. When pictures are attached, call read_pictures first. Never ask the customer for the room or the piece: read them and say in one short sentence what you see, then ask them to confirm.',
  '2. The only fact you must ask for is the customer name. Ask "Who is the customer?" when it is unknown.',
  '3. Once you have the customer name, never wait: call create_order, then call design_brochure for that order. The chat shows the brochure once it exists.',
  '4. After an order exists, every sentence from the studio is an edit. Use update_order for words the customer said and design_brochure to re-compose the pages. Attach new pictures first with the edit if they arrive.',
  '5. When the studio names a detail to magnify, pass it as the direction of design_brochure.',
  '',
  'RULES',
  '- Keep replies to one or two short sentences. Warm, plain British Indian English. No em dashes and no en dashes.',
  '- Never invent a customer name, a price, a date, a dimension or a material.',
  '- Do not describe how the software works. Talk about the project.',
  '- Use tools instead of saying you cannot do something.',
  '- After design_brochure, reply with one short sentence that the brochure is ready and its page count.',
].join('\n');

const TOOL_SPECS = [
  {
    name: 'read_pictures',
    label: 'Read pictures',
    description:
      'Read the pictures attached to this chat and return the room, the piece, the colours and the joinery details worth magnifying. Always call this first when pictures are attached.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'create_order',
    label: 'Create order',
    description:
      'Create the customer and the order for this chat, using the pictures attached to the conversation. Returns the order id and number. Call once, after the customer name is known.',
    parameters: {
      type: 'object',
      properties: {
        customerName: { type: 'string', description: 'The customer name the studio gave.' },
        title: { type: 'string', description: 'The piece, read from the pictures.' },
        room: { type: 'string', description: 'The room, read from the pictures.' },
        brief: { type: 'string', description: 'One short sentence about what the customer asked.' },
      },
      required: ['customerName'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_order',
    label: 'Update order',
    description: 'Update order text fields from a studio sentence, before re-designing.',
    parameters: {
      type: 'object',
      properties: {
        orderId: { type: 'string' },
        title: { type: 'string' },
        room: { type: 'string' },
        brief: { type: 'string' },
        designDirection: { type: 'string' },
      },
      required: ['orderId'],
      additionalProperties: false,
    },
  },
  {
    name: 'design_brochure',
    label: 'Design brochure',
    description:
      'Design and print the brochure for an order with the current pictures, the copy and the studio direction. Returns the render with page count and PDF url.',
    parameters: {
      type: 'object',
      properties: {
        orderId: { type: 'string' },
        direction: {
          type: 'string',
          description: 'The studio sentence for the designer, including any detail to magnify.',
        },
      },
      required: ['orderId'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_order',
    label: 'Read order',
    description: 'Read one order with its attachments and status.',
    parameters: {
      type: 'object',
      properties: { orderId: { type: 'string' } },
      required: ['orderId'],
      additionalProperties: false,
    },
  },
];

function textResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value };
}

/**
 * Turn one chat turn into Pi tool executions. `callApi` performs an internal
 * request against the studio API, so every tool reuses the validated routes.
 */
export function createStudioTools({ callApi, attachments, state }) {
  const call = async (path, body, method = 'POST') => {
    const response = await callApi(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text === '' ? null : JSON.parse(text);
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const message = payload?.error?.message ?? payload?.error ?? text.slice(0, 200);
      throw new Error(String(message));
    }
    return payload;
  };

  return [
    {
      ...TOOL_SPECS[0],
      execute: async () => {
        if (attachments.length === 0) {
          return textResult({ pictures: [], note: 'No pictures are attached to this chat.' });
        }
        const review = await call('/api/analyze-images', {
          images: attachments.slice(0, 12).map((file) => file.url),
        });
        return textResult({
          pictures: (review?.photos ?? []).map((photo) => ({
            name: photo.label ?? photo.name,
            reading: photo.insight ?? null,
            palette: (photo.analysis?.palette ?? []).slice(0, 4),
            details: (photo.analysis?.candidates ?? []).map((candidate) => candidate.label),
          })),
        });
      },
    },
    {
      ...TOOL_SPECS[1],
      executionMode: 'sequential',
      execute: async (_toolCallId, params) => {
        if (state.orderId) {
          return textResult({ orderId: state.orderId, orderNo: state.orderNo, note: 'Order already created.' });
        }
        const customer = await call('/api/customers', { name: params.customerName });
        const order = await call('/api/orders', {
          customerId: customer.id,
          title: params.title ?? '',
          room: params.room ?? '',
          brief: params.brief ?? '',
          attachments,
        });
        state.orderId = order.id;
        state.orderNo = order.orderNo;
        state.order = order;
        return textResult({ orderId: order.id, orderNo: order.orderNo, title: order.title, room: order.room });
      },
    },
    {
      ...TOOL_SPECS[2],
      execute: async (_toolCallId, params) => {
        const orderId = params.orderId ?? state.orderId;
        if (!orderId) throw new Error('No order exists yet.');
        const patch = {};
        for (const key of ['title', 'room', 'brief', 'designDirection']) {
          if (typeof params[key] === 'string' && params[key].trim() !== '') patch[key] = params[key].trim();
        }
        const order = await call(`/api/orders/${encodeURIComponent(orderId)}`, patch, 'PATCH');
        state.order = order;
        return textResult({ orderId: order.id, orderNo: order.orderNo, title: order.title, room: order.room });
      },
    },
    {
      ...TOOL_SPECS[3],
      executionMode: 'sequential',
      execute: async (_toolCallId, params) => {
        const orderId = params.orderId ?? state.orderId;
        if (!orderId) throw new Error('Create the order before designing the brochure.');
        const result = await call(`/api/orders/${encodeURIComponent(orderId)}/ai-brochure`, {
          ...(typeof params.direction === 'string' && params.direction.trim() !== ''
            ? { direction: params.direction.trim() }
            : {}),
        });
        state.render = result?.render ?? null;
        state.orderId = orderId;
        return textResult({
          orderId,
          pageCount: result?.render?.pageCount ?? 0,
          pdfUrl: result?.render?.pdfUrl ?? null,
        });
      },
    },
    {
      ...TOOL_SPECS[4],
      execute: async (_toolCallId, params) => {
        const orderId = params.orderId ?? state.orderId;
        if (!orderId) throw new Error('No order exists yet.');
        const order = await call(`/api/orders/${encodeURIComponent(orderId)}`, undefined, 'GET');
        return textResult({ order });
      },
    },
  ];
}

function openAiMessages(messages) {
  const list = [];
  for (const message of messages ?? []) {
    if (message.role === 'system') {
      const text = typeof message.content === 'string'
        ? message.content
        : (message.content ?? []).map((part) => part.text ?? '').join('\n');
      if (text.trim() !== '') list.push({ role: 'system', content: text });
      continue;
    }
    if (message.role === 'user') {
      if (typeof message.content === 'string') {
        list.push({ role: 'user', content: message.content });
        continue;
      }
      const parts = (message.content ?? []).map((part) => {
        if (part.type === 'image') {
          return {
            type: 'image_url',
            image_url: { url: `data:${part.mimeType ?? 'image/png'};base64,${part.data}` },
          };
        }
        return { type: 'text', text: part.text ?? '' };
      });
      list.push({ role: 'user', content: parts });
      continue;
    }
    if (message.role === 'assistant') {
      const blocks = Array.isArray(message.content) ? message.content : [];
      const text = blocks
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')
        .trim();
      const toolCalls = blocks
        .filter((block) => block.type === 'toolCall')
        .map((block) => ({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: JSON.stringify(block.arguments ?? {}) },
        }));
      list.push({
        role: 'assistant',
        content: text,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }
    if (message.role === 'toolResult') {
      const text = (message.content ?? [])
        .map((part) => (part.type === 'text' ? part.text : ''))
        .join('')
        .trim();
      list.push({ role: 'tool', tool_call_id: message.toolCallId, content: text });
    }
  }
  return list;
}

function assistantMessage(model, blocks, stopReason, errorMessage, providerUsage = null) {
  const input = Number(providerUsage?.prompt_tokens ?? 0) || 0;
  const output = Number(providerUsage?.completion_tokens ?? 0) || 0;
  return {
    role: 'assistant',
    content: blocks,
    api: 'openai-completions',
    provider: 'studio',
    model: model.id,
    usage: {
      input,
      output,
      cacheRead: Number(providerUsage?.prompt_tokens_details?.cached_tokens ?? 0) || 0,
      cacheWrite: 0,
      totalTokens: Number(providerUsage?.total_tokens ?? input + output) || input + output,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    ...(errorMessage ? { errorMessage } : {}),
    stopReason,
    timestamp: Date.now(),
  };
}

function streamFrom(message) {
  const events = [
    { type: 'start', partial: message },
    {
      type: 'done',
      reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop',
      message,
    },
  ];
  const iterator = (async function* emit() {
    for (const event of events) yield event;
  })();
  return {
    [Symbol.asyncIterator]: () => iterator[Symbol.asyncIterator](),
    result: async () => message,
  };
}

/**
 * Our own provider transport for the agent: one OpenAI compatible chat
 * completion, non streaming, the same headers and endpoint the rest of the
 * studio already uses. Pi still owns the agent loop, tools and transcript.
 */
export function createStudioStreamFn(config, fetchImpl = globalThis.fetch) {
  const base = String(config.endpoint ?? '').replace(/\/+$/, '');
  const apiKey = String(config.apiKey ?? '');
  const headers = { ...providerHeaders(base, apiKey, config.provider ?? null) };
  const model = {
    id: config.model,
    name: config.model,
    api: 'openai-completions',
    provider: 'studio',
    baseUrl: base,
    input: ['text', 'image'],
    reasoning: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8000,
  };

  async function streamFn(requestModel, context) {
    const tools = getCurrentTools(context.messages).map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
    const body = {
      model: requestModel.id,
      messages: openAiMessages(context.messages),
      max_tokens: 8000,
      temperature: 0.2,
      ...(tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
    };
    const response = await fetchImpl(`${base}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(150_000),
    });
    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`The model refused the request (${response.status}): ${raw.slice(0, 240)}`);
    }
    let payload;
    try {
      payload = raw === '' ? null : JSON.parse(raw);
    } catch {
      throw new Error('The model returned a reply that was not JSON.');
    }
    const choice = payload?.choices?.[0]?.message ?? {};
    const text = typeof choice.content === 'string' ? choice.content.trim() : '';
    const calls = Array.isArray(choice.tool_calls) ? choice.tool_calls : [];
    const blocks = [];
    if (text !== '') blocks.push({ type: 'text', text });
    for (const call of calls) {
      let args = {};
      try {
        args = JSON.parse(call?.function?.arguments ?? '{}');
      } catch {
        args = {};
      }
      blocks.push({
        type: 'toolCall',
        id: String(call?.id ?? `call-${blocks.length}`),
        name: String(call?.function?.name ?? ''),
        arguments: args,
      });
    }
    if (blocks.length === 0) {
      blocks.push({ type: 'text', text: 'Noted.' });
    }
    const stopReason = calls.length > 0 ? 'toolUse' : 'stop';
    return streamFrom(assistantMessage(requestModel, blocks, stopReason, null, payload?.usage));
  }

  return { model, streamFn, apiKey };
}

function agentHistory(messages) {
  return (messages ?? [])
    .filter((message) => message && (message.role === 'user' || message.role === 'assistant'))
    .filter((message) => typeof message.content === 'string' && message.content.trim() !== '')
    .map((message) => ({ role: message.role, content: message.content.trim(), timestamp: Date.now() }));
}

// The detached chat history is folded into one context line instead of being
// replayed as assistant messages. Pi owns its transcript for the turn, so a
// half formed assistant message from the app can never disturb the model call.
function contextLine(history, orderId) {
  const lines = history.map((message) =>
    `${message.role === 'assistant' ? 'Studio' : 'Customer'}: ${message.content.replace(/\s+/g, ' ').slice(0, 600)}`,
  );
  const orderLine = orderId ? `The order already exists: ${orderId}.` : '';
  const joined = lines.slice(-8).join('\n');
  return [orderLine, joined ? `Conversation so far:\n${joined}` : ''].filter(Boolean).join('\n');
}

/**
 * Run one assistant turn through Pi. `modelsOverride` lets tests supply Pi's
 * faux provider so the whole loop runs offline and deterministically.
 */
export async function runAssistantTurn({
  config,
  messages,
  attachments = [],
  orderId = null,
  previousMessages = [],
  callApi,
  logger,
  modelsOverride = null,
}) {
  let model;
  let streamFn;
  let apiKey = String(config?.apiKey ?? '');
  if (modelsOverride) {
    model = modelsOverride.model;
    streamFn = modelsOverride.streamFn ?? modelsOverride.models.streamSimple.bind(modelsOverride.models);
    apiKey = modelsOverride.apiKey ?? apiKey;
  } else {
    if (!config || String(config.endpoint ?? '').trim() === '' || String(config.model ?? '').trim() === '') {
      throw new Error('No model is configured for the studio assistant.');
    }
    const runtime = createStudioStreamFn(config);
    model = runtime.model;
    streamFn = runtime.streamFn;
    apiKey = runtime.apiKey;
  }
  const state = { orderId, orderNo: null, order: null, render: null, toolCalls: [] };
  const tools = createStudioTools({ callApi, attachments, state });
  const history = agentHistory(messages);
  const last = history.pop();
  if (!last || last.role !== 'user') {
    throw new Error('The assistant needs a message from the studio.');
  }
  const context = contextLine(history, state.orderId);
  const prompt = context === '' ? last.content : `${context}\n\nStudio: ${last.content}`;

  const restored = (Array.isArray(previousMessages) ? previousMessages : [])
    .filter(
      (message) =>
        message &&
        (message.role === 'user' || message.role === 'assistant' || message.role === 'toolResult') &&
        message.role !== 'system',
    )
    .slice(-60);
  const agent = new Agent({
    initialState: {
      systemPrompt: SYSTEM_PROMPT,
      model,
      tools,
      messages: restored,
    },
    streamFn,
    beforeToolCall: async ({ toolCall }) => {
      if (toolCall.name === 'create_order' && state.orderId) {
        return { block: true, reason: 'The order already exists; edit it instead of creating another.' };
      }
      if (toolCall.name === 'design_brochure' && !state.orderId) {
        return { block: true, reason: 'Create the order before designing the brochure.' };
      }
      return undefined;
    },
    getApiKey: async () => apiKey,
  });
  agent.subscribe((event) => {
    if (event.type === 'tool_execution_end') {
      state.toolCalls.push({ name: event.toolName, error: Boolean(event.isError) });
    }
  });

  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('The studio assistant took too long. Try again.')), ASSISTANT_TIMEOUT_MS);
  });
  try {
    await Promise.race([agent.prompt(prompt), timeout]);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger?.warn?.('The studio assistant turn failed.', { reason });
    agent.abort();
    // The order is real work that already completed; never throw it away.
    if (state.orderId) {
      const transcript = transcriptOf(agent);
      return {
        reply:
          state.render
            ? 'The brochure is ready.'
            : 'The order is saved. The brochure did not finish this time; ask me to design it again and I will retry.',
        orderId: state.orderId,
        orderNo: state.orderNo,
        order: state.order,
        render: state.render,
        toolCalls: state.toolCalls,
        transcript,
        usage: usageOf(agent),
        failed: true,
        failure: reason,
      };
    }
    throw error;
  }

  const lastAssistant = [...agent.state.messages]
    .reverse()
    .find((message) => message.role === 'assistant');
  if (lastAssistant && (lastAssistant.stopReason === 'error' || lastAssistant.stopReason === 'aborted')) {
    throw new Error(lastAssistant.errorMessage || 'The model could not answer the chat turn.');
  }

  const replies = agent.state.messages
    .filter((message) => message.role === 'assistant')
    .flatMap((message) => {
      const content = message.content;
      if (typeof content === 'string') return [content];
      if (!Array.isArray(content)) return [];
      return content
        .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text);
    })
    .filter(Boolean);
  const reply = replies.at(-1)?.trim() ?? '';

  return {
    reply,
    orderId: state.orderId,
    orderNo: state.orderNo,
    order: state.order,
    render: state.render,
    toolCalls: state.toolCalls,
    transcript: transcriptOf(agent),
    usage: usageOf(agent),
  };
}

// The transcript is stored as plain JSON, one Pi message per entry, so the
// next turn restores the real conversation including the tool calls.
function transcriptOf(agent) {
  return (agent.state.messages ?? [])
    .filter((message) => message && message.role !== 'system')
    .slice(-80)
    .map((message) => {
      try {
        return JSON.parse(JSON.stringify(message));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function usageOf(agent) {
  const usage = { input: 0, output: 0, totalTokens: 0 };
  for (const message of agent.state.messages ?? []) {
    if (message.role !== 'assistant' || !message.usage) continue;
    usage.input += Number(message.usage.input ?? 0);
    usage.output += Number(message.usage.output ?? 0);
    usage.totalTokens += Number(message.usage.totalTokens ?? 0);
  }
  return usage;
}

export { SYSTEM_PROMPT, TOOL_SPECS };
