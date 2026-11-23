import type { Order } from '@/lib/api';

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** Short readable date: 21 Nov 2026. */
export function formatDate(value: string | null | undefined): string {
  if (!value) {
    return '';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

/** Date and time together: 21 Nov 2026, 4:32 pm. */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) {
    return '';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const suffix = hours >= 12 ? 'pm' : 'am';
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${formatDate(value)}, ${hour12}:${minutes} ${suffix}`;
}

/** Joins the stored dimension strings, skipping anything left blank. */
export function orderDimensions(order: Pick<Order, 'width' | 'height' | 'depth'>): string {
  const parts: string[] = [];
  if (order.width.trim()) {
    parts.push(`W ${order.width.trim()}`);
  }
  if (order.height.trim()) {
    parts.push(`H ${order.height.trim()}`);
  }
  if (order.depth.trim()) {
    parts.push(`D ${order.depth.trim()}`);
  }
  return parts.join(' · ');
}

/** Longest first so the newest drafted orders are on top. */
export function sortOrders(orders: Order[]): Order[] {
  return [...orders].sort((a, b) => {
    const timeA = Date.parse(a.createdAt);
    const timeB = Date.parse(b.createdAt);
    if (!Number.isNaN(timeA) && !Number.isNaN(timeB) && timeA !== timeB) {
      return timeB - timeA;
    }
    return b.orderNo.localeCompare(a.orderNo);
  });
}

/** Trimmed value, or a quiet placeholder for missing specs. */
export function displayValue(value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : 'Not set';
}

export function pageCountLabel(count: number): string {
  if (count === 1) {
    return '1 page';
  }
  return `${count} pages`;
}

export function statusLabel(status: Order['status']): string {
  return status === 'approved' ? 'Approved' : 'Draft';
}
