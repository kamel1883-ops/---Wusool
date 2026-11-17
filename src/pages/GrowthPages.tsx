/**
 * «اكتساب العملاء» — lead acquisition and marketing automation.
 *
 * The screen never displays a lead, a metric or a connected channel that the
 * API did not return. Discovery refuses without a licensed source, and a
 * campaign can only launch when its channel, content and consent checks pass.
 */
import { useMemo, useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { api, ApiError, useApi } from '../lib/api';
import { useSession } from '../lib/session';
import { errorKey, formatDate, formatDateTime } from '../lib/i18n';
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
  Stat,
  Table,
  Tabs,
  Textarea,
  cx,
} from '../components/ui';
import { useCompanyCtx } from './CompanyPages';

type Icp = {
  services: string[];
  sectors: string[];
  cities: string[];
  countries: string[];
  keywords: string[];
  problems: string[];
  idealAudience: string;
  offer: string;
  analysisId: string | null;
  evidence: Array<{ field: string; value: string; source?: string; confidence?: number | null; evidenceUrl?: string | null }>;
  updatedAt: string | null;
};

type SourceInfo = {
  provider: string;
  kind: string;
  label: { ar: string; en: string };
  state: 'connected' | 'requires_credentials' | 'awaiting_approval' | 'not_connected' | 'disabled';
  requires: string[];
  providerName: string | null;
};

type ChannelInfo = {
  channel: string;
  label: { ar: string; en: string };
  state: 'connected' | 'awaiting_approval' | 'requires_credentials';
  requires: string[];
  approval: { ar: string; en: string } | null;
  canSendFromThisBuild: boolean;
};

type Overview = {
  icp: Icp;
  analysis: { id: string; url: string; approvedVersion: number; approvedAt: string | null } | null;
  sources: SourceInfo[];
  channels: ChannelInfo[];
  stats: {
    leads: number;
    qualified: number;
    consented: number;
    doNotContact: number;
    potential: number;
    confirmed: number;
    campaigns: number;
    sent: number;
    failed: number;
  };
  canManage: boolean;
};

type Lead = {
  id: string;
  name: string | null;
  companyName: string | null;
  jobTitle: string | null;
  sector: string | null;
  city: string | null;
  country: string | null;
  email: string | null;
  emailSource: string | null;
  phone: string | null;
  phoneSource: string | null;
  website: string | null;
  profileUrl: string | null;
  sourceKind: string;
  sourceProvider: string | null;
  sourceUrl: string;
  evidenceText: string;
  interestSignal: string;
  score: number;
  scoreReasons: Array<{ code: string; points: number; detail: string }>;
  classification: 'potential' | 'confirmed';
  stage: string;
  consentState: string;
  doNotContact: boolean;
  campaignId: string | null;
  discoveredAt: string;
};

type Campaign = {
  id: string;
  name: string;
  objective: string | null;
  audience: string | null;
  sector: string | null;
  city: string | null;
  channel: string;
  status: string;
  contentRef: string | null;
  contentApproved: boolean;
  budgetSar: number | null;
  createdAt: string;
};

type Blocker = { code: string; count?: number };

const STAGES = ['new', 'qualified', 'contacted', 'replied', 'meeting', 'proposal', 'won', 'lost'];
const SIGNALS = ['search_intent', 'public_request', 'public_question', 'company_fit', 'inbound'];
const label = (value: string, t: (key: string) => string) => t(`growth.enum.${value}`);

function StateChip({ state, t }: { state: string; t: (key: string) => string }) {
  const tone =
    state === 'connected'
      ? 'ok'
      : state === 'awaiting_approval'
        ? 'warn'
        : state === 'requires_credentials'
          ? 'info'
          : 'muted';
  return <span className={cx('growth-state', `growth-state-${tone}`)}>{t(`growth.state.${state}`)}</span>;
}

function ScorePill({ score }: { score: number }) {
  const tone = score >= 70 ? 'high' : score >= 45 ? 'mid' : 'low';
  return <span className={cx('score-pill', `score-${tone}`)}>{score}</span>;
}

export function CompanyGrowthPage() {
  const { companyId } = useParams();
  const { t, locale } = useSession();
  const { overview: company } = useCompanyCtx();
  const { data, loading, error, reload } = useApi<Overview>(
    companyId ? `/api/company/${companyId}/growth` : null
  );

  // Deep links from the workspace cards: ?tab=channels.
  const [tab, setTab] = useState(() => {
    const wanted = new URLSearchParams(window.location.search).get('tab');
    return wanted && ['icp', 'sources', 'leads', 'campaigns', 'channels', 'results'].includes(wanted)
      ? wanted
      : 'icp';
  });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'warn' | 'danger' | 'info'; text: string } | null>(null);
  const [showLeadForm, setShowLeadForm] = useState(false);
  const [showCampaignForm, setShowCampaignForm] = useState(false);

  const refresh = () => {
    reload();
  };

  const discover = async () => {
    if (!companyId) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await api<{ inserted: number; skipped: number; city?: string | null }>(
        `/api/company/${companyId}/growth/discover`,
        { method: 'POST', body: { limit: 20 } }
      );
      setNotice({
        tone: result.inserted ? 'ok' : 'warn',
        text: t('growth.discoverDone')
          .replace('{inserted}', String(result.inserted))
          .replace('{skipped}', String(result.skipped)),
      });
      refresh();
    } catch (err) {
      const code = (err as ApiError).code;
      if (code === 'lead_source_not_connected') {
        setNotice({ tone: 'warn', text: t('growth.discoverNotConnected') });
        setTab('sources');
      } else if (code === 'analysis_not_approved') {
        setNotice({ tone: 'warn', text: t('growth.discoverNeedsAnalysis') });
      } else {
        setNotice({ tone: 'danger', text: t(errorKey(code)) });
      }
    } finally {
      setBusy(false);
    }
  };

  const tabs = useMemo(
    () => [
      { id: 'icp', label: t('growth.tab.icp') },
      { id: 'sources', label: t('growth.tab.sources') },
      { id: 'leads', label: t('growth.tab.leads') },
      { id: 'campaigns', label: t('growth.tab.campaigns') },
      { id: 'channels', label: t('growth.tab.channels') },
      { id: 'results', label: t('growth.tab.results') },
    ],
    [t]
  );

  if (loading) return <Loading />;
  if (error || !data) {
    return (
      <Card>
        <Alert tone="danger">{t(errorKey(error ?? undefined))}</Alert>
      </Card>
    );
  }

  return (
    <>
      <PageHeader
        title={t('growth.title')}
        subtitle={t('growth.subtitle')}
        actions={
          data.canManage ? (
            <div className="row-actions">
              <Button variant="secondary" loading={busy} onClick={() => void discover()}>
                {t('growth.discover')}
              </Button>
              <Button onClick={() => setShowCampaignForm(true)}>{t('growth.newCampaign')}</Button>
            </div>
          ) : null
        }
      />

      {!company.subscription.isActive ? <Alert tone="warn">{t('err.subscription_inactive')}</Alert> : null}
      {notice ? <Alert tone={notice.tone === 'ok' ? 'ok' : notice.tone}>{notice.text}</Alert> : null}

      <div className="growth-stats">
        <Stat label={t('growth.stat.leads')} value={String(data.stats.leads)} />
        <Stat label={t('growth.stat.potential')} value={String(data.stats.potential ?? 0)} />
        <Stat label={t('growth.stat.qualified')} value={String(data.stats.qualified)} />
        <Stat label={t('growth.stat.consented')} value={String(data.stats.consented)} />
        <Stat label={t('growth.stat.campaigns')} value={String(data.stats.campaigns)} />
        <Stat label={t('growth.stat.sent')} value={String(data.stats.sent)} />
      </div>

      <Tabs tabs={tabs} active={tab} onChange={setTab} />

      {tab === 'icp' ? <IcpPanel companyId={companyId!} icp={data.icp} analysis={data.analysis} canManage={data.canManage} onSaved={refresh} /> : null}
      {tab === 'sources' ? <SourcesPanel sources={data.sources} t={t} locale={locale} /> : null}
      {tab === 'leads' ? (
        <LeadsPanel
          companyId={companyId!}
          canManage={data.canManage}
          t={t}
          locale={locale}
          onChanged={refresh}
          onAdd={() => setShowLeadForm(true)}
        />
      ) : null}
      {tab === 'campaigns' ? (
        <CampaignsPanel companyId={companyId!} canManage={data.canManage} t={t} locale={locale} onChanged={refresh} />
      ) : null}
      {tab === 'channels' ? <ChannelsPanel channels={data.channels} t={t} locale={locale} /> : null}
      {tab === 'results' ? <ResultsPanel companyId={companyId!} canManage={data.canManage} t={t} locale={locale} /> : null}

      {showLeadForm && companyId ? (
        <LeadFormModal
          companyId={companyId}
          onClose={() => setShowLeadForm(false)}
          onSaved={() => {
            setShowLeadForm(false);
            refresh();
            setTab('leads');
          }}
        />
      ) : null}

      {showCampaignForm && companyId ? (
        <CampaignFormModal
          companyId={companyId}
          channels={data.channels}
          onClose={() => setShowCampaignForm(false)}
          onSaved={() => {
            setShowCampaignForm(false);
            refresh();
            setTab('campaigns');
          }}
        />
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// ICP
// ---------------------------------------------------------------------------

function IcpPanel({
  companyId,
  icp,
  analysis,
  canManage,
  onSaved,
}: {
  companyId: string;
  icp: Icp;
  analysis: Overview['analysis'];
  canManage: boolean;
  onSaved: () => void;
}) {
  const { t, locale } = useSession();
  const [form, setForm] = useState({
    services: icp.services.join('، '),
    sectors: icp.sectors.join('، '),
    cities: icp.cities.join('، '),
    keywords: icp.keywords.join('، '),
    problems: icp.problems.join('، '),
    idealAudience: icp.idealAudience,
    offer: icp.offer,
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);
  const empty = !icp.services.length && !icp.sectors.length && !icp.idealAudience;

  const derive = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await api(`/api/company/${companyId}/growth/icp/derive`, { method: 'POST' });
      setMessage({ tone: 'ok', text: t('growth.icpDerived') });
      onSaved();
    } catch (err) {
      const code = (err as ApiError).code;
      setMessage({
        tone: 'danger',
        text: code === 'analysis_not_approved' ? t('growth.icpNeedsAnalysis') : t(errorKey(code)),
      });
    } finally {
      setBusy(false);
    }
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await api(`/api/company/${companyId}/growth/icp`, { method: 'PUT', body: form });
      setMessage({ tone: 'ok', text: t('common.saved') });
      onSaved();
    } catch (err) {
      setMessage({ tone: 'danger', text: t(errorKey((err as ApiError).code)) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="growth-grid">
      <Card title={t('growth.icpTitle')}>
        <p className="muted small">{t('growth.icpHint')}</p>
        {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
        {empty ? <Alert tone="info">{t('growth.icpEmpty')}</Alert> : null}
        <div className="row-actions growth-icp-actions">
          <Button size="sm" variant="secondary" loading={busy} disabled={!canManage} onClick={() => void derive()}>
            {t('growth.icpDerive')}
          </Button>
          {analysis ? (
            <span className="muted small">
              {t('growth.icpFrom')} <span dir="ltr">{analysis.url}</span>
            </span>
          ) : (
            <span className="muted small">{t('growth.icpNoAnalysis')}</span>
          )}
        </div>

        <form className="stack" onSubmit={save}>
          <Field label={t('growth.icpServices')} htmlFor="icp-services">
            <Textarea
              id="icp-services"
              rows={2}
              value={form.services}
              disabled={!canManage}
              onChange={(event) => setForm({ ...form, services: event.target.value })}
            />
          </Field>
          <Field label={t('growth.icpSectors')} htmlFor="icp-sectors">
            <Textarea
              id="icp-sectors"
              rows={2}
              value={form.sectors}
              disabled={!canManage}
              onChange={(event) => setForm({ ...form, sectors: event.target.value })}
            />
          </Field>
          <Field label={t('growth.icpCities')} htmlFor="icp-cities">
            <Textarea
              id="icp-cities"
              rows={2}
              value={form.cities}
              disabled={!canManage}
              onChange={(event) => setForm({ ...form, cities: event.target.value })}
            />
          </Field>
          <Field label={t('growth.icpKeywords')} htmlFor="icp-keywords">
            <Textarea
              id="icp-keywords"
              rows={2}
              value={form.keywords}
              disabled={!canManage}
              onChange={(event) => setForm({ ...form, keywords: event.target.value })}
            />
          </Field>
          <Field label={t('growth.icpProblems')} htmlFor="icp-problems">
            <Textarea
              id="icp-problems"
              rows={2}
              value={form.problems}
              disabled={!canManage}
              onChange={(event) => setForm({ ...form, problems: event.target.value })}
            />
          </Field>
          <Field label={t('growth.icpAudience')} htmlFor="icp-audience">
            <Input
              id="icp-audience"
              value={form.idealAudience}
              disabled={!canManage}
              onChange={(event) => setForm({ ...form, idealAudience: event.target.value })}
            />
          </Field>
          <Field label={t('growth.icpOffer')} htmlFor="icp-offer">
            <Input
              id="icp-offer"
              value={form.offer}
              disabled={!canManage}
              onChange={(event) => setForm({ ...form, offer: event.target.value })}
            />
          </Field>
          {canManage ? (
            <Button type="submit" loading={busy}>
              {t('common.save')}
            </Button>
          ) : null}
        </form>
      </Card>

      <Card title={t('growth.icpEvidence')}>
        {!icp.evidence.length ? (
          <EmptyState>{t('growth.icpEvidenceEmpty')}</EmptyState>
        ) : (
          <ul className="growth-evidence">
            {icp.evidence.map((item, index) => (
              <li key={`${item.field}-${index}`}>
                <span className="source-tag source-website">{t(`growth.icpField.${item.field}`)}</span>
                <span>{item.value}</span>
                {item.evidenceUrl ? (
                  <a href={item.evidenceUrl} target="_blank" rel="noreferrer" dir="ltr" className="growth-link">
                    {t('growth.openSource')}
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <p className="muted small">{t('growth.icpEvidenceHint')}</p>
        {icp.updatedAt ? (
          <p className="muted small">
            {t('growth.updatedAt')} {formatDateTime(icp.updatedAt, locale)}
          </p>
        ) : null}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sources & channels
// ---------------------------------------------------------------------------

function SourcesPanel({
  sources,
  t,
  locale,
}: {
  sources: SourceInfo[];
  t: (key: string) => string;
  locale: 'ar' | 'en';
}) {
  return (
    <div className="growth-grid">
      <Card title={t('growth.sourcesTitle')}>
        <p className="muted small">{t('growth.sourcesHint')}</p>
        <ul className="growth-source-list">
          {sources.map((source) => (
            <li key={source.provider}>
              <div className="growth-source-head">
                <strong>{locale === 'ar' ? source.label.ar : source.label.en}</strong>
                <StateChip state={source.state} t={t} />
              </div>
              {source.providerName ? (
                <p className="muted small">
                  {t('growth.provider')}: <span dir="ltr">{source.providerName}</span>
                </p>
              ) : null}
              {source.requires && source.requires.length > 0 ? (
                <p className="muted small">{source.requires.join(' · ')}</p>
              ) : null}
            </li>
          ))}
        </ul>
      </Card>
      <Card title={t('growth.discoveryRulesTitle')}>
        <ul className="growth-rules">
          <li>{t('growth.ruleEvidence')}</li>
          <li>{t('growth.ruleNoScraping')}</li>
          <li>{t('growth.ruleNoFakeContact')}</li>
          <li>{t('growth.ruleNoFakeConnector')}</li>
        </ul>
      </Card>
    </div>
  );
}

function ChannelsPanel({
  channels,
  t,
  locale,
}: {
  channels: ChannelInfo[];
  t: (key: string) => string;
  locale: 'ar' | 'en';
}) {
  return (
    <Card title={t('growth.channelsTitle')}>
      <p className="muted small">{t('growth.channelsHint')}</p>
      <div className="growth-channel-grid">
        {channels.map((channel) => (
          <div key={channel.channel} className="growth-channel">
            <div className="growth-source-head">
              <strong>{locale === 'ar' ? channel.label.ar : channel.label.en}</strong>
              <StateChip state={channel.state} t={t} />
            </div>
            {channel.state === 'requires_credentials' ? (
              <p className="muted small">{t('growth.channelNeedsActivation')}</p>
            ) : null}
            {channel.channel === 'meta' ? (
              <p className="muted small">{t('growth.metaOAuthHint')}</p>
            ) : null}
            {channel.approval ? (
              <p className="muted small">
                {t('growth.approval')}: {locale === 'ar' ? channel.approval.ar : channel.approval.en}
              </p>
            ) : null}
            {!channel.canSendFromThisBuild ? (
              <p className="muted small">{t('growth.adapterPending')}</p>
            ) : null}
          </div>
        ))}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Leads
// ---------------------------------------------------------------------------

function LeadsPanel({
  companyId,
  canManage,
  t,
  locale,
  onChanged,
  onAdd,
}: {
  companyId: string;
  canManage: boolean;
  t: (key: string) => string;
  locale: 'ar' | 'en';
  onChanged: () => void;
  onAdd: () => void;
}) {
  const [stage, setStage] = useState('');
  const [search, setSearch] = useState('');
  const leads = useApi<{ leads: Lead[] }>(
    `/api/company/${companyId}/growth/leads?stage=${encodeURIComponent(stage)}&q=${encodeURIComponent(search)}`
  );
  const suppressions = useApi<{ suppressions: Array<{ id: string; channel: string; address: string; reason: string | null; createdAt: string }> }>(
    `/api/company/${companyId}/growth/suppressions`
  );
  const [expanded, setExpanded] = useState<string | null>(null);
  const [activityLead, setActivityLead] = useState<Lead | null>(null);
  const [suppressForm, setSuppressForm] = useState({ channel: 'email', address: '', reason: '' });
  const [error, setError] = useState<string | null>(null);

  const patch = async (lead: Lead, body: Record<string, unknown>) => {
    setError(null);
    try {
      await api(`/api/company/${companyId}/growth/leads/${lead.id}`, { method: 'PATCH', body });
      leads.reload();
      onChanged();
    } catch (err) {
      setError(t(errorKey((err as ApiError).code)));
    }
  };

  const addSuppression = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      await api(`/api/company/${companyId}/growth/suppressions`, { method: 'POST', body: suppressForm });
      setSuppressForm({ channel: 'email', address: '', reason: '' });
      suppressions.reload();
    } catch (err) {
      setError(t(errorKey((err as ApiError).code)));
    }
  };

  const rows = leads.data?.leads ?? [];

  const openDataSource = rows.some((lead) => lead.sourceProvider === 'openstreetmap');

  return (
    <div className="growth-stack">
      <Card
        title={t('growth.leadsTitle')}
        actions={
          canManage ? (
            <Button size="sm" variant="secondary" onClick={onAdd}>
              {t('growth.addLead')}
            </Button>
          ) : null
        }
      >
        <div className="growth-filters">
          <Select value={stage} onChange={(event) => setStage(event.target.value)} aria-label={t('growth.stage')}>
            <option value="">{t('growth.allStages')}</option>
            {STAGES.map((item) => (
              <option key={item} value={item}>
                {label(item, t)}
              </option>
            ))}
          </Select>
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('growth.search')}
            aria-label={t('growth.search')}
          />
        </div>

        {error ? <Alert tone="danger">{error}</Alert> : null}
        {leads.error ? <Alert tone="danger">{t(errorKey(leads.error))}</Alert> : null}
        <p className="muted small">{t('growth.classificationHint')}</p>
        {openDataSource ? <Alert tone="info">{t('growth.osmNote')}</Alert> : null}
        {leads.loading ? (
          <Loading />
        ) : !rows.length ? (
          <EmptyState>
            <strong>{t('growth.leadsEmpty')}</strong>
            <br />
            {t('growth.leadsEmptyHint')}
          </EmptyState>
        ) : (
          <Table
            head={[
              t('growth.columnLead'),
              t('growth.columnSector'),
              t('growth.columnScore'),
              t('growth.columnReason'),
              t('growth.columnStage'),
              t('growth.columnConsent'),
              t('growth.columnDate'),
              t('common.actions'),
            ]}
          >
            {rows.map((lead) => (
              <tr key={lead.id} className={expanded === lead.id ? 'row-open' : undefined}>
                <td>
                  <strong>{lead.companyName || lead.name}</strong>
                  <div>
                    <span
                      className={cx(
                        'badge',
                        lead.classification === 'confirmed' ? 'badge-ok' : 'badge-muted'
                      )}
                    >
                      {t(`growth.classification.${lead.classification}`)}
                    </span>
                  </div>
                  {lead.name && lead.companyName ? <div className="muted small">{lead.name}</div> : null}
                  {lead.email ? (
                    <div className="muted small" dir="ltr">
                      {lead.email}
                    </div>
                  ) : null}
                </td>
                <td>
                  {lead.sector || '—'}
                  {lead.city ? <div className="muted small">{lead.city}</div> : null}
                </td>
                <td>
                  <ScorePill score={lead.score} />
                </td>
                <td className="growth-reason">
                  <span className="muted small">{label(lead.interestSignal, t)}</span>
                  <div>{lead.evidenceText.slice(0, 90)}{lead.evidenceText.length > 90 ? '…' : ''}</div>
                  <a href={lead.sourceUrl} target="_blank" rel="noreferrer" className="growth-link" dir="ltr">
                    {t('growth.openSource')}
                  </a>
                </td>
                <td>
                  {canManage ? (
                    <Select
                      value={lead.stage}
                      onChange={(event) => void patch(lead, { stage: event.target.value })}
                      aria-label={t('growth.stage')}
                    >
                      {STAGES.map((item) => (
                        <option key={item} value={item}>
                          {label(item, t)}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    label(lead.stage, t)
                  )}
                </td>
                <td>
                  <div className="growth-consent">
                    <span className={cx('badge', lead.consentState === 'granted' ? 'badge-ok' : 'badge-muted')}>
                      {label(lead.consentState, t)}
                    </span>
                    {lead.doNotContact ? <span className="badge badge-danger">{t('growth.dnc')}</span> : null}
                  </div>
                </td>
                <td>{formatDate(lead.discoveredAt, locale)}</td>
                <td className="row-actions">
                  <Button size="sm" variant="ghost" onClick={() => setExpanded(expanded === lead.id ? null : lead.id)}>
                    {expanded === lead.id ? t('common.close') : t('growth.details')}
                  </Button>
                  {canManage ? (
                    <Button size="sm" variant="ghost" onClick={() => setActivityLead(lead)}>
                      {t('growth.logContact')}
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
            {expanded ? (
              <tr className="growth-expanded-row">
                <td colSpan={8}>
                  <LeadDetails
                    lead={rows.find((item) => item.id === expanded)!}
                    companyId={companyId}
                    canManage={canManage}
                    t={t}
                    onPatch={patch}
                  />
                </td>
              </tr>
            ) : null}
          </Table>
        )}
      </Card>

      <Card title={t('growth.suppressionTitle')}>
        <p className="muted small">{t('growth.suppressionHint')}</p>
        <form className="growth-filters" onSubmit={addSuppression}>
          <Select
            value={suppressForm.channel}
            onChange={(event) => setSuppressForm({ ...suppressForm, channel: event.target.value })}
            aria-label={t('growth.channel')}
          >
            <option value="email">{t('growth.channelEmail')}</option>
            <option value="whatsapp">{t('growth.channelWhatsapp')}</option>
            <option value="all">{t('growth.channelAll')}</option>
          </Select>
          <Input
            dir="ltr"
            required
            value={suppressForm.address}
            onChange={(event) => setSuppressForm({ ...suppressForm, address: event.target.value })}
            placeholder={t('growth.suppressionAddress')}
            aria-label={t('growth.suppressionAddress')}
          />
          <Input
            value={suppressForm.reason}
            onChange={(event) => setSuppressForm({ ...suppressForm, reason: event.target.value })}
            placeholder={t('growth.suppressionReason')}
            aria-label={t('growth.suppressionReason')}
          />
          <Button type="submit" size="sm" variant="secondary" disabled={!canManage}>
            {t('growth.addSuppression')}
          </Button>
        </form>
        {suppressions.data?.suppressions.length ? (
          <Table head={[t('growth.channel'), t('growth.suppressionAddress'), t('growth.suppressionReason'), t('growth.columnDate')]}>
            {suppressions.data.suppressions.map((row) => (
              <tr key={row.id}>
                <td>{row.channel}</td>
                <td dir="ltr">{row.address}</td>
                <td>{row.reason || '—'}</td>
                <td>{formatDate(row.createdAt, locale)}</td>
              </tr>
            ))}
          </Table>
        ) : (
          <EmptyState>{t('growth.suppressionEmpty')}</EmptyState>
        )}
      </Card>

      {activityLead ? (
        <ActivityModal
          companyId={companyId}
          lead={activityLead}
          onClose={() => setActivityLead(null)}
          onSaved={() => {
            leads.reload();
          }}
        />
      ) : null}
    </div>
  );
}

function LeadDetails({
  lead,
  companyId,
  canManage,
  t,
  onPatch,
}: {
  lead: Lead;
  companyId: string;
  canManage: boolean;
  t: (key: string) => string;
  onPatch: (lead: Lead, body: Record<string, unknown>) => void;
}) {
  const campaigns = useApi<{ campaigns: Campaign[] }>(`/api/company/${companyId}/growth/campaigns`);

  return (
    <div className="growth-details">
      <div>
        <h4>{t('growth.whyLead')}</h4>
        <ul className="growth-reasons">
          {lead.scoreReasons.map((reason) => (
            <li key={reason.code}>
              <span className="score-points">+{reason.points}</span> {reason.detail}
            </li>
          ))}
        </ul>
        <p className="muted small">
          {t('growth.sourceKind')}:{' '}
          {t(
            lead.sourceProvider === 'openstreetmap'
              ? 'growth.sourceKind.open_data'
              : `growth.sourceKind.${lead.sourceKind}`
          )}
          {lead.sourceProvider ? ` · ${lead.sourceProvider}` : ''}
        </p>
        <p className="muted small">
          {t('growth.matchScoreLabel')}: {lead.score}/100 ·{' '}
          {t(`growth.classification.${lead.classification}`)}
        </p>
        <p className="muted small">
          {t('growth.signal')}: {label(lead.interestSignal, t)}
        </p>
      </div>
      <div>
        <h4>{t('growth.contactData')}</h4>
        <dl className="detail-list">
          <div>
            <dt>{t('common.email')}</dt>
            <dd dir="ltr">
              {lead.email || '—'}
              {lead.emailSource ? <span className="muted small"> ({lead.emailSource})</span> : null}
            </dd>
          </div>
          <div>
            <dt>{t('growth.phone')}</dt>
            <dd dir="ltr">
              {lead.phone || '—'}
              {lead.phoneSource ? <span className="muted small"> ({lead.phoneSource})</span> : null}
            </dd>
          </div>
          <div>
            <dt>{t('growth.profile')}</dt>
            <dd>
              {lead.profileUrl ? (
                <a href={lead.profileUrl} target="_blank" rel="noreferrer" dir="ltr" className="growth-link">
                  {lead.profileUrl}
                </a>
              ) : (
                '—'
              )}
            </dd>
          </div>
        </dl>
        {canManage ? (
          <div className="row-actions growth-detail-actions">
            <Button
              size="sm"
              variant="secondary"
              onClick={() =>
                onPatch(lead, { consentState: lead.consentState === 'granted' ? 'withdrawn' : 'granted' })
              }
            >
              {lead.consentState === 'granted' ? t('growth.withdrawConsent') : t('growth.grantConsent')}
            </Button>
            <Button
              size="sm"
              variant={lead.doNotContact ? 'secondary' : 'ghost'}
              onClick={() => onPatch(lead, { doNotContact: !lead.doNotContact })}
            >
              {lead.doNotContact ? t('growth.allowContact') : t('growth.blockContact')}
            </Button>
            <Select
              value={lead.campaignId ?? ''}
              onChange={(event) => onPatch(lead, { campaignId: event.target.value || null })}
              aria-label={t('growth.campaign')}
            >
              <option value="">{t('growth.noCampaign')}</option>
              {(campaigns.data?.campaigns ?? []).map((campaign) => (
                <option key={campaign.id} value={campaign.id}>
                  {campaign.name}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ActivityModal({
  companyId,
  lead,
  onClose,
  onSaved,
}: {
  companyId: string;
  lead: Lead;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t, locale } = useSession();
  const activities = useApi<{ activities: Array<{ id: string; kind: string; note: string | null; createdAt: string }> }>(
    `/api/company/${companyId}/growth/leads/${lead.id}/activities`
  );
  const [kind, setKind] = useState('note');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/api/company/${companyId}/growth/leads/${lead.id}/activities`, {
        method: 'POST',
        body: { kind, note },
      });
      setNote('');
      activities.reload();
      onSaved();
    } catch (err) {
      setError(t(errorKey((err as ApiError).code)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open title={`${t('growth.logContact')} — ${lead.companyName || lead.name}`} onClose={onClose}>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <form className="stack" onSubmit={submit}>
        <Field label={t('growth.activityKind')} htmlFor="activity-kind">
          <Select id="activity-kind" value={kind} onChange={(event) => setKind(event.target.value)}>
            {['note', 'email', 'call', 'whatsapp', 'meeting', 'proposal'].map((item) => (
              <option key={item} value={item}>
                {t(`growth.activity.${item}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('growth.note')} htmlFor="activity-note">
          <Textarea
            id="activity-note"
            rows={3}
            required
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </Field>
        <Button type="submit" loading={busy}>
          {t('common.save')}
        </Button>
      </form>
      <h4>{t('growth.activityLog')}</h4>
      {activities.loading ? (
        <Loading />
      ) : activities.data?.activities.length ? (
        <ul className="growth-activity-list">
          {activities.data.activities.map((item) => (
            <li key={item.id}>
              <span className="badge">{t(`growth.activity.${item.kind}`)}</span>
              <span>{item.note}</span>
              <span className="muted small">{formatDateTime(item.createdAt, locale)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState>{t('growth.activityEmpty')}</EmptyState>
      )}
    </Modal>
  );
}

function LeadFormModal({
  companyId,
  onClose,
  onSaved,
}: {
  companyId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useSession();
  const [form, setForm] = useState({
    name: '',
    companyName: '',
    sector: '',
    city: '',
    country: '',
    email: '',
    emailSource: 'public_page',
    phone: '',
    phoneSource: 'public_page',
    website: '',
    profileUrl: '',
    interestSignal: 'public_request',
    evidenceText: '',
    sourceUrl: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/api/company/${companyId}/growth/leads`, { method: 'POST', body: form });
      onSaved();
    } catch (err) {
      setError(t(errorKey((err as ApiError).code)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open wide title={t('growth.addLead')} onClose={onClose}>
      <Alert tone="info">{t('growth.addLeadHint')}</Alert>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <form className="stack" onSubmit={submit}>
        <div className="form-row">
          <Field label={t('growth.companyName')} htmlFor="lead-company">
            <Input
              id="lead-company"
              value={form.companyName}
              onChange={(event) => setForm({ ...form, companyName: event.target.value })}
            />
          </Field>
          <Field label={t('growth.personName')} htmlFor="lead-name">
            <Input id="lead-name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
          </Field>
        </div>
        <div className="form-row">
          <Field label={t('growth.sector')} htmlFor="lead-sector">
            <Input id="lead-sector" value={form.sector} onChange={(event) => setForm({ ...form, sector: event.target.value })} />
          </Field>
          <Field label={t('growth.city')} htmlFor="lead-city">
            <Input id="lead-city" value={form.city} onChange={(event) => setForm({ ...form, city: event.target.value })} />
          </Field>
        </div>
        <Field label={t('growth.signal')} htmlFor="lead-signal">
          <Select
            id="lead-signal"
            value={form.interestSignal}
            onChange={(event) => setForm({ ...form, interestSignal: event.target.value })}
          >
            {SIGNALS.map((item) => (
              <option key={item} value={item}>
                {label(item, t)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('growth.evidence')} htmlFor="lead-evidence">
          <Textarea
            id="lead-evidence"
            rows={2}
            required
            value={form.evidenceText}
            onChange={(event) => setForm({ ...form, evidenceText: event.target.value })}
            placeholder={t('growth.evidencePlaceholder')}
          />
        </Field>
        <Field label={t('growth.sourceUrl')} htmlFor="lead-source-url">
          <Input
            id="lead-source-url"
            type="url"
            dir="ltr"
            required
            value={form.sourceUrl}
            onChange={(event) => setForm({ ...form, sourceUrl: event.target.value })}
            placeholder="https://"
          />
        </Field>
        <div className="form-row">
          <Field label={t('common.email')} htmlFor="lead-email">
            <Input
              id="lead-email"
              type="email"
              dir="ltr"
              value={form.email}
              onChange={(event) => setForm({ ...form, email: event.target.value })}
            />
          </Field>
          <Field label={t('growth.contactSource')} htmlFor="lead-email-source">
            <Select
              id="lead-email-source"
              value={form.emailSource}
              onChange={(event) => setForm({ ...form, emailSource: event.target.value })}
            >
              <option value="public_page">{t('growth.contactSource.public_page')}</option>
              <option value="customer_provided">{t('growth.contactSource.customer_provided')}</option>
              <option value="licensed_provider">{t('growth.contactSource.licensed_provider')}</option>
            </Select>
          </Field>
        </div>
        <div className="form-row">
          <Field label={t('growth.phone')} htmlFor="lead-phone">
            <Input
              id="lead-phone"
              dir="ltr"
              value={form.phone}
              onChange={(event) => setForm({ ...form, phone: event.target.value })}
            />
          </Field>
          <Field label={t('growth.contactSource')} htmlFor="lead-phone-source">
            <Select
              id="lead-phone-source"
              value={form.phoneSource}
              onChange={(event) => setForm({ ...form, phoneSource: event.target.value })}
            >
              <option value="public_page">{t('growth.contactSource.public_page')}</option>
              <option value="customer_provided">{t('growth.contactSource.customer_provided')}</option>
              <option value="licensed_provider">{t('growth.contactSource.licensed_provider')}</option>
            </Select>
          </Field>
        </div>
        <div className="form-row">
          <Field label={t('growth.website')} htmlFor="lead-website">
            <Input
              id="lead-website"
              dir="ltr"
              value={form.website}
              onChange={(event) => setForm({ ...form, website: event.target.value })}
            />
          </Field>
          <Field label={t('growth.profile')} htmlFor="lead-profile">
            <Input
              id="lead-profile"
              dir="ltr"
              value={form.profileUrl}
              onChange={(event) => setForm({ ...form, profileUrl: event.target.value })}
            />
          </Field>
        </div>
        <Button type="submit" loading={busy}>
          {t('growth.saveLead')}
        </Button>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

function CampaignsPanel({
  companyId,
  canManage,
  t,
  locale,
  onChanged,
}: {
  companyId: string;
  canManage: boolean;
  t: (key: string) => string;
  locale: 'ar' | 'en';
  onChanged: () => void;
}) {
  const campaigns = useApi<{ campaigns: Campaign[] }>(`/api/company/${companyId}/growth/campaigns`);
  const [checking, setChecking] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, { ready: boolean; blockers: Blocker[]; eligible: number }>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const preflight = async (campaign: Campaign) => {
    setChecking(campaign.id);
    setError(null);
    try {
      const result = await api<any>(`/api/company/${companyId}/growth/campaigns/${campaign.id}/preflight`, {
        method: 'POST',
      });
      setResults((current) => ({ ...current, [campaign.id]: result }));
    } catch (err) {
      setError(t(errorKey((err as ApiError).code)));
    } finally {
      setChecking(null);
    }
  };

  const launch = async (campaign: Campaign) => {
    setBusy(campaign.id);
    setError(null);
    try {
      const result = await api<{ sent: number; failed: number }>(
        `/api/company/${companyId}/growth/campaigns/${campaign.id}/launch`,
        { method: 'POST' }
      );
      setError(null);
      alert(`${t('growth.launchResult')} ${result.sent} / ${result.failed}`);
      campaigns.reload();
      onChanged();
    } catch (err) {
      const apiError = err as ApiError & { payload?: any };
      setError(t(errorKey(apiError.code)));
      void preflight(campaign);
    } finally {
      setBusy(null);
    }
  };

  const approveContent = async (campaign: Campaign) => {
    setBusy(campaign.id);
    try {
      await api(`/api/company/${companyId}/growth/campaigns/${campaign.id}`, {
        method: 'PATCH',
        body: { contentApproved: true },
      });
      campaigns.reload();
      onChanged();
    } catch (err) {
      setError(t(errorKey((err as ApiError).code)));
    } finally {
      setBusy(null);
    }
  };

  const rows = campaigns.data?.campaigns ?? [];

  return (
    <Card title={t('growth.campaignsTitle')}>
      <p className="muted small">{t('growth.campaignsHint')}</p>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {campaigns.loading ? (
        <Loading />
      ) : !rows.length ? (
        <EmptyState>{t('growth.campaignsEmpty')}</EmptyState>
      ) : (
        <div className="growth-campaign-list">
          {rows.map((campaign) => {
            const check = results[campaign.id];
            return (
              <div key={campaign.id} className="growth-campaign">
                <div className="growth-source-head">
                  <strong>{campaign.name}</strong>
                  <span className="badge">{t(`growth.campaignStatus.${campaign.status}`)}</span>
                </div>
                <p className="muted small">
                  {t('growth.channel')}: {t(`growth.enum.${campaign.channel}`)}
                  {campaign.sector ? ` · ${campaign.sector}` : ''}
                  {campaign.city ? ` · ${campaign.city}` : ''}
                  {campaign.budgetSar ? ` · ${campaign.budgetSar} SAR` : ''}
                </p>
                {campaign.contentRef ? (
                  <p className="muted small">
                    {t('growth.content')}: {campaign.contentRef} ·{' '}
                    {campaign.contentApproved ? t('growth.contentApproved') : t('growth.contentNotApproved')}
                  </p>
                ) : (
                  <p className="muted small">{t('growth.contentMissing')}</p>
                )}
                <p className="muted small">
                  {t('growth.createdAt')}: {formatDate(campaign.createdAt, locale)}
                </p>

                {check ? (
                  <div className={cx('growth-preflight', check.ready ? 'is-ready' : 'is-blocked')}>
                    <strong>{check.ready ? t('growth.readyToSend') : t('growth.blockedSend')}</strong>
                    <span className="muted small">
                      {t('growth.eligible')}: {check.eligible}
                    </span>
                    <ul>
                      {check.blockers.map((blocker) => (
                        <li key={blocker.code}>
                          {t(`growth.blocker.${blocker.code}`)}
                          {blocker.count ? ` (${blocker.count})` : ''}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {canManage ? (
                  <div className="row-actions">
                    <Button size="sm" variant="secondary" loading={checking === campaign.id} onClick={() => void preflight(campaign)}>
                      {t('growth.preflight')}
                    </Button>
                    {campaign.contentRef && !campaign.contentApproved ? (
                      <Button size="sm" variant="ghost" loading={busy === campaign.id} onClick={() => void approveContent(campaign)}>
                        {t('growth.approveContent')}
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={!check?.ready}
                      loading={busy === campaign.id}
                      onClick={() => void launch(campaign)}
                    >
                      {t('growth.launch')}
                    </Button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function CampaignFormModal({
  companyId,
  channels,
  onClose,
  onSaved,
}: {
  companyId: string;
  channels: ChannelInfo[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t, locale } = useSession();
  const [form, setForm] = useState({
    name: '',
    objective: '',
    audience: '',
    sector: '',
    city: '',
    channel: 'email',
    contentRef: '',
    budgetSar: '',
    startsOn: '',
    endsOn: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (!effectiveChannel) {
        setError(t('growth.noSendableChannel'));
        setBusy(false);
        return;
      }
      await api(`/api/company/${companyId}/growth/campaigns`, {
        method: 'POST',
        body: { ...form, channel: effectiveChannel },
      });
      onSaved();
    } catch (err) {
      setError(t(errorKey((err as ApiError).code)));
    } finally {
      setBusy(false);
    }
  };

  const sendable = channels.filter((channel) => channel.canSendFromThisBuild);
  const effectiveChannel = sendable.some((channel) => channel.channel === form.channel)
    ? form.channel
    : (sendable[0]?.channel ?? '');
  const selected = channels.find((channel) => channel.channel === effectiveChannel);

  return (
    <Modal open title={t('growth.newCampaign')} onClose={onClose}>
      <Alert tone="info">{t('growth.campaignHint')}</Alert>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <form className="stack" onSubmit={submit}>
        <Field label={t('growth.campaignName')} htmlFor="campaign-name">
          <Input
            id="campaign-name"
            required
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
          />
        </Field>
        <Field label={t('growth.objective')} htmlFor="campaign-objective">
          <Input
            id="campaign-objective"
            value={form.objective}
            onChange={(event) => setForm({ ...form, objective: event.target.value })}
          />
        </Field>
        <Field label={t('growth.audience')} htmlFor="campaign-audience">
          <Input
            id="campaign-audience"
            value={form.audience}
            onChange={(event) => setForm({ ...form, audience: event.target.value })}
          />
        </Field>
        <div className="form-row">
          <Field label={t('growth.sector')} htmlFor="campaign-sector">
            <Input
              id="campaign-sector"
              value={form.sector}
              onChange={(event) => setForm({ ...form, sector: event.target.value })}
            />
          </Field>
          <Field label={t('growth.city')} htmlFor="campaign-city">
            <Input id="campaign-city" value={form.city} onChange={(event) => setForm({ ...form, city: event.target.value })} />
          </Field>
        </div>
        <Field label={t('growth.channel')} htmlFor="campaign-channel">
          <Select id="campaign-channel" value={effectiveChannel} onChange={(event) => setForm({ ...form, channel: event.target.value })}>
            {sendable.map((channel) => (
              <option key={channel.channel} value={channel.channel}>
                {t(`growth.enum.${channel.channel}`)}
              </option>
            ))}
          </Select>
        </Field>
        {sendable.length === 0 ? <Alert tone="warn">{t('growth.noSendableChannel')}</Alert> : null}
        {selected ? (
          <Alert tone={selected.state === 'connected' ? 'ok' : 'warn'}>
            {t('growth.channelState')}: {t(`growth.state.${selected.state}`)}
            {!selected.canSendFromThisBuild ? ` — ${t('growth.adapterPending')}` : ''}
          </Alert>
        ) : null}
        <Field label={t('growth.content')} htmlFor="campaign-content">
          <Input
            id="campaign-content"
            value={form.contentRef}
            onChange={(event) => setForm({ ...form, contentRef: event.target.value })}
            placeholder={t('growth.contentPlaceholder')}
          />
        </Field>
        <div className="form-row">
          <Field label={t('growth.budget')} htmlFor="campaign-budget">
            <Input
              id="campaign-budget"
              type="number"
              min={0}
              value={form.budgetSar}
              onChange={(event) => setForm({ ...form, budgetSar: event.target.value })}
            />
          </Field>
          <Field label={t('growth.dates')} htmlFor="campaign-start">
            <div className="growth-date-row">
              <Input
                id="campaign-start"
                type="date"
                value={form.startsOn}
                onChange={(event) => setForm({ ...form, startsOn: event.target.value })}
              />
              <Input
                type="date"
                value={form.endsOn}
                aria-label={t('growth.dates')}
                onChange={(event) => setForm({ ...form, endsOn: event.target.value })}
              />
            </div>
          </Field>
        </div>
        <p className="muted small">{locale === 'ar' ? 'لن يُرسل شيء قبل اجتياز فحص الجاهزية.' : 'Nothing is sent before the readiness check passes.'}</p>
        <Button type="submit" loading={busy} disabled={!effectiveChannel}>
          {t('growth.createCampaign')}
        </Button>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

function ResultsPanel({
  companyId,
  canManage,
  t,
  locale,
}: {
  companyId: string;
  canManage: boolean;
  t: (key: string) => string;
  locale: 'ar' | 'en';
}) {
  const metrics = useApi<{
    metrics: Array<any>;
    totals: {
      impressions: number;
      engagements: number;
      replies: number;
      leads: number;
      meetings: number;
      proposals: number;
      won: number;
      revenue: number;
      spend: number;
      costPerLead: number | null;
      roas: number | null;
      roi: number | null;
    };
  }>(`/api/company/${companyId}/growth/metrics`);
  const campaigns = useApi<{ campaigns: Campaign[] }>(`/api/company/${companyId}/growth/campaigns`);
  const [form, setForm] = useState({
    campaignId: '',
    periodDate: new Date().toISOString().slice(0, 10),
    impressions: '',
    engagements: '',
    replies: '',
    leads: '',
    meetings: '',
    proposals: '',
    won: '',
    spendSar: '',
    revenueSar: '',
    note: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/api/company/${companyId}/growth/metrics`, { method: 'POST', body: form });
      metrics.reload();
    } catch (err) {
      setError(t(errorKey((err as ApiError).code)));
    } finally {
      setBusy(false);
    }
  };

  const totals = metrics.data?.totals;

  return (
    <div className="growth-stack">
      <Card title={t('growth.resultsTitle')}>
        <p className="muted small">{t('growth.resultsHint')}</p>
        <div className="growth-stats">
          <Stat label={t('growth.metric.impressions')} value={String(totals?.impressions ?? 0)} />
          <Stat label={t('growth.metric.engagements')} value={String(totals?.engagements ?? 0)} />
          <Stat label={t('growth.metric.replies')} value={String(totals?.replies ?? 0)} />
          <Stat label={t('growth.metric.leads')} value={String(totals?.leads ?? 0)} />
          <Stat label={t('growth.metric.meetings')} value={String(totals?.meetings ?? 0)} />
          <Stat label={t('growth.metric.proposals')} value={String(totals?.proposals ?? 0)} />
          <Stat label={t('growth.metric.won')} value={String(totals?.won ?? 0)} />
          <Stat label={t('growth.metric.spend')} value={String(totals?.spend ?? 0)} />
          <Stat label={t('growth.metric.revenue')} value={String(totals?.revenue ?? 0)} />
          <Stat label={t('growth.metric.cpl')} value={totals?.costPerLead != null ? String(totals.costPerLead) : '—'} />
          <Stat label={t('growth.metric.roi')} value={totals?.roi != null ? `${totals.roi}%` : '—'} />
        </div>
        {totals?.roi == null ? <p className="muted small">{t('growth.roiUnavailable')}</p> : null}
        {metrics.data?.metrics.length ? (
          <Table
            head={[
              t('growth.period'),
              t('growth.metric.impressions'),
              t('growth.metric.replies'),
              t('growth.metric.leads'),
              t('growth.metric.won'),
              t('growth.metric.spend'),
              t('growth.metric.revenue'),
              t('growth.source'),
            ]}
          >
            {metrics.data.metrics.map((row) => (
              <tr key={row.id}>
                <td>{formatDate(row.periodDate, locale)}</td>
                <td>{row.impressions}</td>
                <td>{row.replies}</td>
                <td>{row.leads}</td>
                <td>{row.won}</td>
                <td>{row.spendSar}</td>
                <td>{row.revenueSar}</td>
                <td>{t(`growth.metricSource.${row.source}`)}</td>
              </tr>
            ))}
          </Table>
        ) : (
          <EmptyState>{t('growth.metricsEmpty')}</EmptyState>
        )}
      </Card>

      {canManage ? (
        <Card title={t('growth.addMetrics')}>
          {error ? <Alert tone="danger">{error}</Alert> : null}
          <form className="stack" onSubmit={submit}>
            <div className="form-row">
              <Field label={t('growth.campaign')} htmlFor="metrics-campaign">
                <Select
                  id="metrics-campaign"
                  required
                  value={form.campaignId}
                  onChange={(event) => setForm({ ...form, campaignId: event.target.value })}
                >
                  <option value="">—</option>
                  {(campaigns.data?.campaigns ?? []).map((campaign) => (
                    <option key={campaign.id} value={campaign.id}>
                      {campaign.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('growth.period')} htmlFor="metrics-period">
                <Input
                  id="metrics-period"
                  type="date"
                  value={form.periodDate}
                  onChange={(event) => setForm({ ...form, periodDate: event.target.value })}
                />
              </Field>
            </div>
            <div className="growth-metric-grid">
              {(
                [
                  ['impressions', 'impressions'],
                  ['engagements', 'engagements'],
                  ['replies', 'replies'],
                  ['leads', 'leads'],
                  ['meetings', 'meetings'],
                  ['proposals', 'proposals'],
                  ['won', 'won'],
                  ['spendSar', 'spend'],
                  ['revenueSar', 'revenue'],
                ] as const
              ).map(([field, key]) => (
                <Field key={field} label={t(`growth.metric.${key}`)} htmlFor={`metrics-${field}`}>
                  <Input
                    id={`metrics-${field}`}
                    type="number"
                    min={0}
                    value={(form as any)[field]}
                    onChange={(event) => setForm({ ...form, [field]: event.target.value })}
                  />
                </Field>
              ))}
            </div>
            <Field label={t('growth.note')} htmlFor="metrics-note">
              <Input
                id="metrics-note"
                value={form.note}
                onChange={(event) => setForm({ ...form, note: event.target.value })}
              />
            </Field>
            <Button type="submit" loading={busy} disabled={!form.campaignId}>
              {t('common.save')}
            </Button>
          </form>
        </Card>
      ) : null}
    </div>
  );
}
