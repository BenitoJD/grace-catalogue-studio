// Small structured logger. Every line is one JSON object written to stdout so
// an operations team can pipe the server log straight into a log collector.
//
// Request logs use exactly: time, level, requestId, method, path, status,
// durationMs. Operational logs use time, level, msg and optional extra fields.
// Request bodies and headers are never logged.

export const LOG_LEVELS = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
});

export const DEFAULT_LOG_LEVEL = 'info';

// Accepts any casing and trims whitespace. Unknown values fall back to info so
// a typo in the environment cannot silence the log.
export function parseLogLevel(value) {
  if (typeof value !== 'string') return DEFAULT_LOG_LEVEL;
  const normalised = value.trim().toLowerCase();
  return Object.hasOwn(LOG_LEVELS, normalised) ? normalised : DEFAULT_LOG_LEVEL;
}

export function isLogLevel(name) {
  return typeof name === 'string' && Object.hasOwn(LOG_LEVELS, name);
}

// The level a request is recorded at, based on how it was answered.
export function levelForStatus(status) {
  if (status >= 500) return 'error';
  if (status >= 400) return 'warn';
  return 'info';
}

/**
 * Build a logger bound to a minimum level.
 *
 * `write` is called with the finished record object; the default writes one
 * JSON line to stdout. Tests can pass their own sink.
 */
export function createLogger({
  level = parseLogLevel(process.env.LOG_LEVEL),
  now = () => new Date(),
  write,
  stream = process.stdout,
} = {}) {
  const threshold = LOG_LEVELS[level] ?? LOG_LEVELS.info;

  function emit(recordLevel, record) {
    if ((LOG_LEVELS[recordLevel] ?? LOG_LEVELS.info) < threshold) return;
    const line = {
      time: now().toISOString(),
      level: recordLevel,
      ...record,
    };
    if (typeof write === 'function') {
      write(line);
      return;
    }
    stream.write(`${JSON.stringify(line)}\n`);
  }

  return {
    level,
    /** True when a record at this level would be written. */
    enabled(recordLevel) {
      return (LOG_LEVELS[recordLevel] ?? LOG_LEVELS.info) >= threshold;
    },
    debug(msg, fields = {}) {
      emit('debug', { msg, ...fields });
    },
    info(msg, fields = {}) {
      emit('info', { msg, ...fields });
    },
    warn(msg, fields = {}) {
      emit('warn', { msg, ...fields });
    },
    error(msg, fields = {}) {
      emit('error', { msg, ...fields });
    },
    /** Structured access log line for one request. */
    request({ requestId, method, path, status, durationMs }) {
      emit(levelForStatus(status), {
        requestId,
        method,
        path,
        status,
        durationMs,
      });
    },
  };
}
