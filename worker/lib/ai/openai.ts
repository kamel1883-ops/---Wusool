/**
 * OpenAI-compatible provider (OpenAI, Azure-compatible gateways, Gemini/Llama
 * behind an OpenAI-compatible proxy).
 *
 * The API key is read from the Worker environment only — it is never sent to
 * the browser, stored in D1, logged, or included in an error message.
 */
import {
  type AiAnalysis,
  type AIProvider,
  type AnalyzeInput,
  ProviderError,
  normalizeResult,
} from './types';

const MAX_PROMPT_CHARS = 18_000;

const SYSTEM_PROMPT = `You are a B2B marketing analyst for a Saudi agency.
You receive text extracted from a company's public website. Return ONE JSON object
with exactly this shape (no markdown, no commentary):

{"company_profile":{"company_name":{"value":"","source":"website|inference|missing","confidence":0},"industry":{...},"summary":{...}},
"mission":{...},"vision":{...},
"values":[],"products_and_services":[],"target_markets":[],"target_locations":[],"audiences":[],
"buyer_personas":[],"customer_problems":[],"value_proposition":[],"calls_to_action":[],"keywords":[],
"strengths":[],"opportunities":[],"risks":[],"marketing_channels":[],"recommended_campaigns":[],
"content_pillars":[],"roadmap":[],"recommended_kpis":[],"missing_information":[],"assumptions_requiring_review":[]}

Rules:
- Array items are objects {"value":"","source":"website|inference|missing","confidence":0,"evidence_url":""}.
- source "website" ONLY if the value is literally supported by the supplied text.
- Anything you conclude yourself is "inference"; anything not stated is "missing" with an empty value.
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

export class OpenAIProvider implements AIProvider {
  readonly name = 'openai';

  constructor(
    private options: { apiKey: string; baseUrl: string; model: string }
  ) {}

  get model() {
    return this.options.model;
  }

  async analyzeSite(input: AnalyzeInput): Promise<AiAnalysis> {
    if (!this.options.apiKey) throw new ProviderError('ai_provider_not_configured');

    const endpoint = `${this.options.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify({
          model: this.options.model,
          temperature: 0.2,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: buildUserPrompt(input) },
          ],
        }),
        signal: AbortSignal.timeout(45_000),
      });
    } catch {
      // Never surface the upstream error text (it can echo the request).
      throw new ProviderError('ai_provider_unreachable');
    }

    if (!response.ok) {
      throw new ProviderError('ai_provider_failed', `status_${response.status}`);
    }

    const payload: any = await response.json().catch(() => null);
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new ProviderError('ai_invalid_response');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new ProviderError('ai_invalid_response');
    }

    return {
      result: normalizeResult(parsed),
      usage: {
        provider: 'openai',
        model: this.options.model,
        operation: 'site_analysis',
        inputTokens: Number(payload?.usage?.prompt_tokens ?? 0) || 0,
        outputTokens: Number(payload?.usage?.completion_tokens ?? 0) || 0,
        estimatedCostMicros: 0,
      },
    };
  }
}
