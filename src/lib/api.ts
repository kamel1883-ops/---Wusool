import { useCallback, useEffect, useState } from 'react';
import type { Locale } from './i18n';

export class ApiError extends Error {
  code: string;
  status: number;

  constructor(code: string, status: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  formData?: FormData;
};

export async function api<T = any>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, formData } = options;
  const headers: Record<string, string> = { 'x-wusool-client': 'web' };
  let payload: BodyInit | undefined;

  if (formData) {
    payload = formData;
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  const response = await fetch(path, {
    method,
    headers,
    body: payload,
    credentials: 'same-origin',
  });

  const isJson = response.headers.get('content-type')?.includes('application/json');
  const data = isJson ? await response.json().catch(() => null) : null;

  if (!response.ok) {
    const code = (data as any)?.error?.code ?? 'internal_error';
    throw new ApiError(code, response.status);
  }
  return (data ?? {}) as T;
}

// ---------------------------------------------------------------------------
// Shared response types
// ---------------------------------------------------------------------------

export type CompanyRole = 'owner' | 'marketing_manager' | 'content_writer' | 'designer' | 'viewer';
export type CompanyStatus = 'pending' | 'active' | 'suspended' | 'expired' | 'cancelled';

export type Subscription = {
  status: CompanyStatus;
  effectiveStatus: CompanyStatus;
  daysLeft: number | null;
  expiringSoon: boolean;
  isActive: boolean;
};

export type Branding = {
  nameAr: string;
  nameEn: string;
  taglineAr: string;
  taglineEn: string;
  primaryColor: string;
  inkColor: string;
  logoUrl: string;
  website: string;
};

export type Support = { email: string; whatsapp: string };

export type Me = {
  user: {
    id: string;
    name: string;
    email: string;
    locale: Locale;
    platformRole: 'none' | 'super_admin';
    mustChangePassword: boolean;
  };
  companies: Array<{
    id: string;
    name: string;
    role: CompanyRole;
    planId: string | null;
    permissions: string[];
    subscriptionEnd: string | null;
    status: CompanyStatus;
    effectiveStatus: CompanyStatus;
    daysLeft: number | null;
    expiringSoon: boolean;
    isActive: boolean;
  }>;
  branding: Branding;
  support: Support;
  platform: { warningDays: number; supportedLocales: string[] };
};

export type Member = {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: CompanyRole;
  status: 'active' | 'disabled';
  lastLoginAt: string | null;
  createdAt: string;
};

export type Proof = {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  reference: string | null;
  note: string | null;
  status: 'pending_review' | 'approved' | 'rejected';
  reviewNote: string | null;
  reviewedAt: string | null;
  createdAt: string;
};

export type Invoice = {
  id: string;
  number: string;
  amountSar: number;
  currency: string;
  periodStart: string | null;
  periodEnd: string | null;
  issuedAt: string;
  dueAt: string | null;
  status: 'draft' | 'issued' | 'pending_review' | 'paid' | 'void';
  notes: string | null;
  proofs: Proof[];
};

export type AdminInvoice = Invoice & {
  companyId: string;
  companyName: string;
  pendingProofs: number;
};

export type CompanySummary = {
  id: string;
  name: string;
  legalName: string | null;
  domain: string | null;
  industry: string | null;
  city: string | null;
  country: string;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  planId: string | null;
  planName?: string | null;
  subscriptionStart: string | null;
  subscriptionEnd: string | null;
  status: CompanyStatus;
  notes?: string | null;
  createdAt: string;
  updatedAt: string;
  ownerName?: string | null;
  ownerEmail?: string | null;
  membersCount?: number;
  pendingProofs?: number;
  subscription: Subscription;
};

export type Plan = {
  id: string;
  nameAr: string;
  nameEn: string;
  priceSar: number;
  billingPeriod: string;
  maxUsers: number | null;
  monthlyAnalyses: number | null;
  maxConcurrent: number | null;
  featuresAr: string[];
  featuresEn: string[];
  isActive: boolean;
  sortOrder: number;
};

export type AdminUser = {
  id: string;
  name: string;
  email: string;
  platformRole: 'none' | 'super_admin';
  status: 'active' | 'disabled';
  mustChangePassword: boolean;
  membershipsCount: number;
  createdAt: string;
  lastLoginAt: string | null;
};

export type AuditEntry = {
  companyId?: string | null;
  actorEmail: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  meta: Record<string, unknown> | null;
  createdAt: string;
};

export type AdminProof = {
  id: string;
  invoiceId: string;
  invoiceNumber: string;
  invoiceAmountSar: number;
  invoicePeriodStart: string | null;
  invoicePeriodEnd: string | null;
  companyId: string;
  companyName: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  reference: string | null;
  note: string | null;
  status: 'pending_review' | 'approved' | 'rejected';
  reviewNote: string | null;
  reviewedAt: string | null;
  createdAt: string;
};

// ---------------------------------------------------------------------------
// Phase 2 — site analysis
// ---------------------------------------------------------------------------

export type AnalysisStatus =
  | 'draft'
  | 'queued'
  | 'crawling'
  | 'extracting'
  | 'analyzing'
  | 'awaiting_review'
  | 'approved'
  | 'changes_requested'
  | 'failed'
  | 'cancelled';

export type FieldSource = 'website' | 'inference' | 'suggestion' | 'missing';

export type AnalysisItem = {
  value: string;
  source: FieldSource;
  confidence: number;
  evidence_url?: string | null;
};

export type AnalysisField = AnalysisItem;

export type StructuredAnalysisResult = {
  company_profile: { company_name: AnalysisField; industry: AnalysisField; summary: AnalysisField };
  mission: AnalysisField;
  vision: AnalysisField;
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

export type SiteAnalysis = {
  id: string;
  companyId: string;
  url: string;
  normalizedUrl: string;
  status: AnalysisStatus;
  provider: string | null;
  model: string | null;
  crawlerProvider: string | null;
  locale: 'ar' | 'en' | 'ar-en';
  maxPages: number;
  maxDepth: number;
  consentConfirmed: boolean;
  latestVersion: number;
  approvedVersion: number | null;
  robotsPolicy: string | null;
  pagesFound: number;
  pagesAnalyzed: number;
  pagesFailed: number;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AnalysisResultPayload = {
  id: string;
  analysisId: string;
  version: number;
  result: StructuredAnalysisResult | null;
  confidence: number | null;
  sourceSummary: { website: number; inference: number; suggestion?: number; missing: number } | null;
  createdByAi: boolean;
  editedByUser: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AnalysisCapabilities = {
  create: boolean;
  edit: boolean;
  review: boolean;
  approve: boolean;
};

export type AnalysisProviderStatus = {
  provider: string;
  model: string;
  mock: boolean;
  configured: boolean;
  notice: string | null;
};

export type AnalysisLimits = {
  defaultMaxPages: number;
  defaultMaxDepth: number;
  hardMaxPages: number;
  hardMaxDepth: number;
  requireConsent: boolean;
  showCostToClient: boolean;
};

export type AnalysisApproval = {
  id: string;
  version: number;
  action: 'submitted' | 'approved' | 'changes_requested' | 'reanalysis_requested';
  userId: string;
  userName: string | null;
  comment: string | null;
  createdAt: string;
};

export type AnalysisDetail = {
  analysis: SiteAnalysis;
  result: AnalysisResultPayload | null;
  versions: Array<{
    id: string;
    version: number;
    confidence: number | null;
    editedByUser: string | null;
    createdAt: string;
  }>;
  approvals: AnalysisApproval[];
  ai: AnalysisProviderStatus;
  capabilities: {
    edit: boolean;
    review: boolean;
    approve: boolean;
    reopen: boolean;
    showCost: boolean;
  };
};

export type AnalysisPageRow = {
  id: string;
  url: string;
  title: string | null;
  statusCode: number | null;
  wordCount: number;
  depth: number;
  status: 'ok' | 'blocked' | 'not_found' | 'error' | 'skipped';
  errorMessage: string | null;
  createdAt: string;
};

// ---------------------------------------------------------------------------
// Data loading hook
// ---------------------------------------------------------------------------

export function useApi<T = any>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    if (!path) {
      setData(null);
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    setError(null);
    api<T>(path)
      .then((result) => {
        if (active) setData(result);
      })
      .catch((err: ApiError) => {
        if (active) setError(err.code ?? 'internal_error');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [path, nonce]);

  return { data, loading, error, reload };
}
