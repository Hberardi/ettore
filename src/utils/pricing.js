// Pricing per 1M tokens { in: $/1M input, out: $/1M output, ctx: context window tokens }

const PRICING = {
  // OpenAI
  'gpt-4o':              { in: 2.50,  out: 10.00, ctx: 128000  },
  'gpt-4o-mini':         { in: 0.15,  out: 0.60,  ctx: 128000  },
  'gpt-4-turbo':         { in: 10.00, out: 30.00, ctx: 128000  },
  'gpt-4':               { in: 30.00, out: 60.00, ctx: 8192    },
  'gpt-3.5-turbo':       { in: 0.50,  out: 1.50,  ctx: 16385   },
  'o1':                  { in: 15.00, out: 60.00, ctx: 200000  },
  'o1-mini':             { in: 3.00,  out: 12.00, ctx: 128000  },
  'o3':                  { in: 10.00, out: 40.00, ctx: 200000  },
  'o3-mini':             { in: 1.10,  out: 4.40,  ctx: 200000  },
  'o4-mini':             { in: 1.10,  out: 4.40,  ctx: 200000  },
  // Anthropic
  'claude-opus-4':       { in: 15.00, out: 75.00, ctx: 200000  },
  'claude-sonnet-4':     { in: 3.00,  out: 15.00, ctx: 200000  },
  'claude-3-5-sonnet':   { in: 3.00,  out: 15.00, ctx: 200000  },
  'claude-3-5-haiku':    { in: 0.80,  out: 4.00,  ctx: 200000  },
  'claude-3-opus':       { in: 15.00, out: 75.00, ctx: 200000  },
  'claude-3-sonnet':     { in: 3.00,  out: 15.00, ctx: 200000  },
  'claude-3-haiku':      { in: 0.25,  out: 1.25,  ctx: 200000  },
  // Groq
  'llama-3.3-70b':       { in: 0.59,  out: 0.79,  ctx: 128000  },
  'llama-3.1-70b':       { in: 0.59,  out: 0.79,  ctx: 131072  },
  'llama-3.1-8b':        { in: 0.05,  out: 0.08,  ctx: 131072  },
  'llama-3.2-90b':       { in: 0.90,  out: 0.90,  ctx: 128000  },
  'llama-3.2-11b':       { in: 0.18,  out: 0.18,  ctx: 128000  },
  'llama-3.2-3b':        { in: 0.06,  out: 0.06,  ctx: 128000  },
  'mixtral-8x7b':        { in: 0.24,  out: 0.24,  ctx: 32768   },
  'gemma2-9b':           { in: 0.20,  out: 0.20,  ctx: 8192    },
  'deepseek-r1':         { in: 0.55,  out: 2.19,  ctx: 65536   },
  'deepseek-v3':         { in: 0.27,  out: 1.10,  ctx: 65536   },
  // Google Gemini
  'gemini-2.0-flash':    { in: 0.10,  out: 0.40,  ctx: 1000000 },
  'gemini-2.5-pro':      { in: 1.25,  out: 10.00, ctx: 1000000 },
  'gemini-1.5-pro':      { in: 1.25,  out: 5.00,  ctx: 2000000 },
  'gemini-1.5-flash':    { in: 0.075, out: 0.30,  ctx: 1000000 },
  // Mistral
  'mistral-large':       { in: 3.00,  out: 9.00,  ctx: 128000  },
  'codestral':           { in: 1.00,  out: 3.00,  ctx: 256000  },
  'mistral-small':       { in: 0.20,  out: 0.60,  ctx: 128000  },
  'pixtral':             { in: 0.15,  out: 0.15,  ctx: 128000  },
  // Together / Cerebras / NVIDIA (approximate)
  'qwen2.5-72b':         { in: 1.20,  out: 1.20,  ctx: 131072  },
  'nemotron-70b':        { in: 0.97,  out: 0.97,  ctx: 131072  },
  // xAI (Grok)
  'grok-3':              { in: 3.00,  out: 15.00, ctx: 131072  },
  'grok-3-mini':         { in: 0.30,  out: 0.50,  ctx: 131072  },
  'grok-2':              { in: 2.00,  out: 10.00, ctx: 131072  },
  // Perplexity
  'sonar-pro':           { in: 3.00,  out: 15.00, ctx: 127072  },
  'sonar-reasoning-pro': { in: 2.00,  out: 8.00,  ctx: 127072  },
  'sonar':               { in: 1.00,  out: 1.00,  ctx: 127072  },
  // DeepSeek (direct API — slightly different from Groq)
  'deepseek-r1-0528':    { in: 0.55,  out: 2.19,  ctx: 65536   },
  // Cohere
  'command-r-plus':      { in: 2.50,  out: 10.00, ctx: 128000  },
  'command-r':           { in: 0.15,  out: 0.60,  ctx: 128000  },
  'command-a':           { in: 2.50,  out: 10.00, ctx: 256000  },
  // MiniMax
  'minimax-text-01':     { in: 0.28,  out: 1.12,  ctx: 1000000 },
  'minimax-m2.7':        { in: 0.50,  out: 2.00,  ctx: 128000  },
  // Moonshot (Kimi)
  'kimi-k2':             { in: 0.60,  out: 2.50,  ctx: 131072  },
  'moonshot-v1-128k':    { in: 0.80,  out: 0.80,  ctx: 131072  },
  // Zhipu GLM
  'glm-4':               { in: 0.10,  out: 0.10,  ctx: 128000  },
  'glm-4-flash':         { in: 0.01,  out: 0.01,  ctx: 128000  },
  // Qwen
  'qwen-plus':           { in: 0.40,  out: 1.20,  ctx: 131072  },
  'qwen-turbo':          { in: 0.05,  out: 0.20,  ctx: 131072  },
  'qwen2.5-max':         { in: 1.60,  out: 6.40,  ctx: 32768   },
  // SambaNova
  'llama-3.1-405b':      { in: 5.00,  out: 10.00, ctx: 16384   },
  // AI21
  'jamba-2.0':           { in: 0.50,  out: 0.70,  ctx: 256000  },
  'jamba-1.5-large':     { in: 2.00,  out: 8.00,  ctx: 256000  },
  'jamba-1.5-mini':      { in: 0.20,  out: 0.40,  ctx: 256000  },
};

export function getModelPricing(modelId) {
  if (!modelId) return { in: null, out: null, ctx: 128000 };
  const id = modelId.toLowerCase();
  if (PRICING[id]) return PRICING[id];
  // prefix / substring match (handles versioned names like gpt-4o-2024-11-20)
  for (const [key, val] of Object.entries(PRICING)) {
    if (id.startsWith(key) || id.includes(key)) return val;
  }
  return { in: null, out: null, ctx: 128000 };
}

export function calcCost(inputTokens, outputTokens, modelId) {
  const p = getModelPricing(modelId);
  if (p.in === null) return null;
  return (inputTokens / 1e6) * p.in + (outputTokens / 1e6) * p.out;
}

export function formatCost(dollars) {
  if (dollars === null || dollars === undefined) return null;
  if (dollars === 0) return '$0.000';
  if (dollars < 0.001) return '<$0.001';
  if (dollars < 0.01)  return `$${dollars.toFixed(4)}`;
  if (dollars < 1)     return `$${dollars.toFixed(3)}`;
  return `$${dollars.toFixed(2)}`;
}

export function formatTokens(n) {
  if (!n) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
