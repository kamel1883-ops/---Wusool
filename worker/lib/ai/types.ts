/**
 * Structured analysis contract shared by every AI provider.
 *
 * Rule that the whole phase depends on: a value is never presented as a fact
 * unless it was found on the customer's own website. Every field therefore
 * carries `source` ('website' | 'inference' | 'missing'), a confidence score
 * and optional evidence URL. `missing` values stay empty — nothing is invented.
 */

export type FieldSource = 'website' | 'inference' | 'suggestion' | 'missing';

export type AnalysisItem = {
  value: string;
  source: FieldSource;
  confidence: number;
  evidence_url?: string | null;
};

export type FieldValue = AnalysisItem;

export type StructuredAnalysisResult = {
  company_profile: {
    company_name: FieldValue;
    industry: FieldValue;
    summary: FieldValue;
  };
  mission: FieldValue;
  vision: FieldValue;
  values: AnalysisItem[];
  products_and_services: AnalysisItem[];
  target_markets: AnalysisItem[];
  target_locations: AnalysisItem[];
  audiences: AnalysisItem[];
  buyer_personas: AnalysisItem[];
  customer_problems: AnalysisItem[];
  value_proposition: AnalysisItem[];
  calls_to_action: AnalysisItem[];
  keywords: AnalysisItem[];
  strengths: AnalysisItem[];
  opportunities: AnalysisItem[];
  risks: AnalysisItem[];
  marketing_channels: AnalysisItem[];
  recommended_campaigns: AnalysisItem[];
  content_pillars: AnalysisItem[];
  roadmap: AnalysisItem[];
  recommended_kpis: AnalysisItem[];
  missing_information: AnalysisItem[];
  assumptions_requiring_review: AnalysisItem[];
};

export const RESULT_FIELDS = [
  'company_profile',
  'mission',
  'vision',
  'values',
  'products_and_services',
  'target_markets',
  'target_locations',
  'audiences',
  'buyer_personas',
  'customer_problems',
  'value_proposition',
  'calls_to_action',
  'keywords',
  'strengths',
  'opportunities',
  'risks',
  'marketing_channels',
  'recommended_campaigns',
  'content_pillars',
  'roadmap',
  'recommended_kpis',
  'missing_information',
  'assumptions_requiring_review',
] as const;

export const LIST_FIELDS = [
  'values',
  'products_and_services',
  'target_markets',
  'target_locations',
  'audiences',
  'buyer_personas',
  'customer_problems',
  'value_proposition',
  'calls_to_action',
  'keywords',
  'strengths',
  'opportunities',
  'risks',
  'marketing_channels',
  'recommended_campaigns',
  'content_pillars',
  'roadmap',
  'recommended_kpis',
  'missing_information',
  'assumptions_requiring_review',
] as const;

export type SitePage = {
  url: string;
  title: string;
  contentMarkdown: string;
  wordCount: number;
};

export type AnalysisLocale = 'ar' | 'en' | 'ar-en';

export type AnalyzeInput = {
  companyId: string;
  analysisId: string;
  pages: SitePage[];
  locale: AnalysisLocale;
  url: string;
};

export type AiUsage = {
  provider: string;
  model: string;
  operation: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostMicros: number;
};

export type AiAnalysis = { result: StructuredAnalysisResult; usage: AiUsage };

export interface AIProvider {
  readonly name: string;
  /** Human readable model name, recorded per analysis. */
  readonly model: string;
  analyzeSite(input: AnalyzeInput): Promise<AiAnalysis>;
}

/** Provider failures are surfaced as stable codes, never as raw upstream text. */
export class ProviderError extends Error {
  code: string;
  detail?: string;

  constructor(code: string, detail?: string) {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

export const emptyField = (): FieldValue => ({ value: '', source: 'missing', confidence: 0 });

export const item = (
  value: string,
  source: FieldSource,
  confidence: number,
  evidenceUrl?: string | null
): AnalysisItem => ({
  value: String(value ?? '').trim().slice(0, 1200),
  source,
  confidence: Math.max(0, Math.min(1, Number(confidence) || 0)),
  evidence_url: evidenceUrl ?? null,
});

export function emptyResult(): StructuredAnalysisResult {
  const list = () => [] as AnalysisItem[];
  return {
    company_profile: { company_name: emptyField(), industry: emptyField(), summary: emptyField() },
    mission: emptyField(),
    vision: emptyField(),
    values: list(),
    products_and_services: list(),
    target_markets: list(),
    target_locations: list(),
    audiences: list(),
    buyer_personas: list(),
    customer_problems: list(),
    value_proposition: list(),
    calls_to_action: list(),
    keywords: list(),
    strengths: list(),
    opportunities: list(),
    risks: list(),
    marketing_channels: list(),
    recommended_campaigns: list(),
    content_pillars: list(),
    roadmap: list(),
    recommended_kpis: list(),
    missing_information: list(),
    assumptions_requiring_review: list(),
  };
}

const SOURCES: FieldSource[] = ['website', 'inference', 'suggestion', 'missing'];

function normalizeItem(raw: unknown, fallbackSource: FieldSource = 'inference'): AnalysisItem | null {
  if (typeof raw === 'string') {
    const value = raw.trim();
    return value ? item(value, fallbackSource, 0.4) : null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const source = SOURCES.includes((raw as any).source) ? ((raw as any).source as FieldSource) : fallbackSource;
  const value = typeof (raw as any).value === 'string' ? (raw as any).value.trim() : '';
  if (!value) return null;
  const confidence = Number((raw as any).confidence);
  const evidence =
    typeof (raw as any).evidence_url === 'string' ? (raw as any).evidence_url.slice(0, 500) : null;
  return item(value, source, Number.isFinite(confidence) ? confidence : 0.4, evidence);
}

function normalizeField(raw: unknown, fallbackSource: FieldSource = 'inference'): FieldValue {
  const normalized = normalizeItem(raw, fallbackSource);
  return normalized ?? emptyField();
}

/**
 * Coerce anything (model output, a stored value, a user edit) into the fixed
 * schema. Unknown keys are dropped, missing provenance defaults to 'inference'
 * so nothing can silently look like a verified website fact.
 */
export function normalizeResult(raw: unknown): StructuredAnalysisResult {
  const base = emptyResult();
  if (!raw || typeof raw !== 'object') return base;
  const input = raw as Record<string, any>;

  if (input.company_profile && typeof input.company_profile === 'object') {
    base.company_profile.company_name = normalizeField(input.company_profile.company_name);
    base.company_profile.industry = normalizeField(input.company_profile.industry);
    base.company_profile.summary = normalizeField(input.company_profile.summary);
  }
  base.mission = normalizeField(input.mission);
  base.vision = normalizeField(input.vision);

  for (const field of LIST_FIELDS) {
    const value = input[field];
    if (!Array.isArray(value)) continue;
    const items: AnalysisItem[] = [];
    for (const entry of value.slice(0, 60)) {
      const normalized = normalizeItem(entry);
      if (normalized) items.push(normalized);
    }
    (base as any)[field] = items;
  }
  return base;
}

/** Fields still empty, used to build the "needs client input" list. */
export function missingFields(result: StructuredAnalysisResult): string[] {
  const missing: string[] = [];
  const check = (label: string, field: FieldValue) => {
    if (!field.value || field.source === 'missing') missing.push(label);
  };
  check('company_profile.company_name', result.company_profile.company_name);
  check('company_profile.industry', result.company_profile.industry);
  check('company_profile.summary', result.company_profile.summary);
  check('mission', result.mission);
  check('vision', result.vision);
  return missing;
}

/** Average confidence over everything that is not marked as missing. */
export function overallConfidence(result: StructuredAnalysisResult): number {
  const scores: number[] = [];
  const add = (field: FieldValue) => {
    if (field.value && field.source !== 'missing') scores.push(field.confidence);
  };
  add(result.company_profile.company_name);
  add(result.company_profile.industry);
  add(result.company_profile.summary);
  add(result.mission);
  add(result.vision);
  for (const field of LIST_FIELDS) {
    for (const entry of result[field]) {
      if (entry.value && entry.source !== 'missing') scores.push(entry.confidence);
    }
  }
  if (!scores.length) return 0;
  return Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100;
}

/** Provenance summary stored with every version for quick auditing. */
export function sourceSummary(result: StructuredAnalysisResult) {
  let website = 0;
  let inference = 0;
  let suggestion = 0;
  const count = (field: FieldValue) => {
    if (!field.value) return;
    if (field.source === 'website') website += 1;
    if (field.source === 'inference') inference += 1;
    if (field.source === 'suggestion') suggestion += 1;
  };
  count(result.company_profile.company_name);
  count(result.company_profile.industry);
  count(result.company_profile.summary);
  count(result.mission);
  count(result.vision);
  for (const field of LIST_FIELDS) for (const entry of result[field]) count(entry as FieldValue);
  return { website, inference, suggestion, missing: result.missing_information.length };
}
