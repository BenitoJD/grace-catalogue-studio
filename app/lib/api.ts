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

export const API_BASE_URL = normaliseBaseUrl(rawBaseUrl) || 'http://localhost:8787';

export type OrderStatus = 'draft' | 'approved';

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
  createdAt: string;
}

export interface Material {
  id: string;
  name: string;
  kind: string;
  hex: string;
  imageUrl: string | null;
  createdAt: string;
}

export interface Render {
  id: string;
  orderId: string;
  kind: 'voucher' | 'kit';
  templateId: string | null;
  pageCount: number;
  pdfUrl: string;
  pageUrls: string[];
  createdAt: string;
}

export interface Template {
  id: string;
  name: string;
  palette: string;
  cover: string;
  family?: string;
  previewUrl: string;
  pageCount: number;
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
}

export interface HealthResponse {
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

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

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
      `Cannot reach the API at ${API_BASE_URL}. Check that the server is running.`,
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
  listTemplates(): Promise<Template[]> {
    return request<Template[]>('/api/templates');
  },
  listRenders(): Promise<Render[]> {
    return request<Render[]>('/api/renders');
  },
};

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
