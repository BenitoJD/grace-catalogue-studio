/**
 * Central API client for the Grace Catalogue Studio.
 *
 * The base URL comes from EXPO_PUBLIC_API_URL at build time, with the local
 * development server as the fallback agreed in CONTRACT.md.
 */

const rawBaseUrl = process.env.EXPO_PUBLIC_API_URL ?? '';

function normaliseBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  return trimmed.replace(/\/+$/, '');
}

/**
 * Where the API lives.
 *
 * Builds can set EXPO_PUBLIC_API_URL. When they do not:
 * - on a phone or simulator, localhost is the development machine
 * - on the web in development, the API runs on 8787
 * - on the web in production, the app is served behind the same host as the API,
 *   so same origin is the safest default
 */
function defaultBaseUrl(): string {
  if (typeof window !== 'undefined' && window.location && window.location.hostname) {
    const host = window.location.hostname;
    const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0';
    return isLocal ? 'http://localhost:8787' : window.location.origin;
  }
  return 'http://localhost:8787';
}

export const API_BASE_URL = normaliseBaseUrl(rawBaseUrl) || defaultBaseUrl();

export type OrderStatus = 'draft' | 'approved';

/** What the model chose for a generated brochure, kept with the render. */
export interface AiDesign {
  label?: string | null;
  designed?: boolean;
  direction?: string;
}

export interface AiBrochureBody {
  brief?: string;
  direction?: string;
  copy?: BrochureCopy;
  /** A studio sentence to apply to the brochure that already exists. */
  edit?: string;
}

export interface Customer {
  id: string;
  name: string;
  phone: string;
  address: string;
  createdAt: string;
}

export interface Order {
  id: string;
  orderNo: string;
  customerId: string;
  customerName: string;
  title: string;
  room: string;
  width: string;
  height: string;
  depth: string;
  shutters: string;
  carcass: string;
  backPanel: string;
  shuttersMat: string;
  drawers: string;
  exterior: string;
  interior: string;
  hinges: string;
  channels: string;
  edgeShutter: string;
  edgeCarcass: string;
  edgeNote: string;
  handle: string;
  handleNote: string;
  finishExt: string;
  finishInt: string;
  status: OrderStatus;
  brief?: string;
  designDirection?: string;
  copy?: BrochureCopy | null;
  attachments?: OrderAttachment[];
  createdAt: string;
}

export interface BrochureCopy {
  headline: string;
  body: string;
  closing: string;
}

export interface GeneratedCopy {
  copy: BrochureCopy;
  model: string;
  latencyMs: number;
}

export interface Material {
  id: string;
  name: string;
  kind: string;
  hex: string;
  imageUrl: string | null;
  priceAmount?: number;
  priceUnit?: string;
  sku?: string;
  createdAt: string;
}


export interface Render {
  id: string;
  orderId: string;
  kind: 'voucher' | 'kit' | 'catalogue' | 'ai';
  templateId: string | null;
  design?: Record<string, unknown> | null;
  pageCount: number;
  pdfUrl: string;
  pageUrls: string[];
  createdAt: string;
}

export interface LlmSettings {
  provider: string;
  providerLabel: string;
  endpoint: string;
  model: string;
  hasKey: boolean;
  keyOptional: boolean;
  source: 'settings' | 'env' | 'none';
  updatedAt: string | null;
}

export interface LlmProvider {
  id: string;
  label: string;
  endpoint: string;
  models: string[];
  keyUrl: string | null;
  keyOptional: boolean;
  note: string;
}

export interface LlmTestResult {
  ok: boolean;
  latencyMs?: number;
  model?: string;
  sample?: string;
  error?: { message?: string; status?: number; type?: string };
}

export interface ReviewCandidate {
  id: string;
  label: string;
  /** Circle centre as a percentage of the photograph. */
  x: number;
  y: number;
  /** The colour inside the magnified area, named like a paint chip. */
  hex: string;
  name: string;
}

export interface AssistantProgress {
  sessionId: string;
  stage: string;
  label: string;
  detail?: string;
  startedAt: number;
  updatedAt: number;
  elapsedMs: number;
  finished: boolean;
  steps: { stage: string; label: string; at: number }[];
}

export interface AssistantReply {
  assistant?: boolean;
  sessionId?: string;
  reply: string;
  order?: Order | null;
  orderId?: string | null;
  orderNo?: string | null;
  render?: Render | null;
  review?: ReviewPhoto[] | null;
  toolCalls?: { name: string; error?: boolean }[];
  usage?: { input: number; output: number; cacheRead?: number; totalTokens: number } | null;
  failed?: boolean;
  failure?: string | null;
}

export interface ReviewPhoto {
  /** The uploaded file. A PDF is shown through its first page preview. */
  url: string;
  /** PNG page image for a PDF, otherwise equal to url. */
  previewUrl?: string;
  name: string;
  /** Human label: the uploaded file name, or "sheet.pdf · page 1 of 3". */
  label?: string;
  /** What the vision model read in this picture, when it can see. */
  insight?: {
    summary?: string;
    piece?: string;
    room?: string;
    colours?: string[];
  };
  analysis: {
    width: number;
    height: number;
    orientation: string;
    palette: { hex: string; name: string }[];
    candidates: ReviewCandidate[];
  };
}

export interface OrderPalette {
  /** photo1, photo2 and so on, in upload order. */
  photo: string;
  /** Four hex colours read from that photograph. */
  colors: string[];
  /** Their showroom names, the way a paint card names a colour. */
  names: string[];
}

export interface OrderAttachment {
  url: string;
  name: string;
  contentType: string;
  bytes: number;
}

export interface IntakeMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface IntakeResult {
  reply: string;
  draft: Record<string, string>;
  missing: string[];
  ready: boolean;
  model: string;
  latencyMs: number;
}

export interface OrderNote {
  note: string;
  model: string;
  latencyMs: number;
}

export interface Bootstrap {
  customers: Customer[];
  orders: Order[];
  materials: Material[];
}

export interface NewCustomerInput {
  name: string;
  phone?: string;
  address?: string;
}

/** Order fields accepted by POST /api/orders. */
export interface NewOrderInput {
  customerId: string;
  title: string;
  room: string;
  width: string;
  height: string;
  depth: string;
  shutters: string;
  carcass: string;
  backPanel: string;
  shuttersMat: string;
  drawers: string;
  exterior: string;
  interior: string;
  hinges: string;
  channels: string;
  edgeShutter: string;
  edgeCarcass: string;
  edgeNote: string;
  handle: string;
  handleNote: string;
  finishExt: string;
  finishInt: string;
  brief?: string;
  attachments?: OrderAttachment[];
}

export interface HealthResponse {
  assistant?: boolean;
  ok: boolean;
  version: string;
}

export class ApiError extends Error {
  readonly url: string;
  readonly status?: number;

  constructor(message: string, url: string, status?: number) {
    super(message);
    this.name = 'ApiError';
    this.url = url;
    this.status = status;
  }
}

const DEFAULT_TIMEOUT_MS = 20000;
const RENDER_TIMEOUT_MS = 120000;

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface RequestOptions {
  method?: Method;
  body?: unknown;
  timeoutMs?: number;
}

function messageFromBody(body: unknown): string | null {
  if (body && typeof body === 'object' && 'error' in body) {
    const value = (body as { error?: unknown }).error;
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
    // The language model routes answer { ok: false, error: { message, type } }.
    if (value && typeof value === 'object' && 'message' in value) {
      const nested = (value as { message?: unknown }).message;
      if (typeof nested === 'string' && nested.trim().length > 0) {
        return nested.trim();
      }
    }
  }
  return null;
}

function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { name?: string }).name === 'AbortError');
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const url = `${API_BASE_URL}${path}`;
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const headers: Record<string, string> = { Accept: 'application/json' };
  let body: string | undefined;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  try {
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      headers,
      body,
      signal: controller.signal,
    });

    const raw = await response.text();
    let parsed: unknown;
    if (raw.trim().length > 0) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = raw;
      }
    }

    if (!response.ok) {
      const serverMessage = messageFromBody(parsed);
      throw new ApiError(
        serverMessage ?? `The API answered with status ${response.status}.`,
        url,
        response.status,
      );
    }

    return parsed as T;
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    if (isAbortError(error)) {
      throw new ApiError('The API took too long to answer. Try again.', url);
    }
    throw new ApiError(
      'Cannot reach the studio engine. Close and reopen the app, then try again.',
      url,
    );
  } finally {
    clearTimeout(timer);
  }
}

function encodeId(id: string): string {
  return encodeURIComponent(id);
}

export const api = {
  health(): Promise<HealthResponse> {
    return request<HealthResponse>('/health');
  },
  bootstrap(): Promise<Bootstrap> {
    return request<Bootstrap>('/api/bootstrap');
  },
  listOrders(): Promise<Order[]> {
    return request<Order[]>('/api/orders');
  },
  assistant(input: {
    messages: { role: 'user' | 'assistant'; content: string }[];
    orderId?: string;
    sessionId?: string;
    attachments?: OrderAttachment[];
  }): Promise<AssistantReply> {
    return request<AssistantReply>('/api/assistant', {
      method: 'POST',
      body: input,
      timeoutMs: 2100000,
    });
  },

  assistantProgress(sessionId: string): Promise<{ progress: AssistantProgress | null }> {
    return request<{ progress: AssistantProgress | null }>(
      `/api/assistant/progress/${encodeURIComponent(sessionId)}`,
    );
  },

  analyzeImages(images: string[]): Promise<{ photos: ReviewPhoto[] }> {
    return request<{ photos: ReviewPhoto[] }>('/api/analyze-images', {
      method: 'POST',
      body: { images },
    });
  },

  orderPalettes(id: string): Promise<{ palettes: OrderPalette[] }> {
    return request<{ palettes: OrderPalette[] }>(`/api/orders/${id}/palettes`);
  },

  getOrder(id: string): Promise<Order> {
    return request<Order>(`/api/orders/${encodeId(id)}`);
  },
  listCustomers(): Promise<Customer[]> {
    return request<Customer[]>('/api/customers');
  },
  createCustomer(input: NewCustomerInput): Promise<Customer> {
    return request<Customer>('/api/customers', { method: 'POST', body: input });
  },
  createOrder(input: NewOrderInput): Promise<Order> {
    return request<Order>('/api/orders', { method: 'POST', body: { ...input } });
  },
  renderOrder(id: string, kind: Render['kind'] = 'voucher', templateId?: string): Promise<Render> {
    return request<Render>(`/api/orders/${encodeId(id)}/render`, {
      method: 'POST',
      body: templateId ? { kind, templateId } : { kind },
      timeoutMs: RENDER_TIMEOUT_MS,
    });
  },
  getLlmSettings(): Promise<LlmSettings> {
    return request<LlmSettings>('/api/llm/settings');
  },
  saveLlmSettings(input: {
    provider?: string;
    endpoint?: string;
    model?: string;
    apiKey?: string;
  }): Promise<LlmSettings> {
    return request<LlmSettings>('/api/llm/settings', { method: 'PUT', body: input });
  },
  listProviders(): Promise<{ providers: LlmProvider[] }> {
    return request<{ providers: LlmProvider[] }>('/api/llm/providers');
  },
  intake(
    messages: IntakeMessage[],
    draft?: Record<string, string>,
    attachments?: OrderAttachment[],
    skip?: string[]
  ): Promise<IntakeResult> {
    return request<IntakeResult>('/api/intake', {
      method: 'POST',
      body: { messages, draft, attachments, skip },
      timeoutMs: 120000,
    });
  },
  editOrder(
    orderId: string,
    message: string,
    attachments: OrderAttachment[] = []
  ): Promise<{
    reply: string;
    order: Order;
    copy: BrochureCopy | null;
    attachmentsAdded: number;
    rerender: boolean;
    changedOrder: boolean;
  }> {
    return request(`/api/orders/${orderId}/edit`, {
      method: 'POST',
      body: { message, attachments },
      timeoutMs: 120000,
    });
  },
  aiBrochure(
    orderId: string,
    body: AiBrochureBody = {}
  ): Promise<{
    render: Render;
    design: AiDesign;
    copy: BrochureCopy;
    direction?: string;
  }> {
    return request(`/api/orders/${orderId}/ai-brochure`, {
      method: 'POST',
      body,
      timeoutMs: 180000,
    });
  },
  generateOrderCopy(
    orderId: string,
    input: { brief?: string; regenerate?: boolean } = {}
  ): Promise<GeneratedCopy> {
    return request<GeneratedCopy>(`/api/orders/${encodeId(orderId)}/copy`, {
      method: 'POST',
      body: input,
      timeoutMs: 90000,
    });
  },
  draftOrderNote(orderId: string): Promise<OrderNote> {
    return request<OrderNote>(`/api/orders/${encodeId(orderId)}/note`, {
      method: 'POST',
      body: {},
      timeoutMs: 45000,
    });
  },
  uploadFile(
    data: string,
    name: string,
    contentType: string
  ): Promise<{ url: string; contentType: string; bytes: number; name: string }> {
    return request('/api/media', {
      method: 'POST',
      body: { data, name, contentType },
      timeoutMs: 120000,
    });
  },
  uploadImage(data: string, contentType: string): Promise<{ url: string; contentType: string; bytes: number }> {
    return request('/api/media', {
      method: 'POST',
      body: { data, contentType },
      timeoutMs: 60000,
    });
  },
  renderCatalogue(templateId?: string): Promise<Render> {
    return request<Render>('/api/catalogue/render', {
      method: 'POST',
      body: templateId ? { templateId } : {},
      timeoutMs: RENDER_TIMEOUT_MS,
    });
  },
  listRenders(): Promise<Render[]> {
    return request<Render[]>('/api/renders');
  },
};

/**
 * Calls the configured model and always resolves with the parsed body, because a
 * failing test returns the provider's own message and that is the useful part.
 */
export async function testLlmConnection(): Promise<LlmTestResult> {
  const url = `${API_BASE_URL}/api/llm/test`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(url, { method: 'POST', signal: controller.signal });
    const body = (await response.json().catch(() => null)) as LlmTestResult | null;
    if (body && typeof body.ok === 'boolean') {
      return body;
    }
    return { ok: false, error: { message: `The server replied ${response.status}.` } };
  } catch (error) {
    return {
      ok: false,
      error: { message: error instanceof Error ? error.message : 'The test could not reach the server.' },
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Turn a server relative path such as /files/x.pdf into an absolute URL. */
export function fileUrl(pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) {
    return pathOrUrl;
  }
  const path = pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`;
  return `${API_BASE_URL}${path}`;
}

/** Readable message for anything thrown by the API client. */
export function errorMessage(error: unknown, fallback = 'Something went wrong. Try again.'): string {
  if (error instanceof ApiError) {
    return error.message;
  }
  if (error && typeof error === 'object' && (error as { name?: string }).name === 'ApiError') {
    const message = (error as { message?: string }).message;
    return message && message.trim().length > 0 ? message : fallback;
  }
  return fallback;
}
