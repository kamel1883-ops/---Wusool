/**
 * Post studio generation.
 *
 * A client describes an idea ("two Saudi men standing, holding a phone, the
 * post says …") and the studio turns it into a caption plus a poster image.
 * Two paths produce the same draft shape:
 *
 *  - When a real OpenAI-compatible provider is configured on the server, the
 *    model writes the caption and the poster copy from the idea, the client's
 *    feedback and facts taken from the client's own approved analysis only.
 *  - Otherwise a deterministic local generator weaves the client's own words
 *    into short marketing copy. It never invents company facts and never
 *    calls the network, so the studio still works offline/demo deployments.
 *
 * Image generation is free and open-source via Pollinations.ai
 * (image.pollinations.ai — no key, no signup). The SVG poster stays as
 * the fallback when the free service is rate-limited or unreachable.
 */

import { extractJsonObject, isUsableGatewayUrl } from '../ai/openai';
import { ProviderError } from '../ai/types';

export type StudioDraftInput = {
  idea: string;
  feedback: string;
  language: 'ar' | 'en';
  companyName: string;
  /** Short factual context from the approved analysis (website/inference). */
  context: string[];
  /** The draft the client is regenerating from, if any. */
  previous: { headline: string; caption: string } | null;
  /** 0 for the first generation, 1+ for each regeneration. */
  variant: number;
};

export type StudioDraft = {
  title: string;
  captionAr: string;
  captionEn: string;
  hashtags: string;
  headline: string;
  subhead: string;
  cta: string;
  /** Visual description derived from the idea, for image generation. */
  imagePrompt: string;
};

const clip = (value: string, max: number) => {
  const text = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
};

/** First clause of the idea, cleaned up for use inside generated copy. */
const ideaCore = (idea: string) => {
  const first = idea
    .split(/[\n.。!؟?؛;،,]/)
    .map((part) => part.trim())
    .filter(Boolean)[0];
  return clip(first || idea, 120);
};

/** Hashtags taken from the client's own words — never invented topics. */
const hashtagsFrom = (idea: string, companyName: string): string => {
  const words = idea
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 4 && word.length <= 20);
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const word of words) {
    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(word);
    if (tags.length === 5) break;
  }
  if (companyName && companyName.length >= 3 && tags.length < 5) tags.push(companyName);
  return tags.join(' ');
};

const AR_OPENERS = [
  'فكرة تستاهل تتصدر المنشور:',
  'اليوم نشارككم حاجة مهمة:',
  'لو كنت تدور على الفرق، اسمع هذي:',
  'رسالة قصيرة من فريقنا لكم:',
  'أبسط طريقة تفهمها:',
];

const AR_CLOSERS = [
  'تواصل معنا اليوم وخلك قريب من الحل.',
  'جاهزين نوصل لك الخدمة بالطريقة اللي تناسبك.',
  'اطلب الآن وخلّ الباقي علينا.',
  'احجز مكانك قبل ما ينشغل الوقت.',
  'جرّبها اليوم وشوف الفرق بنفسك.',
];

const EN_OPENERS = [
  'An idea worth putting front and center:',
  'Today we are sharing something important:',
  'If you are looking for the difference, here it is:',
  'A short note from our team to you:',
  'The simplest way to understand it:',
];

const EN_CLOSERS = [
  'Reach out today and stay close to the solution.',
  'We are ready to deliver the service your way.',
  'Order now and leave the rest to us.',
  'Book your slot before time runs out.',
  'Try it today and see the difference yourself.',
];

/**
 * Deterministic local generator. Each regeneration picks the next opener /
 * closer pair, so "regenerate" visibly changes the copy without any network
 * call. Client feedback shifts the rotation too, so a note like "أقصر"
 * produces a different (and when the idea is long, shorter) draft.
 */
export function buildLocalDraft(input: StudioDraftInput): StudioDraft {
  const core = ideaCore(input.idea);
  const company = input.companyName.trim();
  const contextLine = input.context.find((line) => line.trim());
  const wantsShort = /أقصر|مختصر|قصير|short|concise/i.test(input.feedback || '');
  const slot = Math.abs(input.variant + (input.feedback ? input.feedback.length % 3 : 0)) % 5;

  const headline = clip(
    input.language === 'en'
      ? EN_OPENERS[slot].replace(/:$/, '')
      : AR_OPENERS[slot].replace(/:$/, ''),
    90
  );
  const subhead = clip(
    wantsShort ? core : contextLine ? `${core} — ${clip(contextLine, 90)}` : core,
    180
  );

  const captionAr = [
    AR_OPENERS[slot],
    core,
    contextLine ? `نقدّم ${clip(contextLine, 120)}.` : '',
    AR_CLOSERS[slot],
  ]
    .filter(Boolean)
    .join(' ');
  const captionEn = [
    EN_OPENERS[slot],
    core,
    contextLine ? `We offer ${clip(contextLine, 120)}.` : '',
    EN_CLOSERS[slot],
  ]
    .filter(Boolean)
    .join(' ');

  return {
    title: clip(company ? `${company} — ${core}` : core, 120),
    captionAr: clip(captionAr, 1200),
    captionEn: clip(captionEn, 1200),
    hashtags: hashtagsFrom(input.idea, company),
    headline,
    subhead,
    cta: input.language === 'en' ? 'Contact us today' : 'تواصل معنا اليوم',
    imagePrompt: clip(
      `صورة تسويقية للمنشور: ${input.idea} — أسلوب واقعي نظيف، إضاءة طبيعية، ألوان هادئة، بدون نصوص داخل الصورة`,
      600
    ),
  };
}

const SYSTEM_PROMPT = `You are a Saudi B2B marketing copywriter.
The client described an idea for a social media post and may have left feedback
on a previous draft. Write a fresh post inspired by the idea. Return ONE JSON
object only (no markdown, no commentary) with exactly these keys:

{"title":"","captionAr":"","captionEn":"","hashtags":"","headline":"","subhead":"","cta":"","imagePrompt":""}

Rules:
- captionAr: 2-4 short Arabic sentences (Saudi-friendly, no slang overload), hashtags separate.
- captionEn: the same message in English.
- headline: 3-8 words for a poster. subhead: one short supporting line.
- cta: a short call to action in the requested language.
- imagePrompt: a visual description of the scene the client described, in English, no text in the image.
- Use ONLY the supplied company facts. Never invent prices, phone numbers,
  addresses, certifications, clients or statistics.
- If feedback is given, change the draft in the direction it asks for.`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ask the configured OpenAI-compatible provider for a draft. Returns null
 * when no provider is configured so the caller can fall back locally.
 */
export async function buildAiDraft(
  env: { AI_API_KEY?: string; AI_GATEWAY_URL?: string; AI_MODEL?: string },
  input: StudioDraftInput
): Promise<StudioDraft | null> {
  const apiKey = String(env.AI_API_KEY ?? '');
  if (!apiKey) return null;
  const baseUrl = String(env.AI_GATEWAY_URL ?? 'https://api.openai.com/v1') || 'https://api.openai.com/v1';
  if (!isUsableGatewayUrl(baseUrl)) throw new ProviderError('ai_gateway_url_invalid');
  const model = String(env.AI_MODEL ?? 'gpt-4o-mini') || 'gpt-4o-mini';

  const lines = [
    `Company: ${input.companyName || '—'}`,
    `Facts from the company (only these may be used):`,
    ...(input.context.length ? input.context.map((line) => `- ${line}`) : ['- (none)']),
    `Client idea: ${input.idea}`,
    input.feedback ? `Client feedback on the previous draft: ${input.feedback}` : 'Client feedback: none',
    input.previous
      ? `Previous draft headline: ${input.previous.headline}\nPrevious draft caption: ${input.previous.caption}`
      : 'Previous draft: none',
    `Post language: ${input.language}`,
    `Variant: ${input.variant + 1}`,
  ];

  let lastError: unknown = new ProviderError('ai_provider_failed');
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          temperature: 0.7,
          max_tokens: 900,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: lines.join('\n') },
          ],
        }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      lastError = new ProviderError(
        error instanceof TypeError ? 'ai_gateway_url_invalid' : 'ai_provider_unreachable'
      );
      if (attempt === 2) break;
      await sleep(900);
      continue;
    }
    if (!response.ok) {
      lastError = new ProviderError(
        response.status === 401 || response.status === 403
          ? 'ai_provider_unauthorized'
          : response.status === 429
            ? 'ai_rate_limited'
            : response.status >= 500
              ? 'ai_provider_unavailable'
              : 'ai_provider_failed'
      );
      if (attempt === 2) break;
      await sleep(900);
      continue;
    }
    const payload: any = await response.json().catch(() => null);
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      lastError = new ProviderError('ai_invalid_response');
      continue;
    }
    let parsed: any;
    try {
      parsed = extractJsonObject(content) as any;
    } catch {
      lastError = new ProviderError('ai_invalid_response');
      continue;
    }
    const draft: StudioDraft = {
      title: clip(parsed.title ?? '', 120) || clip(input.idea, 120),
      captionAr: clip(parsed.captionAr ?? '', 1200),
      captionEn: clip(parsed.captionEn ?? '', 1200),
      hashtags: clip(parsed.hashtags ?? '', 600),
      headline: clip(parsed.headline ?? '', 120),
      subhead: clip(parsed.subhead ?? '', 240),
      cta: clip(parsed.cta ?? '', 60),
      imagePrompt: clip(parsed.imagePrompt ?? '', 600),
    };
    if (!draft.captionAr && !draft.captionEn) {
      lastError = new ProviderError('ai_invalid_response');
      continue;
    }
    if (!draft.headline) draft.headline = clip(ideaCore(input.idea), 90);
    if (!draft.imagePrompt) draft.imagePrompt = clip(input.idea, 600);
    return draft;
  }
  throw lastError;
}

export type StudioImageResult =
  | { kind: 'url'; url: string; source: 'open' | 'ai' }
  | { kind: 'base64'; base64: string; contentType: string; source: 'open' | 'ai' }
  | null;



/**
 * Free open-source image generation via Pollinations.ai.
 *
 * No API key, no signup, no charge — a plain GET returns a JPEG.
 * The anonymous tier is rate-limited (roughly one image per 15-40s and
 * occasional 402s), so we retry with back-off. The headline text is
 * included in the prompt as a hint; the caption carries the exact copy.
 * Returns null when the service fails so the caller can fall back to
 * the SVG poster instead of erroring the whole generation.
 */
export async function generateOpenImage(
  prompt: string,
  width: number,
  height: number,
  seed: number
): Promise<StudioImageResult> {
  const w = Math.min(1024, Math.max(256, Math.round(width)));
  const h = Math.min(1024, Math.max(256, Math.round(height)));
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${w}&height=${h}&seed=${seed}&nologo=true&enhance=true`;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (!response.ok) {
        if (attempt < 3) await sleep(2500 * attempt);
        continue;
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length < 1000) {
        if (attempt < 3) await sleep(2500 * attempt);
        continue;
      }
      let binary = '';
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
      }
      return { kind: 'base64', base64: btoa(binary), contentType: 'image/jpeg', source: 'open' };
    } catch {
      if (attempt < 3) await sleep(2500 * attempt);
    }
  }
  return null;
}

/**
 * Optional raster image generation. Only runs when `AI_IMAGE_MODEL` is set —
 * guessing a model name against a gateway that may not offer images would
 * turn every generation into a confusing failure.
 */
export async function generateStudioImage(
  env: {
    AI_API_KEY?: string;
    AI_GATEWAY_URL?: string;
    AI_IMAGE_MODEL?: string;
  },
  prompt: string,
  width: number,
  height: number,
  headline = '',
  _subhead = '',
  _cta = '',
  _language: 'ar' | 'en' = 'ar'
): Promise<StudioImageResult> {
  // Free open-source images first (Pollinations, no key). The seed varies
  // per call so a regeneration does not return the cached same image.
  const openImage = await generateOpenImage(
    headline ? `${prompt} — professional Saudi social media ad, clean modern design, high quality, no watermark, no logos, no text` : prompt,
    width,
    height,
    Math.floor(Math.random() * 1000000)
  );
  if (openImage) return openImage;
  const apiKey = String(env.AI_API_KEY ?? '');
  const imageModel = String(env.AI_IMAGE_MODEL ?? '').trim();
  if (!apiKey || !imageModel) return null;
  const baseUrl = String(env.AI_GATEWAY_URL ?? 'https://api.openai.com/v1') || 'https://api.openai.com/v1';
  if (!isUsableGatewayUrl(baseUrl)) return null;

  let response: Response;
  try {
    response = await fetch(`${baseUrl.replace(/\/+$/, '')}/images/generations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: imageModel,
        prompt,
        size: `${Math.max(256, width)}x${Math.max(256, height)}`,
        n: 1,
      }),
      signal: AbortSignal.timeout(90_000),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const payload: any = await response.json().catch(() => null);
  const image = payload?.data?.[0];
  if (typeof image?.url === 'string' && image.url) return { kind: 'url', url: image.url.slice(0, 2000), source: 'ai' };
  if (typeof image?.b64_json === 'string' && image.b64_json) {
    return { kind: 'base64', base64: image.b64_json, contentType: 'image/png', source: 'ai' };
  }
  return null;
}
