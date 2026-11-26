// Live progress for one agent turn. The chat polls this while the agent works,
// so the studio can see whether it is reading pictures, making the order or
// designing the pages instead of staring at a spinner.
const sessions = new Map();
const MAX_AGE_MS = 60 * 60 * 1000;

function prune() {
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const [id, value] of sessions) {
    if (value.updatedAt < cutoff) sessions.delete(id);
  }
}

export function setAssistantProgress(sessionId, update) {
  const id = String(sessionId ?? '').trim();
  if (id === '') return;
  prune();
  const previous = sessions.get(id);
  const now = Date.now();
  const steps = Array.isArray(previous?.steps) ? [...previous.steps] : [];
  if (update.stage) {
    const existing = steps.find((step) => step.stage === update.stage);
    if (existing) existing.label = update.label ?? existing.label;
    else steps.push({ stage: update.stage, label: update.label ?? update.stage, at: now });
  }
  // A full activity feed, one line per real action. Steps are stage summary,
  // events are what the studio wants to read: round, score, fixes, print.
  const events = Array.isArray(previous?.events) ? [...previous.events] : [];
  const label = update.label ?? update.event;
  if (typeof label === 'string' && label.trim() !== '') {
    const last = events[events.length - 1];
    if (!last || last.label !== label.trim()) {
      events.push({
        label: label.trim(),
        detail: update.detail ?? '',
        stage: update.stage ?? previous?.stage ?? 'working',
        at: now,
      });
      while (events.length > 30) events.shift();
    }
  }
  sessions.set(id, {
    sessionId: id,
    stage: update.stage ?? previous?.stage ?? 'working',
    label: update.label ?? previous?.label ?? 'Working on the brochure',
    detail: update.detail ?? previous?.detail ?? '',
    startedAt: previous?.startedAt ?? now,
    updatedAt: now,
    finished: update.finished ?? false,
    steps,
    events,
  });
}

export function getAssistantProgress(sessionId) {
  prune();
  const value = sessions.get(String(sessionId ?? '').trim());
  if (!value) return null;
  return { ...value, events: Array.isArray(value.events) ? value.events : [], elapsedMs: Date.now() - value.startedAt };
}

export function finishAssistantProgress(sessionId, update = {}) {
  setAssistantProgress(sessionId, {
    stage: update.stage ?? 'done',
    label: update.label ?? 'Finished',
    finished: true,
  });
}
