/**
 * Provider resolution. The provider is chosen on the server from settings or
 * environment variables — the frontend never selects or sees it beyond a label.
 */
import type { Env } from '../db';
import { MockAIProvider } from './mock';
import { OpenAIProvider } from './openai';
import { type AIProvider, ProviderError } from './types';

export type ProviderStatus = {
  provider: string;
  model: string;
  mock: boolean;
  configured: boolean;
  /** Translation key the UI shows when the provider can't run. */
  notice: string | null;
};

export function resolveAiProvider(env: Env, settings: Record<string, string>): AIProvider {
  const provider = (String(env.AI_PROVIDER ?? settings['analysis.ai_provider'] ?? 'mock') || 'mock')
    .toLowerCase()
    .trim();
  const fallbackModel = provider === 'mock' ? 'mock-structured-v1' : 'gpt-4o-mini';
  const model = String(env.AI_MODEL ?? settings['analysis.ai_model'] ?? fallbackModel) || fallbackModel;

  if (provider === 'mock') return new MockAIProvider(model);

  if (provider === 'openai') {
    const apiKey = String(env.AI_API_KEY ?? '');
    if (!apiKey) throw new ProviderError('ai_provider_not_configured');
    const baseUrl = String(env.AI_GATEWAY_URL ?? 'https://api.openai.com/v1') || 'https://api.openai.com/v1';
    return new OpenAIProvider({ apiKey, baseUrl, model });
  }

  throw new ProviderError('ai_provider_unsupported');
}

export function aiProviderStatus(env: Env, settings: Record<string, string>): ProviderStatus {
  const provider = (String(env.AI_PROVIDER ?? settings['analysis.ai_provider'] ?? 'mock') || 'mock').toLowerCase();
  const mock = provider === 'mock';
  const configured = mock || (provider === 'openai' && Boolean(env.AI_API_KEY));
  return {
    provider,
    model: String(env.AI_MODEL ?? settings['analysis.ai_model'] ?? (mock ? 'mock-structured-v1' : 'gpt-4o-mini')),
    mock,
    configured,
    notice: configured ? (mock ? 'ai.mockNotice' : null) : 'ai.notConfigured',
  };
}
