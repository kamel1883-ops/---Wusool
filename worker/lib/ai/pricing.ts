/**
 * Token cost table (USD per 1M tokens) used to estimate every AI call.
 * Values are reviewed when models change; unknown models fall back to a
 * conservative generic rate so usage is never recorded as free by accident.
 */
type ModelRate = { input: number; output: number };

const RATES: Array<{ match: RegExp; rate: ModelRate }> = [
  { match: /gpt-4o-mini/i, rate: { input: 0.15, output: 0.6 } },
  { match: /gpt-4\.1-mini/i, rate: { input: 0.4, output: 1.6 } },
  { match: /gpt-4\.1\b/i, rate: { input: 2.0, output: 8.0 } },
  { match: /gpt-4o\b/i, rate: { input: 2.5, output: 10.0 } },
  { match: /o4-mini|o3-mini/i, rate: { input: 1.1, output: 4.4 } },
  { match: /llama-3/i, rate: { input: 0.2, output: 0.2 } },
];

const GENERIC_RATE: ModelRate = { input: 0.5, output: 1.5 };

export function rateForModel(model: string): ModelRate {
  const name = String(model ?? '');
  for (const entry of RATES) {
    if (entry.match.test(name)) return entry.rate;
  }
  return GENERIC_RATE;
}

/** Estimated cost in micro-dollars (integer, D1-friendly). */
export function estimateCostMicros(model: string, inputTokens: number, outputTokens: number): number {
  const rate = rateForModel(model);
  const micros = (Number(inputTokens) || 0) * (rate.input / 1_000_000) * 1_000_000 +
    (Number(outputTokens) || 0) * (rate.output / 1_000_000) * 1_000_000;
  return Math.max(0, Math.round(micros));
}
