/** Claude API list prices, USD per million tokens. Batch API halves every line. */
export const PRICES = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
} as const;

export type PricedModel = keyof typeof PRICES;

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export function isPricedModel(m: string): m is PricedModel {
  return m in PRICES;
}

export function costUsd(model: string, usage: TokenUsage, opts: { batch?: boolean } = {}): number {
  if (!isPricedModel(model)) return 0;
  const p = PRICES[model];
  const usd =
    (usage.input_tokens * p.input +
      usage.output_tokens * p.output +
      (usage.cache_read_input_tokens ?? 0) * p.cacheRead +
      (usage.cache_creation_input_tokens ?? 0) * p.cacheWrite) /
    1_000_000;
  return opts.batch ? usd / 2 : usd;
}
