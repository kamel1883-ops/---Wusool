/**
 * Wusool Tracking, the performance dashboard panel, and the paid-advertising
 * placeholder.
 *
 * Nothing on these screens is pre-filled with a number the server did not
 * measure: every metric the API marks unavailable is printed as such, together
 * with the reason and the source field the API reports.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
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
  Stat,
  Table,
} from '../components/ui';

type LinkRow = {
  id: string;
  code: string;
  label: string;
  destinationUrl: string;
  shortUrl: string;
  campaignId: string | null;
  platform: string | null;
  status: 'active' | 'paused';
  utm: { source: string | null; medium: string | null; campaign: string | null; content: string | null; term: string | null };
  createdAt: string;
  counts: {
    clicks: number;
    pageViews: number;
    whatsappClicks: number;
    callClicks: number;
    formSubmits: number;
    leads: number;
  } | null;
};

type Overview = {
  links: LinkRow[];
  totals: {
    clicks: number;
    pageViews: number;
    whatsappClicks: number;
    callClicks: number;
    formSubmits: number;
    leads: number;
    uniqueVisitors: number;
  };
  leads: { total: number; attributed: number };
  platformMetrics: { state: string; note: string };
  attribution: { state: string; note: string };
  canManage: boolean;
};

const PLATFORM_OPTIONS = [
  'facebook_page',
  'instagram_business',
  'tiktok_business',
  'snapchat_business',
  'linkedin_org',
] as const;

export function CompanyTrackingPage() {
  const { companyId } = useParams();
  const { t, locale } = useSession();
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'danger' | 'info'; text: string } | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [eventsFor, setEventsFor] = useState<LinkRow | null>(null);
  const [events, setEvents] = useState<any[] | null>(null);
  const [snippetFor, setSnippetFor] = useState<LinkRow | null>(null);
  const [form, setForm] = useState({
    label: '',
    destinationUrl: '',
    utmSource: '',
    utmMedium: '',
    utmCampaign: '',
    utmContent: '',
    utmTerm: '',
    platform: '',
  });

  const base = companyId ? `/api/company/${companyId}/tracking` : null;

  const load = useCallback(async () => {
    if (!base) return;
    try {
      setData(await api<Overview>(base));
    } catch (error) {
      setNotice({ tone: 'danger', text: t(errorKey((error as ApiError)?.code)) });
    } finally {
      setLoading(false);
    }
  }, [base, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    if (!base) return;
    setBusy('create');
    setNotice(null);
    try {
      await api(`${base}/links`, {
        method: 'POST',
        body: {
          label: form.label,
          destinationUrl: form.destinationUrl,
          utmSource: form.utmSource,
          utmMedium: form.utmMedium,
          utmCampaign: form.utmCampaign,
          utmContent: form.utmContent,
          utmTerm: form.utmTerm,
          platform: form.platform || undefined,
        },
      });
      setFormOpen(false);
      setForm({ label: '', destinationUrl: '', utmSource: '', utmMedium: '', utmCampaign: '', utmContent: '', utmTerm: '', platform: '' });
      setNotice({ tone: 'ok', text: t('trk.created', 'Link created.') });
      await load();
    } catch (error) {
      setNotice({ tone: 'danger', text: t(errorKey((error as ApiError)?.code)) });
    } finally {
      setBusy(null);
    }
  };

  const toggle = async (link: LinkRow) => {
    if (!base) return;
    setBusy(link.id);
    try {
      await api(`${base}/links/${link.id}`, {
        method: 'PATCH',
        body: { status: link.status === 'active' ? 'paused' : 'active' },
      });
      await load();
    } catch (error) {
      setNotice({ tone: 'danger', text: t(errorKey((error as ApiError)?.code)) });
    } finally {
      setBusy(null);
    }
  };

  const remove = async (link: LinkRow) => {
    if (!base) return;
    if (!window.confirm(t('trk.deleteConfirm'))) return;
    setBusy(link.id);
    try {
      await api(`${base}/links/${link.id}`, { method: 'DELETE' });
      await load();
    } catch (error) {
      setNotice({ tone: 'danger', text: t(errorKey((error as ApiError)?.code)) });
    } finally {
      setBusy(null);
    }
  };

  const openEvents = async (link: LinkRow) => {
    if (!base) return;
    setEventsFor(link);
    setEvents(null);
    try {
      const result = await api<{ events: any[] }>(`${base}/links/${link.id}/events`);
      setEvents(result.events);
    } catch (error) {
      setEvents([]);
      setNotice({ tone: 'danger', text: t(errorKey((error as ApiError)?.code)) });
    }
  };

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setNotice({ tone: 'ok', text: t('trk.copied') });
    } catch {
      setNotice({ tone: 'info', text: value });
    }
  };

  if (loading) return <Loading />;

  return (
    <>
      <PageHeader
        title={t('trk.title')}
        subtitle={t('trk.subtitle')}
        actions={
          data?.canManage ? (
            <Button onClick={() => setFormOpen(true)}>{t('trk.newLink')}</Button>
          ) : undefined
        }
      />

      {notice ? (
        <Alert tone={notice.tone} onClose={() => setNotice(null)}>
          {notice.text}
        </Alert>
      ) : null}

      {data ? (
        <>
          <div className="social-stats">
            <Stat label={t('trk.clicks')} value={String(data.totals.clicks)} />
            <Stat label={t('trk.visitors')} value={String(data.totals.uniqueVisitors)} />
            <Stat label={t('trk.pageViews')} value={String(data.totals.pageViews)} />
            <Stat label={t('trk.whatsapp')} value={String(data.totals.whatsappClicks)} />
            <Stat label={t('trk.calls')} value={String(data.totals.callClicks)} />
            <Stat label={t('trk.forms')} value={String(data.totals.formSubmits)} />
            <Stat
              label={t('trk.leadAttribution')}
              value={`${data.leads.attributed}/${data.leads.total}`}
            />
          </div>

          <Card title={t('trk.links')} subtitle={t('trk.linksHint')}>
            {data.links.length === 0 ? (
              <EmptyState>{t('trk.empty')}</EmptyState>
            ) : (
              <Table
                head={[
                  t('trk.label'),
                  t('trk.shortUrl'),
                  t('common.status'),
                  t('trk.clicks'),
                  t('trk.forms'),
                  t('common.actions'),
                ]}
              >
                {data.links.map((link) => (
                  <tr key={link.id}>
                    <td>
                      <strong>{link.label}</strong>
                      <div className="muted small" dir="ltr">
                        {link.platform ?? '—'} · {link.destinationUrl.slice(0, 60)}
                      </div>
                    </td>
                    <td>
                      <code dir="ltr">{link.shortUrl}</code>
                      <div className="row-actions">
                        <Button size="sm" variant="ghost" onClick={() => void copy(link.shortUrl)}>
                          {t('trk.copy')}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setSnippetFor(link)}>
                          {t('trk.snippet')}
                        </Button>
                      </div>
                    </td>
                    <td>
                      <span className={`badge badge-${link.status === 'active' ? 'ok' : 'muted'}`}>
                        {t(`trk.status.${link.status}`)}
                      </span>
                    </td>
                    <td>{link.counts?.clicks ?? 0}</td>
                    <td>{link.counts?.formSubmits ?? 0}</td>
                    <td>
                      <div className="row-actions">
                        <Button size="sm" variant="ghost" onClick={() => void openEvents(link)}>
                          {t('trk.events')}
                        </Button>
                        {data.canManage ? (
                          <>
                            <Button
                              size="sm"
                              variant="ghost"
                              loading={busy === link.id}
                              onClick={() => void toggle(link)}
                            >
                              {link.status === 'active' ? t('trk.pause') : t('trk.activate')}
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => void remove(link)}>
                              {t('trk.delete')}
                            </Button>
                          </>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>

          <div className="grid-2">
            <Card title={t('trk.window')}>
              <p className="muted small">{data.attribution.note}</p>
              <p className="muted small">{data.attribution.state}</p>
            </Card>
            <Card title={t('dash.perf.reach')}>
              <Alert tone="info">{data.platformMetrics.note}</Alert>
            </Card>
          </div>
        </>
      ) : null}

      <Modal
        open={formOpen}
        title={t('trk.newLink')}
        onClose={() => setFormOpen(false)}
        footer={
          <div className="row-actions">
            <Button loading={busy === 'create'} onClick={() => void create()}>
              {t('trk.create')}
            </Button>
            <Button variant="ghost" onClick={() => setFormOpen(false)}>
              {t('common.cancel')}
            </Button>
          </div>
        }
      >
        <div className="form-grid">
          <Field label={t('trk.label')}>
            <Input
              value={form.label}
              onChange={(event) => setForm({ ...form, label: event.target.value })}
              maxLength={160}
            />
          </Field>
          <Field label={t('trk.destination')} hint="https://example.com/offer">
            <Input
              dir="ltr"
              value={form.destinationUrl}
              onChange={(event) => setForm({ ...form, destinationUrl: event.target.value })}
              placeholder="https://example.com/offer"
            />
          </Field>
          <Field label={t('trk.platform')}>
            <Select
              value={form.platform}
              onChange={(event) => setForm({ ...form, platform: event.target.value })}
            >
              <option value="">—</option>
              {PLATFORM_OPTIONS.map((platform) => (
                <option key={platform} value={platform}>
                  {platform}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('trk.source')}>
            <Input
              dir="ltr"
              value={form.utmSource}
              onChange={(event) => setForm({ ...form, utmSource: event.target.value })}
            />
          </Field>
          <Field label={t('trk.medium')}>
            <Input
              dir="ltr"
              value={form.utmMedium}
              onChange={(event) => setForm({ ...form, utmMedium: event.target.value })}
            />
          </Field>
          <Field label={t('trk.campaign')}>
            <Input
              dir="ltr"
              value={form.utmCampaign}
              onChange={(event) => setForm({ ...form, utmCampaign: event.target.value })}
            />
          </Field>
          <Field label={t('trk.content')}>
            <Input
              dir="ltr"
              value={form.utmContent}
              onChange={(event) => setForm({ ...form, utmContent: event.target.value })}
            />
          </Field>
          <Field label={t('trk.term')}>
            <Input
              dir="ltr"
              value={form.utmTerm}
              onChange={(event) => setForm({ ...form, utmTerm: event.target.value })}
            />
          </Field>
        </div>
        <p className="muted small">{t('trk.privacy')}</p>
      </Modal>

      <Modal
        open={Boolean(eventsFor)}
        title={`${t('trk.events')} · ${eventsFor?.label ?? ''}`}
        onClose={() => setEventsFor(null)}
        wide
      >
        {events === null ? (
          <Loading />
        ) : events.length === 0 ? (
          <EmptyState>{t('trk.noEvents')}</EmptyState>
        ) : (
          <Table head={[t('common.status'), t('dash.perf.source'), t('common.date')]}>
            {events.map((event) => (
              <tr key={event.id}>
                <td>{event.kind}</td>
                <td>
                  {[event.platform, event.device, event.country].filter(Boolean).join(' · ') || '—'}
                </td>
                <td>{formatDateTime(event.occurredAt, locale)}</td>
              </tr>
            ))}
          </Table>
        )}
        <p className="muted small">{t('trk.privacy')}</p>
      </Modal>

      <Modal
        open={Boolean(snippetFor)}
        title={t('trk.snippet')}
        onClose={() => setSnippetFor(null)}
      >
        <p className="muted small">{t('trk.snippetHint')}</p>
        {snippetFor ? (
          <pre className="code-block" dir="ltr">
{`<script>
fetch('${window.location.origin}/api/tracking/events', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code: '${snippetFor.code}', kind: 'page_view', path: location.pathname })
});
</script>`}
          </pre>
        ) : null}
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------------------
// Dashboard performance panel
// ---------------------------------------------------------------------------

type Metric = { value: string | number | null; available: boolean; source?: string; note?: string };

function MetricRow({ label, metric, t }: { label: string; metric: Metric; t: (key: string, fallback?: string) => string }) {
  return (
    <div className="metric-row">
      <span className="muted small">{label}</span>
      <strong>
        {metric.available
          ? typeof metric.value === 'number'
            ? new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(metric.value)
            : String(metric.value ?? '—')
          : t('dash.perf.unavailable')}
      </strong>
      <span className="muted small" dir="ltr">
        {metric.source ?? ''}
        {!metric.available && metric.note ? ` · ${metric.note}` : ''}
      </span>
    </div>
  );
}

export function PerformancePanel({ companyId }: { companyId: string }) {
  const { t } = useSession();
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api<any>(`/api/company/${companyId}/dashboard`)
      .then((result) => {
        if (live) setData(result);
      })
      .catch((failure) => {
        if (live) setError(t(errorKey((failure as ApiError)?.code)));
      });
    return () => {
      live = false;
    };
  }, [companyId, t]);

  if (error) return <Alert tone="warn">{error}</Alert>;
  if (!data) return <Loading />;

  const post = (key: string) => data.posts[key] as Metric;
  const track = (key: string) => data.tracking[key] as Metric;

  return (
    <div className="social-stack">
      <Card title={t('dash.perf.title')} subtitle={t('dash.perf.subtitle')}>
        <div className="metrics-grid">
          <MetricRow label={t('dash.perf.accounts')} metric={{ value: data.accounts.connected, available: true, source: 'social_connections' }} t={t} />
          <MetricRow label={t('dash.perf.published')} metric={post('published')} t={t} />
          <MetricRow label={t('dash.perf.scheduled')} metric={post('scheduled')} t={t} />
          <MetricRow label={t('dash.perf.failed')} metric={post('failed')} t={t} />
        </div>
      </Card>

      <div className="grid-2">
        <Card title={t('dash.perf.tracking')}>
          <div className="metrics-grid">
            <MetricRow label={t('trk.clicks')} metric={track('clicks')} t={t} />
            <MetricRow label={t('trk.visitors')} metric={track('uniqueVisitors')} t={t} />
            <MetricRow label={t('trk.pageViews')} metric={track('pageViews')} t={t} />
            <MetricRow label={t('trk.whatsapp')} metric={track('whatsappClicks')} t={t} />
            <MetricRow label={t('trk.calls')} metric={track('callClicks')} t={t} />
            <MetricRow label={t('trk.forms')} metric={track('formSubmits')} t={t} />
          </div>
        </Card>
        <Card title={t('dash.perf.leads')}>
          <div className="metrics-grid">
            <MetricRow label={t('dash.perf.leads')} metric={data.leads.total} t={t} />
            <MetricRow label={t('trk.leadAttribution')} metric={data.leads.attributed} t={t} />
            <MetricRow label={t('dash.meetings', 'Meetings')} metric={data.leads.meetings} t={t} />
            <MetricRow label={t('dash.won', 'Won')} metric={data.leads.won} t={t} />
          </div>
        </Card>
      </div>

      <div className="grid-2">
        <Card title={t('dash.perf.reach')}>
          <div className="metrics-grid">
            <MetricRow label="Impressions" metric={data.reach.impressions} t={t} />
            <MetricRow label="Reach" metric={data.reach.reach} t={t} />
            <MetricRow label="Engagement" metric={data.reach.engagement} t={t} />
          </div>
        </Card>
        <Card title={t('dash.perf.revenue')}>
          <div className="metrics-grid">
            <MetricRow label={t('dash.perf.revenue')} metric={data.revenue.booked} t={t} />
            <MetricRow label={t('dash.perf.cpl')} metric={data.revenue.cpl} t={t} />
            <MetricRow label={t('dash.perf.roi')} metric={data.revenue.roi} t={t} />
          </div>
        </Card>
      </div>

      <div className="grid-2">
        <Card title={t('dash.perf.highlights')}>
          <div className="metrics-grid">
            <MetricRow label={t('dash.perf.bestPlatform')} metric={data.highlights.bestPlatform} t={t} />
            <MetricRow label={t('dash.perf.bestCampaign')} metric={data.highlights.bestCampaign} t={t} />
            <MetricRow label={t('dash.perf.bestPost')} metric={data.highlights.bestPost} t={t} />
            <MetricRow label={t('dash.perf.bestAudience')} metric={data.highlights.bestAudience} t={t} />
          </div>
        </Card>
        <Card title={t('dash.perf.demographics')}>
          <Alert tone="info">{data.demographics.note}</Alert>
        </Card>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Paid advertising — an explicit placeholder, no working controls
// ---------------------------------------------------------------------------

export function CompanyPaidAdsPage() {
  const { companyId } = useParams();
  const { t } = useSession();
  return (
    <>
      <PageHeader title={t('paid.title')} subtitle={t('paid.state')} />
      <Card title={t('paid.title')}>
        <p>{t('paid.body')}</p>
        <Link className="btn btn-secondary" to={`/app/${companyId}`}>
          {t('paid.back')}
        </Link>
      </Card>
    </>
  );
}
