// One place for the studio's internal instructions. Built in defaults are
// registered by the server, edits are stored in the settings table, and every
// consumer resolves the live text at call time.

const defaults = new Map();
let store = {
  get: () => null,
  set: () => {},
  remove: () => false,
};

export const PROMPT_KEYS = Object.freeze({
  assistant: 'prompt_assistant',
  designer: 'prompt_designer',
  vision: 'prompt_vision',
  quality: 'prompt_quality',
});

export const PROMPT_CATALOG = Object.freeze([
  {
    id: 'assistant',
    key: PROMPT_KEYS.assistant,
    label: 'Studio assistant',
    description:
      'The instructions the agent follows in the chat: workflow, when to read pictures, create the order, design, edit and reply.',
  },
  {
    id: 'designer',
    key: PROMPT_KEYS.designer,
    label: 'Page designer',
    description:
      'The art direction rules the model follows when it composes the pamphlet or brochure pages.',
  },
  {
    id: 'vision',
    key: PROMPT_KEYS.vision,
    label: 'Picture analyst',
    description:
      'How every uploaded picture is read: the piece, room, colours, details and the mood, materials, light and composition notes.',
  },
  {
    id: 'quality',
    key: PROMPT_KEYS.quality,
    label: 'Art director judge',
    description:
      'The scoring system that decides whether a design is world class, and the concrete fixes it sends back.',
  },
]);

export function registerPromptDefaults(values) {
  for (const [id, value] of Object.entries(values ?? {})) {
    if (typeof value === 'string' && value.trim() !== '') defaults.set(id, value);
  }
}

export function configurePromptStore(next) {
  store = {
    get: typeof next?.get === 'function' ? next.get : store.get,
    set: typeof next?.set === 'function' ? next.set : store.set,
    remove: typeof next?.remove === 'function' ? next.remove : store.remove,
  };
}

export function defaultPrompt(id) {
  return defaults.get(id) ?? '';
}

export function resolvePrompt(id, fallback = '') {
  try {
    const stored = store.get(PROMPT_KEYS[id]);
    if (typeof stored === 'string' && stored.trim() !== '') return stored;
  } catch {
    // A settings read problem must never stop a design.
  }
  return fallback !== '' ? fallback : defaultPrompt(id);
}

export function listPrompts() {
  return PROMPT_CATALOG.map((entry) => {
    const builtIn = defaultPrompt(entry.id);
    let value = null;
    let updatedAt = null;
    try {
      const setting = store.get(entry.key);
      if (setting && typeof setting === 'object') {
        value = typeof setting.value === 'string' && setting.value.trim() !== '' ? setting.value : null;
        updatedAt = setting.updatedAt ?? null;
      } else if (typeof setting === 'string' && setting.trim() !== '') {
        value = setting;
      }
    } catch {
      value = null;
    }
    return {
      ...entry,
      value: value ?? builtIn,
      isDefault: value === null,
      updatedAt,
    };
  });
}

export function savePrompt(id, value) {
  const entry = PROMPT_CATALOG.find((candidate) => candidate.id === id);
  if (!entry) return null;
  const text = String(value ?? '').trim();
  if (text === '') {
    store.remove(entry.key);
    return listPrompts().find((candidate) => candidate.id === id) ?? null;
  }
  store.set(entry.key, text.slice(0, 60_000));
  return listPrompts().find((candidate) => candidate.id === id) ?? null;
}

export function resetPrompt(id) {
  const entry = PROMPT_CATALOG.find((candidate) => candidate.id === id);
  if (!entry) return null;
  store.remove(entry.key);
  return listPrompts().find((candidate) => candidate.id === id) ?? null;
}
