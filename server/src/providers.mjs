// The language model providers the studio knows about.
//
// Every preset is an OpenAI compatible base URL, so one request path works for
// all of them. A provider may add headers or body fields of its own (OpenCode
// needs a session header and asks reasoning models for a direct answer). The
// studio also accepts any other OpenAI compatible endpoint as Custom.

export const PROVIDERS = Object.freeze([
  {
    id: 'deepseek',
    label: 'DeepSeek',
    endpoint: 'https://api.deepseek.com/v1',
    hostnames: ['api.deepseek.com'],
    models: ['deepseek-chat', 'deepseek-reasoner'],
    keyUrl: 'https://platform.deepseek.com/api_keys',
    note: 'Official DeepSeek API. The reasoner model thinks before it answers.',
  },
  {
    id: 'opencode',
    label: 'OpenCode Zen (Go)',
    endpoint: 'https://opencode.ai/zen/go/v1',
    hostnames: ['opencode.ai', 'www.opencode.ai'],
    models: ['deepseek-v4.1-flash', 'deepseek-v4.1-pro', 'qwen3-coder'],
    keyUrl: 'https://opencode.ai/auth',
    note: 'OpenCode Zen Go plan. Needs the OpenCode key, not the CLI login.',
    bodyExtras: { reasoning_effort: 'none' },
  },
  {
    id: 'commandcode',
    label: 'Command Code (Provider API)',
    endpoint: 'https://api.commandcode.ai/provider/v1',
    hostnames: ['api.commandcode.ai'],
    models: ['deepseek-v4-flash', 'deepseek-v4.1-flash', 'gpt-5-6-luna', 'claude-sonnet-4-5'],
    keyUrl: 'https://commandcode.ai/provider',
    note: 'Command Code Provider plan, OpenAI chat completions endpoint. The same key as the CLI.',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    endpoint: 'https://api.openai.com/v1',
    hostnames: ['api.openai.com'],
    models: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'o4-mini'],
    keyUrl: 'https://platform.openai.com/api-keys',
    note: 'Official OpenAI API.',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    endpoint: 'https://openrouter.ai/api/v1',
    hostnames: ['openrouter.ai'],
    models: ['deepseek/deepseek-chat', 'anthropic/claude-sonnet-4', 'google/gemini-2.5-pro'],
    keyUrl: 'https://openrouter.ai/keys',
    note: 'One key for hundreds of models. The model id carries the vendor prefix.',
  },
  {
    id: 'groq',
    label: 'Groq',
    endpoint: 'https://api.groq.com/openai/v1',
    hostnames: ['api.groq.com'],
    models: ['llama-3.3-70b-versatile', 'deepseek-r1-distill-llama-70b'],
    keyUrl: 'https://console.groq.com/keys',
    note: 'Fast inference on open models.',
  },
  {
    id: 'together',
    label: 'Together AI',
    endpoint: 'https://api.together.xyz/v1',
    hostnames: ['api.together.xyz'],
    models: ['deepseek-ai/DeepSeek-V3', 'meta-llama/Llama-3.3-70B-Instruct-Turbo'],
    keyUrl: 'https://api.together.ai/settings/api-keys',
    note: 'Open models hosted by Together.',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    endpoint: 'https://api.mistral.ai/v1',
    hostnames: ['api.mistral.ai'],
    models: ['mistral-large-latest', 'mistral-small-latest'],
    keyUrl: 'https://console.mistral.ai/api-keys',
    note: 'Official Mistral API.',
  },
  {
    id: 'google',
    label: 'Google Gemini',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai',
    hostnames: ['generativelanguage.googleapis.com'],
    models: ['gemini-2.5-pro', 'gemini-2.5-flash'],
    keyUrl: 'https://aistudio.google.com/apikey',
    note: 'Gemini through its OpenAI compatible endpoint.',
  },
  {
    id: 'xai',
    label: 'xAI Grok',
    endpoint: 'https://api.x.ai/v1',
    hostnames: ['api.x.ai'],
    models: ['grok-4', 'grok-3-mini'],
    keyUrl: 'https://console.x.ai',
    note: 'Official xAI API.',
  },
  {
    id: 'ollama',
    label: 'Ollama (this computer)',
    endpoint: 'http://localhost:11434/v1',
    hostnames: ['localhost', '127.0.0.1'],
    models: ['llama3.2', 'qwen2.5-coder'],
    keyOptional: true,
    note: 'Runs on the office machine. No key needed and no internet used.',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio (this computer)',
    endpoint: 'http://localhost:1234/v1',
    hostnames: ['localhost', '127.0.0.1'],
    models: ['local-model'],
    keyOptional: true,
    note: 'Local OpenAI compatible server from LM Studio.',
  },
  {
    id: 'custom',
    label: 'Custom / OpenAI compatible',
    endpoint: '',
    hostnames: [],
    models: [],
    note: 'Any provider that speaks the OpenAI chat completions format.',
  },
]);

const BY_ID = new Map(PROVIDERS.map((provider) => [provider.id, provider]));

export function getProvider(id) {
  return BY_ID.get(String(id ?? '').trim().toLowerCase()) ?? null;
}

export function providerForEndpoint(endpoint) {
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  return (
    PROVIDERS.find((provider) => {
      if (provider.id === 'custom') return false;
      if (!provider.hostnames.some((candidate) => host === candidate)) return false;
      // The same host can host a local model server on another port; only call
      // it that provider when the port matches its documented endpoint.
      try {
        return new URL(provider.endpoint).port === parsed.port;
      } catch {
        return false;
      }
    }) ?? null
  );
}

/** Resolve the provider a config should use: explicit id, then host, then custom. */
export function resolveProvider(id, endpoint) {
  const byId = getProvider(id);
  if (byId) return byId;
  return providerForEndpoint(endpoint) ?? getProvider('custom');
}

/** Public catalog for the app: no secrets, safe to cache. */
export function publicProviders() {
  return PROVIDERS.map((provider) => ({
    id: provider.id,
    label: provider.label,
    endpoint: provider.endpoint,
    models: [...provider.models],
    keyUrl: provider.keyUrl ?? null,
    keyOptional: Boolean(provider.keyOptional),
    note: provider.note ?? '',
  }));
}
