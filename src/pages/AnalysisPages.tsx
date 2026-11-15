/**
 * Phase 2 client screens: analysis list, creation wizard, job stage view and
 * the structured report with per-section editing and human approval.
 *
 * Everything shown here comes from the API; permissions are re-checked on the
 * server, so hiding a control is cosmetic only.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  api,
  ApiError,
  useApi,
  type AnalysisApproval,
  type AnalysisCapabilities,
  type AnalysisDetail,
  type AnalysisItem,
  type AnalysisLimits,
  type AnalysisPageRow,
  type AnalysisProviderStatus,
  type AnalysisResultPayload,
  type AnalysisStatus,
  type FieldSource,
  type SiteAnalysis,
  type StructuredAnalysisResult,
} from '../lib/api';
import { useSession } from '../lib/session';
import { errorKey, formatDateTime } from '../lib/i18n';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Loading,
  Modal,
  PageHeader,
  Select,
  StatusBadge,
  Table,
  Textarea,
  cx,
} from '../components/ui';
import { useCompanyCtx } from './CompanyPages';

type ListResponse = {
  analyses: SiteAnalysis[];
  ai: AnalysisProviderStatus;
  limits: AnalysisLimits;
  capabilities: AnalysisCapabilities;
};

const SOURCE_CLASS: Record<FieldSource, string> = {
  website: 'source-website',
  inference: 'source-inference',
  suggestion: 'source-suggestion',
  missing: 'source-missing',
};

function SourceTag({ source }: { source: FieldSource }) {
  const { t } = useSession();
  const label =
    source === 'website'
      ? t('analysis.sourceWebsite')
      : source === 'inference'
        ? t('analysis.sourceInference')
        : source === 'suggestion'
          ? t('analysis.sourceSuggestion')
          : t('analysis.sourceMissing');
  return <span className={cx('source-tag', SOURCE_CLASS[source])}>{label}</span>;
}

function ProviderNotice({ ai }: { ai: AnalysisProviderStatus }) {
  const { t } = useSession();
  if (!ai.configured) return <Alert tone="danger">{t('analysis.notConfigured')}</Alert>;
  if (ai.mock) {
    return (
      <Alert tone="warn">
        <strong>{t('analysis.mock')}</strong> — {t('analysis.mockNotice')}
      </Alert>
    );
  }
  return null;
}

const localeLabel = (locale: string, t: (key: string) => string) =>
  locale === 'en' ? t('analysis.localeEn') : locale === 'ar-en' ? t('analysis.localeBoth') : t('analysis.localeAr');

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export function CompanyAnalysesPage() {
  const { companyId } = useParams();
  const { t, locale } = useSession();
  const navigate = useNavigate();
  const { overview } = useCompanyCtx();
  const { data, loading, error, reload } = useApi<ListResponse>(
    companyId ? `/api/company/${companyId}/site-analyses` : null
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const act = async (analysisId: string, action: 'start' | 'retry' | 'cancel') => {
    if (!companyId) return;
    if (action === 'cancel' && !window.confirm(t('analysis.cancelConfirm'))) return;
    setBusy(analysisId);
    setActionError(null);
    try {
      await api(`/api/company/${companyId}/site-analyses/${analysisId}/${action}`, { method: 'POST' });
      reload();
      if (action === 'start' || action === 'retry') {
        navigate(`/app/${companyId}/analyses/${analysisId}`);
      }
    } catch (err) {
      setActionError(errorKey((err as ApiError).code));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <PageHeader
        title={t('analysis.title')}
        subtitle={t('analysis.subtitle')}
        actions={
          data?.capabilities.create && overview.subscription.isActive ? (
            <Link className="btn btn-primary" to={`/app/${companyId}/analyses/new`}>
              {t('analysis.new')}
            </Link>
          ) : null
        }
      />

      {data ? <ProviderNotice ai={data.ai} /> : null}
      {!overview.subscription.isActive ? <Alert tone="warn">{t('err.subscription_inactive')}</Alert> : null}
      {actionError ? <Alert tone="danger">{t(actionError)}</Alert> : null}

      <Card padded={false}>
        {loading ? (
          <Loading />
        ) : error ? (
          <Alert tone="danger">{t(errorKey(error))}</Alert>
        ) : !data || !data.analyses.length ? (
          <EmptyState>
            <strong>{t('analysis.emptyList')}</strong>
            <br />
            {t('analysis.emptyListHint')}
          </EmptyState>
        ) : (
          <Table
            head={[
              t('analysis.columnUrl'),
              t('analysis.columnStatus'),
              t('analysis.columnLocale'),
              t('analysis.columnPages'),
              t('analysis.columnDate'),
              t('common.actions'),
            ]}
          >
            {data.analyses.map((analysis) => (
              <tr key={analysis.id}>
                <td dir="ltr" className="mono-cell">
                  {analysis.normalizedUrl}
                </td>
                <td>
                  <StatusBadge status={analysis.status} />
                </td>
                <td>{localeLabel(analysis.locale, t)}</td>
                <td>
                  {analysis.pagesAnalyzed}/{analysis.pagesFound}
                </td>
                <td>{formatDateTime(analysis.createdAt, locale)}</td>
                <td className="row-actions">
                  <Link className="btn btn-secondary btn-sm" to={`/app/${companyId}/analyses/${analysis.id}`}>
                    {t('analysis.view')}
                  </Link>
                  {data.capabilities.create &&
                  ['draft', 'cancelled', 'changes_requested', 'failed'].includes(analysis.status) ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={busy === analysis.id}
                      onClick={() => void act(analysis.id, analysis.status === 'draft' ? 'start' : 'retry')}
                    >
                      {analysis.status === 'draft' ? t('analysis.start') : t('analysis.retry')}
                    </Button>
                  ) : null}
                  {data.capabilities.create && analysis.status === 'draft' ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void act(analysis.id, 'cancel')}
                    >
                      {t('analysis.cancel')}
                    </Button>
                  ) : null}
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
// Create
// ---------------------------------------------------------------------------

export function NewAnalysisPage() {
  const { companyId } = useParams();
  const { t } = useSession();
  const navigate = useNavigate();
  const { data, loading } = useApi<ListResponse>(
    companyId ? `/api/company/${companyId}/site-analyses` : null
  );

  const [url, setUrl] = useState('');
  const [locale, setLocale] = useState<'ar' | 'en' | 'ar-en'>('ar');
  const [maxPages, setMaxPages] = useState(10);
  const [maxDepth, setMaxDepth] = useState(2);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!data) return;
    setMaxPages((current) => (current === 10 ? data.limits.defaultMaxPages : current));
    setMaxDepth((current) => (current === 2 ? data.limits.defaultMaxDepth : current));
  }, [data]);

  const submit = async () => {
    if (!companyId) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api<{ analysis: SiteAnalysis }>(
        `/api/company/${companyId}/site-analyses`,
        { method: 'POST', body: { url, locale, maxPages, maxDepth, consent } }
      );
      await api(`/api/company/${companyId}/site-analyses/${created.analysis.id}/start`, { method: 'POST' });
      navigate(`/app/${companyId}/analyses/${created.analysis.id}`);
    } catch (err) {
      setError(errorKey((err as ApiError).code));
      setBusy(false);
    }
  };

  if (loading && !data) return <Loading />;

  return (
    <>
      <PageHeader title={t('analysis.newTitle')} subtitle={t('analysis.newSubtitle')} />
      {data ? <ProviderNotice ai={data.ai} /> : null}
      {error ? <Alert tone="danger">{t(error)}</Alert> : null}

      <Card>
        <div className="form-grid">
          <Field label={t('analysis.urlLabel')} hint={t('analysis.urlHint')}>
            <Input
              dir="ltr"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://example.com"
            />
          </Field>
          <Field label={t('analysis.localeLabel')}>
            <Select value={locale} onChange={(event) => setLocale(event.target.value as typeof locale)}>
              <option value="ar">{t('analysis.localeAr')}</option>
              <option value="en">{t('analysis.localeEn')}</option>
              <option value="ar-en">{t('analysis.localeBoth')}</option>
            </Select>
          </Field>
          <Field
            label={t('analysis.maxPages')}
            hint={t('analysis.maxPagesHint').replace('{max}', String(data?.limits.hardMaxPages ?? 10))}
          >
            <Input
              type="number"
              min={1}
              max={data?.limits.hardMaxPages ?? 10}
              value={maxPages}
              onChange={(event) => setMaxPages(Number(event.target.value))}
            />
          </Field>
          <Field label={t('analysis.maxDepth')}>
            <Input
              type="number"
              min={0}
              max={data?.limits.hardMaxDepth ?? 4}
              value={maxDepth}
              onChange={(event) => setMaxDepth(Number(event.target.value))}
            />
          </Field>
        </div>

        <label className="checkbox-row">
          <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
          <span>
            {t('analysis.consent')}
            <small className="muted block">{t('analysis.consentHint')}</small>
          </span>
        </label>

        <Alert tone="info">{t('analysis.needsReview')}</Alert>

        <div className="row-actions">
          <Button loading={busy} onClick={() => void submit()} disabled={!url.trim() || !consent}>
            {busy ? t('analysis.starting') : t('analysis.createAndStart')}
          </Button>
          <Link className="btn btn-secondary" to={`/app/${companyId}/analyses`}>
            {t('common.cancel')}
          </Link>
        </div>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

const STAGE_ORDER: Array<{ key: string; statuses: AnalysisStatus[] }> = [
  { key: 'analysis.stageValidate', statuses: ['draft', 'queued'] },
  { key: 'analysis.stageRead', statuses: ['crawling'] },
  { key: 'analysis.stageExtract', statuses: ['extracting'] },
  { key: 'analysis.stageAnalyze', statuses: ['analyzing'] },
  { key: 'analysis.stageReport', statuses: ['awaiting_review', 'approved', 'changes_requested'] },
  { key: 'analysis.stageReview', statuses: ['approved'] },
];

const STAGE_INDEX: Record<string, number> = {
  draft: 0,
  queued: 0,
  crawling: 1,
  extracting: 2,
  analyzing: 3,
  awaiting_review: 4,
  changes_requested: 4,
  approved: 5,
  failed: 1,
  cancelled: 0,
};

type SectionConfig =
  | {
      id: string;
      titleKey: string;
      kind: 'field';
      get: (result: StructuredAnalysisResult) => AnalysisItem;
      set: (result: StructuredAnalysisResult, item: AnalysisItem) => StructuredAnalysisResult;
    }
  | {
      id: string;
      titleKey: string;
      kind: 'list';
      get: (result: StructuredAnalysisResult) => AnalysisItem[];
      set: (result: StructuredAnalysisResult, items: AnalysisItem[]) => StructuredAnalysisResult;
    };

const clone = (result: StructuredAnalysisResult): StructuredAnalysisResult =>
  JSON.parse(JSON.stringify(result)) as StructuredAnalysisResult;

const SECTIONS: SectionConfig[] = [
  {
    id: 'company_name',
    titleKey: 'analysis.sectionCompany',
    kind: 'field',
    get: (r) => r.company_profile.company_name,
    set: (r, item) => ({ ...r, company_profile: { ...r.company_profile, company_name: item } }),
  },
  {
    id: 'industry',
    titleKey: 'analysis.sectionIndustry',
    kind: 'field',
    get: (r) => r.company_profile.industry,
    set: (r, item) => ({ ...r, company_profile: { ...r.company_profile, industry: item } }),
  },
  {
    id: 'summary',
    titleKey: 'analysis.sectionSummary',
    kind: 'field',
    get: (r) => r.company_profile.summary,
    set: (r, item) => ({ ...r, company_profile: { ...r.company_profile, summary: item } }),
  },
  {
    id: 'mission',
    titleKey: 'analysis.sectionMission',
    kind: 'field',
    get: (r) => r.mission,
    set: (r, item) => ({ ...r, mission: item }),
  },
  {
    id: 'vision',
    titleKey: 'analysis.sectionVision',
    kind: 'field',
    get: (r) => r.vision,
    set: (r, item) => ({ ...r, vision: item }),
  },
  { id: 'values', titleKey: 'analysis.sectionValues', kind: 'list', get: (r) => r.values, set: (r, items) => ({ ...r, values: items }) },
  {
    id: 'products_and_services',
    titleKey: 'analysis.sectionProducts',
    kind: 'list',
    get: (r) => r.products_and_services,
    set: (r, items) => ({ ...r, products_and_services: items }),
  },
  {
    id: 'target_markets',
    titleKey: 'analysis.sectionMarkets',
    kind: 'list',
    get: (r) => r.target_markets,
    set: (r, items) => ({ ...r, target_markets: items }),
  },
  {
    id: 'target_locations',
    titleKey: 'analysis.sectionLocations',
    kind: 'list',
    get: (r) => r.target_locations,
    set: (r, items) => ({ ...r, target_locations: items }),
  },
  { id: 'audiences', titleKey: 'analysis.sectionAudiences', kind: 'list', get: (r) => r.audiences, set: (r, items) => ({ ...r, audiences: items }) },
  {
    id: 'buyer_personas',
    titleKey: 'analysis.sectionPersonas',
    kind: 'list',
    get: (r) => r.buyer_personas,
    set: (r, items) => ({ ...r, buyer_personas: items }),
  },
  {
    id: 'customer_problems',
    titleKey: 'analysis.sectionProblems',
    kind: 'list',
    get: (r) => r.customer_problems,
    set: (r, items) => ({ ...r, customer_problems: items }),
  },
  {
    id: 'value_proposition',
    titleKey: 'analysis.sectionValueProp',
    kind: 'list',
    get: (r) => r.value_proposition,
    set: (r, items) => ({ ...r, value_proposition: items }),
  },
  {
    id: 'calls_to_action',
    titleKey: 'analysis.sectionCtas',
    kind: 'list',
    get: (r) => r.calls_to_action,
    set: (r, items) => ({ ...r, calls_to_action: items }),
  },
  { id: 'keywords', titleKey: 'analysis.sectionKeywords', kind: 'list', get: (r) => r.keywords, set: (r, items) => ({ ...r, keywords: items }) },
  { id: 'strengths', titleKey: 'analysis.sectionStrengths', kind: 'list', get: (r) => r.strengths, set: (r, items) => ({ ...r, strengths: items }) },
  {
    id: 'opportunities',
    titleKey: 'analysis.sectionOpportunities',
    kind: 'list',
    get: (r) => r.opportunities,
    set: (r, items) => ({ ...r, opportunities: items }),
  },
  { id: 'risks', titleKey: 'analysis.sectionRisks', kind: 'list', get: (r) => r.risks, set: (r, items) => ({ ...r, risks: items }) },
  {
    id: 'marketing_channels',
    titleKey: 'analysis.sectionChannels',
    kind: 'list',
    get: (r) => r.marketing_channels,
    set: (r, items) => ({ ...r, marketing_channels: items }),
  },
  {
    id: 'recommended_campaigns',
    titleKey: 'analysis.sectionCampaigns',
    kind: 'list',
    get: (r) => r.recommended_campaigns,
    set: (r, items) => ({ ...r, recommended_campaigns: items }),
  },
  {
    id: 'content_pillars',
    titleKey: 'analysis.sectionPillars',
    kind: 'list',
    get: (r) => r.content_pillars,
    set: (r, items) => ({ ...r, content_pillars: items }),
  },
  { id: 'roadmap', titleKey: 'analysis.sectionRoadmap', kind: 'list', get: (r) => r.roadmap, set: (r, items) => ({ ...r, roadmap: items }) },
  {
    id: 'recommended_kpis',
    titleKey: 'analysis.sectionKpis',
    kind: 'list',
    get: (r) => r.recommended_kpis,
    set: (r, items) => ({ ...r, recommended_kpis: items }),
  },
  {
    id: 'missing_information',
    titleKey: 'analysis.sectionMissing',
    kind: 'list',
    get: (r) => r.missing_information,
    set: (r, items) => ({ ...r, missing_information: items }),
  },
  {
    id: 'assumptions_requiring_review',
    titleKey: 'analysis.sectionAssumptions',
    kind: 'list',
    get: (r) => r.assumptions_requiring_review,
    set: (r, items) => ({ ...r, assumptions_requiring_review: items }),
  },
];

function FieldView({ item }: { item: AnalysisItem }) {
  const { t } = useSession();
  if (!item.value) {
    return (
      <p className="muted">
        <SourceTag source="missing" /> {t('analysis.emptySection')}
      </p>
    );
  }
  return (
    <div className="field-view">
      <p className="field-value">{item.value}</p>
      <div className="field-meta">
        <SourceTag source={item.source} />
        <span className="muted small">
          {t('analysis.confidence')}: {Math.round((item.confidence ?? 0) * 100)}%
        </span>
        {item.evidence_url ? (
          <a className="muted small" href={item.evidence_url} target="_blank" rel="noreferrer">
            {t('analysis.evidence')}
          </a>
        ) : null}
      </div>
    </div>
  );
}

function FieldEditor({ item, onChange }: { item: AnalysisItem; onChange: (item: AnalysisItem) => void }) {
  const { t } = useSession();
  return (
    <div className="field-editor">
      <Textarea
        rows={2}
        value={item.value}
        onChange={(event) => onChange({ ...item, value: event.target.value })}
      />
      <div className="field-editor-row">
        <Select
          value={item.source}
          onChange={(event) => onChange({ ...item, source: event.target.value as FieldSource })}
        >
          <option value="website">{t('analysis.sourceWebsite')}</option>
          <option value="inference">{t('analysis.sourceInference')}</option>
          <option value="suggestion">{t('analysis.sourceSuggestion')}</option>
          <option value="missing">{t('analysis.sourceMissing')}</option>
        </Select>
        <Input
          type="number"
          min={0}
          max={1}
          step={0.05}
          value={item.confidence}
          onChange={(event) => onChange({ ...item, confidence: Number(event.target.value) })}
        />
      </div>
    </div>
  );
}

function ListEditor({ items, onChange }: { items: AnalysisItem[]; onChange: (items: AnalysisItem[]) => void }) {
  const { t } = useSession();
  const toText = (list: AnalysisItem[]) => list.map((item) => item.value).join('\n');
  const apply = (text: string) => {
    const lines = text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    onChange(
      lines.map((line) => {
        const existing = items.find((item) => item.value === line);
        return existing ?? { value: line, source: 'inference' as FieldSource, confidence: 0.4 };
      })
    );
  };
  return (
    <div className="field-editor">
      <Textarea rows={Math.min(8, Math.max(3, items.length + 1))} value={toText(items)} onChange={(event) => apply(event.target.value)} />
      <span className="muted small">{t('analysis.editHint')}</span>
    </div>
  );
}

function StagedJobView({ analysis }: { analysis: SiteAnalysis }) {
  const { t } = useSession();
  const activeIndex = STAGE_INDEX[analysis.status] ?? 0;
  return (
    <Card title={t('analysis.stages')}>
      <ol className="stage-list">
        {STAGE_ORDER.map((stage, index) => (
          <li
            key={stage.key}
            className={cx(
              'stage-item',
              index < activeIndex && 'stage-done',
              index === activeIndex && 'stage-current'
            )}
          >
            <span className="stage-index">{index + 1}</span>
            <span>{t(stage.key)}</span>
          </li>
        ))}
      </ol>
      {analysis.status === 'failed' && analysis.errorMessage ? (
        <Alert tone="danger">
          {t(errorKey(analysis.errorMessage))} <code className="code-inline">{analysis.errorMessage}</code>
        </Alert>
      ) : null}
    </Card>
  );
}

export function AnalysisDetailPage() {
  const { companyId, analysisId } = useParams();
  const { t, locale } = useSession();
  const base = companyId && analysisId ? `/api/company/${companyId}/site-analyses/${analysisId}` : null;
  const [version, setVersion] = useState<number | null>(null);
  const { data, loading, error, reload } = useApi<AnalysisDetail>(
    base ? (version ? `${base}?version=${version}` : base) : null
  );
  const pagesApi = useApi<{ pages: AnalysisPageRow[] }>(
    base && data?.capabilities.review ? `${base}/pages` : null
  );

  const [draft, setDraft] = useState<StructuredAnalysisResult | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [approveOpen, setApproveOpen] = useState(false);
  const [changesOpen, setChangesOpen] = useState(false);
  const [comment, setComment] = useState('');

  const result: AnalysisResultPayload | null = data?.result ?? null;

  useEffect(() => {
    setDraft(result?.result ? clone(result.result) : null);
    setNote('');
  }, [result?.id, result?.version]);

  const dirty = useMemo(() => {
    if (!draft || !result?.result) return false;
    return JSON.stringify(draft) !== JSON.stringify(result.result);
  }, [draft, result?.result]);

  const run = async (action: string, body?: unknown) => {
    if (!base) return;
    setBusy(action);
    setActionError(null);
    setFlash(null);
    try {
      await api(`${base}/${action}`, { method: 'POST', body });
      setVersion(null);
      reload();
      if (action === 'submit-review') setFlash(t('analysis.submitReview'));
      if (action === 'approve') setFlash(t('analysis.approved'));
    } catch (err) {
      setActionError(errorKey((err as ApiError).code));
    } finally {
      setBusy(null);
    }
  };

  const saveVersion = async () => {
    if (!base || !draft) return;
    setBusy('save');
    setActionError(null);
    try {
      await api(`${base}/results`, { method: 'PUT', body: { result: draft, comment: note } });
      setVersion(null);
      reload();
      setFlash(t('analysis.savedVersion'));
    } catch (err) {
      setActionError(errorKey((err as ApiError).code));
    } finally {
      setBusy(null);
    }
  };

  if (loading) return <Loading />;
  if (error) return <Alert tone="danger">{t(errorKey(error))}</Alert>;
  if (!data) return <EmptyState>{t('common.noData')}</EmptyState>;

  const { analysis, capabilities, ai, versions, approvals } = data;
  const editable = Boolean(capabilities.edit && draft && !version);

  return (
    <>
      <PageHeader
        title={t('analysis.report')}
        subtitle={analysis.normalizedUrl}
        actions={
          <Link className="btn btn-secondary" to={`/app/${companyId}/analyses`}>
            {t('common.back')}
          </Link>
        }
      />

      <Alert tone="info">{t('analysis.needsReview')}</Alert>
      <ProviderNotice ai={ai} />
      {capabilities.reopen ? <Alert tone="warn">{t('analysis.reopenNotice')}</Alert> : null}
      {actionError ? <Alert tone="danger">{t(actionError)}</Alert> : null}
      {flash ? <Alert tone="ok">{flash}</Alert> : null}

      <div className="analysis-meta">
        <StatusBadge status={analysis.status} />
        <span className="badge badge-role">
          {t('analysis.version')} {analysis.latestVersion}
        </span>
        {analysis.approvedVersion ? (
          <span className="badge badge-ok">
            {t('analysis.approved')} · {t('analysis.versionLabel')} {analysis.approvedVersion}
          </span>
        ) : (
          <span className="badge badge-warn">{t('analysis.notApproved')}</span>
        )}
        <span className="muted small">
          {t('analysis.provider')}: {analysis.provider ?? '—'} · {t('analysis.model')}: {analysis.model ?? '—'}
        </span>
        {analysis.robotsPolicy ? (
          <span className="muted small">
            robots.txt: {analysis.robotsPolicy}
          </span>
        ) : null}
        <span className="muted small">
          {formatDateTime(analysis.createdAt, locale)}
        </span>
      </div>

      <StagedJobView analysis={analysis} />

      {versions.length > 1 ? (
        <Card title={t('analysis.history')}>
          <div className="row-actions wrap">
            <Button
              size="sm"
              variant={version === null ? 'primary' : 'secondary'}
              onClick={() => setVersion(null)}
            >
              {t('analysis.versionLabel')} {analysis.latestVersion}
            </Button>
            {versions
              .filter((row) => row.version !== analysis.latestVersion)
              .map((row) => (
                <Button
                  key={row.id}
                  size="sm"
                  variant={version === row.version ? 'primary' : 'secondary'}
                  onClick={() => setVersion(row.version)}
                >
                  {t('analysis.versionLabel')} {row.version}
                </Button>
              ))}
          </div>
          <ul className="timeline">
            {approvals.length ? (
              approvals.map((approval: AnalysisApproval) => (
                <li key={approval.id}>
                  <span className="badge badge-role">{t(`approval.${approval.action}`, approval.action)}</span>{' '}
                  <span className="muted small">
                    {approval.userName ?? '—'} · {formatDateTime(approval.createdAt, locale)} ·{' '}
                    {t('analysis.versionLabel')} {approval.version}
                  </span>
                  {approval.comment ? <p className="small">{approval.comment}</p> : null}
                </li>
              ))
            ) : (
              <li className="muted">{t('analysis.historyEmpty')}</li>
            )}
          </ul>
        </Card>
      ) : null}

      {!result ? (
        <Card>
          <EmptyState>{t('analysis.noResult')}</EmptyState>
          {capabilities.edit && ['draft', 'failed', 'cancelled', 'changes_requested'].includes(analysis.status) ? (
            <div className="row-actions">
              <Button loading={busy === 'retry'} onClick={() => void run('retry')}>
                {t('analysis.retry')}
              </Button>
            </div>
          ) : null}
        </Card>
      ) : (
        <>
          <Card
            title={`${t('analysis.report')} · ${t('analysis.version')} ${result.version}`}
            subtitle={editable ? t('analysis.editHint') : t('analysis.readOnly')}
            actions={
              capabilities.edit ? (
                dirty ? (
                  <div className="row-actions">
                    <Button size="sm" variant="ghost" onClick={() => setDraft(result.result ? clone(result.result) : null)}>
                      {t('analysis.discard')}
                    </Button>
                    <Button size="sm" loading={busy === 'save'} onClick={() => void saveVersion()}>
                      {t('analysis.saveVersion')}
                    </Button>
                  </div>
                ) : null
              ) : null
            }
          >
            {dirty ? (
              <div className="field">
                <Field label={t('analysis.note')} hint={t('analysis.notePlaceholder')}>
                  <Input value={note} onChange={(event) => setNote(event.target.value)} />
                </Field>
              </div>
            ) : null}
            <div className="report-summary">
              <span className="muted small">
                {t('analysis.confidence')}: {Math.round((result.confidence ?? 0) * 100)}%
              </span>
              {result.sourceSummary ? (
                <span className="muted small">
                  {t('analysis.sourceWebsite')}: {result.sourceSummary.website} ·{' '}
                  {t('analysis.sourceInference')}: {result.sourceSummary.inference} ·{' '}
                  {t('analysis.sourceSuggestion')}: {result.sourceSummary.suggestion ?? 0}
                </span>
              ) : null}
              {result.editedByUser ? <span className="badge badge-role">{t('analysis.edit')}</span> : null}
            </div>
          </Card>

          <div className="report-grid">
            {SECTIONS.map((section) => {
              if (!draft || !result.result) return null;
              const value = section.kind === 'field' ? section.get(draft) : section.get(draft);
              return (
                <Card key={section.id} title={t(section.titleKey)}>
                  {section.kind === 'field' ? (
                    editable ? (
                      <FieldEditor
                        item={value as AnalysisItem}
                        onChange={(item) => setDraft(section.set(draft, item))}
                      />
                    ) : (
                      <FieldView item={value as AnalysisItem} />
                    )
                  ) : editable ? (
                    <ListEditor
                      items={value as AnalysisItem[]}
                      onChange={(items) => setDraft(section.set(draft, items))}
                    />
                  ) : (value as AnalysisItem[]).length ? (
                    <ul className="item-list">
                      {(value as AnalysisItem[]).map((item, index) => (
                        <li key={`${section.id}-${index}`}>
                          <span>{item.value}</span>
                          <span className="item-meta">
                            <SourceTag source={item.source} />
                            <span className="muted small">{Math.round((item.confidence ?? 0) * 100)}%</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="muted">{t('analysis.emptySection')}</p>
                  )}
                </Card>
              );
            })}
          </div>

          <Card>
            <div className="row-actions wrap">
              {capabilities.review && analysis.status === 'awaiting_review' ? (
                <>
                  {capabilities.approve ? (
                    <Button loading={busy === 'approve'} onClick={() => setApproveOpen(true)}>
                      {t('analysis.approve')}
                    </Button>
                  ) : null}
                  <Button variant="secondary" onClick={() => setChangesOpen(true)}>
                    {t('analysis.requestChanges')}
                  </Button>
                </>
              ) : null}
              {capabilities.edit &&
              ['draft', 'changes_requested', 'awaiting_review'].includes(analysis.status) ? (
                <Button variant="secondary" loading={busy === 'submit-review'} onClick={() => void run('submit-review')}>
                  {t('analysis.submitReview')}
                </Button>
              ) : null}
              {capabilities.edit && dirty ? (
                <Button loading={busy === 'save'} onClick={() => void saveVersion()}>
                  {t('analysis.saveVersion')}
                </Button>
              ) : null}
            </div>
          </Card>
        </>
      )}

      {pagesApi.data ? (
        <Card title={t('analysis.pages')} subtitle={t('analysis.pagesHint')}>
          {pagesApi.data.pages.length ? (
            <Table head={[t('analysis.columnUrl'), t('analysis.pageStatus'), t('analysis.columnPages')]}>
              {pagesApi.data.pages.map((page) => (
                <tr key={page.id}>
                  <td dir="ltr" className="mono-cell">
                    {page.url}
                  </td>
                  <td>
                    <StatusBadge status={page.status} />
                    {page.errorMessage ? <span className="muted small"> ({page.errorMessage})</span> : null}
                  </td>
                  <td>
                    {page.wordCount} {t('analysis.pageWords')}
                  </td>
                </tr>
              ))}
            </Table>
          ) : (
            <EmptyState>{t('common.noData')}</EmptyState>
          )}
        </Card>
      ) : null}

      <Modal
        open={approveOpen}
        title={t('analysis.approve')}
        onClose={() => setApproveOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setApproveOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              loading={busy === 'approve'}
              onClick={() => {
                setApproveOpen(false);
                void run('approve', { comment });
              }}
            >
              {t('common.confirm')}
            </Button>
          </>
        }
      >
        <Field label={t('analysis.note')} hint={t('analysis.approvedAt')}>
          <Textarea rows={3} value={comment} onChange={(event) => setComment(event.target.value)} />
        </Field>
      </Modal>

      <Modal
        open={changesOpen}
        title={t('analysis.requestChanges')}
        onClose={() => setChangesOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setChangesOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              loading={busy === 'request-changes'}
              disabled={!comment.trim()}
              onClick={() => {
                setChangesOpen(false);
                void run('request-changes', { comment });
              }}
            >
              {t('common.confirm')}
            </Button>
          </>
        }
      >
        <Field label={t('analysis.changesComment')}>
          <Textarea rows={3} value={comment} onChange={(event) => setComment(event.target.value)} />
        </Field>
      </Modal>
    </>
  );
}
