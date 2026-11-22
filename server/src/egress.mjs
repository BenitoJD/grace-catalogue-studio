// Network egress guard.
//
// The studio is local software. Apart from the language model the operator
// chose, nothing should leave the machine: no analytics, no fonts, no image
// CDNs, no update service. This wrapper enforces that in code instead of
// relying on a promise. The configured model endpoint, and loopback, are the
// only permitted destinations. An operator can add another origin with
// CATALOG_ALLOWED_EGRESS_ORIGINS if a future integration needs one.

export class EgressBlockedError extends Error {
  constructor(origin, allowed) {
    super(
      `Blocked external network call to ${origin}. Only the configured language model provider may be contacted.`,
    );
    this.name = 'EgressBlockedError';
    this.code = 'EGRESS_BLOCKED';
    this.origin = origin;
    this.allowed = allowed;
  }
}

function originOf(value) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function allowedEgressOrigins(config, env = process.env) {
  const origins = new Set();
  const modelOrigin = originOf(config?.endpoint ?? '');
  if (modelOrigin) origins.add(modelOrigin);
  for (const raw of String(env.CATALOG_ALLOWED_EGRESS_ORIGINS ?? '').split(',')) {
    const origin = originOf(raw.trim());
    if (origin) origins.add(origin);
  }
  return origins;
}

export function isLoopbackHost(hostname) {
  const host = String(hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

export function isAllowedEgressUrl(url, { config = null, env = process.env } = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (isLoopbackHost(parsed.hostname)) return true;
  return allowedEgressOrigins(config, env).has(parsed.origin);
}

/**
 * Replace global fetch with a guarded version. Returns a restore function.
 * `fetchImpl` and `resolveConfig` are injectable for tests.
 */
export function installEgressGuard({ resolveConfig, env = process.env, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') return () => {};
  const guarded = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input?.url;
    const config = typeof resolveConfig === 'function' ? resolveConfig() : null;
    if (!isAllowedEgressUrl(url, { config, env })) {
      throw new EgressBlockedError(originOf(url) ?? String(url), [...allowedEgressOrigins(config, env)]);
    }
    // Never follow a redirect off the allowlist: a provider cannot bounce the
    // studio to another host.
    return fetchImpl(input, { ...init, redirect: 'manual' });
  };
  globalThis.fetch = guarded;
  return () => {
    if (globalThis.fetch === guarded) globalThis.fetch = fetchImpl;
  };
}
