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
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
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
