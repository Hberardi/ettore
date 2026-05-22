export const PROVIDER_ENV_VARS = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  nvidia: ['NVIDIA_API_KEY', 'NVIDIA_NIM_API_KEY'],
  groq: ['GROQ_API_KEY'],
  google: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  together: ['TOGETHER_API_KEY'],
  cerebras: ['CEREBRAS_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  xai: ['XAI_API_KEY'],
  perplexity: ['PERPLEXITY_API_KEY'],
  fireworks: ['FIREWORKS_API_KEY'],
  sambanova: ['SAMBANOVA_API_KEY'],
  hyperbolic: ['HYPERBOLIC_API_KEY'],
  cohere: ['COHERE_API_KEY'],
  ai21: ['AI21_API_KEY'],
  novita: ['NOVITA_API_KEY'],
  upstage: ['UPSTAGE_API_KEY'],
  lepton: ['LEPTON_API_KEY'],
  minimax: ['MINIMAX_API_KEY'],
  moonshot: ['MOONSHOT_API_KEY'],
  zhipu: ['ZHIPU_API_KEY'],
  yi: ['YI_API_KEY'],
  qwen: ['QWEN_API_KEY'],
  baichuan: ['BAICHUAN_API_KEY'],
  stepfun: ['STEPFUN_API_KEY'],
  hunyuan: ['HUNYUAN_API_KEY'],
};

export function getProviderEnvVars(providerName) {
  return PROVIDER_ENV_VARS[String(providerName || '').toLowerCase()] || [];
}

export function getProviderEnvKey(providerName, env = process.env) {
  for (const name of getProviderEnvVars(providerName)) {
    const value = env[name];
    if (value) return { name, value };
  }
  return null;
}

export function listConfiguredEnvProviders(env = process.env) {
  return Object.entries(PROVIDER_ENV_VARS)
    .filter(([, names]) => names.some(name => !!env[name]))
    .map(([provider]) => provider);
}
