import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, Outlet, useNavigate, useParams } from 'react-router-dom';
import {
  api,
  ApiError,
  useApi,
  type AdminInvoice,
  type AdminProof,
  type AdminUser,
  type AuditEntry,
  type CompanyRole,
  type CompanyStatus,
  type CompanySummary,
  type Invoice,
  type Member,
  type Plan,
} from '../lib/api';
import { useSession } from '../lib/session';
import { errorKey, formatBytes, formatDate, formatDateTime, formatSAR } from '../lib/i18n';
import { AppShell, FullPageLoading, type NavItem } from '../components/Shell';
import {
  Alert,
  Button,
  Card,
  CopyValue,
  EmptyState,
  Field,
  Input,
  Loading,
  Modal,
  PageHeader,
  RoleBadge,
  Select,
  Stat,
  StatusBadge,
  Table,
  Tabs,
  Textarea,
} from '../components/ui';

const COMPANY_STATUSES: CompanyStatus[] = [
  'pending',
  'active',
  'suspended',
  'expired',
  'cancelled',
];

export function AdminLayout() {
  const { me, loading, t } = useSession();

  const nav = useMemo<NavItem[]>(
    () => [
      { to: '/admin', label: t('nav.adminOverview'), icon: 'grid', end: true },
      { to: '/admin/companies', label: t('nav.companies'), icon: 'building' },
      { to: '/admin/invoices', label: t('nav.invoices'), icon: 'card' },
      { to: '/admin/plans', label: t('nav.plans'), icon: 'layers' },
      { to: '/admin/users', label: t('nav.users'), icon: 'users' },
      { to: '/admin/usage', label: t('nav.usage'), icon: 'chart' },
      { to: '/admin/audit', label: t('nav.audit'), icon: 'file' },
      { to: '/admin/settings', label: t('nav.platformSettings'), icon: 'settings' },
    ],
    [t]
  );

  if (loading) return <FullPageLoading label={t('common.loading')} />;
  if (!me || me.user.platformRole !== 'super_admin') {
    return (
      <div className="center-page">
        <Card title={t('admin.noAccess')}>
          <Link className="btn btn-secondary" to="/">
            {t('common.back')}
          </Link>
        </Card>
      </div>
    );
  }

  return (
    <AppShell nav={nav} sectionLabel={t('nav.adminArea')}>
      <div className="workspace-head admin-head">
        <div>
          <span className="workspace-label">{t('nav.adminArea')}</span>
          <strong>
            {me.branding.nameAr} · {t('role.super_admin')}
          </strong>
        </div>
        {me.companies.length > 0 ? (
          <Link className="btn btn-secondary btn-sm" to={`/app/${me.companies[0].id}`}>
            {t('nav.clientArea')}
          </Link>
        ) : null}
      </div>
      <Outlet />
    </AppShell>
  );
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

type AdminOverview = {
  warningDays: number;
  companies: {
    total: number;
    pending: number;
    active: number;
    suspended: number;
    expired: number;
    cancelled: number;
  };
  expiring: Array<{ id: string; name: string; subscriptionEnd: string | null }>;
  pendingProofs: number;
  openInvoices: number;
  paidTotal: number;
  users: number;
  pendingCompanies: number;
  usage: Record<string, number>;
  recentCompanies: CompanySummary[];
};

export function AdminOverviewPage() {
  const { t, locale } = useSession();
  const { data, loading } = useApi<AdminOverview>('/api/admin/overview');
  if (loading || !data) return <Loading />;

  return (
    <>
      <PageHeader title={t('admin.overview')} />
      <div className="stats-grid stats-grid-wide">
        <Stat label={t('admin.totalCompanies')} value={data.companies.total} tone="brand" />
        <Stat label={t('admin.activeCompanies')} value={data.companies.active} tone="ok" />
        <Stat
          label={t('admin.pendingCompanies')}
          value={data.companies.pending}
          tone={data.companies.pending ? 'warn' : 'default'}
        />
        <Stat
          label={t('admin.suspendedCompanies')}
          value={data.companies.suspended}
          tone={data.companies.suspended ? 'danger' : 'default'}
        />
        <Stat
          label={t('admin.pendingProofs')}
          value={data.pendingProofs}
          tone={data.pendingProofs ? 'warn' : 'default'}
        />
        <Stat label={t('admin.openInvoices')} value={data.openInvoices} />
        <Stat label={t('admin.paidTotal')} value={formatSAR(data.paidTotal, locale)} />
        <Stat label={t('admin.users')} value={data.users} />
      </div>

      <div className="grid-2">
        <Card
          title={t('admin.expiring')}
          actions={
            <Link className="link small" to="/admin/companies?status=active">
              {t('admin.viewAll')}
            </Link>
          }
        >
          {data.expiring.length === 0 ? (
            <EmptyState>{t('common.noData')}</EmptyState>
          ) : (
            <ul className="plain-list">
              {data.expiring.map((company) => (
                <li key={company.id}>
                  <Link to={`/admin/companies/${company.id}`}>{company.name}</Link>
                  <span className="muted small">{formatDate(company.subscriptionEnd, locale)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title={t('admin.usageTitle')} subtitle={t('admin.usageNote')}>
          <dl className="detail-list">
            {['site_analysis', 'content_generation', 'image_generation'].map((kind) => (
              <div key={kind}>
                <dt>
                  {kind === 'site_analysis'
                    ? t('module.siteAnalysis')
                    : kind === 'content_generation'
                      ? t('module.content')
                      : t('module.design')}
                </dt>
                <dd>{data.usage[kind] ?? 0}</dd>
              </div>
            ))}
          </dl>
        </Card>
      </div>

      <Card
        title={t('admin.recentCompanies')}
        actions={
          <Link className="btn btn-secondary btn-sm" to="/admin/companies">
            {t('admin.viewAll')}
          </Link>
        }
        padded={false}
      >
        {data.recentCompanies.length === 0 ? (
          <div className="card-body">
            <EmptyState>{t('common.noData')}</EmptyState>
          </div>
        ) : (
          <Table
            head={[t('admin.company'), t('admin.owner'), t('admin.subEnd'), t('common.status'), '']}
          >
            {data.recentCompanies.map((company) => (
              <tr key={company.id}>
                <td>
                  <Link to={`/admin/companies/${company.id}`} className="link">
                    {company.name}
                  </Link>
                </td>
                <td className="muted small" dir="ltr">
                  {company.ownerEmail ?? '—'}
                </td>
                <td>{formatDate(company.subscriptionEnd, locale)}</td>
                <td>
                  <StatusBadge status={company.subscription.effectiveStatus} />
                </td>
                <td>
                  <Link className="link small" to={`/admin/companies/${company.id}`}>
                    {t('common.details')}
                  </Link>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Companies
// ---------------------------------------------------------------------------

export function AdminCompaniesPage() {
  const { t, locale } = useSession();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState({ q: '', status: '' });
  const path = useMemo(() => {
    const params = new URLSearchParams();
    if (search.q) params.set('q', search.q);
    if (search.status) params.set('status', search.status);
    const suffix = params.toString();
    return `/api/admin/companies${suffix ? `?${suffix}` : ''}`;
  }, [search]);
  const { data, loading, reload } = useApi<{ companies: CompanySummary[] }>(path);
  const plans = useApi<{ plans: Plan[] }>('/api/admin/plans');

  const [open, setOpen] = useState(false);
  const [created, setCreated] = useState<{ id: string; tempPassword: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  const [form, setForm] = useState({
    name: '',
    legalName: '',
    domain: '',
    industry: '',
    city: '',
    contactName: '',
    contactEmail: '',
    contactPhone: '',
    planId: '',
    subscriptionStart: '',
    subscriptionEnd: '',
    status: 'pending' as CompanyStatus,
    ownerName: '',
    ownerEmail: '',
    invoiceAmount: '',
    invoiceNotes: '',
  });

  const createCompany = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ companyId: string; ownerTempPassword: string | null }>(
        '/api/admin/companies',
        {
          method: 'POST',
          body: {
            ...form,
            planId: form.planId || null,
            invoiceAmount: form.invoiceAmount ? Number(form.invoiceAmount) : 0,
          },
        }
      );
      setOpen(false);
      setCreated({ id: result.companyId, tempPassword: result.ownerTempPassword });
      setForm({
        name: '',
        legalName: '',
        domain: '',
        industry: '',
        city: '',
        contactName: '',
        contactEmail: '',
        contactPhone: '',
        planId: '',
        subscriptionStart: '',
        subscriptionEnd: '',
        status: 'pending',
        ownerName: '',
        ownerEmail: '',
        invoiceAmount: '',
        invoiceNotes: '',
      });
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.code : 'internal_error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title={t('admin.companiesTitle')}
        subtitle={t('admin.companiesSubtitle')}
        actions={<Button onClick={() => setOpen(true)}>{t('admin.newCompany')}</Button>}
      />

      <Card>
        <div className="filters">
          <Input
            placeholder={t('common.search')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') setSearch({ q: query, status });
            }}
          />
          <Select value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="">{t('common.all')}</option>
            {COMPANY_STATUSES.map((value) => (
              <option key={value} value={value}>
                {t(`status.${value}`)}
              </option>
            ))}
          </Select>
          <Button variant="secondary" onClick={() => setSearch({ q: query, status })}>
            {t('common.search')}
          </Button>
        </div>
      </Card>

      <Card padded={false}>
        {loading || !data ? (
          <div className="card-body">
            <Loading />
          </div>
        ) : data.companies.length === 0 ? (
          <div className="card-body">
            <EmptyState>{t('common.noData')}</EmptyState>
          </div>
        ) : (
          <Table
            head={[
              t('admin.company'),
              t('admin.owner'),
              t('admin.plan'),
              t('admin.members'),
              t('admin.subEnd'),
              t('common.status'),
              '',
            ]}
          >
            {data.companies.map((company) => (
              <tr key={company.id}>
                <td>
                  <div className="cell-stack">
                    <Link className="link" to={`/admin/companies/${company.id}`}>
                      {company.name}
                    </Link>
                    <span className="muted small" dir="ltr">
                      {company.domain ?? '—'}
                    </span>
                  </div>
                </td>
                <td>
                  <div className="cell-stack">
                    <span>{company.ownerName ?? '—'}</span>
                    <span className="muted small" dir="ltr">
                      {company.ownerEmail ?? '—'}
                    </span>
                  </div>
                </td>
                <td>{company.planName ?? t('common.notSet')}</td>
                <td>{company.membersCount ?? 0}</td>
                <td>{formatDate(company.subscriptionEnd, locale)}</td>
                <td>
                  <StatusBadge status={company.subscription.effectiveStatus} />
                </td>
                <td>
                  <Link className="link small" to={`/admin/companies/${company.id}`}>
                    {t('common.details')}
                  </Link>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Modal
        open={open}
        title={t('admin.newCompany')}
        wide
        onClose={() => setOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button form="company-form" type="submit" loading={busy}>
              {t('admin.createCompany')}
            </Button>
          </>
        }
      >
        {error ? <Alert tone="danger">{t(errorKey(error))}</Alert> : null}
        <form id="company-form" onSubmit={createCompany} className="form-grid">
          <Field label={t('profile.companyName')} htmlFor="ac-name">
            <Input
              id="ac-name"
              required
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
            />
          </Field>
          <Field label={t('profile.legalName')} htmlFor="ac-legal">
            <Input
              id="ac-legal"
              value={form.legalName}
              onChange={(event) => setForm({ ...form, legalName: event.target.value })}
            />
          </Field>
          <Field label={t('profile.website')} htmlFor="ac-domain">
            <Input
              id="ac-domain"
              dir="ltr"
              placeholder="https://example.com"
              value={form.domain}
              onChange={(event) => setForm({ ...form, domain: event.target.value })}
            />
          </Field>
          <Field label={t('common.industry')} htmlFor="ac-industry">
            <Input
              id="ac-industry"
              value={form.industry}
              onChange={(event) => setForm({ ...form, industry: event.target.value })}
            />
          </Field>
          <Field label={t('common.city')} htmlFor="ac-city">
            <Input
              id="ac-city"
              value={form.city}
              onChange={(event) => setForm({ ...form, city: event.target.value })}
            />
          </Field>
          <Field label={t('admin.ownerName')} htmlFor="ac-contact">
            <Input
              id="ac-contact"
              value={form.contactName}
              onChange={(event) => setForm({ ...form, contactName: event.target.value })}
            />
          </Field>
          <Field label={t('common.email')} htmlFor="ac-email">
            <Input
              id="ac-email"
              type="email"
              dir="ltr"
              value={form.contactEmail}
              onChange={(event) => setForm({ ...form, contactEmail: event.target.value })}
            />
          </Field>
          <Field label={t('common.phone')} htmlFor="ac-phone">
            <Input
              id="ac-phone"
              dir="ltr"
              value={form.contactPhone}
              onChange={(event) => setForm({ ...form, contactPhone: event.target.value })}
            />
          </Field>
          <Field label={t('admin.plan')} htmlFor="ac-plan">
            <Select
              id="ac-plan"
              value={form.planId}
              onChange={(event) => setForm({ ...form, planId: event.target.value })}
            >
              <option value="">{t('common.notSet')}</option>
              {plans.data?.plans.map((plan) => (
                <option key={plan.id} value={plan.id}>
                  {locale === 'ar' ? plan.nameAr : plan.nameEn}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('admin.initialStatus')} htmlFor="ac-status">
            <Select
              id="ac-status"
              value={form.status}
              onChange={(event) =>
                setForm({ ...form, status: event.target.value as CompanyStatus })
              }
            >
              {COMPANY_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {t(`status.${value}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('admin.subStart')} htmlFor="ac-start">
            <Input
              id="ac-start"
              type="date"
              value={form.subscriptionStart}
              onChange={(event) => setForm({ ...form, subscriptionStart: event.target.value })}
            />
          </Field>
          <Field label={t('admin.subEnd')} htmlFor="ac-end">
            <Input
              id="ac-end"
              type="date"
              value={form.subscriptionEnd}
              onChange={(event) => setForm({ ...form, subscriptionEnd: event.target.value })}
            />
          </Field>
          <Field label={t('admin.ownerName')} htmlFor="ac-owner-name">
            <Input
              id="ac-owner-name"
              value={form.ownerName}
              onChange={(event) => setForm({ ...form, ownerName: event.target.value })}
            />
          </Field>
          <Field label={t('admin.ownerEmail')} htmlFor="ac-owner-email">
            <Input
              id="ac-owner-email"
              type="email"
              dir="ltr"
              value={form.ownerEmail}
              onChange={(event) => setForm({ ...form, ownerEmail: event.target.value })}
            />
          </Field>
          <Field
            label={t('admin.invoiceOnCreate')}
            hint={t('admin.priceZeroHint')}
            htmlFor="ac-amount"
          >
            <Input
              id="ac-amount"
              type="number"
              min={0}
              dir="ltr"
              value={form.invoiceAmount}
              onChange={(event) => setForm({ ...form, invoiceAmount: event.target.value })}
            />
          </Field>
          <Field label={t('admin.invoiceNotes')} htmlFor="ac-invoice-notes">
            <Input
              id="ac-invoice-notes"
              value={form.invoiceNotes}
              onChange={(event) => setForm({ ...form, invoiceNotes: event.target.value })}
            />
          </Field>
        </form>
      </Modal>

      <Modal
        open={Boolean(created)}
        title={t('admin.createdTitle')}
        onClose={() => setCreated(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setCreated(null)}>
              {t('common.close')}
            </Button>
            {created ? (
              <Button onClick={() => navigate(`/admin/companies/${created.id}`)}>
                {t('common.details')}
              </Button>
            ) : null}
          </>
        }
      >
        {created?.tempPassword ? (
          <>
            <p className="muted">{t('admin.createdNote')}</p>
            <CopyValue value={created.tempPassword} />
          </>
        ) : (
          <p className="muted">{t('common.saved')}</p>
        )}
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------------------
// Company detail
// ---------------------------------------------------------------------------

type CompanyDetail = {
  company: CompanySummary;
  members: Member[];
  invoices: Invoice[];
  usage: Record<string, number>;
  activity: AuditEntry[];
};

export function AdminCompanyDetailPage() {
  const { companyId } = useParams();
  const { t, locale } = useSession();
  const { data, loading, error, reload } = useApi<CompanyDetail>(
    companyId ? `/api/admin/companies/${companyId}` : null
  );
  const plans = useApi<{ plans: Plan[] }>('/api/admin/plans');
  const [form, setForm] = useState({
    name: '',
    legalName: '',
    domain: '',
    industry: '',
    city: '',
    contactName: '',
    contactEmail: '',
    contactPhone: '',
    notes: '',
    planId: '',
    status: 'pending' as CompanyStatus,
    subscriptionStart: '',
    subscriptionEnd: '',
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const [invoiceOpen, setInvoiceOpen] = useState(false);
  const [invoiceForm, setInvoiceForm] = useState({
    amountSar: '',
    periodStart: '',
    periodEnd: '',
    dueAt: '',
    notes: '',
  });

  useEffect(() => {
    if (!data) return;
    const company = data.company;
    setForm({
      name: company.name,
      legalName: company.legalName ?? '',
      domain: company.domain ?? '',
      industry: company.industry ?? '',
      city: company.city ?? '',
      contactName: company.contactName ?? '',
      contactEmail: company.contactEmail ?? '',
      contactPhone: company.contactPhone ?? '',
      notes: company.notes ?? '',
      planId: company.planId ?? '',
      status: company.status,
      subscriptionStart: company.subscriptionStart?.slice(0, 10) ?? '',
      subscriptionEnd: company.subscriptionEnd?.slice(0, 10) ?? '',
    });
  }, [data]);

  if (loading || !data) return <Loading />;
  if (error) {
    return (
      <Card title={t(errorKey(error))}>
        <Link className="btn btn-secondary" to="/admin/companies">
          {t('common.back')}
        </Link>
      </Card>
    );
  }

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    setFormError(null);
    try {
      await api(`/api/admin/companies/${data.company.id}`, {
        method: 'PATCH',
        body: { ...form, planId: form.planId || null },
      });
      setMessage(t('common.saved'));
      reload();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.code : 'internal_error');
    } finally {
      setBusy(false);
    }
  };

  const removeCompany = async () => {
    if (!window.confirm(t('admin.deleteConfirm'))) return;
    await api(`/api/admin/companies/${data.company.id}`, { method: 'DELETE' });
    window.location.href = '/admin/companies';
  };

  const resetPassword = async (member: Member) => {
    if (!window.confirm(`${t('admin.resetConfirm')} (${member.email})`)) return;
    const result = await api<{ tempPassword: string }>(
      `/api/admin/users/${member.userId}/reset-password`,
      { method: 'POST' }
    );
    window.alert(`${t('admin.tempPassword')}: ${result.tempPassword}`);
  };

  const createInvoice = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setFormError(null);
    try {
      await api(`/api/admin/companies/${data.company.id}/invoices`, {
        method: 'POST',
        body: { ...invoiceForm, amountSar: Number(invoiceForm.amountSar) },
      });
      setInvoiceOpen(false);
      setInvoiceForm({ amountSar: '', periodStart: '', periodEnd: '', dueAt: '', notes: '' });
      setMessage(t('admin.invoiceCreated'));
      reload();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.code : 'internal_error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title={data.company.name}
        subtitle={data.company.ownerEmail ?? undefined}
        actions={
          <>
            <StatusBadge status={data.company.subscription.effectiveStatus} />
            <Button variant="danger" onClick={() => void removeCompany()}>
              {t('admin.deleteCompany')}
            </Button>
          </>
        }
      />
      {message ? (
        <Alert tone="ok" onClose={() => setMessage(null)}>
          {message}
        </Alert>
      ) : null}
      {formError ? <Alert tone="danger">{t(errorKey(formError))}</Alert> : null}

      <div className="grid-2">
        <Card title={t('admin.companyDetail')}>
          <form onSubmit={save} className="stack">
            <Field label={t('profile.companyName')} htmlFor="d-name">
              <Input
                id="d-name"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
              />
            </Field>
            <Field label={t('profile.legalName')} htmlFor="d-legal">
              <Input
                id="d-legal"
                value={form.legalName}
                onChange={(event) => setForm({ ...form, legalName: event.target.value })}
              />
            </Field>
            <Field label={t('profile.website')} htmlFor="d-domain">
              <Input
                id="d-domain"
                dir="ltr"
                value={form.domain}
                onChange={(event) => setForm({ ...form, domain: event.target.value })}
              />
            </Field>
            <div className="form-row">
              <Field label={t('common.industry')} htmlFor="d-industry">
                <Input
                  id="d-industry"
                  value={form.industry}
                  onChange={(event) => setForm({ ...form, industry: event.target.value })}
                />
              </Field>
              <Field label={t('common.city')} htmlFor="d-city">
                <Input
                  id="d-city"
                  value={form.city}
                  onChange={(event) => setForm({ ...form, city: event.target.value })}
                />
              </Field>
            </div>
            <Field label={t('admin.ownerName')} htmlFor="d-contact">
              <Input
                id="d-contact"
                value={form.contactName}
                onChange={(event) => setForm({ ...form, contactName: event.target.value })}
              />
            </Field>
            <div className="form-row">
              <Field label={t('common.email')} htmlFor="d-email">
                <Input
                  id="d-email"
                  type="email"
                  dir="ltr"
                  value={form.contactEmail}
                  onChange={(event) => setForm({ ...form, contactEmail: event.target.value })}
                />
              </Field>
              <Field label={t('common.phone')} htmlFor="d-phone">
                <Input
                  id="d-phone"
                  dir="ltr"
                  value={form.contactPhone}
                  onChange={(event) => setForm({ ...form, contactPhone: event.target.value })}
                />
              </Field>
            </div>
            <Field label={t('common.notes')} htmlFor="d-notes">
              <Textarea
                id="d-notes"
                rows={3}
                value={form.notes}
                onChange={(event) => setForm({ ...form, notes: event.target.value })}
              />
            </Field>
            <Button type="submit" loading={busy}>
              {t('common.save')}
            </Button>
          </form>
        </Card>

        <Card title={t('dash.subscription')} subtitle={t('admin.statusNote')}>
          <form onSubmit={save} className="stack">
            <Field label={t('admin.plan')} htmlFor="d-plan">
              <Select
                id="d-plan"
                value={form.planId}
                onChange={(event) => setForm({ ...form, planId: event.target.value })}
              >
                <option value="">{t('common.notSet')}</option>
                {plans.data?.plans.map((plan) => (
                  <option key={plan.id} value={plan.id}>
                    {locale === 'ar' ? plan.nameAr : plan.nameEn}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('common.status')} htmlFor="d-status">
              <Select
                id="d-status"
                value={form.status}
                onChange={(event) =>
                  setForm({ ...form, status: event.target.value as CompanyStatus })
                }
              >
                {COMPANY_STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {t(`status.${value}`)}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="form-row">
              <Field label={t('admin.subStart')} htmlFor="d-start">
                <Input
                  id="d-start"
                  type="date"
                  value={form.subscriptionStart}
                  onChange={(event) => setForm({ ...form, subscriptionStart: event.target.value })}
                />
              </Field>
              <Field label={t('admin.subEnd')} htmlFor="d-end">
                <Input
                  id="d-end"
                  type="date"
                  value={form.subscriptionEnd}
                  onChange={(event) => setForm({ ...form, subscriptionEnd: event.target.value })}
                />
              </Field>
            </div>
            <Button type="submit" loading={busy}>
              {t('common.save')}
            </Button>
          </form>
        </Card>
      </div>

      <Card
        title={t('admin.invoiceCount')}
        actions={<Button onClick={() => setInvoiceOpen(true)}>{t('admin.createInvoice')}</Button>}
        padded={false}
      >
        {data.invoices.length === 0 ? (
          <div className="card-body">
            <EmptyState>{t('sub.noInvoices')}</EmptyState>
          </div>
        ) : (
          <Table
            head={[
              t('sub.invoiceNumber'),
              t('sub.period'),
              t('common.amount'),
              t('sub.issuedAt'),
              t('common.status'),
              t('sub.proofs'),
            ]}
          >
            {data.invoices.map((invoice) => (
              <tr key={invoice.id}>
                <td dir="ltr">{invoice.number}</td>
                <td className="small">
                  {formatDate(invoice.periodStart, locale)} — {formatDate(invoice.periodEnd, locale)}
                </td>
                <td>{formatSAR(invoice.amountSar, locale)}</td>
                <td>{formatDate(invoice.issuedAt, locale)}</td>
                <td>
                  <StatusBadge status={invoice.status} />
                </td>
                <td>
                  {invoice.proofs.length === 0 ? (
                    <span className="muted">—</span>
                  ) : (
                    <div className="cell-stack">
                      {invoice.proofs.map((proof) => (
                        <a
                          key={proof.id}
                          className="link small"
                          href={`/api/admin/proofs/${proof.id}/file`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {proof.fileName} · {formatBytes(proof.sizeBytes)}
                        </a>
                      ))}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card title={t('team.title')} padded={false}>
        {data.members.length === 0 ? (
          <div className="card-body">
            <EmptyState>{t('team.noMembers')}</EmptyState>
          </div>
        ) : (
          <Table
            head={[
              t('common.name'),
              t('common.email'),
              t('team.role'),
              t('common.status'),
              t('team.lastLogin'),
              t('common.actions'),
            ]}
          >
            {data.members.map((member) => (
              <tr key={member.id}>
                <td>{member.name}</td>
                <td dir="ltr" className="muted">
                  {member.email}
                </td>
                <td>
                  <RoleBadge role={member.role} />
                </td>
                <td>
                  <StatusBadge status={member.status} />
                </td>
                <td className="muted small">
                  {member.lastLoginAt ? formatDateTime(member.lastLoginAt, locale) : t('team.never')}
                </td>
                <td>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void resetPassword(member)}
                  >
                    {t('admin.resetPassword')}
                  </Button>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card title={t('activity.title')} padded={false}>
        {data.activity.length === 0 ? (
          <div className="card-body">
            <EmptyState>{t('activity.empty')}</EmptyState>
          </div>
        ) : (
          <Table head={[t('admin.auditAction'), t('admin.auditActor'), t('common.date')]}>
            {data.activity.map((entry, index) => (
              <tr key={`${entry.action}-${index}`}>
                <td dir="ltr" className="small">
                  {entry.action}
                </td>
                <td dir="ltr" className="muted small">
                  {entry.actorEmail ?? '—'}
                </td>
                <td className="muted small">{formatDateTime(entry.createdAt, locale)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Modal
        open={invoiceOpen}
        title={t('admin.createInvoice')}
        onClose={() => setInvoiceOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setInvoiceOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button form="invoice-form" type="submit" loading={busy}>
              {t('admin.createInvoice')}
            </Button>
          </>
        }
      >
        <form id="invoice-form" onSubmit={createInvoice} className="stack">
          <Field label={t('common.amount')} htmlFor="i-amount">
            <Input
              id="i-amount"
              type="number"
              min={1}
              required
              dir="ltr"
              value={invoiceForm.amountSar}
              onChange={(event) => setInvoiceForm({ ...invoiceForm, amountSar: event.target.value })}
            />
          </Field>
          <div className="form-row">
            <Field label={t('admin.subStart')} htmlFor="i-start">
              <Input
                id="i-start"
                type="date"
                value={invoiceForm.periodStart}
                onChange={(event) =>
                  setInvoiceForm({ ...invoiceForm, periodStart: event.target.value })
                }
              />
            </Field>
            <Field label={t('admin.subEnd')} htmlFor="i-end">
              <Input
                id="i-end"
                type="date"
                value={invoiceForm.periodEnd}
                onChange={(event) =>
                  setInvoiceForm({ ...invoiceForm, periodEnd: event.target.value })
                }
              />
            </Field>
          </div>
          <Field label={t('sub.dueDate')} htmlFor="i-due">
            <Input
              id="i-due"
              type="date"
              value={invoiceForm.dueAt}
              onChange={(event) => setInvoiceForm({ ...invoiceForm, dueAt: event.target.value })}
            />
          </Field>
          <Field label={t('admin.invoiceNotes')} htmlFor="i-notes">
            <Input
              id="i-notes"
              value={invoiceForm.notes}
              onChange={(event) => setInvoiceForm({ ...invoiceForm, notes: event.target.value })}
            />
          </Field>
        </form>
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------------------
// Invoices & proof review
// ---------------------------------------------------------------------------

export function AdminInvoicesPage() {
  const { t, locale } = useSession();
  const invoices = useApi<{ invoices: AdminInvoice[] }>('/api/admin/invoices');
  const proofs = useApi<{ proofs: AdminProof[] }>('/api/admin/proofs?status=pending_review');
  const [review, setReview] = useState<AdminProof | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decide = async (decision: 'approved' | 'rejected') => {
    if (!review) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/admin/proofs/${review.id}/review`, {
        method: 'POST',
        body: { decision, note },
      });
      setReview(null);
      setNote('');
      proofs.reload();
      invoices.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.code : 'internal_error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title={t('admin.invoicesTitle')} subtitle={t('admin.invoicesSubtitle')} />
      {error ? <Alert tone="danger">{t(errorKey(error))}</Alert> : null}

      <Card title={t('admin.pendingProofsTitle')}>
        {proofs.loading || !proofs.data ? (
          <Loading />
        ) : proofs.data.proofs.length === 0 ? (
          <EmptyState>{t('admin.noPendingProofs')}</EmptyState>
        ) : (
          <Table
            head={[
              t('admin.company'),
              t('sub.invoiceNumber'),
              t('common.amount'),
              t('common.file'),
              t('common.date'),
              t('common.actions'),
            ]}
          >
            {proofs.data.proofs.map((proof) => (
              <tr key={proof.id}>
                <td>{proof.companyName}</td>
                <td dir="ltr">{proof.invoiceNumber}</td>
                <td>{formatSAR(proof.invoiceAmountSar, locale)}</td>
                <td>
                  <a
                    className="link small"
                    href={`/api/admin/proofs/${proof.id}/file`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {proof.fileName} · {formatBytes(proof.sizeBytes)}
                  </a>
                </td>
                <td className="muted small">{formatDate(proof.createdAt, locale)}</td>
                <td>
                  <Button
                    size="sm"
                    onClick={() => {
                      setReview(proof);
                      setNote('');
                      setError(null);
                    }}
                  >
                    {t('admin.reviewProof')}
                  </Button>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card title={t('admin.invoiceCount')} padded={false}>
        {invoices.loading || !invoices.data ? (
          <div className="card-body">
            <Loading />
          </div>
        ) : invoices.data.invoices.length === 0 ? (
          <div className="card-body">
            <EmptyState>{t('sub.noInvoices')}</EmptyState>
          </div>
        ) : (
          <Table
            head={[
              t('admin.company'),
              t('sub.invoiceNumber'),
              t('common.amount'),
              t('sub.period'),
              t('common.status'),
            ]}
          >
            {invoices.data.invoices.map((invoice) => (
              <tr key={invoice.id}>
                <td>
                  <Link className="link" to={`/admin/companies/${invoice.companyId}`}>
                    {invoice.companyName}
                  </Link>
                </td>
                <td dir="ltr">{invoice.number}</td>
                <td>{formatSAR(invoice.amountSar, locale)}</td>
                <td className="small">
                  {formatDate(invoice.periodStart, locale)} — {formatDate(invoice.periodEnd, locale)}
                </td>
                <td>
                  <StatusBadge status={invoice.status} />
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Modal
        open={Boolean(review)}
        title={t('admin.reviewProof')}
        onClose={() => setReview(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setReview(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="danger" loading={busy} onClick={() => void decide('rejected')}>
              {t('admin.reject')}
            </Button>
            <Button loading={busy} onClick={() => void decide('approved')}>
              {t('admin.approve')}
            </Button>
          </>
        }
      >
        {review ? (
          <div className="stack">
            <dl className="detail-list">
              <div>
                <dt>{t('admin.company')}</dt>
                <dd>{review.companyName}</dd>
              </div>
              <div>
                <dt>{t('sub.invoiceNumber')}</dt>
                <dd dir="ltr">{review.invoiceNumber}</dd>
              </div>
              <div>
                <dt>{t('common.amount')}</dt>
                <dd>{formatSAR(review.invoiceAmountSar, locale)}</dd>
              </div>
              <div>
                <dt>{t('sub.reference')}</dt>
                <dd dir="ltr">{review.reference ?? '—'}</dd>
              </div>
              <div>
                <dt>{t('sub.proofNote')}</dt>
                <dd>{review.note ?? '—'}</dd>
              </div>
            </dl>
            <a
              className="btn btn-secondary btn-sm"
              href={`/api/admin/proofs/${review.id}/file`}
              target="_blank"
              rel="noreferrer"
            >
              {t('admin.openFile')}
            </a>
            <Field label={t('admin.reviewNote')} htmlFor="review-note">
              <Textarea
                id="review-note"
                rows={3}
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
            </Field>
          </div>
        ) : null}
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

export function AdminPlansPage() {
  const { t, locale } = useSession();
  const { data, loading, reload } = useApi<{ plans: Plan[] }>('/api/admin/plans');
  const [drafts, setDrafts] = useState<Record<string, any>>({});
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newPlan, setNewPlan] = useState({
    nameAr: '',
    nameEn: '',
    priceSar: '',
    maxUsers: '',
    featuresAr: '',
    featuresEn: '',
  });

  const planDraft = (plan: Plan) =>
    drafts[plan.id] ?? {
      nameAr: plan.nameAr,
      nameEn: plan.nameEn,
      priceSar: String(plan.priceSar),
      maxUsers: plan.maxUsers ? String(plan.maxUsers) : '',
      featuresAr: plan.featuresAr.join('\n'),
      featuresEn: plan.featuresEn.join('\n'),
      isActive: plan.isActive,
    };

  const updateDraft = (plan: Plan, patch: Record<string, unknown>) =>
    setDrafts({ ...drafts, [plan.id]: { ...planDraft(plan), ...patch } });

  const savePlan = async (plan: Plan) => {
    const draft = planDraft(plan);
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      await api(`/api/admin/plans/${plan.id}`, {
        method: 'PATCH',
        body: {
          nameAr: draft.nameAr,
          nameEn: draft.nameEn,
          priceSar: Number(draft.priceSar) || 0,
          maxUsers: draft.maxUsers ? Number(draft.maxUsers) : null,
          featuresAr: String(draft.featuresAr)
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean),
          featuresEn: String(draft.featuresEn)
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean),
          isActive: draft.isActive,
        },
      });
      setMessage(t('common.saved'));
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.code : 'internal_error');
    } finally {
      setBusy(false);
    }
  };

  const createPlan = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/api/admin/plans', {
        method: 'POST',
        body: {
          nameAr: newPlan.nameAr,
          nameEn: newPlan.nameEn || newPlan.nameAr,
          priceSar: Number(newPlan.priceSar) || 0,
          maxUsers: newPlan.maxUsers ? Number(newPlan.maxUsers) : null,
          featuresAr: newPlan.featuresAr.split('\n').map((line) => line.trim()).filter(Boolean),
          featuresEn: newPlan.featuresEn.split('\n').map((line) => line.trim()).filter(Boolean),
        },
      });
      setOpen(false);
      setNewPlan({ nameAr: '', nameEn: '', priceSar: '', maxUsers: '', featuresAr: '', featuresEn: '' });
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.code : 'internal_error');
    } finally {
      setBusy(false);
    }
  };

  if (loading || !data) return <Loading />;

  return (
    <>
      <PageHeader
        title={t('admin.plansTitle')}
        subtitle={t('admin.plansSubtitle')}
        actions={<Button onClick={() => setOpen(true)}>{t('admin.addPlan')}</Button>}
      />
      {message ? <Alert tone="ok">{message}</Alert> : null}
      {error ? <Alert tone="danger">{t(errorKey(error))}</Alert> : null}

      <div className="plan-grid">
        {data.plans.map((plan) => {
          const draft = planDraft(plan);
          return (
            <Card key={plan.id} title={locale === 'ar' ? plan.nameAr : plan.nameEn}>
              <div className="stack">
                <div className="form-row">
                  <Field label={t('admin.planNameAr')} htmlFor={`p-ar-${plan.id}`}>
                    <Input
                      id={`p-ar-${plan.id}`}
                      value={draft.nameAr}
                      onChange={(event) => updateDraft(plan, { nameAr: event.target.value })}
                    />
                  </Field>
                  <Field label={t('admin.planNameEn')} htmlFor={`p-en-${plan.id}`}>
                    <Input
                      id={`p-en-${plan.id}`}
                      dir="ltr"
                      value={draft.nameEn}
                      onChange={(event) => updateDraft(plan, { nameEn: event.target.value })}
                    />
                  </Field>
                </div>
                <div className="form-row">
                  <Field label={t('admin.priceSar')} hint={t('admin.priceZeroHint')} htmlFor={`p-price-${plan.id}`}>
                    <Input
                      id={`p-price-${plan.id}`}
                      type="number"
                      min={0}
                      dir="ltr"
                      value={draft.priceSar}
                      onChange={(event) => updateDraft(plan, { priceSar: event.target.value })}
                    />
                  </Field>
                  <Field label={t('admin.maxUsers')} htmlFor={`p-users-${plan.id}`}>
                    <Input
                      id={`p-users-${plan.id}`}
                      type="number"
                      min={1}
                      dir="ltr"
                      value={draft.maxUsers}
                      onChange={(event) => updateDraft(plan, { maxUsers: event.target.value })}
                    />
                  </Field>
                </div>
                <Field label={t('admin.featuresAr')} htmlFor={`p-far-${plan.id}`}>
                  <Textarea
                    id={`p-far-${plan.id}`}
                    rows={3}
                    value={draft.featuresAr}
                    onChange={(event) => updateDraft(plan, { featuresAr: event.target.value })}
                  />
                </Field>
                <Field label={t('admin.featuresEn')} htmlFor={`p-fen-${plan.id}`}>
                  <Textarea
                    id={`p-fen-${plan.id}`}
                    rows={3}
                    dir="ltr"
                    value={draft.featuresEn}
                    onChange={(event) => updateDraft(plan, { featuresEn: event.target.value })}
                  />
                </Field>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={Boolean(draft.isActive)}
                    onChange={(event) => updateDraft(plan, { isActive: event.target.checked })}
                  />
                  <span>{t('admin.activePlan')}</span>
                </label>
                <Button size="sm" loading={busy} onClick={() => void savePlan(plan)}>
                  {t('common.save')}
                </Button>
              </div>
            </Card>
          );
        })}
      </div>

      <Modal
        open={open}
        title={t('admin.addPlan')}
        onClose={() => setOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button form="plan-form" type="submit" loading={busy}>
              {t('common.create')}
            </Button>
          </>
        }
      >
        <form id="plan-form" onSubmit={createPlan} className="stack">
          <Field label={t('admin.planNameAr')} htmlFor="np-ar">
            <Input
              id="np-ar"
              required
              value={newPlan.nameAr}
              onChange={(event) => setNewPlan({ ...newPlan, nameAr: event.target.value })}
            />
          </Field>
          <Field label={t('admin.planNameEn')} htmlFor="np-en">
            <Input
              id="np-en"
              dir="ltr"
              value={newPlan.nameEn}
              onChange={(event) => setNewPlan({ ...newPlan, nameEn: event.target.value })}
            />
          </Field>
          <div className="form-row">
            <Field label={t('admin.priceSar')} htmlFor="np-price">
              <Input
                id="np-price"
                type="number"
                min={0}
                dir="ltr"
                value={newPlan.priceSar}
                onChange={(event) => setNewPlan({ ...newPlan, priceSar: event.target.value })}
              />
            </Field>
            <Field label={t('admin.maxUsers')} htmlFor="np-users">
              <Input
                id="np-users"
                type="number"
                min={1}
                dir="ltr"
                value={newPlan.maxUsers}
                onChange={(event) => setNewPlan({ ...newPlan, maxUsers: event.target.value })}
              />
            </Field>
          </div>
          <Field label={t('admin.featuresAr')} htmlFor="np-far">
            <Textarea
              id="np-far"
              rows={3}
              value={newPlan.featuresAr}
              onChange={(event) => setNewPlan({ ...newPlan, featuresAr: event.target.value })}
            />
          </Field>
          <Field label={t('admin.featuresEn')} htmlFor="np-fen">
            <Textarea
              id="np-fen"
              rows={3}
              dir="ltr"
              value={newPlan.featuresEn}
              onChange={(event) => setNewPlan({ ...newPlan, featuresEn: event.target.value })}
            />
          </Field>
        </form>
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export function AdminUsersPage() {
  const { t } = useSession();
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const { data, loading, reload } = useApi<{ users: AdminUser[] }>(
    `/api/admin/users${search ? `?q=${encodeURIComponent(search)}` : ''}`
  );
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', password: '', superAdmin: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tempPassword, setTempPassword] = useState<string | null>(null);

  const addUser = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ tempPassword: string | null }>('/api/admin/users', {
        method: 'POST',
        body: {
          name: form.name,
          email: form.email,
          password: form.password || undefined,
          platformRole: form.superAdmin ? 'super_admin' : 'none',
        },
      });
      setOpen(false);
      setForm({ name: '', email: '', password: '', superAdmin: false });
      if (result.tempPassword) setTempPassword(result.tempPassword);
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.code : 'internal_error');
    } finally {
      setBusy(false);
    }
  };

  const patchUser = async (user: AdminUser, patch: Record<string, string>) => {
    setError(null);
    try {
      await api(`/api/admin/users/${user.id}`, { method: 'PATCH', body: patch });
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.code : 'internal_error');
    }
  };

  const reset = async (user: AdminUser) => {
    if (!window.confirm(`${t('admin.resetConfirm')} (${user.email})`)) return;
    const result = await api<{ tempPassword: string }>(
      `/api/admin/users/${user.id}/reset-password`,
      { method: 'POST' }
    );
    setTempPassword(result.tempPassword);
  };

  return (
    <>
      <PageHeader
        title={t('admin.usersTitle')}
        subtitle={t('admin.usersSubtitle')}
        actions={<Button onClick={() => setOpen(true)}>{t('admin.addUser')}</Button>}
      />
      {error ? <Alert tone="danger">{t(errorKey(error))}</Alert> : null}
      {tempPassword ? (
        <Alert tone="ok" onClose={() => setTempPassword(null)}>
          <strong>{t('admin.tempPassword')}</strong>
          <CopyValue value={tempPassword} />
        </Alert>
      ) : null}

      <Card>
        <div className="filters">
          <Input
            placeholder={t('common.search')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') setSearch(query);
            }}
          />
          <Button variant="secondary" onClick={() => setSearch(query)}>
            {t('common.search')}
          </Button>
        </div>
      </Card>

      <Card padded={false}>
        {loading || !data ? (
          <div className="card-body">
            <Loading />
          </div>
        ) : data.users.length === 0 ? (
          <div className="card-body">
            <EmptyState>{t('common.noData')}</EmptyState>
          </div>
        ) : (
          <Table
            head={[
              t('common.name'),
              t('common.email'),
              t('admin.role'),
              t('admin.membershipCount'),
              t('common.status'),
              t('common.actions'),
            ]}
          >
            {data.users.map((user) => (
              <tr key={user.id}>
                <td>{user.name}</td>
                <td dir="ltr" className="muted">
                  {user.email}
                </td>
                <td>
                  <Select
                    className="compact"
                    value={user.platformRole}
                    onChange={(event) =>
                      void patchUser(user, { platformRole: event.target.value })
                    }
                  >
                    <option value="none">{t('admin.regularUser')}</option>
                    <option value="super_admin">{t('admin.superAdmin')}</option>
                  </Select>
                </td>
                <td>{user.membershipsCount}</td>
                <td>
                  <StatusBadge status={user.status} />
                </td>
                <td>
                  <div className="row-actions">
                    <Button size="sm" variant="secondary" onClick={() => void reset(user)}>
                      {t('admin.resetPassword')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        void patchUser(user, {
                          status: user.status === 'active' ? 'disabled' : 'active',
                        })
                      }
                    >
                      {user.status === 'active' ? t('team.disabled') : t('team.enable')}
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Modal
        open={open}
        title={t('admin.addUser')}
        onClose={() => setOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button form="user-form" type="submit" loading={busy}>
              {t('common.create')}
            </Button>
          </>
        }
      >
        <form id="user-form" onSubmit={addUser} className="stack">
          <Field label={t('common.name')} htmlFor="u-name">
            <Input
              id="u-name"
              required
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
            />
          </Field>
          <Field label={t('common.email')} htmlFor="u-email">
            <Input
              id="u-email"
              type="email"
              dir="ltr"
              required
              value={form.email}
              onChange={(event) => setForm({ ...form, email: event.target.value })}
            />
          </Field>
          <Field
            label={t('common.password')}
            hint={t('admin.tempPassword')}
            htmlFor="u-password"
          >
            <Input
              id="u-password"
              type="password"
              dir="ltr"
              value={form.password}
              onChange={(event) => setForm({ ...form, password: event.target.value })}
            />
          </Field>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={form.superAdmin}
              onChange={(event) => setForm({ ...form, superAdmin: event.target.checked })}
            />
            <span>{t('admin.superAdmin')}</span>
          </label>
        </form>
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

type UsageRow = {
  companyId: string;
  companyName: string;
  siteAnalysis: number;
  contentGeneration: number;
  imageGeneration: number;
  emailSend: number;
  whatsappSend: number;
  costMicros: number;
};

export function AdminUsagePage() {
  const { t, locale } = useSession();
  const { data, loading } = useApi<{ usage: UsageRow[] }>('/api/admin/usage');
  if (loading || !data) return <Loading />;

  return (
    <>
      <PageHeader title={t('admin.usageTitle')} subtitle={t('admin.usageSubtitle')} />
      <Alert tone="info">{t('admin.usageNote')}</Alert>
      <Card padded={false}>
        {data.usage.length === 0 ? (
          <div className="card-body">
            <EmptyState>{t('common.noData')}</EmptyState>
          </div>
        ) : (
          <Table
            head={[
              t('admin.company'),
              t('module.siteAnalysis'),
              t('module.content'),
              t('module.design'),
              t('module.messaging'),
              t('admin.paidTotal'),
            ]}
          >
            {data.usage.map((row) => (
              <tr key={row.companyId}>
                <td>{row.companyName}</td>
                <td>{row.siteAnalysis}</td>
                <td>{row.contentGeneration}</td>
                <td>{row.imageGeneration}</td>
                <td>{row.emailSend + row.whatsappSend}</td>
                <td>{formatSAR(row.costMicros / 1_000_000, locale)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export function AdminAuditPage() {
  const { t, locale } = useSession();
  const [action, setAction] = useState('');
  const [search, setSearch] = useState('');
  const { data, loading } = useApi<{ logs: AuditEntry[] }>(
    `/api/admin/audit?limit=200${search ? `&action=${encodeURIComponent(search)}` : ''}`
  );

  return (
    <>
      <PageHeader title={t('admin.auditTitle')} subtitle={t('admin.auditSubtitle')} />
      <Card>
        <div className="filters">
          <Input
            placeholder={t('admin.auditAction')}
            value={action}
            onChange={(event) => setAction(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') setSearch(action);
            }}
          />
          <Button variant="secondary" onClick={() => setSearch(action)}>
            {t('common.search')}
          </Button>
        </div>
      </Card>
      <Card padded={false}>
        {loading || !data ? (
          <div className="card-body">
            <Loading />
          </div>
        ) : data.logs.length === 0 ? (
          <div className="card-body">
            <EmptyState>{t('common.noData')}</EmptyState>
          </div>
        ) : (
          <Table
            head={[
              t('admin.auditAction'),
              t('admin.auditActor'),
              t('admin.auditScope'),
              t('common.date'),
            ]}
          >
            {data.logs.map((log, index) => (
              <tr key={`${log.action}-${index}`}>
                <td dir="ltr" className="small">
                  {log.action}
                </td>
                <td dir="ltr" className="muted small">
                  {log.actorEmail ?? '—'}
                </td>
                <td dir="ltr" className="muted small">
                  {log.entityType ?? '—'}
                </td>
                <td className="muted small">{formatDateTime(log.createdAt, locale)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Platform settings
// ---------------------------------------------------------------------------

const SETTINGS_TABS = ['branding', 'support', 'bank', 'owner', 'general'] as const;
type SettingsTab = (typeof SETTINGS_TABS)[number];

export function AdminSettingsPage() {
  const { t, refresh } = useSession();
  const { data, loading, reload } = useApi<{ values: Record<string, string> }>(
    '/api/admin/settings'
  );
  const [tab, setTab] = useState<SettingsTab>('branding');
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (data?.values) setValues(data.values);
  }, [data]);

  if (loading || !data) return <Loading />;

  const set = (key: string, value: string) => setValues({ ...values, [key]: value });

  const save = async (keys: string[]) => {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const payload: Record<string, string> = {};
      for (const key of keys) payload[key] = values[key] ?? '';
      await api('/api/admin/settings', { method: 'PATCH', body: { values: payload } });
      setMessage(t('admin.settingsSaved'));
      reload();
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.code : 'internal_error');
    } finally {
      setBusy(false);
    }
  };

  const textField = (key: string, label: string, dir?: 'ltr') => (
    <Field label={label} htmlFor={key}>
      <Input
        id={key}
        dir={dir}
        value={values[key] ?? ''}
        onChange={(event) => set(key, event.target.value)}
      />
    </Field>
  );

  return (
    <>
      <PageHeader title={t('admin.settingsTitle')} subtitle={t('admin.settingsSubtitle')} />
      {message ? <Alert tone="ok">{message}</Alert> : null}
      {error ? <Alert tone="danger">{t(errorKey(error))}</Alert> : null}
      <Card subtitle={t('admin.emptyValueNote')}>
        <Tabs
          tabs={SETTINGS_TABS.map((id) => ({
            id,
            label: t(
              id === 'branding'
                ? 'admin.tabBranding'
                : id === 'support'
                  ? 'admin.tabSupport'
                  : id === 'bank'
                    ? 'admin.tabBank'
                    : id === 'owner'
                      ? 'admin.tabOwner'
                      : 'admin.tabGeneral'
            ),
          }))}
          active={tab}
          onChange={(id) => setTab(id as SettingsTab)}
        />

        {tab === 'branding' ? (
          <div className="stack">
            <div className="form-row">
              {textField('brand.name_ar', t('admin.brandNameAr'))}
              {textField('brand.name_en', t('admin.brandNameEn'), 'ltr')}
            </div>
            <div className="form-row">
              {textField('brand.tagline_ar', t('admin.taglineAr'))}
              {textField('brand.tagline_en', t('admin.taglineEn'), 'ltr')}
            </div>
            <div className="form-row">
              {textField('brand.primary_color', t('admin.primaryColor'), 'ltr')}
              {textField('brand.ink_color', t('admin.inkColor'), 'ltr')}
            </div>
            <div className="form-row">
              {textField('brand.logo_url', t('admin.logoUrl'), 'ltr')}
              {textField('brand.website', t('admin.website'), 'ltr')}
            </div>
            <Button
              loading={busy}
              onClick={() =>
                void save([
                  'brand.name_ar',
                  'brand.name_en',
                  'brand.tagline_ar',
                  'brand.tagline_en',
                  'brand.primary_color',
                  'brand.ink_color',
                  'brand.logo_url',
                  'brand.website',
                ])
              }
            >
              {t('common.save')}
            </Button>
          </div>
        ) : null}

        {tab === 'support' ? (
          <div className="stack">
            <div className="form-row">
              {textField('support.email', t('admin.supportEmail'), 'ltr')}
              {textField('support.whatsapp', t('admin.supportWhatsapp'), 'ltr')}
            </div>
            <Button
              loading={busy}
              onClick={() => void save(['support.email', 'support.whatsapp'])}
            >
              {t('common.save')}
            </Button>
          </div>
        ) : null}

        {tab === 'bank' ? (
          <div className="stack">
            <div className="form-row">
              {textField('billing.bank_name', t('admin.bankName'))}
              {textField('billing.account_name', t('admin.accountName'))}
            </div>
            <div className="form-row">
              {textField('billing.iban', t('admin.iban'), 'ltr')}
              {textField('billing.account_number', t('admin.accountNumber'), 'ltr')}
            </div>
            <div className="form-row">
              {textField('billing.notes_ar', t('admin.billingNotesAr'))}
              {textField('billing.notes_en', t('admin.billingNotesEn'), 'ltr')}
            </div>
            <Button
              loading={busy}
              onClick={() =>
                void save([
                  'billing.bank_name',
                  'billing.account_name',
                  'billing.iban',
                  'billing.account_number',
                  'billing.notes_ar',
                  'billing.notes_en',
                ])
              }
            >
              {t('common.save')}
            </Button>
          </div>
        ) : null}

        {tab === 'owner' ? (
          <div className="stack">
            <div className="form-row">
              {textField('owner.legal_name_ar', t('admin.ownerLegalAr'))}
              {textField('owner.legal_name_en', t('admin.ownerLegalEn'), 'ltr')}
            </div>
            <div className="form-row">
              {textField('owner.cr_number', t('admin.crNumber'), 'ltr')}
              {textField('owner.vat_number', t('admin.vatNumber'), 'ltr')}
            </div>
            <div className="form-row">
              {textField('owner.representative', t('admin.representative'))}
              {textField('owner.representative_phone', t('admin.repPhone'), 'ltr')}
            </div>
            {textField('owner.address', t('admin.ownerAddress'))}
            <div className="form-row">
              {textField('owner.email', t('admin.ownerOfficialEmail'), 'ltr')}
              {textField('owner.domain', t('admin.ownerDomain'), 'ltr')}
            </div>
            <Button
              loading={busy}
              onClick={() =>
                void save([
                  'owner.legal_name_ar',
                  'owner.legal_name_en',
                  'owner.cr_number',
                  'owner.vat_number',
                  'owner.representative',
                  'owner.representative_phone',
                  'owner.address',
                  'owner.email',
                  'owner.domain',
                ])
              }
            >
              {t('common.save')}
            </Button>
          </div>
        ) : null}

        {tab === 'general' ? (
          <div className="stack">
            <div className="form-row">
              <Field label={t('admin.warningDays')} htmlFor="warning">
                <Input
                  id="warning"
                  type="number"
                  min={1}
                  max={365}
                  dir="ltr"
                  value={values['subscription.warning_days'] ?? '30'}
                  onChange={(event) => set('subscription.warning_days', event.target.value)}
                />
              </Field>
              <Field label={t('admin.defaultLocale')} htmlFor="default-locale">
                <Select
                  id="default-locale"
                  value={values['platform.default_locale'] ?? 'ar'}
                  onChange={(event) => set('platform.default_locale', event.target.value)}
                >
                  <option value="ar">العربية</option>
                  <option value="en">English</option>
                </Select>
              </Field>
            </div>
            {textField('platform.supported_locales', t('admin.supportedLocales'), 'ltr')}
            <Button
              loading={busy}
              onClick={() =>
                void save([
                  'subscription.warning_days',
                  'platform.default_locale',
                  'platform.supported_locales',
                ])
              }
            >
              {t('common.save')}
            </Button>
          </div>
        ) : null}
      </Card>

      <Card title={t('admin.contractFiles')}>
        <p className="muted">{t('admin.contractsSoon')}</p>
      </Card>
    </>
  );
}

/** Shared role labels for the super admin company view. */
export const adminRoleLabel = (role: CompanyRole) => role;
