/**
 * OpenAI-compatible provider (OpenAI, AI Gateway, Workers AI OpenAI endpoint,
 * or any proxy speaking /v1/chat/completions + /v1/models).
 *
 * The API key is read from the Worker environment only — it is never sent to
 * the browser, stored in D1, logged, or included in an error message.
 * Transient failures (network, 429, 5xx, malformed JSON) are retried with
 * backoff; authentication and client errors fail immediately with stable codes.
 */
import {
  type AiAnalysis,
  type AIProvider,
  type AnalyzeInput,
  ProviderError,
  normalizeResult,
} from './types';
import { estimateCostMicros } from './pricing';

const MAX_PROMPT_CHARS = 18_000;
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [900, 2200];

export type OpenAIOptions = { apiKey: string; baseUrl: string; model: string };

const SYSTEM_PROMPT = `You are a B2B marketing analyst for a Saudi agency.
You receive text extracted from a company's public website. Return ONE JSON object
with exactly this shape (no markdown, no commentary):

{"company_profile":{"company_name":{"value":"","source":"website|inference|suggestion|missing","confidence":0},"industry":{...},"summary":{...}},
"mission":{...},"vision":{...},
"values":[],...,"missing_information":[],"assumptions_requiring_review":[]}

Rules:
- Array items are objects {"value":"","source":"website|inference|suggestion|missing","confidence":0,"evidence_url":""}.
- source "website" ONLY if the value is literally supported by the supplied text
  (something the company wrote about itself: name, service, fact, contact).
- source "inference" for conclusions you derive from website facts (e.g. the
  industry, the audience, a strength implied by the content).
- source "suggestion" for YOUR recommendations: campaigns, channels, content
  pillars, roadmap steps, KPIs, value propositions you propose. These are advice,
  not facts — never mark them "website".
- source "missing" with an empty value when the text says nothing about it.
- Never invent addresses, phone numbers, prices, certifications, clients or statistics.
- Put every empty/unstated item in missing_information as a question for the client.
- Write values in the requested language: ar, en, or ar-en for both.`;

function buildUserPrompt(input: AnalyzeInput) {
  const parts: string[] = [
    `Website: ${input.url}`,
    `Output language: ${input.locale}`,
    'Pages:',
  ];
  let budget = MAX_PROMPT_CHARS;
  for (const page of input.pages) {
    if (budget <= 0) break;
    const slice = page.contentMarkdown.slice(0, Math.min(4000, budget));
    budget -= slice.length;
    parts.push(`\n--- ${page.url} — ${page.title}\n${slice}`);
  }
  return parts.join('\n');
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const classifyHttpError = (status: number): ProviderError => {
  if (status === 401 || status === 403) return new ProviderError('ai_provider_unauthorized');
  if (status === 429) return new ProviderError('ai_rate_limited', `status_${status}`);
  if (status >= 500) return new ProviderError('ai_provider_unavailable', `status_${status}`);
  return new ProviderError('ai_provider_failed', `status_${status}`);
};

/** Retryable codes: transport/429/5xx plus one malformed-JSON retry. */
export const isRetryableAiError = (error: unknown) =>
  error instanceof ProviderError &&
  ['ai_provider_unreachable', 'ai_rate_limited', 'ai_provider_unavailable', 'ai_invalid_response'].includes(
    error.code
  );

export class OpenAIProvider implements AIProvider {
  readonly name = 'openai';

  constructor(private options: OpenAIOptions) {}

  get model() {
    return this.options.model;
  }

  private endpoint(path: string) {
    return `${this.options.baseUrl.replace(/\/+$/, '')}${path}`;
  }

  private async postChat(body: Record<string, unknown>): Promise<any> {
    let response: Response;
    try {
      response = await fetch(this.endpoint('/chat/completions'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(45_000),
      });
    } catch {
      // Never surface the upstream error text (it can echo the request).
      throw new ProviderError('ai_provider_unreachable');
    }
    if (!response.ok) throw classifyHttpError(response.status);
    const payload: any = await response.json().catch(() => null);
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new ProviderError('ai_invalid_response');
    }
    return { payload, content };
  }

  async analyzeSite(input: AnalyzeInput): Promise<AiAnalysis> {
    if (!this.options.apiKey) throw new ProviderError('ai_provider_not_configured');

    const body = {
      model: this.options.model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(input) },
      ],
    };

    let lastError: unknown = new ProviderError('ai_provider_failed');
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        const { payload, content } = await this.postChat(body);
        let parsed: unknown;
        try {
          parsed = JSON.parse(content);
        } catch {
          throw new ProviderError('ai_invalid_response');
        }
        const inputTokens = Number(payload?.usage?.prompt_tokens ?? 0) || 0;
        const outputTokens = Number(payload?.usage?.completion_tokens ?? 0) || 0;
        return {
          result: normalizeResult(parsed),
          usage: {
            provider: 'openai',
            model: this.options.model,
            operation: 'site_analysis',
            inputTokens,
            outputTokens,
            estimatedCostMicros: estimateCostMicros(this.options.model, inputTokens, outputTokens),
          },
        };
      } catch (error) {
        lastError = error;
        if (!isRetryableAiError(error) || attempt === MAX_ATTEMPTS) break;
        await sleep(BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)]);
      }
    }
    throw lastError;
  }
}

export type ConnectionTestOutcome =
  | { ok: true; modelCount: number }
  | { ok: false; code: string };

/**
 * Connection test for Super Admin: lists models (no tokens spent, no content
 * generated). Returns a stable code on failure; the key is never echoed.
 */
export async function testOpenAIConnection(options: OpenAIOptions): Promise<ConnectionTestOutcome> {
  if (!options.apiKey) return { ok: false, code: 'ai_provider_not_configured' };
  let response: Response;
  try {
    response = await fetch(`${options.baseUrl.replace(/\/+$/, '')}/models`, {
      method: 'GET',
      headers: { authorization: `Bearer ${options.apiKey}` },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return { ok: false, code: 'ai_provider_unreachable' };
  }
  if (!response.ok) return { ok: false, code: classifyHttpError(response.status).code };
  const payload: any = await response.json().catch(() => null);
  const models = Array.isArray(payload?.data) ? payload.data : [];
  return { ok: true, modelCount: models.length };
}
