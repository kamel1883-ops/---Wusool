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

const MAX_PROMPT_CHARS = 9_000;
const MAX_ATTEMPTS = 2;
const BACKOFF_MS = [900, 2200];
// Hosted open models can take well over a minute for a full report; too short
// a timeout turns a slow success into a hard "unreachable" failure.
const CHAT_TIMEOUT_MS = 90_000;

export type OpenAIOptions = { apiKey: string; baseUrl: string; model: string };

const SYSTEM_PROMPT = `You are a B2B marketing analyst for a Saudi agency.
You receive text extracted from a company's public website. Return ONE JSON object
with EVERY key below present (no markdown, no commentary). Never omit a key and
never shorten the object with ellipses:

{
  "company_profile": { "company_name": FIELD, "industry": FIELD, "summary": FIELD },
  "mission": FIELD,
  "vision": FIELD,
  "values": [ITEM],
  "products_and_services": [ITEM],
  "target_markets": [ITEM],
  "target_locations": [ITEM],
  "audiences": [ITEM],
  "buyer_personas": [ITEM],
  "customer_problems": [ITEM],
  "value_proposition": [ITEM],
  "calls_to_action": [ITEM],
  "keywords": [ITEM],
  "strengths": [ITEM],
  "opportunities": [ITEM],
  "risks": [ITEM],
  "marketing_channels": [ITEM],
  "recommended_campaigns": [ITEM],
  "content_pillars": [ITEM],
  "roadmap": [ITEM],
  "recommended_kpis": [ITEM],
  "missing_information": [ITEM],
  "assumptions_requiring_review": [ITEM]
}

FIELD = {"value":"","source":"website|inference|suggestion|missing","confidence":0,"evidence_url":""}
ITEM = the same four-key object. Use the four-key object even inside lists.
Return exactly 2 ITEMs for every list the text supports, each value at most
160 characters — a compact report that renders beats a long one that times out.
An empty list is allowed only when the text truly says nothing about it.

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
- Always populate the advisory lists (strengths, opportunities, risks,
  marketing_channels, recommended_campaigns, content_pillars, roadmap,
  recommended_kpis) as "suggestion"/"inference" items — they are your work,
  and an empty advice section is a failed report even when the site is thin.
- Write values in the requested language: ar, en, or ar-en for both.`;

/**
 * Models routinely wrap JSON in markdown fences or add a sentence before it,
 * even when a JSON response format is requested. Extract the outermost object
 * instead of failing the whole analysis; a genuinely non-JSON answer still
 * throws ai_invalid_response.
 */
export function extractJsonObject(content: string): unknown {
  const text = content.trim();
  const direct = () => JSON.parse(text);
  try {
    return direct();
  } catch {
    // fall through to fence/brace extraction
  }
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // fall through
    }
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      // fall through
    }
  }
  throw new ProviderError('ai_invalid_response');
}

function buildUserPrompt(input: AnalyzeInput) {
  const parts: string[] = [
    `Website: ${input.url}`,
    `Output language: ${input.locale}`,
    'Pages:',
  ];
  let budget = MAX_PROMPT_CHARS;
  for (const page of input.pages) {
    if (budget <= 0) break;
    const slice = page.contentMarkdown.slice(0, Math.min(3000, budget));
    budget -= slice.length;
    parts.push(`\n--- ${page.url} — ${page.title}\n${slice}`);
  }
  return parts.join('\n');
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const classifyHttpError = (status: number): ProviderError => {
  if (status === 401 || status === 403) return new ProviderError('ai_provider_unauthorized');
  if (status === 429) return new ProviderError('ai_rate_limited', `status_${status}`);
  // Cloudflare Workers AI answers 410 when a model has been retired; retrying
  // the same model can never succeed, so the admin is told to change the model.
  if (status === 410) return new ProviderError('ai_model_deprecated', `status_${status}`);
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
        signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
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
        const parsed = extractJsonObject(content);
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
  | { ok: true; modelCount: number; via: 'models' | 'chat' }
  | { ok: false; code: string; status?: number; upstreamCode?: number };

/**
 * Pull only Cloudflare/OpenAI numeric error codes out of an error body — never
 * messages, which can echo the request and account identifiers.
 */
const upstreamErrorCode = async (response: Response): Promise<number | undefined> => {
  const payload: any = await response.clone().json().catch(() => null);
  const direct = payload?.error?.code;
  const cf = payload?.errors?.[0]?.code;
  const code = Number(direct ?? cf);
  return Number.isFinite(code) ? code : undefined;
};

/**
 * Connection test for Super Admin.
 *
 * Prefers the cheap model listing (no tokens spent). OpenAI-compatible
 * gateways such as Cloudflare Workers AI only expose /chat/completions and
 * /embeddings, so a 404/400/405 on /models falls back to one minimal
 * completion against the configured model — which also proves the model name
 * is valid. Authentication failures are never retried. The key is never echoed.
 */
export async function testOpenAIConnection(options: OpenAIOptions): Promise<ConnectionTestOutcome> {
  if (!options.apiKey) return { ok: false, code: 'ai_provider_not_configured' };
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/models`, {
      method: 'GET',
      headers: { authorization: `Bearer ${options.apiKey}` },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return { ok: false, code: 'ai_provider_unreachable' };
  }
  if (response.ok) {
    const payload: any = await response.json().catch(() => null);
    const models = Array.isArray(payload?.data) ? payload.data : [];
    return { ok: true, modelCount: models.length, via: 'models' };
  }
  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      code: 'ai_provider_unauthorized',
      status: response.status,
      upstreamCode: await upstreamErrorCode(response),
    };
  }

  // No /models on this gateway — verify with a one-token completion instead.
  let chatResponse: Response;
  try {
    chatResponse = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify({
        model: options.model,
        messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
        // Reasoning models spend part of the budget before answering, so a
        // 1-token ping can come back empty. 64 is still negligible spend.
        max_tokens: 64,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return { ok: false, code: 'ai_provider_unreachable' };
  }
  if (!chatResponse.ok) {
    return {
      ok: false,
      code: classifyHttpError(chatResponse.status).code,
      status: chatResponse.status,
      upstreamCode: await upstreamErrorCode(chatResponse),
    };
  }
  const payload: any = await chatResponse.json().catch(() => null);
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    return { ok: false, code: 'ai_invalid_response' };
  }
  return { ok: true, modelCount: 1, via: 'chat' };
}
