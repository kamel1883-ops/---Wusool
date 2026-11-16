import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, Navigate, Outlet, useNavigate, useOutletContext, useParams } from 'react-router-dom';
import {
  api,
  ApiError,
  useApi,
  type CompanyRole,
  type CompanySummary,
  type Invoice,
  type Member,
  type Subscription,
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
  Textarea,
  cx,
} from '../components/ui';

export type CompanyOverview = {
  company: CompanySummary;
  subscription: Subscription;
  role: CompanyRole;
  permissions: string[];
  plan: { id: string; nameAr: string; nameEn: string; priceSar: number; billingPeriod: string } | null;
  counts: { members: number; invoices: number; pendingProofs: number };
  usage: Record<string, number>;
  team: Member[];
};

export type CompanyContextValue = {
  overview: CompanyOverview;
  reload: () => void;
};

export const useCompanyCtx = () => useOutletContext<CompanyContextValue>();

export function CompanyLayout() {
  const { companyId } = useParams();
  const { me, t, locale } = useSession();
  const { data, loading, error, reload } = useApi<CompanyOverview>(
    companyId ? `/api/company/${companyId}` : null
  );

  const membership = me?.companies.find((company) => company.id === companyId);
  const permissions = data?.permissions ?? membership?.permissions ?? [];

  const nav = useMemo<NavItem[]>(() => {
    const base = `/app/${companyId}`;
    const items: NavItem[] = [
      { to: base, label: t('nav.dashboard'), icon: 'grid', end: true },
      ...(permissions.some((permission) => permission.startsWith('analysis.'))
        ? [{ to: `${base}/analyses`, label: t('nav.analyses'), icon: 'layers' as const }]
        : []),
      ...(permissions.includes('leads.manage')
        ? [{ to: `${base}/growth`, label: t('nav.growth'), icon: 'target' as const }]
        : []),
      { to: `${base}/company`, label: t('nav.company'), icon: 'building' },
      { to: `${base}/team`, label: t('nav.team'), icon: 'users' },
    ];
    if (permissions.includes('billing.manage')) {
      items.push({ to: `${base}/subscription`, label: t('nav.subscription'), icon: 'card' });
    }
    if (permissions.includes('team.manage')) {
      items.push({ to: `${base}/activity`, label: t('nav.activity'), icon: 'clock' });
    }
    items.push({ to: `${base}/settings`, label: t('nav.settings'), icon: 'settings' });
    return items;
  }, [companyId, permissions, t]);

  if (loading) return <FullPageLoading label={t('common.loading')} />;
  if (error || !data || !membership) {
    return (
      <div className="center-page">
        <Card title={t('err.company_not_found')}>
          <Link className="btn btn-secondary" to="/app">
            {t('common.back')}
          </Link>
        </Card>
      </div>
    );
  }

  return (
    <AppShell
      nav={nav}
      sectionLabel={t('nav.clientArea')}
      subscription={data.subscription}
    >
      <div className="workspace-head">
        <div>
          <span className="workspace-label">{t('dash.workspace')}</span>
          <strong>{data.company.name}</strong>
        </div>
        <div className="workspace-meta">
          {me && me.companies.length > 1 ? (
            <CompanySwitcher companyId={companyId ?? ''} />
          ) : null}
          <RoleBadge role={data.role} />
          {data.plan ? (
            <span className="badge badge-role">
              {locale === 'ar' ? data.plan.nameAr : data.plan.nameEn}
            </span>
          ) : null}
        </div>
      </div>
      <Outlet context={{ overview: data, reload } satisfies CompanyContextValue} />
    </AppShell>
  );
}

function CompanySwitcher({ companyId }: { companyId: string }) {
  const { me } = useSession();
  const navigate = useNavigate();
  return (
    <select
      className="input select compact"
      value={companyId}
      onChange={(event) => navigate(`/app/${event.target.value}`)}
      aria-label="company"
    >
      {me?.companies.map((company) => (
        <option key={company.id} value={company.id}>
          {company.name}
        </option>
      ))}
    </select>
  );
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export function CompanyDashboardPage() {
  const { overview, reload } = useCompanyCtx();
  const { me, t, locale } = useSession();
  const { company, subscription, counts, team, plan, usage } = overview;
  void reload;

  const statusMessage = (() => {
    if (subscription.effectiveStatus === 'suspended') return t('dash.suspended');
    if (subscription.effectiveStatus === 'expired') return t('dash.expired');
    if (subscription.effectiveStatus === 'cancelled') return t('dash.cancelled');
    if (subscription.effectiveStatus === 'pending') return t('dash.pending');
    if (subscription.expiringSoon && company.subscriptionEnd) {
      return `${t('dash.expiring')} ${formatDate(company.subscriptionEnd, locale)}`;
    }
    return null;
  })();

  const modules: Array<{ key: string; phase: string; to?: string }> = [
    { key: 'siteAnalysis', phase: 'module.available', to: 'analyses' },
    { key: 'growth', phase: 'module.available', to: 'growth' },
    { key: 'strategy', phase: 'module.phase3' },
    { key: 'content', phase: 'module.phase3' },
    { key: 'design', phase: 'module.phase4' },
    { key: 'messaging', phase: 'module.phase5' },
    { key: 'reports', phase: 'module.phase6' },
  ];

  return (
    <>
      <PageHeader
        title={`${t('dash.welcome')}، ${me?.user.name ?? ''}`}
        subtitle={company.name}
        actions={
          overview.permissions.includes('billing.manage') ? (
            <Link className="btn btn-secondary" to={`/app/${company.id}/subscription`}>
              {t('nav.subscription')}
            </Link>
          ) : undefined
        }
      />

      {statusMessage ? (
        <Alert
          tone={
            subscription.effectiveStatus === 'active'
              ? 'warn'
              : subscription.effectiveStatus === 'pending'
                ? 'info'
                : 'danger'
          }
        >
          {statusMessage}
        </Alert>
      ) : null}

      <div className="grid-2">
        <Card title={t('dash.subscription')}>
          <div className="sub-status">
            <StatusBadge status={subscription.effectiveStatus} />
            {subscription.daysLeft !== null && subscription.effectiveStatus === 'active' ? (
              <span className="sub-days">
                {subscription.daysLeft} {t('common.days')} {t('dash.daysLeft')}
              </span>
            ) : null}
          </div>
          <dl className="detail-list">
            <div>
              <dt>{t('dash.plan')}</dt>
              <dd>{plan ? (locale === 'ar' ? plan.nameAr : plan.nameEn) : t('common.notSet')}</dd>
            </div>
            <div>
              <dt>{t('dash.startsOn')}</dt>
              <dd>{formatDate(company.subscriptionStart, locale)}</dd>
            </div>
            <div>
              <dt>{t('dash.endsOn')}</dt>
              <dd>{formatDate(company.subscriptionEnd, locale)}</dd>
            </div>
          </dl>
          {subscription.isActive && company.subscriptionEnd ? (
            <div className="progress">
              <div
                className="progress-bar"
                style={{
                  width: `${Math.max(4, Math.min(100, Math.round(((subscription.daysLeft ?? 0) / 365) * 100)))}%`,
                }}
              />
            </div>
          ) : null}
        </Card>

        <div className="stats-grid">
          <Stat label={t('dash.members')} value={counts.members} tone="brand" />
          <Stat label={t('dash.invoices')} value={counts.invoices} />
          <Stat
            label={t('dash.pendingProofs')}
            value={counts.pendingProofs}
            tone={counts.pendingProofs > 0 ? 'warn' : 'default'}
          />
        </div>
      </div>

      <Card
        title={t('dash.team')}
        subtitle={t('dash.teamHint')}
        actions={
          overview.permissions.includes('team.view') ? (
            <Link className="btn btn-secondary btn-sm" to={`/app/${company.id}/team`}>
              {t('common.details')}
            </Link>
          ) : undefined
        }
      >
        {team.length === 0 ? (
          <EmptyState>{t('team.noMembers')}</EmptyState>
        ) : (
          <Table head={[t('common.name'), t('common.email'), t('team.role'), t('common.status')]}>
            {team.slice(0, 6).map((member) => (
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
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card title={t('dash.nextPhases')} subtitle={t('dash.nextPhasesNote')}>
        <div className="module-grid">
          {modules.map((module) => (
            (() => {
              const inner = (
                <>
                  <div className="module-card-head">
                    <strong>{t(`module.${module.key}`)}</strong>
                    <span className="tag">{t(module.phase)}</span>
                  </div>
                  {module.key === 'siteAnalysis' && (usage.site_analysis ?? 0) > 0 ? (
                    <span className="muted small">{usage.site_analysis}</span>
                  ) : null}
                </>
              );
              return module.to ? (
                <Link className="module-card module-card-link" key={module.key} to={module.to}>
                  {inner}
                </Link>
              ) : (
                <div className="module-card" key={module.key}>
                  {inner}
                </div>
              );
            })()
          ))}
        </div>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Company profile
// ---------------------------------------------------------------------------

export function CompanyProfilePage() {
  const { overview, reload } = useCompanyCtx();
  const { t } = useSession();
  const { company } = overview;
  const canEdit = overview.permissions.includes('company.edit');
  const isOwner = overview.role === 'owner';

  const [form, setForm] = useState({
    name: company.name,
    legalName: company.legalName ?? '',
    domain: company.domain ?? '',
    industry: company.industry ?? '',
    city: company.city ?? '',
    contactName: company.contactName ?? '',
    contactEmail: company.contactEmail ?? '',
    contactPhone: company.contactPhone ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setSaved(false);
  }, [company.updatedAt]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const payload: Record<string, string> = { ...form };
      if (!isOwner) delete payload.name;
      await api(`/api/company/${company.id}`, { method: 'PATCH', body: payload });
      setSaved(true);
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.code : 'internal_error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title={t('profile.title')} subtitle={t('profile.subtitle')} />
      {saved ? <Alert tone="ok">{t('profile.saved')}</Alert> : null}
      {error ? <Alert tone="danger">{t(errorKey(error))}</Alert> : null}
      <Card>
        <form onSubmit={submit} className="form-grid">
          <Field label={t('profile.companyName')} htmlFor="c-name">
            <Input
              id="c-name"
              value={form.name}
              disabled={!canEdit || !isOwner}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
            />
          </Field>
          <Field label={t('profile.legalName')} htmlFor="c-legal">
            <Input
              id="c-legal"
              value={form.legalName}
              disabled={!canEdit}
              onChange={(event) => setForm({ ...form, legalName: event.target.value })}
            />
          </Field>
          <Field
            label={t('profile.website')}
            hint={t('profile.domainNote')}
            htmlFor="c-domain"
          >
            <Input
              id="c-domain"
              dir="ltr"
              placeholder="https://example.com"
              value={form.domain}
              disabled={!canEdit}
              onChange={(event) => setForm({ ...form, domain: event.target.value })}
            />
          </Field>
          <Field label={t('common.industry')} htmlFor="c-industry">
            <Input
              id="c-industry"
              value={form.industry}
              disabled={!canEdit}
              onChange={(event) => setForm({ ...form, industry: event.target.value })}
            />
          </Field>
          <Field label={t('common.city')} htmlFor="c-city">
            <Input
              id="c-city"
              value={form.city}
              disabled={!canEdit}
              onChange={(event) => setForm({ ...form, city: event.target.value })}
            />
          </Field>
          <Field label={t('admin.ownerName')} htmlFor="c-contact">
            <Input
              id="c-contact"
              value={form.contactName}
              disabled={!canEdit}
              onChange={(event) => setForm({ ...form, contactName: event.target.value })}
            />
          </Field>
          <Field label={t('common.email')} htmlFor="c-email">
            <Input
              id="c-email"
              type="email"
              dir="ltr"
              value={form.contactEmail}
              disabled={!canEdit}
              onChange={(event) => setForm({ ...form, contactEmail: event.target.value })}
            />
          </Field>
          <Field label={t('common.phone')} htmlFor="c-phone">
            <Input
              id="c-phone"
              dir="ltr"
              value={form.contactPhone}
              disabled={!canEdit}
              onChange={(event) => setForm({ ...form, contactPhone: event.target.value })}
            />
          </Field>
          <div className="form-actions">
            <Button type="submit" loading={busy} disabled={!canEdit}>
              {t('common.save')}
            </Button>
          </div>
        </form>
        <p className="muted small">{t('profile.adminOnly')}</p>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Team
// ---------------------------------------------------------------------------

export function CompanyTeamPage() {
  const { overview, reload } = useCompanyCtx();
  const { t, locale } = useSession();
  const { company } = overview;
  const canManage = overview.permissions.includes('team.manage');

  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState<{ name: string; email: string; role: CompanyRole }>({
    name: '',
    email: '',
    role: 'content_writer',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tempPassword, setTempPassword] = useState<string | null>(null);
  const [existingUser, setExistingUser] = useState(false);

  const addMember = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ tempPassword?: string; existingUser?: boolean }>(
        `/api/company/${company.id}/members`,
        { method: 'POST', body: form }
      );
      setTempPassword(result.tempPassword ?? null);
      setExistingUser(Boolean(result.existingUser));
      setModalOpen(false);
      setForm({ name: '', email: '', role: 'content_writer' });
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.code : 'internal_error');
    } finally {
      setBusy(false);
    }
  };

  const updateMember = async (member: Member, patch: Record<string, string>) => {
    setError(null);
    try {
      await api(`/api/company/${company.id}/members/${member.id}`, {
        method: 'PATCH',
        body: patch,
      });
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.code : 'internal_error');
    }
  };

  const removeMember = async (member: Member) => {
    if (!window.confirm(t('team.removeConfirm'))) return;
    setError(null);
    try {
      await api(`/api/company/${company.id}/members/${member.id}`, { method: 'DELETE' });
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.code : 'internal_error');
    }
  };

  return (
    <>
      <PageHeader
        title={t('team.title')}
        subtitle={t('team.subtitle')}
        actions={
          canManage ? (
            <Button onClick={() => setModalOpen(true)}>{t('team.add')}</Button>
          ) : undefined
        }
      />
      {!overview.subscription.isActive ? (
        <Alert tone="warn">{t('team.subscriptionRequired')}</Alert>
      ) : null}
      {error ? <Alert tone="danger">{t(errorKey(error))}</Alert> : null}
      {tempPassword ? (
        <Alert tone="ok" onClose={() => setTempPassword(null)}>
          <strong>{t('team.tempTitle')}</strong>
          <CopyValue value={tempPassword} />
        </Alert>
      ) : null}
      {existingUser ? (
        <Alert tone="info" onClose={() => setExistingUser(false)}>
          {t('team.existingUser')}
        </Alert>
      ) : null}

      <Card padded={false}>
        {overview.team.length === 0 ? (
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
            {overview.team.map((member) => (
              <tr key={member.id}>
                <td>
                  <div className="cell-stack">
                    <strong>{member.name}</strong>
                  </div>
                </td>
                <td dir="ltr" className="muted">
                  {member.email}
                </td>
                <td>
                  {canManage ? (
                    <Select
                      className="compact"
                      value={member.role}
                      onChange={(event) =>
                        void updateMember(member, { role: event.target.value })
                      }
                    >
                      {(
                        [
                          'owner',
                          'marketing_manager',
                          'content_writer',
                          'designer',
                          'viewer',
                        ] as CompanyRole[]
                      ).map((role) => (
                        <option key={role} value={role}>
                          {t(`role.${role}`)}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <RoleBadge role={member.role} />
                  )}
                </td>
                <td>
                  <StatusBadge status={member.status} />
                </td>
                <td className="muted small">
                  {member.lastLoginAt ? formatDateTime(member.lastLoginAt, locale) : t('team.never')}
                </td>
                <td>
                  {canManage ? (
                    <div className="row-actions">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          void updateMember(member, {
                            status: member.status === 'active' ? 'disabled' : 'active',
                          })
                        }
                      >
                        {member.status === 'active' ? t('team.disabled') : t('team.enable')}
                      </Button>
                      <Button size="sm" variant="danger" onClick={() => void removeMember(member)}>
                        {t('team.remove')}
                      </Button>
                    </div>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Modal
        open={modalOpen}
        title={t('team.add')}
        onClose={() => setModalOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setModalOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button form="member-form" type="submit" loading={busy}>
              {t('common.add')}
            </Button>
          </>
        }
      >
        <form id="member-form" onSubmit={addMember} className="stack">
          <Field label={t('common.name')} htmlFor="m-name">
            <Input
              id="m-name"
              required
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
            />
          </Field>
          <Field label={t('common.email')} htmlFor="m-email">
            <Input
              id="m-email"
              type="email"
              dir="ltr"
              required
              value={form.email}
              onChange={(event) => setForm({ ...form, email: event.target.value })}
            />
          </Field>
          <Field label={t('team.role')} htmlFor="m-role">
            <Select
              id="m-role"
              value={form.role}
              onChange={(event) =>
                setForm({ ...form, role: event.target.value as CompanyRole })
              }
            >
              {(['marketing_manager', 'content_writer', 'designer', 'viewer', 'owner'] as CompanyRole[]).map(
                (role) => (
                  <option key={role} value={role}>
                    {t(`role.${role}`)}
                  </option>
                )
              )}
            </Select>
          </Field>
        </form>
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------------------
// Subscription & invoices
// ---------------------------------------------------------------------------

export function CompanySubscriptionPage() {
  const { overview, reload } = useCompanyCtx();
  const { t, locale } = useSession();
  const { company } = overview;
  const { data, loading, reload: reloadInvoices } = useApi<{
    subscription: Subscription;
    plan: { id: string; nameAr: string; nameEn: string; priceSar: number; billingPeriod: string; maxUsers: number | null; monthlyAnalyses: number | null } | null;
    limits: { seatsUsed: number; seatsMax: number | null; analysesUsed: number; analysesMax: number | null };
    invoices: Invoice[];
    bank: {
      bankName: string;
      accountName: string;
      iban: string;
      accountNumber: string;
      notes: string;
      currency: string;
      configured: boolean;
    };
  }>(`/api/company/${company.id}/invoices`);

  const [uploadFor, setUploadFor] = useState<Invoice | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState(false);

  const submitProof = async (event: FormEvent) => {
    event.preventDefault();
    if (!uploadFor || !file) return;
    setBusy(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      if (reference) formData.append('reference', reference);
      if (note) formData.append('note', note);
      await api(`/api/company/${company.id}/invoices/${uploadFor.id}/proofs`, {
        method: 'POST',
        formData,
      });
      setUploadFor(null);
      setFile(null);
      setReference('');
      setNote('');
      setUploaded(true);
      reloadInvoices();
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
      <PageHeader title={t('sub.title')} subtitle={t('sub.subtitle')} />
      {uploaded ? (
        <Alert tone="ok" onClose={() => setUploaded(false)}>
          {t('sub.uploaded')}
        </Alert>
      ) : null}

      <div className="grid-2">
        <Card title={t('sub.currentPlan')}>
          <div className="sub-status">
            <StatusBadge status={data.subscription.effectiveStatus} />
            {data.subscription.daysLeft !== null && data.subscription.isActive ? (
              <span className="sub-days">
                {data.subscription.daysLeft} {t('common.days')}
              </span>
            ) : null}
          </div>
          <dl className="detail-list">
            <div>
              <dt>{t('dash.plan')}</dt>
              <dd>{data.plan ? (locale === 'ar' ? data.plan.nameAr : data.plan.nameEn) : t('common.notSet')}</dd>
            </div>
            <div>
              <dt>{t('dash.startsOn')}</dt>
              <dd>{formatDate(company.subscriptionStart, locale)}</dd>
            </div>
            <div>
              <dt>{t('dash.endsOn')}</dt>
              <dd>{formatDate(company.subscriptionEnd, locale)}</dd>
            </div>
            <div>
              <dt>{t('common.amount')}</dt>
              <dd>
                {data.plan && data.plan.priceSar > 0
                  ? `${formatSAR(data.plan.priceSar, locale)} / ${t('common.perYear')}`
                  : t('sub.priceNotSet')}
              </dd>
            </div>
          </dl>
        </Card>

        <Card title={t('sub.limitsTitle')}>
          <dl className="detail-list">
            <div>
              <dt>{t('sub.seatsUsed')}</dt>
              <dd dir="ltr">
                {data.limits.seatsUsed} /{' '}
                {data.limits.seatsMax === null ? t('plan.unlimited') : data.limits.seatsMax}
              </dd>
            </div>
            <div>
              <dt>{t('plan.monthlyAnalyses')}</dt>
              <dd dir="ltr">
                {data.limits.analysesUsed} /{' '}
                {data.limits.analysesMax === null ? t('plan.unlimited') : data.limits.analysesMax}
              </dd>
            </div>
          </dl>
        </Card>

        <Card title={t('sub.bankTitle')}>
          {data.bank.configured ? (
            <dl className="detail-list">
              <div>
                <dt>{t('sub.bankName')}</dt>
                <dd>{data.bank.bankName}</dd>
              </div>
              <div>
                <dt>{t('sub.accountName')}</dt>
                <dd>{data.bank.accountName}</dd>
              </div>
              <div>
                <dt>{t('sub.iban')}</dt>
                <dd dir="ltr">{data.bank.iban}</dd>
              </div>
              {data.bank.accountNumber ? (
                <div>
                  <dt>{t('sub.accountNumber')}</dt>
                  <dd dir="ltr">{data.bank.accountNumber}</dd>
                </div>
              ) : null}
              {data.bank.notes ? (
                <div>
                  <dt>{t('common.notes')}</dt>
                  <dd>{data.bank.notes}</dd>
                </div>
              ) : null}
            </dl>
          ) : (
            <Alert tone="warn">{t('sub.bankMissing')}</Alert>
          )}
        </Card>
      </div>

      <Card title={t('sub.invoices')} padded={false}>
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
              t('sub.dueDate'),
              t('common.status'),
              t('sub.proofs'),
              t('common.actions'),
            ]}
          >
            {data.invoices.map((invoice) => (
              <tr key={invoice.id}>
                <td dir="ltr">{invoice.number}</td>
                <td className="small">
                  {formatDate(invoice.periodStart, locale)} — {formatDate(invoice.periodEnd, locale)}
                </td>
                <td>{formatSAR(invoice.amountSar, locale)}</td>
                <td>{formatDate(invoice.dueAt, locale)}</td>
                <td>
                  <StatusBadge status={invoice.status} />
                </td>
                <td>
                  {invoice.proofs.length === 0 ? (
                    <span className="muted">—</span>
                  ) : (
                    <div className="cell-stack">
                      {invoice.proofs.map((proof) => (
                        <span key={proof.id} className="proof-line">
                          <StatusBadge status={proof.status} />
                          <a
                            className="link small"
                            href={`/api/company/${company.id}/proofs/${proof.id}/file`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {proof.fileName}
                          </a>
                          <span className="muted small">{formatBytes(proof.sizeBytes)}</span>
                        </span>
                      ))}
                    </div>
                  )}
                </td>
                <td>
                  {invoice.status === 'issued' ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setUploadFor(invoice);
                        setError(null);
                      }}
                    >
                      {t('sub.uploadProof')}
                    </Button>
                  ) : (
                    <span className="muted small">
                      {invoice.status === 'pending_review' ? t('sub.pendingReview') : '—'}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Modal
        open={Boolean(uploadFor)}
        title={t('sub.uploadProof')}
        onClose={() => setUploadFor(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setUploadFor(null)}>
              {t('common.cancel')}
            </Button>
            <Button form="proof-form" type="submit" loading={busy}>
              {t('sub.upload')}
            </Button>
          </>
        }
      >
        {uploadFor ? (
          <p className="muted small" dir="ltr">
            {uploadFor.number} · {formatSAR(uploadFor.amountSar, locale)}
          </p>
        ) : null}
        {error ? (
          <Alert tone="danger">
            {error === 'file_too_large'
              ? t('sub.fileTooLarge')
              : error === 'file_type_not_allowed'
                ? t('sub.fileType')
                : t(errorKey(error))}
          </Alert>
        ) : null}
        <form id="proof-form" onSubmit={submitProof} className="stack">
          <Field label={t('sub.proofFile')} htmlFor="proof-file">
            <input
              id="proof-file"
              className="input file-input"
              type="file"
              accept="image/png,image/jpeg,image/webp,application/pdf"
              required
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
          </Field>
          <Field label={t('sub.reference')} htmlFor="proof-ref">
            <Input
              id="proof-ref"
              dir="ltr"
              value={reference}
              onChange={(event) => setReference(event.target.value)}
            />
          </Field>
          <Field label={t('sub.proofNote')} htmlFor="proof-note">
            <Textarea
              id="proof-note"
              rows={3}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </Field>
        </form>
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export function CompanySettingsPage() {
  const { t, locale, setLocale } = useSession();
  const [passwordForm, setPasswordForm] = useState({
    currentPassword: '',
    newPassword: '',
    confirm: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const changePassword = async (event: FormEvent) => {
    event.preventDefault();
    if (passwordForm.newPassword !== passwordForm.confirm) {
      setError('mismatch');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api('/api/auth/password', {
        method: 'POST',
        body: {
          currentPassword: passwordForm.currentPassword,
          newPassword: passwordForm.newPassword,
        },
      });
      setDone(true);
      setPasswordForm({ currentPassword: '', newPassword: '', confirm: '' });
    } catch (err) {
      setError(err instanceof ApiError ? err.code : 'internal_error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title={t('set.title')} subtitle={t('set.subtitle')} />
      <div className="grid-2">
        <Card title={t('set.language')}>
          <Field label={t('common.language')} htmlFor="locale">
            <Select
              id="locale"
              value={locale}
              onChange={(event) => void setLocale(event.target.value === 'en' ? 'en' : 'ar')}
            >
              <option value="ar">العربية</option>
              <option value="en">English</option>
            </Select>
          </Field>
        </Card>

        <Card title={t('set.password')} subtitle={t('set.passwordHint')}>
          {done ? <Alert tone="ok">{t('auth.passwordChanged')}</Alert> : null}
          {error ? (
            <Alert tone="danger">
              {error === 'mismatch' ? t('auth.passwordMismatch') : t(errorKey(error))}
            </Alert>
          ) : null}
          <form onSubmit={changePassword} className="stack">
            <Field label={t('auth.currentPassword')} htmlFor="s-current">
              <Input
                id="s-current"
                type="password"
                dir="ltr"
                required
                value={passwordForm.currentPassword}
                onChange={(event) =>
                  setPasswordForm({ ...passwordForm, currentPassword: event.target.value })
                }
              />
            </Field>
            <Field label={t('auth.newPassword')} hint={t('auth.passwordMin')} htmlFor="s-new">
              <Input
                id="s-new"
                type="password"
                dir="ltr"
                minLength={10}
                required
                value={passwordForm.newPassword}
                onChange={(event) =>
                  setPasswordForm({ ...passwordForm, newPassword: event.target.value })
                }
              />
            </Field>
            <Field label={t('auth.confirmPassword')} htmlFor="s-confirm">
              <Input
                id="s-confirm"
                type="password"
                dir="ltr"
                minLength={10}
                required
                value={passwordForm.confirm}
                onChange={(event) =>
                  setPasswordForm({ ...passwordForm, confirm: event.target.value })
                }
              />
            </Field>
            <Button type="submit" loading={busy}>
              {t('auth.changePassword')}
            </Button>
          </form>
        </Card>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

type ActivityEntry = {
  action: string;
  actorEmail: string | null;
  entityType: string | null;
  entityId: string | null;
  meta: Record<string, unknown> | null;
  createdAt: string;
};

const ACTION_LABELS: Record<string, string> = {
  'member.added': 'إضافة عضو',
  'member.created': 'إنشاء عضو',
  'member.updated': 'تعديل عضو',
  'member.removed': 'إزالة عضو',
  'company.updated': 'تحديث بيانات الشركة',
  'payment_proof.uploaded': 'رفع إثبات تحويل',
  'payment_proof.approved': 'اعتماد إثبات تحويل',
  'payment_proof.rejected': 'رفض إثبات تحويل',
  'invoice.created': 'إصدار فاتورة',
  'auth.password_changed': 'تغيير كلمة المرور',
  'auth.login': 'تسجيل دخول',
  'auth.logout': 'تسجيل خروج',
};

export function CompanyActivityPage() {
  const { overview } = useCompanyCtx();
  const { t, locale } = useSession();
  const { company } = overview;
  const { data, loading } = useApi<{ activity: ActivityEntry[] }>(
    `/api/company/${company.id}/activity`
  );

  if (loading || !data) return <Loading />;

  return (
    <>
      <PageHeader title={t('activity.title')} subtitle={t('activity.subtitle')} />
      <Card padded={false}>
        {data.activity.length === 0 ? (
          <div className="card-body">
            <EmptyState>{t('activity.empty')}</EmptyState>
          </div>
        ) : (
          <Table head={[t('activity.action'), t('activity.actor'), t('common.date')]}>
            {data.activity.map((entry, index) => (
              <tr key={`${entry.action}-${index}`}>
                <td>
                  <span className={cx('audit-action')}>
                    {locale === 'ar'
                      ? ACTION_LABELS[entry.action] ?? entry.action
                      : entry.action}
                  </span>
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
    </>
  );
}

export function CompanyRedirect() {
  const { me, loading, t } = useSession();
  if (loading) return <FullPageLoading label={t('common.loading')} />;
  if (!me) return <Navigate to="/login" replace />;
  if (me.companies.length > 0) return <Navigate to={`/app/${me.companies[0].id}`} replace />;
  if (me.user.platformRole === 'super_admin') return <Navigate to="/admin" replace />;
  return (
    <div className="center-page">
      <Card title={t('admin.noAccess')}>
        <p className="muted">{t('err.company_not_found')}</p>
        <Link className="btn btn-secondary" to="/support">
          {t('landing.support')}
        </Link>
      </Card>
    </div>
  );
}
