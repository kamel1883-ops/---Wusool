/**
 * Publishing engine.
 *
 * One target = one platform/account. A target is published at most once: the
 * job row is unique per target and the target is re-read before the network
 * call, so a double click, a retry after a timeout, or a re-run of the queue
 * cannot post the same content twice. A failure on Instagram leaves a
 * published Facebook target exactly as it is.
 *
 * Only official Graph endpoints are called. Where a platform cannot do the
 * operation through its API (Instagram without a public media URL, Business
 * Profile without access approval), the target fails with that documented
 * reason — nothing is simulated and no browser automation is used.
 */
import { first, getSettings, newId, nowIso, run, type Env } from '../db';
import { PLATFORMS as SPECS, type PlatformKey } from './platforms';
import { usableToken } from './oauth';

const graphBase = (env: Env) =>
  String((env as any).SOCIAL_GRAPH_BASE ?? 'https://graph.facebook.com').replace(/\/$/, '');
const graphVersion = (env: Env) => String((env as any).SOCIAL_GRAPH_VERSION ?? 'v23.0');

export type PublishOutcome = {
  status: 'published' | 'failed' | 'skipped';
  externalId?: string | null;
  externalUrl?: string | null;
  errorCode?: string;
  errorMessage?: string;
};

const graphError = (payload: any, status: number) => {
  const error = payload?.error;
  const code = error?.code ? `graph_${error.code}` : `graph_status_${status}`;
  const message = String(error?.message ?? `provider returned ${status}`).slice(0, 400);
  return { code, message };
};

async function facebookPublish(
  env: Env,
  pageId: string,
  token: string,
  text: string,
  link: string | null
): Promise<PublishOutcome> {
  const url = `${graphBase(env)}/${graphVersion(env)}/${pageId}/feed`;
  const body = new URLSearchParams({ message: text, access_token: token });
  if (link) body.set('link', link);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const payload: any = await response.json().catch(() => null);
  if (!response.ok || !payload?.id) {
    const error = graphError(payload, response.status);
    return { status: 'failed', errorCode: error.code, errorMessage: error.message };
  }
  const externalId = String(payload.id);
  return {
    status: 'published',
    externalId,
    externalUrl: `https://www.facebook.com/${externalId}`,
  };
}

async function instagramPublish(
  env: Env,
  igUserId: string,
  token: string,
  caption: string,
  media: Array<{ url: string; kind: 'image' | 'video' }>
): Promise<PublishOutcome> {
  if (!media.length) {
    return {
      status: 'failed',
      errorCode: 'media_required',
      errorMessage: 'The Instagram API requires an image or video hosted at a public URL.',
    };
  }
  const item = media[0];
  const createUrl = `${graphBase(env)}/${graphVersion(env)}/${igUserId}/media`;
  const createBody = new URLSearchParams({ caption, access_token: token });
  if (item.kind === 'video') createBody.set('media_type', 'REELS');
  createBody.set(item.kind === 'video' ? 'video_url' : 'image_url', item.url);

  const created = await fetch(createUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: createBody,
  });
  const createdPayload: any = await created.json().catch(() => null);
  if (!created.ok || !createdPayload?.id) {
    const error = graphError(createdPayload, created.status);
    return { status: 'failed', errorCode: error.code, errorMessage: error.message };
  }

  const publishUrl = `${graphBase(env)}/${graphVersion(env)}/${igUserId}/media_publish`;
  const published = await fetch(publishUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      creation_id: String(createdPayload.id),
      access_token: token,
    }),
  });
  const publishedPayload: any = await published.json().catch(() => null);
  if (!published.ok || !publishedPayload?.id) {
    const error = graphError(publishedPayload, published.status);
    return { status: 'failed', errorCode: error.code, errorMessage: error.message };
  }

  const mediaId = String(publishedPayload.id);
  let permalink: string | null = null;
  try {
    const info = await fetch(
      `${graphBase(env)}/${graphVersion(env)}/${mediaId}?fields=permalink&access_token=${encodeURIComponent(token)}`
    );
    if (info.ok) {
      const data: any = await info.json().catch(() => null);
      permalink = data?.permalink ? String(data.permalink) : null;
    }
  } catch {
    permalink = null;
  }

  return { status: 'published', externalId: mediaId, externalUrl: permalink };
}

/** Publishes a single target through the platform it belongs to. */
export async function publishTarget(
  env: Env,
  input: { companyId: string; targetId: string }
): Promise<PublishOutcome> {
  const target = await first<any>(
    env,
    'SELECT * FROM social_post_targets WHERE id = ? AND company_id = ?',
    input.targetId,
    input.companyId
  );
  if (!target) return { status: 'failed', errorCode: 'target_not_found' };
  if (target.status === 'published') {
    return {
      status: 'skipped',
      externalId: target.external_id,
      externalUrl: target.external_url,
    };
  }
  if (!target.connection_id) {
    await markFailed(env, target, 'connection_missing', 'The target has no connected account.');
    return { status: 'failed', errorCode: 'connection_missing' };
  }

  const connection = await first<any>(
    env,
    'SELECT * FROM social_connections WHERE id = ? AND company_id = ?',
    target.connection_id,
    input.companyId
  );
  if (!connection) {
    await markFailed(env, target, 'connection_missing', 'The connected account no longer exists.');
    return { status: 'failed', errorCode: 'connection_missing' };
  }

  const platform = target.platform as PlatformKey;
  const spec = SPECS[platform];
  const adapted = JSON.parse(target.adapted_json || '{}');
  const text = String(target.adapted_text ?? '');
  const media: Array<{ url: string; kind: 'image' | 'video' }> = Array.isArray(adapted.media)
    ? adapted.media
    : [];

  await run(
    env,
    `UPDATE social_post_targets SET status = 'publishing', attempts = attempts + 1,
       last_attempt_at = ?, updated_at = ? WHERE id = ?`,
    nowIso(),
    nowIso(),
    target.id
  );
  await recomputePostStatus(env, target.post_id);

  let outcome: PublishOutcome;
  try {
    const token = await usableToken(env, connection);

    if (platform === 'facebook_page') {
      outcome = await facebookPublish(
        env,
        String(connection.page_id ?? connection.account_id),
        token.accessToken,
        text,
        target.adapted_json ? JSON.parse(target.adapted_json).linkUrl ?? null : null
      );
    } else if (platform === 'instagram_business') {
      outcome = await instagramPublish(
        env,
        String(connection.profile_id ?? connection.account_id),
        token.accessToken,
        text,
        media
      );
    } else if (platform === 'google_business_profile') {
      const settings = await getSettings(env);
      const granted = settings['social.access.google_business_profile'] === 'approved';
      outcome = {
        status: 'failed',
        errorCode: granted ? 'publish_not_implemented' : 'gbp_access_requires_approval',
        errorMessage: granted
          ? 'Business Profile post creation is not wired in this build.'
          : 'Google has not granted Business Profile API access for this deployment.',
      };
    } else if (!spec.connector || spec.connector === 'none') {
      outcome = {
        status: 'failed',
        errorCode: 'publish_not_supported',
        errorMessage: `${spec.name.en} has no official publishing API path in this build.`,
      };
    } else {
      outcome = {
        status: 'failed',
        errorCode: 'publish_not_implemented',
        errorMessage: 'Publishing for this platform is not implemented.',
      };
    }
  } catch (error) {
    const message = String((error as Error)?.message ?? 'publish_failed');
    const code = message.startsWith('token_')
      ? message
      : message.startsWith('google_refresh_failed')
        ? 'token_refresh_failed'
        : 'publish_failed';
    if (code === 'token_expired' || code === 'token_refresh_failed' || code === 'token_missing') {
      await run(
        env,
        `UPDATE social_connections SET token_status = 'requires_reconnect', last_error = ?, updated_at = ? WHERE id = ?`,
        code,
        nowIso(),
        connection.id
      );
    }
    outcome = { status: 'failed', errorCode: code, errorMessage: message.slice(0, 400) };
  }

  const timestamp = nowIso();
  if (outcome.status === 'published') {
    await run(
      env,
      `UPDATE social_post_targets SET status = 'published', external_id = ?, external_url = ?,
         error_code = NULL, error_message = NULL, published_at = ?, updated_at = ? WHERE id = ?`,
      outcome.externalId ?? null,
      outcome.externalUrl ?? null,
      timestamp,
      timestamp,
      target.id
    );
    await logEvent(env, {
      companyId: target.company_id,
      postId: target.post_id,
      targetId: target.id,
      connectionId: target.connection_id,
      kind: 'target.published',
      detail: outcome.externalUrl ?? outcome.externalId ?? null,
    });
  } else if (outcome.status === 'failed') {
    await markFailed(
      env,
      target,
      outcome.errorCode ?? 'publish_failed',
      outcome.errorMessage ?? null
    );
    const authError =
      outcome.errorCode === 'token_expired' ||
      outcome.errorCode === 'token_refresh_failed' ||
      outcome.errorCode === 'graph_190' ||
      outcome.errorCode === 'token_missing';
    if (authError) {
      await run(
        env,
        `UPDATE social_connections SET token_status = 'requires_reconnect', last_error = ?, updated_at = ? WHERE id = ?`,
        outcome.errorCode ?? 'requires_reconnect',
        timestamp,
        connection.id
      );
    }
  }

  await recomputePostStatus(env, target.post_id);
  return outcome;
}

async function markFailed(
  env: Env,
  target: any,
  code: string,
  message: string | null
) {
  await run(
    env,
    `UPDATE social_post_targets SET status = 'failed', error_code = ?, error_message = ?, updated_at = ?
     WHERE id = ?`,
    code,
    (message ?? '').slice(0, 400) || null,
    nowIso(),
    target.id
  );
  await logEvent(env, {
    companyId: target.company_id,
    postId: target.post_id,
    targetId: target.id,
    connectionId: target.connection_id,
    kind: 'target.failed',
    detail: `${code}${message ? `: ${message}` : ''}`.slice(0, 500),
  });
}

export async function logEvent(
  env: Env,
  input: {
    companyId: string;
    postId?: string | null;
    targetId?: string | null;
    connectionId?: string | null;
    kind: string;
    detail?: string | null;
    actorUserId?: string | null;
  }
) {
  await run(
    env,
    `INSERT INTO social_events (id, company_id, connection_id, post_id, target_id, kind, detail, actor_user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    newId('sev'),
    input.companyId,
    input.connectionId ?? null,
    input.postId ?? null,
    input.targetId ?? null,
    input.kind,
    input.detail ? input.detail.slice(0, 500) : null,
    input.actorUserId ?? null,
    nowIso()
  );
}

/** Post status is derived from its targets, never set by hand. */
export async function recomputePostStatus(env: Env, postId: string) {
  const post = await first<any>(env, 'SELECT * FROM social_posts WHERE id = ?', postId);
  if (!post) return;
  const targets = await (
    await env.DB.prepare('SELECT status FROM social_post_targets WHERE post_id = ?').bind(postId).all()
  ).results as Array<{ status: string }>;

  if (!targets.length) return;
  const published = targets.filter((t) => t.status === 'published').length;
  const failed = targets.filter((t) => t.status === 'failed').length;
  const active = targets.filter((t) => t.status === 'publishing').length;

  let status = post.status;
  let publishedAt = post.published_at;

  if (active > 0) {
    status = 'publishing';
  } else if (published === targets.length) {
    status = 'published';
    publishedAt = publishedAt ?? nowIso();
  } else if (published > 0) {
    status = 'partially_published';
    publishedAt = publishedAt ?? nowIso();
  } else if (failed === targets.length) {
    status = 'failed';
  } else if (post.scheduled_at && post.approved_at) {
    status = 'scheduled';
  } else if (post.approved_at) {
    status = 'approved';
  }

  await run(
    env,
    'UPDATE social_posts SET status = ?, published_at = ?, updated_at = ? WHERE id = ?',
    status,
    publishedAt ?? null,
    nowIso(),
    postId
  );
}

/** One job per target; re-requesting publishing never adds a second job. */
export async function enqueueTarget(env: Env, input: {
  companyId: string;
  targetId: string;
  runAt: string;
}) {
  const timestamp = nowIso();
  await run(
    env,
    `INSERT INTO social_jobs (id, company_id, target_id, kind, state, run_at, created_at, updated_at)
     VALUES (?, ?, ?, 'publish_target', 'pending', ?, ?, ?)
     ON CONFLICT(target_id) DO UPDATE SET run_at = excluded.run_at, state = 'pending', updated_at = excluded.updated_at
       WHERE social_jobs.state IN ('pending', 'failed')`,
    newId('job'),
    input.companyId,
    input.targetId,
    input.runAt,
    timestamp,
    timestamp
  );
  await run(
    env,
    `UPDATE social_post_targets SET status = 'scheduled', updated_at = ? WHERE id = ? AND status IN ('ready', 'blocked', 'failed')`,
    timestamp,
    input.targetId
  );
}

const backoffSeconds = (attempts: number) => Math.min(60 * 2 ** Math.max(0, attempts - 1), 3600);

/**
 * Runs due jobs. Called by the scheduler endpoint (or by an owner on demand);
 * it is deliberately not described as an always-on queue, because this hosting
 * target has no cron trigger configured.
 */
export async function runDueJobs(
  env: Env,
  options: { companyId?: string; limit?: number; now?: string } = {}
) {
  const limit = Math.max(1, Math.min(20, options.limit ?? 10));
  const now = options.now ?? nowIso();
  const rows = options.companyId
    ? await (
        await env.DB.prepare(
          `SELECT * FROM social_jobs WHERE state = 'pending' AND run_at <= ? AND company_id = ? ORDER BY run_at LIMIT ?`
        )
          .bind(now, options.companyId, limit)
          .all()
      ).results
    : await (
        await env.DB.prepare(
          `SELECT * FROM social_jobs WHERE state = 'pending' AND run_at <= ? ORDER BY run_at LIMIT ?`
        )
          .bind(now, limit)
          .all()
      ).results;

  const results: Array<{ targetId: string; outcome: PublishOutcome }> = [];

  for (const job of rows as any[]) {
    const claim = await run(
      env,
      `UPDATE social_jobs SET state = 'running', attempts = attempts + 1, locked_at = ?, updated_at = ?
       WHERE id = ? AND state = 'pending'`,
      nowIso(),
      nowIso(),
      job.id
    );
    if (!(claim as any)?.meta?.changes) continue;

    const outcome = await publishTarget(env, {
      companyId: job.company_id,
      targetId: job.target_id,
    });
    results.push({ targetId: job.target_id, outcome });

    const attempts = Number(job.attempts ?? 0) + 1;
    const maxAttempts = Number(job.max_attempts ?? 3);
    if (outcome.status === 'published' || outcome.status === 'skipped') {
      await run(
        env,
        `UPDATE social_jobs SET state = 'done', last_error = NULL, updated_at = ? WHERE id = ?`,
        nowIso(),
        job.id
      );
    } else if (attempts < maxAttempts) {
      const next = new Date(Date.now() + backoffSeconds(attempts) * 1000).toISOString();
      await run(
        env,
        `UPDATE social_jobs SET state = 'pending', run_at = ?, last_error = ?, updated_at = ? WHERE id = ?`,
        next,
        outcome.errorCode ?? 'publish_failed',
        nowIso(),
        job.id
      );
      await run(
        env,
        `UPDATE social_post_targets SET status = 'scheduled', updated_at = ? WHERE id = ?`,
        nowIso(),
        job.target_id
      );
    } else {
      await run(
        env,
        `UPDATE social_jobs SET state = 'failed', last_error = ?, updated_at = ? WHERE id = ?`,
        outcome.errorCode ?? 'publish_failed',
        nowIso(),
        job.id
      );
    }
  }

  return results;
}
