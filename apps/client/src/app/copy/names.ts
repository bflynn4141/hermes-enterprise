// Brand and model names as a person reads them.
//
// docs/DESIGN.md, "Never on screen": provider slugs (`nous_portal`) and model
// ids (`nous:anthropic/claude-sonnet-5`) stay in the data. The screen says
// "Nous Portal" and "Claude Sonnet 5".

const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  nous_portal: 'Nous Portal',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  deepseek: 'DeepSeek',
  openrouter: 'OpenRouter',
};

/** The model vendors a Nous Portal catalog groups by, keyed by the id's prefix. */
const VENDOR_NAMES: Readonly<Record<string, string>> = {
  ...PROVIDER_NAMES,
  google: 'Google',
  'meta-llama': 'Meta',
  meta: 'Meta',
  mistralai: 'Mistral',
  mistral: 'Mistral',
  'x-ai': 'xAI',
  xai: 'xAI',
  qwen: 'Qwen',
  moonshotai: 'Moonshot AI',
  'z-ai': 'Z.ai',
  nousresearch: 'Nous Research',
  nous: 'Nous Research',
  stepfun: 'StepFun',
  minimax: 'MiniMax',
  cohere: 'Cohere',
  amazon: 'Amazon',
  microsoft: 'Microsoft',
  nvidia: 'NVIDIA',
  perplexity: 'Perplexity',
  ai21: 'AI21',
  baidu: 'Baidu',
  bytedance: 'ByteDance',
  tencent: 'Tencent',
  ibm: 'IBM',
  inflection: 'Inflection',
  liquid: 'Liquid AI',
  other: 'Other',
  Direct: 'Direct',
};

/** Words whose casing a plain title-case would get wrong. */
const WORD_CASE: Readonly<Record<string, string>> = {
  gpt: 'GPT', glm: 'GLM', ai: 'AI', deepseek: 'DeepSeek', openai: 'OpenAI', llama: 'Llama', qwen: 'Qwen',
  minimax: 'MiniMax', stepfun: 'StepFun', grok: 'Grok', oss: 'OSS', vl: 'VL', r1: 'R1', o1: 'o1', o3: 'o3', o4: 'o4',
};

const sentenceWords = (value: string): string =>
  value.replace(/[_-]+/g, ' ').trim().replace(/^\w/, (c) => c.toUpperCase());

/** "nous_portal" → "Nous Portal". An unknown provider still reads as words. */
export function providerName(provider: string | null | undefined): string {
  if (!provider) return 'your model provider';
  return PROVIDER_NAMES[provider] ?? sentenceWords(provider);
}

/** "anthropic" → "Anthropic", "meta-llama" → "Meta". */
export function vendorName(vendor: string): string {
  return VENDOR_NAMES[vendor] ?? VENDOR_NAMES[vendor.toLowerCase()] ?? sentenceWords(vendor);
}

/**
 * A model id as a name, for when the catalog has no label for it:
 * `nous:deepseek/deepseek-v4.1-flash` → "DeepSeek V4.1 Flash",
 * `nous:anthropic/claude-sonnet-5` → "Claude Sonnet 5".
 */
export function modelNameFromId(modelId: string): string {
  const afterProvider = modelId.includes(':') ? modelId.slice(modelId.indexOf(':') + 1) : modelId;
  const name = (afterProvider.split('/').pop() || afterProvider).replace(/:free$/, '');
  const words = name.split(/[-_\s]+/).filter(Boolean).map((word) => {
    const lower = word.toLowerCase();
    if (WORD_CASE[lower]) return WORD_CASE[lower];
    if (/^v\d/.test(lower)) return `V${word.slice(1)}`;
    if (/^\d/.test(word)) return word;
    return word.charAt(0).toUpperCase() + word.slice(1);
  });
  return words.join(' ') || 'A model';
}

/** The catalog's label when there is one; otherwise the id as a name. */
export function modelName(
  modelId: string | null | undefined,
  catalog: ReadonlyArray<{ readonly model_id: string; readonly label: string }> = [],
): string {
  if (!modelId) return 'Model not recorded';
  return catalog.find((row) => row.model_id === modelId)?.label ?? modelNameFromId(modelId);
}
