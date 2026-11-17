/**
 * Social accounts and the post library.
 *
 * The screen never decides what a platform can do: availability, capabilities,
 * adapted text and blocking issues all come from the API, which derives them
 * from the provider documentation and the deployment's real credentials.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
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
  StatusBadge,
  Table,
  Tabs,
  Textarea,
  cx,
} from '../components/ui';

type PlatformInfo = {
  key: string;
  name: { ar: string; en: string };
  category: string;
  connector: string;
  accountRequirement: { ar: string; en: string };
  capabilities: Record<string, boolean>;
  access: { reviewRequired: boolean; reviewNote: { ar: string; en: string }; scopes: string[] };
  limits: { textMax: number; requiresMedia: boolean; hashtagsMax: number | null };
  publishable: boolean;
  oauthImplemented: boolean;
  /** What this build actually does with the channel. */
  state: string;
  capabilityStates: Record<string, string>;
  availability: 'available' | 'requires_credentials' | 'pending_review' | 'not_supported';
  availabilityReasons: string[];
  accessApproved: boolean;
  reviewPending: boolean;
  connections: Connection[];
};

type Connection = {
  id: string;
  platform: string;
  accountId: string;
  pageId: string | null;
  profileId: string | null;
  accountName: string;
  accountType: string | null;
  tokenStatus: 'connected' | 'expiring' | 'expired' | 'requires_reconnect';
  scopes: string[];
  grantedScopes: string[];
  connectedAt: string;
  expiresAt: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
};

type Overview = {
  platforms: PlatformInfo[];
  connections: Connection[];
  setup: {
    tokenKeyConfigured: boolean;
    meta: { configured: boolean; requires: string[] };
    google: { configured: boolean; requires: string[] };
    email: { configured: boolean; requires: string[] };
    scheduler: { state: string; execution: string; automatic: boolean };
  };
  analytics: { state: string; note: string };
  subscription: { status: string; isActive: boolean; daysLeft: number | null };
  stats: {
    connections: number;
    needsReconnect: number;
    posts: { total: number; drafts: number; awaiting: number; scheduled: number; published: number; failed: number };
    jobs: { pending: number; failed: number };
  };
  canManage: boolean;
  canApprove: boolean;
  canCreate: boolean;
};

type Target = {
  id: string;
  platform: string;
  connectionId: string | null;
  accountName: string | null;
  status: string;
  text: string;
  issues: Array<{ code: string; detail?: string }>;
  notes: string[];
  externalId: string | null;
  externalUrl: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  attempts: number;
  publishedAt: string | null;
};

type PostRow = {
  id: string;
  title: string | null;
  bodyAr: string | null;
  bodyEn: string | null;
  linkUrl: string | null;
  ctaLabel: string | null;
  hashtags: string | null;
  media: Array<{ url: string; kind: 'image' | 'video' }>;
  language: 'ar' | 'en' | 'both';
  status: string;
  version: number;
  scheduledAt: string | null;
  approvedAt: string | null;
  submittedAt: string | null;
  reviewNote: string | null;
  reviewedAt: string | null;
  publishedAt: string | null;
  createdAt: string;
  targets: Target[];
};

type Preview = {
  platform: string;
  spec: { name: { ar: string; en: string }; limits: any; capabilities: any; reviewNote: { ar: string; en: string } };
  status: 'ready' | 'blocked';
  text: string;
  issues: Array<{ code: string; detail?: string }>;
  notes: string[];
};

type Job = {
  id: string;
  platform: string;
  accountName: string | null;
  postTitle: string | null;
  state: string;
  runAt: string;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
};

type EventRow = {
  id: string;
  kind: string;
  detail: string | null;
  createdAt: string;
};

const platformName = (platforms: PlatformInfo[], key: string, locale: 'ar' | 'en') =>
  platforms.find((item) => item.key === key)?.name[locale] ?? key;

const toLocalInput = (iso: string | null) => {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

export function CompanySocialPage() {
  const { companyId } = useParams();
  const { t, locale } = useSession();
  // Deep links from the workspace cards: ?tab=library / ?tab=posters.
  const [tab, setTab] = useState(() => {
    const wanted = new URLSearchParams(window.location.search).get('tab');
    return wanted && ['accounts', 'library', 'queue', 'posters'].includes(wanted) ? wanted : 'accounts';
  });
  const [overview, setOverview] = useState<Overview | null>(null);
  const [posts, setPosts] = useState<PostRow[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'warn' | 'danger' | 'info'; text: string } | null>(null);
  const [composer, setComposer] = useState<{ open: boolean; post: PostRow | null }>({ open: false, post: null });
  const [detail, setDetail] = useState<PostRow | null>(null);
  const [pending, setPending] = useState<{ state: string; platform: string; accounts: any[]; chosen: string[] } | null>(null);

  const base = companyId ? `/api/company/${companyId}/social` : null;

  const load = useCallback(async () => {
    if (!base) return;
    try {
      const [data, library, queue] = await Promise.all([
        api<Overview>(base),
        api<{ posts: PostRow[] }>(`${base}/posts`),
        api<{ jobs: Job[] }>(`${base}/jobs`),
      ]);
      setOverview(data);
      setPosts(library.posts);
      setJobs(queue.jobs);
      const activity = await api<{ events: EventRow[] }>(`${base}/events`);
      setEvents(activity.events);
    } catch (error) {
      setNotice({ tone: 'danger', text: t(errorKey((error as ApiError)?.code)) });
    } finally {
      setLoading(false);
    }
  }, [base, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // Returning from an OAuth redirect: show the account picker, nothing is
  // stored until the client chooses.
  useEffect(() => {
    if (!base) return;
    const params = new URLSearchParams(window.location.search);
    const oauth = params.get('oauth');
    const state = params.get('state');
    if (!oauth) return;
    if (oauth === 'select' && state) {
      api<{ platform: string; accounts: any[] }>(`${base}/oauth/pending?state=${encodeURIComponent(state)}`)
        .then((data) =>
          setPending({ state, platform: data.platform, accounts: data.accounts, chosen: data.accounts.map((a) => a.accountId) })
        )
        .catch((error) => setNotice({ tone: 'danger', text: t(errorKey((error as ApiError)?.code)) }));
    } else if (oauth === 'denied') {
      setNotice({ tone: 'warn', text: t('social.oauthDenied') });
    } else {
      setNotice({ tone: 'danger', text: `${t('social.oauthFailed')}${t(errorKey(`oauth_state_${oauth}`))}` });
    }
    window.history.replaceState({}, '', window.location.pathname);
  }, [base, t]);

  const platforms = overview?.platforms ?? [];

  const startOauth = async (platform: string) => {
    if (!base) return;
    setBusy(platform);
    setNotice(null);
    try {
      const data = await api<{ authorizeUrl: string }>(`${base}/oauth/start`, {
        method: 'POST',
        body: { platform },
      });
      window.location.assign(data.authorizeUrl);
    } catch (error) {
      setNotice({ tone: 'danger', text: t(errorKey((error as ApiError)?.code)) });
      setBusy(null);
    }
  };

  const completeOauth = async () => {
    if (!base || !pending) return;
    setBusy('complete');
    try {
      await api(`${base}/oauth/complete`, {
        method: 'POST',
        body: { state: pending.state, accountIds: pending.chosen },
      });
      setPending(null);
      setNotice({ tone: 'ok', text: t('social.saved') });
      await load();
    } catch (error) {
      setNotice({ tone: 'danger', text: t(errorKey((error as ApiError)?.code)) });
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async (connection: Connection) => {
    if (!base) return;
    if (!window.confirm(t('social.confirmDisconnect'))) return;
    setBusy(connection.id);
    try {
      await api(`${base}/connections/${connection.id}`, { method: 'DELETE' });
      await load();
    } catch (error) {
      setNotice({ tone: 'danger', text: t(errorKey((error as ApiError)?.code)) });
    } finally {
      setBusy(null);
    }
  };

  const verify = async (connection: Connection) => {
    if (!base) return;
    setBusy(connection.id);
    try {
      await api(`${base}/connections/${connection.id}/verify`, { method: 'POST' });
      setNotice({ tone: 'ok', text: t('social.saved') });
      await load();
    } catch (error) {
      setNotice({ tone: 'danger', text: t(errorKey((error as ApiError)?.code)) });
      await load();
    } finally {
      setBusy(null);
    }
  };

  const runDue = async () => {
    if (!base) return;
    setBusy('jobs');
    try {
      const result = await api<{ ran: number }>(`${base}/jobs/run`, { method: 'POST' });
      setNotice({ tone: 'ok', text: t('social.runResult').replace('{ran}', String(result.ran)) });
      await load();
    } catch (error) {
      setNotice({ tone: 'danger', text: t(errorKey((error as ApiError)?.code)) });
    } finally {
      setBusy(null);
    }
  };

  const postAction = async (post: PostRow, action: string, body?: unknown) => {
    if (!base) return;
    setBusy(`${post.id}:${action}`);
    try {
      const result = await api<{ post: PostRow }>(`${base}/posts/${post.id}/${action}`, {
        method: 'POST',
        body: body ?? {},
      });
      setPosts((current) => current.map((item) => (item.id === result.post.id ? result.post : item)));
      if (detail?.id === result.post.id) setDetail(result.post);
      await load();
      return result.post;
    } catch (error) {
      const apiError = error as ApiError;
      setNotice({
        tone: 'danger',
        text:
          apiError.code === 'targets_blocked'
            ? t('err.targets_blocked')
            : t(errorKey(apiError.code)),
      });
    } finally {
      setBusy(null);
    }
  };

  if (loading) return <Loading />;
  if (!overview) return <Alert tone="danger">{t('common.error')}</Alert>;

  const tabs = [
    { id: 'accounts', label: t('social.tab.accounts') },
    { id: 'library', label: t('social.tab.library') },
    { id: 'queue', label: t('social.tab.queue') },
    { id: 'posters', label: t('social.tab.posters') },
  ];

  return (
    <>
      <PageHeader
        title={t('social.title')}
        subtitle={t('social.subtitle')}
        actions={
          overview.canCreate ? (
            <Button onClick={() => setComposer({ open: true, post: null })}>{t('social.newPost')}</Button>
          ) : undefined
        }
      />

      {notice ? (
        <Alert tone={notice.tone} onClose={() => setNotice(null)}>
          {notice.text}
        </Alert>
      ) : null}

      <div className="social-stats">
        <Stat label={t('social.stat.connections')} value={String(overview.stats.connections)} />
        <Stat
          label={t('social.state.requires_reconnect')}
          value={String(overview.stats.needsReconnect)}
          tone={overview.stats.needsReconnect ? 'warn' : 'default'}
        />
        <Stat label={t('social.status.scheduled')} value={String(overview.stats.posts.scheduled)} />
        <Stat label={t('social.status.published')} value={String(overview.stats.posts.published)} />
        <Stat
          label={t('social.status.failed')}
          value={String(overview.stats.posts.failed)}
          tone={overview.stats.posts.failed ? 'danger' : 'default'}
        />
      </div>

      <Tabs tabs={tabs} active={tab} onChange={setTab} />

      {tab === 'accounts' ? (
        <AccountsTab
          overview={overview}
          locale={locale}
          t={t}
          busy={busy}
          onConnect={startOauth}
          onDisconnect={disconnect}
          onVerify={verify}
        />
      ) : null}

      {tab === 'library' ? (
        <LibraryTab
          posts={posts}
          platforms={platforms}
          locale={locale}
          t={t}
          busy={busy}
          canApprove={overview.canApprove}
          canCreate={overview.canCreate}
          onEdit={(post) => setComposer({ open: true, post })}
          onDetails={setDetail}
          onAction={postAction}
          onNew={() => setComposer({ open: true, post: null })}
        />
      ) : null}

      {tab === 'posters' && base ? (
        <PostersTab
          base={base}
          t={t}
          canCreate={overview.canCreate}
          canApprove={overview.canApprove}
          onNotice={setNotice}
        />
      ) : null}

      {tab === 'queue' ? (
        <QueueTab
          jobs={jobs}
          events={events}
          locale={locale}
          t={t}
          scheduler={overview.setup.scheduler}
          busy={busy}
          onRun={runDue}
        />
      ) : null}

      {composer.open ? (
        <Composer
          base={base!}
          post={composer.post}
          platforms={platforms}
          t={t}
          locale={locale}
          onClose={() => setComposer({ open: false, post: null })}
          onSaved={async () => {
            setComposer({ open: false, post: null });
            setNotice({ tone: 'ok', text: t('social.saved') });
            await load();
          }}
          onError={(text) => setNotice({ tone: 'danger', text })}
        />
      ) : null}

      <Modal
        open={Boolean(detail)}
        title={t('social.details')}
        onClose={() => setDetail(null)}
        wide
        footer={
          detail ? (
            <div className="row-actions">
              {detail.status === 'awaiting_approval' && overview.canApprove ? (
                <>
                  <Button
                    onClick={async () => {
                      await postAction(detail, 'approve');
                    }}
                  >
                    {t('social.approve')}
                  </Button>
                  <Button
                    variant="secondary"
                    loading={busy === `${detail.id}:request-changes`}
                    onClick={async () => {
                      const reason = window.prompt(t('social.reasonPrompt'));
                      if (!reason) return;
                      await postAction(detail, 'request-changes', { reason });
                    }}
                  >
                    {t('social.requestChanges')}
                  </Button>
                  <Button
                    variant="danger"
                    loading={busy === `${detail.id}:reject`}
                    onClick={async () => {
                      const reason = window.prompt(t('social.reasonPrompt'));
                      if (!reason) return;
                      await postAction(detail, 'reject', { reason });
                    }}
                  >
                    {t('social.reject')}
                  </Button>
                </>
              ) : null}
              {detail.approvedAt ? (
                <Button
                  variant="secondary"
                  loading={busy === `${detail.id}:publish`}
                  onClick={async () => {
                    await postAction(detail, 'publish');
                  }}
                >
                  {t('social.publishNow')}
                </Button>
              ) : null}
              <Button variant="ghost" onClick={() => setDetail(null)}>
                {t('common.close')}
              </Button>
            </div>
          ) : undefined
        }
      >
        {detail ? (
          <>
            <PostDetail post={detail} locale={locale} t={t} platforms={platforms} />
            {detail.version > 1 && base ? (
              <VersionHistory
                base={base}
                post={detail}
                locale={locale}
                t={t}
                canCreate={overview.canCreate}
                onRestored={async () => {
                  setDetail(null);
                  setNotice({ tone: 'ok', text: t('social.restored') });
                  await load();
                }}
              />
            ) : null}
          </>
        ) : null}
      </Modal>

      <Modal
        open={Boolean(pending)}
        title={t('social.chooseAccounts')}
        onClose={() => setPending(null)}
        footer={
          <div className="row-actions">
            <Button loading={busy === 'complete'} onClick={completeOauth}>
              {t('social.completeConnect')}
            </Button>
            <Button variant="ghost" onClick={() => setPending(null)}>
              {t('common.cancel')}
            </Button>
          </div>
        }
      >
        {pending ? (
          <div className="social-pending">
            <p className="muted small">{t('social.chooseAccountsHint')}</p>
            {pending.accounts.map((account) => (
              <label key={account.accountId} className="social-choice">
                <input
                  type="checkbox"
                  checked={pending.chosen.includes(account.accountId)}
                  onChange={(event) =>
                    setPending({
                      ...pending,
                      chosen: event.target.checked
                        ? [...pending.chosen, account.accountId]
                        : pending.chosen.filter((id) => id !== account.accountId),
                    })
                  }
                />
                <span>
                  <strong>{account.accountName}</strong>
                  <span className="muted small" dir="ltr">
                    {account.accountType}
                    {account.pageId ? ` · page ${account.pageId}` : ''}
                  </span>
                </span>
              </label>
            ))}
          </div>
        ) : null}
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

function AccountsTab({
  overview,
  locale,
  t,
  busy,
  onConnect,
  onDisconnect,
  onVerify,
}: {
  overview: Overview;
  locale: 'ar' | 'en';
  t: (key: string, fallback?: string) => string;
  busy: string | null;
  onConnect: (platform: string) => void;
  onDisconnect: (connection: Connection) => void;
  onVerify: (connection: Connection) => void;
}) {
  const capabilityRows: Array<[string, string]> = [
    ['publishText', 'social.cap.publishText'],
    ['publishImage', 'social.cap.publishImage'],
    ['publishVideo', 'social.cap.publishVideo'],
    ['nativeScheduling', 'social.cap.nativeScheduling'],
    ['readComments', 'social.cap.readComments'],
    ['readAnalytics', 'social.cap.readAnalytics'],
    ['ads', 'social.cap.ads'],
  ];

  // Phase 0: Google Analytics, Search Console and Tag Manager are not part of
  // the product surface. Their tables and connections are kept, but they are
  // not offered here as features.
  const visiblePlatforms = overview.platforms.filter((platform) => platform.category === 'social');
  const hiddenGoogle = overview.platforms.filter((platform) =>
    ['ga4', 'search_console', 'google_tag_manager'].includes(platform.key)
  );

  const setupRow = (label: string, ready: boolean, requires: string[]) => (
    <li key={label} className="social-setup-row">
      <span>{label}</span>
      <span className={cx('badge', ready ? 'badge-ok' : 'badge-warn')}>
        {ready ? t('social.setupReady') : t('social.setupMissing')}
      </span>
      {!ready && requires.length ? (
        <code className="social-requires" dir="ltr">
          {requires.join(' · ')}
        </code>
      ) : null}
    </li>
  );

  return (
    <div className="social-stack">
      <Card title={t('social.setupTitle')} subtitle={t('social.setupHint')}>
        <ul className="social-setup">
          {setupRow(t('social.setupTokenKey'), overview.setup.tokenKeyConfigured, ['SOCIAL_TOKEN_KEY'])}
          {setupRow(t('social.setupMeta'), overview.setup.meta.configured, overview.setup.meta.requires)}
          {setupRow(t('social.setupGoogle'), overview.setup.google.configured, overview.setup.google.requires)}
          {setupRow(t('social.setupEmail'), overview.setup.email.configured, overview.setup.email.requires)}
          {setupRow(t('social.setupScheduler'), overview.setup.scheduler.state === 'configured', [
            'JOBS_SECRET',
          ])}
        </ul>
        {overview.setup.scheduler.state !== 'configured' ? (
          <Alert tone="warn">{t('social.setupSchedulerOff')}</Alert>
        ) : (
          <p className="muted small">{t('social.schedulerManualOnly')}</p>
        )}
        {!overview.subscription.isActive ? (
          <Alert tone="danger">{t('social.subscriptionBlocked')}</Alert>
        ) : null}
      </Card>

      {hiddenGoogle.length ? (
        <Card title={t('social.googleHiddenTitle')}>
          <p className="muted small">{t('social.googleHiddenNote')}</p>
          <ul className="social-setup">
            {hiddenGoogle.map((platform) => (
              <li key={platform.key} className="social-setup-row">
                <span>{platform.name[locale]}</span>
                <span className="badge badge-muted">{t(`social.state.${platform.state}`, platform.state)}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {visiblePlatforms.map((platform) => (
        <Card
          key={platform.key}
          title={
            <span className="social-platform-head">
              {platform.name[locale]}
              <span className={cx('badge', `badge-${stateTone(platform.state)}`)}>
                {t(`social.state.${platform.state}`, platform.state)}
              </span>
              {platform.availability === 'requires_credentials' ? (
                <span className="badge badge-warn">{t('social.state.requires_credentials')}</span>
              ) : null}
            </span>
          }
          subtitle={platform.accountRequirement[locale]}
        >
          <div className="social-capabilities">
            {capabilityRows.map(([key, label]) => {
              const state = platform.capabilityStates?.[key] ?? 'not_supported';
              return (
                <span
                  key={key}
                  className={cx('social-cap', state === 'working_test' ? 'is-yes' : 'is-no')}
                  title={t(`social.state.${state}`, state)}
                >
                  {t(label)}: {t(`social.state.${state}`, state)}
                </span>
              );
            })}
          </div>

          {platform.access.reviewRequired ? (
            <p className="social-review-note">
              <strong>{t('social.reviewNeeded')}: </strong>
              {platform.access.reviewNote[locale]}
            </p>
          ) : null}

          {platform.availability !== 'available' ? (
            <Alert tone={platform.availability === 'requires_credentials' ? 'warn' : 'info'}>
              <div>{t(`social.reason.${platform.availabilityReasons[0] ?? 'unavailable'}`, t('social.reason.unavailable'))}</div>
              {platform.availabilityReasons.some((reason) => reason.includes('_')) &&
              platform.availabilityReasons.some((reason) => /^[A-Z_]+$/.test(reason)) ? (
                <code className="social-requires" dir="ltr">
                  {platform.availabilityReasons.filter((reason) => /^[A-Z_]+$/.test(reason)).join(' · ')}
                </code>
              ) : null}
            </Alert>
          ) : null}

          <div className="social-connection-list">
            {platform.connections.length ? (
              platform.connections.map((connection) => (
                <div key={connection.id} className="social-connection">
                  <div className="social-connection-main">
                    <strong>{connection.accountName}</strong>
                    <span className="muted small" dir="ltr">
                      {connection.accountId}
                      {connection.pageId ? ` · page ${connection.pageId}` : ''}
                    </span>
                    <span className={cx('badge', `badge-${tokenTone(connection.tokenStatus)}`)}>
                      {t(`social.state.${connection.tokenStatus}`)}
                    </span>
                  </div>
                  <dl className="social-meta">
                    <div>
                      <dt>{t('social.expires')}</dt>
                      <dd>{connection.expiresAt ? formatDateTime(connection.expiresAt, locale) : t('social.noExpiry')}</dd>
                    </div>
                    <div>
                      <dt>{t('social.connectedAt')}</dt>
                      <dd>{formatDateTime(connection.connectedAt, locale)}</dd>
                    </div>
                    <div>
                      <dt>{t('social.lastSync')}</dt>
                      <dd>{connection.lastSyncAt ? formatDateTime(connection.lastSyncAt, locale) : '—'}</dd>
                    </div>
                    <div>
                      <dt>{t('social.grantedScopes')}</dt>
                      <dd dir="ltr">
                        {connection.grantedScopes.length
                          ? connection.grantedScopes.join(', ')
                          : connection.scopes.join(', ') || '—'}
                      </dd>
                    </div>
                  </dl>
                  {connection.lastError ? (
                    <p className="social-error" dir="ltr">
                      {connection.lastError}
                    </p>
                  ) : null}
                  <div className="row-actions">
                    {overview.canManage ? (
                      <>
                        <Button
                          size="sm"
                          variant="secondary"
                          loading={busy === connection.id}
                          onClick={() => onVerify(connection)}
                        >
                          {t('social.verify')}
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          loading={busy === platform.key}
                          onClick={() => onConnect(platform.key)}
                        >
                          {t('social.reconnect')}
                        </Button>
                        <Button size="sm" variant="danger" onClick={() => onDisconnect(connection)}>
                          {t('social.disconnect')}
                        </Button>
                      </>
                    ) : null}
                  </div>
                </div>
              ))
            ) : (
              <EmptyState>{t('social.noConnections')}</EmptyState>
            )}
          </div>

          {overview.canManage && platform.oauthImplemented ? (
            <div className="row-actions">
              <Button
                loading={busy === platform.key}
                disabled={platform.availability === 'requires_credentials' || platform.availability === 'not_supported'}
                onClick={() => onConnect(platform.key)}
              >
                {t('social.connect')}
              </Button>
              <span className="muted small" dir="ltr">
                {platform.access.scopes.join(' · ')}
              </span>
            </div>
          ) : null}
        </Card>
      ))}
    </div>
  );
}

/** Tones for the states this build may claim. `live_verified` is never set
 * by the build itself; it exists so a verified run has a label. */
const stateTone = (state: string) =>
  state === 'working_test' || state === 'live_verified'
    ? 'ok'
    : state === 'requires_credentials' || state === 'requires_app_review'
      ? 'warn'
      : state === 'not_implemented' || state === 'blocked_by_hosting'
        ? 'info'
        : 'muted';

const tokenTone = (state: string) =>
  state === 'connected' ? 'ok' : state === 'expiring' ? 'warn' : 'danger';

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

function LibraryTab({
  posts,
  platforms,
  locale,
  t,
  busy,
  canApprove,
  canCreate,
  onEdit,
  onDetails,
  onAction,
  onNew,
}: {
  posts: PostRow[];
  platforms: PlatformInfo[];
  locale: 'ar' | 'en';
  t: (key: string, fallback?: string) => string;
  busy: string | null;
  canApprove: boolean;
  canCreate: boolean;
  onEdit: (post: PostRow) => void;
  onDetails: (post: PostRow) => void;
  onAction: (post: PostRow, action: string, body?: unknown) => Promise<PostRow | undefined>;
  onNew: () => void;
}) {
  return (
    <Card title={t('social.libraryTitle')} subtitle={t('social.libraryHint')}>
      {posts.length === 0 ? (
        <EmptyState>{t('social.noPosts')}</EmptyState>
      ) : (
        <Table
          head={[
            t('social.postTitle'),
            t('social.targets'),
            t('common.status'),
            t('social.scheduledAt'),
            t('common.actions'),
          ]}
        >
          {posts.map((post) => (
            <tr key={post.id}>
              <td>
                <strong>{post.title || (post.bodyAr || post.bodyEn || '').slice(0, 40)}</strong>
                <div className="muted small">
                  v{post.version} · {formatDateTime(post.createdAt, locale)}
                </div>
              </td>
              <td>
                <div className="social-chip-list">
                  {post.targets.map((target) => (
                    <span
                      key={target.id}
                      className={cx('social-chip', `is-${target.status}`)}
                      title={target.errorCode ?? ''}
                    >
                      {platformName(platforms, target.platform, locale)}
                    </span>
                  ))}
                </div>
              </td>
              <td>
                <StatusBadge status={post.status} label={t(`social.status.${post.status}`)} />
              </td>
              <td>{post.scheduledAt ? formatDateTime(post.scheduledAt, locale) : '—'}</td>
              <td>
                <div className="row-actions">
                  <Button size="sm" variant="ghost" onClick={() => onDetails(post)}>
                    {t('social.details')}
                  </Button>
                  {canCreate && !['published', 'partially_published'].includes(post.status) ? (
                    <Button size="sm" variant="ghost" onClick={() => onEdit(post)}>
                      {t('social.edit')}
                    </Button>
                  ) : null}
                  {canCreate && ['draft', 'awaiting_approval', 'approved'].includes(post.status) ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={busy === `${post.id}:submit`}
                      onClick={() => void onAction(post, 'submit')}
                    >
                      {t('social.submitApproval')}
                    </Button>
                  ) : null}
                  {canApprove && post.status === 'awaiting_approval' ? (
                    <Button
                      size="sm"
                      loading={busy === `${post.id}:approve`}
                      onClick={() => void onAction(post, 'approve')}
                    >
                      {t('social.approve')}
                    </Button>
                  ) : null}
                  {canApprove && post.approvedAt && !['published', 'cancelled', 'archived'].includes(post.status) ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={busy === `${post.id}:publish`}
                      onClick={() => void onAction(post, 'publish')}
                    >
                      {t('social.publishNow')}
                    </Button>
                  ) : null}
                  {canCreate ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={busy === `${post.id}:duplicate`}
                      onClick={() => void onAction(post, 'duplicate')}
                    >
                      {t('social.duplicate')}
                    </Button>
                  ) : null}
                  {canApprove && !['published', 'cancelled', 'archived'].includes(post.status) ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={busy === `${post.id}:cancel`}
                      onClick={() => void onAction(post, 'cancel')}
                    >
                      {t('social.cancelPost')}
                    </Button>
                  ) : null}
                </div>
              </td>
            </tr>
          ))}
        </Table>
      )}
      {posts.length === 0 && canCreate ? (
        <div className="row-actions">
          <Button onClick={onNew}>{t('social.newPost')}</Button>
        </div>
      ) : null}
    </Card>
  );
}

function PostDetail({
  post,
  locale,
  t,
  platforms,
}: {
  post: PostRow;
  locale: 'ar' | 'en';
  t: (key: string, fallback?: string) => string;
  platforms: PlatformInfo[];
}) {
  return (
    <div className="social-stack">
      <div className="social-detail-head">
        <StatusBadge status={post.status} label={t(`social.status.${post.status}`)} />
        <span className="muted small">
          v{post.version} · {formatDateTime(post.createdAt, locale)}
        </span>
        {post.publishedAt ? (
          <span className="muted small">
            {t('social.status.published')}: {formatDateTime(post.publishedAt, locale)}
          </span>
        ) : null}
      </div>

      {post.reviewNote ? (
        <Alert tone={post.status === 'rejected' ? 'danger' : 'warn'}>
          <strong>
            {post.status === 'rejected' ? t('social.reject') : t('social.requestChanges')}:{' '}
          </strong>
          {post.reviewNote}
          {post.reviewedAt ? (
            <span className="muted small"> · {formatDateTime(post.reviewedAt, locale)}</span>
          ) : null}
        </Alert>
      ) : null}

      <div className="social-post-body">
        {post.bodyAr ? <p dir="rtl">{post.bodyAr}</p> : null}
        {post.bodyEn ? <p dir="ltr">{post.bodyEn}</p> : null}
        {post.linkUrl ? (
          <p className="muted small" dir="ltr">
            {post.linkUrl}
          </p>
        ) : null}
      </div>

      {post.targets.map((target) => (
        <div key={target.id} className="social-target">
          <div className="social-target-head">
            <strong>{platformName(platforms, target.platform, locale)}</strong>
            <span className="muted small">{target.accountName}</span>
            <StatusBadge status={target.status} label={t(`social.status.${target.status}`)} />
          </div>
          <p className="social-target-text" dir="auto">
            {target.text}
          </p>
          {target.issues.length ? (
            <div className="social-issues">
              <strong>{t('social.issues')}</strong>
              <ul>
                {target.issues.map((issue) => (
                  <li key={issue.code}>
                    {t(`social.issue.${issue.code}`, issue.code)}
                    {issue.detail ? ` (${issue.detail})` : ''}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {target.notes.length ? (
            <ul className="social-notes">
              {target.notes.map((note) => (
                <li key={note}>{t(`social.note.${note.replace(/_\d+$/, '_trimmed')}`, note)}</li>
              ))}
            </ul>
          ) : null}
          {target.errorCode ? (
            <p className="social-error" dir="ltr">
              {t('social.error')}: {target.errorCode}
              {target.errorMessage ? ` — ${target.errorMessage}` : ''}
            </p>
          ) : null}
          {target.externalUrl ? (
            <a href={target.externalUrl} target="_blank" rel="noreferrer" dir="ltr">
              {target.externalUrl}
            </a>
          ) : null}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

function Composer({
  base,
  post,
  platforms,
  t,
  locale,
  onClose,
  onSaved,
  onError,
}: {
  base: string;
  post: PostRow | null;
  platforms: PlatformInfo[];
  t: (key: string, fallback?: string) => string;
  locale: 'ar' | 'en';
  onClose: () => void;
  onSaved: () => Promise<void>;
  onError: (text: string) => void;
}) {
  const [title, setTitle] = useState(post?.title ?? '');
  const [bodyAr, setBodyAr] = useState(post?.bodyAr ?? '');
  const [bodyEn, setBodyEn] = useState(post?.bodyEn ?? '');
  const [linkUrl, setLinkUrl] = useState(post?.linkUrl ?? '');
  const [ctaLabel, setCtaLabel] = useState(post?.ctaLabel ?? '');
  const [hashtags, setHashtags] = useState(post?.hashtags ?? '');
  const [language, setLanguage] = useState<'ar' | 'en' | 'both'>(post?.language ?? 'ar');
  const [media, setMedia] = useState<Array<{ url: string; kind: 'image' | 'video' }>>(post?.media ?? []);
  const [scheduledAt, setScheduledAt] = useState(toLocalInput(post?.scheduledAt ?? null));
  const [selected, setSelected] = useState<string[]>(
    post?.targets.map((target) => target.connectionId ?? '').filter(Boolean) ?? []
  );
  const [previews, setPreviews] = useState<Preview[]>([]);
  const [saving, setSaving] = useState(false);

  // Only channels that actually publish can be post targets. Analytics and
  // search connections are for measurement, not for composing.
  const connections = useMemo(
    () =>
      platforms
        .filter((platform) => platform.publishable)
        .flatMap((platform) => platform.connections.map((connection) => ({ platform, connection }))),
    [platforms]
  );

  const selectedPlatforms = useMemo(
    () =>
      Array.from(
        new Set(
          connections
            .filter((item) => selected.includes(item.connection.id))
            .map((item) => item.platform.key)
        )
      ),
    [connections, selected]
  );

  const payload = useMemo(
    () => ({
      title,
      bodyAr,
      bodyEn,
      linkUrl,
      ctaLabel,
      hashtags,
      language,
      media,
      scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : null,
    }),
    [title, bodyAr, bodyEn, linkUrl, ctaLabel, hashtags, language, media, scheduledAt]
  );

  useEffect(() => {
    if (!selectedPlatforms.length) {
      setPreviews([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      api<{ previews: Preview[] }>(`${base}/preview`, {
        method: 'POST',
        body: { ...payload, platforms: selectedPlatforms },
      })
        .then((data) => {
          if (!cancelled) setPreviews(data.previews);
        })
        .catch(() => {
          if (!cancelled) setPreviews([]);
        });
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [base, payload, selectedPlatforms]);

  const save = async () => {
    setSaving(true);
    try {
      const targets = connections
        .filter((item) => selected.includes(item.connection.id))
        .map((item) => ({ platform: item.platform.key, connectionId: item.connection.id }));
      const body = { ...payload, targets };
      if (post) {
        await api(`${base}/posts/${post.id}`, { method: 'PUT', body });
      } else {
        await api(`${base}/posts`, { method: 'POST', body });
      }
      await onSaved();
    } catch (error) {
      onError(t(errorKey((error as ApiError)?.code)));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      title={post ? t('social.edit') : t('social.newPost')}
      onClose={onClose}
      wide
      footer={
        <div className="row-actions">
          <Button loading={saving} onClick={save}>
            {t('social.saveDraft')}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
        </div>
      }
    >
      <div className="social-composer">
        <div className="social-composer-form">
          <Field label={t('social.postTitle')} htmlFor="sp-title">
            <Input id="sp-title" value={title} onChange={(event) => setTitle(event.target.value)} />
          </Field>
          <div className="social-grid-2">
            <Field label={t('social.bodyAr')} htmlFor="sp-ar">
              <Textarea id="sp-ar" dir="rtl" rows={5} value={bodyAr} onChange={(event) => setBodyAr(event.target.value)} />
            </Field>
            <Field label={t('social.bodyEn')} htmlFor="sp-en">
              <Textarea id="sp-en" dir="ltr" rows={5} value={bodyEn} onChange={(event) => setBodyEn(event.target.value)} />
            </Field>
          </div>
          <div className="social-grid-2">
            <Field label={t('social.linkUrl')} htmlFor="sp-link">
              <Input id="sp-link" dir="ltr" value={linkUrl} onChange={(event) => setLinkUrl(event.target.value)} />
            </Field>
            <Field label={t('social.hashtags')} htmlFor="sp-tags">
              <Input id="sp-tags" dir="ltr" value={hashtags} onChange={(event) => setHashtags(event.target.value)} />
            </Field>
          </div>
          <div className="social-grid-2">
            <Field label={t('social.ctaLabel')} htmlFor="sp-cta">
              <Input id="sp-cta" value={ctaLabel} onChange={(event) => setCtaLabel(event.target.value)} />
            </Field>
            <Field label={t('social.language')} htmlFor="sp-lang">
              <Select
                id="sp-lang"
                value={language}
                onChange={(event) => setLanguage(event.target.value as 'ar' | 'en' | 'both')}
              >
                <option value="ar">العربية</option>
                <option value="en">English</option>
                <option value="both">AR + EN</option>
              </Select>
            </Field>
          </div>
          <Field label={t('social.scheduledAt')} hint="UTC±local" htmlFor="sp-when">
            <Input
              id="sp-when"
              type="datetime-local"
              value={scheduledAt}
              onChange={(event) => setScheduledAt(event.target.value)}
            />
          </Field>

          <div className="social-media">
            <div className="social-media-head">
              <strong>{t('social.mediaTitle')}</strong>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setMedia([...media, { url: '', kind: 'image' }])}
              >
                {t('social.mediaAdd')}
              </Button>
            </div>
            {media.map((item, index) => (
              <div key={index} className="social-media-row">
                <Input
                  dir="ltr"
                  placeholder="https://…"
                  value={item.url}
                  onChange={(event) =>
                    setMedia(media.map((entry, i) => (i === index ? { ...entry, url: event.target.value } : entry)))
                  }
                />
                <Select
                  value={item.kind}
                  onChange={(event) =>
                    setMedia(
                      media.map((entry, i) =>
                        i === index ? { ...entry, kind: event.target.value as 'image' | 'video' } : entry
                      )
                    )
                  }
                >
                  <option value="image">image</option>
                  <option value="video">video</option>
                </Select>
                <Button size="sm" variant="ghost" onClick={() => setMedia(media.filter((_, i) => i !== index))}>
                  ×
                </Button>
              </div>
            ))}
          </div>

          <div className="social-targets">
            <strong>{t('social.targets')}</strong>
            <p className="muted small">{t('social.targetsHint')}</p>
            {connections.length === 0 ? (
              <EmptyState>{t('social.noConnectedAccount')}</EmptyState>
            ) : (
              connections.map(({ platform, connection }) => (
                <label key={connection.id} className="social-choice">
                  <input
                    type="checkbox"
                    checked={selected.includes(connection.id)}
                    onChange={(event) =>
                      setSelected(
                        event.target.checked
                          ? [...selected, connection.id]
                          : selected.filter((id) => id !== connection.id)
                      )
                    }
                  />
                  <span>
                    <strong>{platform.name[locale]}</strong>
                    <span className="muted small"> · {connection.accountName}</span>
                    {connection.tokenStatus !== 'connected' ? (
                      <span className="badge badge-warn">{t(`social.state.${connection.tokenStatus}`)}</span>
                    ) : null}
                  </span>
                </label>
              ))
            )}
          </div>
        </div>

        <aside className="social-previews">
          <strong>{t('social.preview')}</strong>
          <p className="muted small">{t('social.previewHint')}</p>
          {previews.length === 0 ? (
            <EmptyState>{t('social.previewEmpty')}</EmptyState>
          ) : (
            previews.map((preview) => (
              <div key={preview.platform} className="social-preview">
                <div className="social-preview-head">
                  <strong>{preview.spec.name[locale]}</strong>
                  <span className={cx('badge', preview.status === 'ready' ? 'badge-ok' : 'badge-warn')}>
                    {t(`social.status.${preview.status}`)}
                  </span>
                </div>
                <p className="social-preview-text" dir="auto">
                  {preview.text}
                </p>
                <div className="muted small">
                  {preview.text.length} / {preview.spec.limits.textMax}
                </div>
                {preview.issues.length ? (
                  <ul className="social-issues">
                    {preview.issues.map((issue) => (
                      <li key={issue.code}>
                        {t(`social.issue.${issue.code}`, issue.code)}
                        {issue.detail ? ` (${issue.detail})` : ''}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {preview.notes.length ? (
                  <ul className="social-notes">
                    {preview.notes.map((note) => (
                      <li key={note}>{t(`social.note.${note.replace(/_\d+$/, '_trimmed')}`, note)}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ))
          )}
        </aside>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

function QueueTab({
  jobs,
  events,
  locale,
  t,
  scheduler,
  busy,
  onRun,
}: {
  jobs: Job[];
  events: EventRow[];
  locale: 'ar' | 'en';
  t: (key: string, fallback?: string) => string;
  scheduler: { state: string; execution: string; automatic: boolean };
  busy: string | null;
  onRun: () => void;
}) {
  return (
    <div className="social-stack">
      <Card
        title={t('social.queueTitle')}
        subtitle={t('social.queueHint')}
        actions={
          <Button size="sm" variant="secondary" loading={busy === 'jobs'} onClick={onRun}>
            {t('social.runDue')}
          </Button>
        }
      >
        {scheduler.state !== 'configured' ? (
          <Alert tone="warn">{t('social.schedulerOff')}</Alert>
        ) : (
          <Alert tone="info">{t('social.schedulerManualOnly')}</Alert>
        )}
        {jobs.length === 0 ? (
          <EmptyState>{t('social.queueEmpty')}</EmptyState>
        ) : (
          <Table
            head={[
              t('social.tab.library'),
              t('social.targets'),
              t('social.runAt'),
              t('social.attempts'),
              t('common.status'),
              t('social.error'),
            ]}
          >
            {jobs.map((job) => (
              <tr key={job.id}>
                <td>{job.postTitle ?? '—'}</td>
                <td dir="ltr">{job.platform}</td>
                <td>{formatDateTime(job.runAt, locale)}</td>
                <td>
                  {job.attempts}/{job.maxAttempts}
                </td>
                <td>
                  <StatusBadge status={job.state} label={job.state} />
                </td>
                <td dir="ltr">{job.lastError ?? '—'}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card title={t('social.activityTitle')}>
        {events.length === 0 ? (
          <EmptyState>{t('social.activityEmpty')}</EmptyState>
        ) : (
          <ul className="social-events">
            {events.map((event) => (
              <li key={event.id}>
                <span className="badge badge-muted">{t(`social.event.${event.kind}`, event.kind)}</span>
                <span className="muted small" dir="auto">
                  {event.detail ?? ''}
                </span>
                <time className="muted small">{formatDateTime(event.createdAt, locale)}</time>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

/**
 * Posters are rendered by the Worker as SVG from the client's own words and
 * brand colour. Nothing enters publishing before approval: a draft has no
 * public image URL.
 */
function PostersTab({
  base,
  t,
  canCreate,
  canApprove,
  onNotice,
}: {
  base: string;
  t: (key: string, fallback?: string) => string;
  canCreate: boolean;
  canApprove: boolean;
  onNotice: (notice: { tone: 'ok' | 'warn' | 'danger' | 'info'; text: string } | null) => void;
}) {
  const [data, setData] = useState<any>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState({
    headline: '',
    subhead: '',
    cta: '',
    sizeKey: 'instagram_business',
    template: 'bold',
    brandColor: '#0f766e',
    language: 'ar',
  });

  const load = useCallback(async () => {
    try {
      setData(await api<any>(`${base}/posters`));
    } catch (error) {
      onNotice({ tone: 'danger', text: t(errorKey((error as ApiError)?.code)) });
    }
  }, [base, t, onNotice]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    setBusy('create');
    try {
      await api(`${base}/posters`, { method: 'POST', body: form });
      setOpen(false);
      setForm({ ...form, headline: '', subhead: '', cta: '' });
      onNotice({ tone: 'ok', text: t('social.posterCreated') });
      await load();
    } catch (error) {
      onNotice({ tone: 'danger', text: t(errorKey((error as ApiError)?.code)) });
    } finally {
      setBusy(null);
    }
  };

  const act = async (poster: any, action: 'approve' | 'archive') => {
    setBusy(poster.id);
    try {
      await api(`${base}/posters/${poster.id}/${action}`, { method: 'POST', body: {} });
      await load();
    } catch (error) {
      onNotice({ tone: 'danger', text: t(errorKey((error as ApiError)?.code)) });
    } finally {
      setBusy(null);
    }
  };

  const posters: any[] = data?.posters ?? [];

  return (
    <div className="social-stack">
      <Card
        title={t('social.postersTitle')}
        subtitle={t('social.postersHint')}
        actions={
          canCreate ? (
            <Button size="sm" onClick={() => setOpen(true)}>
              {t('social.newPoster')}
            </Button>
          ) : undefined
        }
      >
        {posters.length === 0 ? (
          <EmptyState>{t('social.noPosters')}</EmptyState>
        ) : (
          <div className="poster-grid">
            {posters.map((poster) => (
              <figure key={poster.id} className="poster-card">
                <img
                  src={`${base}/posters/${poster.id}/preview.svg`}
                  alt={poster.headline}
                  loading="lazy"
                />
                <figcaption>
                  <strong>{poster.headline}</strong>
                  <span className="muted small" dir="ltr">
                    {poster.sizeKey} · {poster.width}×{poster.height} · v{poster.version}
                  </span>
                  <StatusBadge
                    status={poster.status === 'approved' ? 'approved' : 'draft'}
                    label={t(`social.poster.${poster.status}`)}
                  />
                  <div className="row-actions">
                    {canApprove && poster.status === 'draft' ? (
                      <Button
                        size="sm"
                        loading={busy === poster.id}
                        onClick={() => void act(poster, 'approve')}
                      >
                        {t('social.approve')}
                      </Button>
                    ) : null}
                    {canApprove && poster.status !== 'archived' ? (
                      <Button size="sm" variant="ghost" onClick={() => void act(poster, 'archive')}>
                        {t('social.archive')}
                      </Button>
                    ) : null}
                  </div>
                </figcaption>
              </figure>
            ))}
          </div>
        )}
      </Card>

      <Modal
        open={open}
        title={t('social.newPoster')}
        onClose={() => setOpen(false)}
        footer={
          <div className="row-actions">
            <Button loading={busy === 'create'} onClick={() => void create()}>
              {t('common.create')}
            </Button>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {t('common.cancel')}
            </Button>
          </div>
        }
      >
        <div className="form-grid">
          <Field label={t('social.posterHeadline')}>
            <Input
              value={form.headline}
              onChange={(event) => setForm({ ...form, headline: event.target.value })}
              maxLength={240}
            />
          </Field>
          <Field label={t('social.posterSubhead')}>
            <Input
              value={form.subhead}
              onChange={(event) => setForm({ ...form, subhead: event.target.value })}
              maxLength={400}
            />
          </Field>
          <Field label={t('social.posterCta')}>
            <Input
              value={form.cta}
              onChange={(event) => setForm({ ...form, cta: event.target.value })}
              maxLength={60}
            />
          </Field>
          <Field label={t('social.posterSize')}>
            <Select
              value={form.sizeKey}
              onChange={(event) => setForm({ ...form, sizeKey: event.target.value })}
            >
              {(data?.sizes ?? []).map((size: any) => (
                <option key={size.key} value={size.key}>
                  {size.key} · {size.width}×{size.height}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('social.posterTemplate')}>
            <Select
              value={form.template}
              onChange={(event) => setForm({ ...form, template: event.target.value })}
            >
              {(data?.templates ?? ['bold']).map((template: string) => (
                <option key={template} value={template}>
                  {template}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('social.posterColor')}>
            <Input
              dir="ltr"
              value={form.brandColor}
              onChange={(event) => setForm({ ...form, brandColor: event.target.value })}
            />
          </Field>
          <Field label={t('social.posterLanguage')}>
            <Select
              value={form.language}
              onChange={(event) => setForm({ ...form, language: event.target.value })}
            >
              <option value="ar">العربية</option>
              <option value="en">English</option>
            </Select>
          </Field>
        </div>
      </Modal>
    </div>
  );
}

/**
 * Every edit stores a snapshot. Restoring does not rewrite the current post:
 * the API creates a new draft from the old snapshot, so nothing is lost.
 */
function VersionHistory({
  base,
  post,
  locale,
  t,
  canCreate,
  onRestored,
}: {
  base: string;
  post: PostRow;
  locale: 'ar' | 'en';
  t: (key: string, fallback?: string) => string;
  canCreate: boolean;
  onRestored: () => Promise<void>;
}) {
  const [items, setItems] = useState<Array<any>>([]);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void Promise.all(
      Array.from({ length: post.version }, (_, index) =>
        api<any>(`${base}/posts/${post.id}/versions/${index + 1}`).catch(() => null)
      )
    ).then((rows) => {
      if (live) setItems(rows.filter(Boolean).reverse());
    });
    return () => {
      live = false;
    };
  }, [base, post.id, post.version]);

  const restore = async (version: number) => {
    setBusy(version);
    setError(null);
    try {
      await api(`${base}/posts/${post.id}/versions/${version}/restore`, {
        method: 'POST',
        body: {},
      });
      await onRestored();
    } catch (failure) {
      setError(t(errorKey((failure as ApiError)?.code)));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card title={t('social.versions')} subtitle={t('social.versionsHint')}>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Table head={[t('social.version'), t('social.versionChange'), t('social.createdAt'), t('common.actions')]}>
        {items.map((item) => (
          <tr key={item.version}>
            <td>v{item.version}</td>
            <td className="muted small" dir="auto">
              {(item.snapshot?.bodyAr || item.snapshot?.bodyEn || '').slice(0, 80)}
            </td>
            <td>{formatDateTime(item.createdAt, locale)}</td>
            <td>
              {canCreate && item.version !== post.version ? (
                <Button
                  size="sm"
                  variant="ghost"
                  loading={busy === item.version}
                  onClick={() => void restore(item.version)}
                >
                  {t('social.restore')}
                </Button>
              ) : (
                <span className="muted small">{t('social.currentVersion')}</span>
              )}
            </td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}
