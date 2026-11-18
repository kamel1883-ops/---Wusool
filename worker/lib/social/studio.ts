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
 * Image generation is a separate, opt-in step (`AI_IMAGE_MODEL`): only when
 * that secret is set does the server ask the gateway for a raster image.
 * Without it, the studio's image is the server-rendered poster (SVG) built
 * from the generated headline — the same artefact the posters tab approves.
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
  | { kind: 'url'; url: string; source: 'gemini' | 'ai' }
  | { kind: 'base64'; base64: string; contentType: string; source: 'gemini' | 'ai' }
  | null;

/** Closest Gemini aspect ratio for the requested poster size. */
const aspectRatioFor = (width: number, height: number): string => {
  const ratio = width / Math.max(1, height);
  if (ratio > 1.7) return '21:9';
  if (ratio > 1.4) return '16:9';
  if (ratio > 1.15) return '4:3';
  if (ratio > 0.9) return '1:1';
  if (ratio > 0.7) return '3:4';
  return '9:16';
};

/**
 * Professional marketing image generation via Google Gemini (Nano Banana).
 *
 * Uses a Gemini API key (`GEMINI_API_KEY`, free from Google AI Studio).
 * The model renders the headline/subhead/CTA text directly in the image so
 * the result is a finished social post visual, not a blank illustration.
 * Returns null when no key is configured so the caller can fall back.
 */
export async function generateGeminiImage(
  env: { GEMINI_API_KEY?: string; GOOGLE_AI_API_KEY?: string; GEMINI_IMAGE_MODEL?: string },
  prompt: string,
  headline: string,
  subhead: string,
  cta: string,
  language: 'ar' | 'en',
  width: number,
  height: number
): Promise<StudioImageResult> {
  const apiKey = String(env.GEMINI_API_KEY ?? env.GOOGLE_AI_API_KEY ?? '').trim();
  if (!apiKey) return null;
  const model = String(env.GEMINI_IMAGE_MODEL ?? 'gemini-2.5-flash-image').trim() || 'gemini-2.5-flash-image';
  const text = [
    headline ? `Headline (render exactly, large bold, ${language === 'ar' ? 'Arabic' : 'English'}): ${headline}` : '',
    subhead ? `Subheadline (smaller, below headline): ${subhead}` : '',
    cta ? `CTA button text (small pill at bottom): ${cta}` : '',
    `Scene: ${prompt}`,
    'Style: professional Saudi B2B social media ad, clean modern design, high quality, natural lighting, brand-safe colors, no watermark, no logos, no mockups, crisp Arabic typography, balanced composition with image on one side and text panel on the other side',
  ].filter(Boolean).join('\n');

  let response: Response;
  try {
    response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text }] }],
          generationConfig: {
            responseModalities: ['TEXT', 'IMAGE'],
            imageConfig: { aspectRatio: aspectRatioFor(width, height) },
          },
        }),
        signal: AbortSignal.timeout(120_000),
      }
    );
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const payload: any = await response.json().catch(() => null);
  const parts = payload?.candidates?.[0]?.content?.parts ?? [];
  for (const part of parts) {
    const data = part?.inlineData?.data;
    const mime = part?.inlineData?.mimeType;
    if (typeof data === 'string' && data) {
      return { kind: 'base64', base64: data, contentType: String(mime ?? 'image/png'), source: 'gemini' };
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
    GEMINI_API_KEY?: string;
    GOOGLE_AI_API_KEY?: string;
    GEMINI_IMAGE_MODEL?: string;
  },
  prompt: string,
  width: number,
  height: number,
  headline = '',
  subhead = '',
  cta = '',
  language: 'ar' | 'en' = 'ar'
): Promise<StudioImageResult> {
  // Gemini first — professional Nano Banana images with rendered text.
  const gemini = await generateGeminiImage(env, prompt, headline, subhead, cta, language, width, height);
  if (gemini) return gemini;
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
