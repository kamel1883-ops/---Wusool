/**
 * Per-platform adaptation and pre-publish validation.
 *
 * The client writes one post; every selected platform gets its own copy and
 * its own list of blocking problems. Nothing here silently shortens a post
 * into something the client did not write: exceeding a limit is an error the
 * client has to resolve, and a platform that cannot take the post is blocked
 * with the documented reason rather than skipped quietly.
 */
import { PLATFORMS, type PlatformKey } from './platforms';

export type PostMedia = {
  url: string;
  kind: 'image' | 'video';
  alt?: string;
};

export type PostInput = {
  title: string;
  bodyAr: string;
  bodyEn: string;
  linkUrl: string;
  ctaLabel: string;
  hashtags: string;
  language: 'ar' | 'en' | 'both';
  media: PostMedia[];
};

export type Issue = { code: string; detail?: string };

export type Adapted = {
  status: 'ready' | 'blocked';
  text: string;
  subject: string | null;
  media: PostMedia[];
  issues: Issue[];
  notes: string[];
};

const normaliseTags = (raw: string) =>
  raw
    .split(/[\s,،\n]+/)
    .map((tag) => tag.replace(/^#+/, '').trim())
    .filter(Boolean);

const hashtagBlock = (raw: string, limit: number | null) => {
  const tags = normaliseTags(raw);
  if (!tags.length) return { block: '', count: 0 };
  const used = limit === null ? tags : tags.slice(0, limit);
  return { block: used.map((tag) => `#${tag}`).join(' '), count: tags.length };
};

const isHttpUrl = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
};

export function adaptPost(post: PostInput, platform: PlatformKey): Adapted {
  const spec = PLATFORMS[platform];
  const issues: Issue[] = [];
  const notes: string[] = [];

  const baseBody = (post.language === 'en' ? post.bodyEn : post.bodyAr) || post.bodyAr || post.bodyEn;
  if (!baseBody.trim()) issues.push({ code: 'body_required' });

  if (!spec.capabilities.publishText && !spec.capabilities.publishImage && !spec.capabilities.publishVideo) {
    issues.push({ code: 'platform_not_publishable' });
    return { status: 'blocked', text: '', subject: null, media: [], issues, notes };
  }

  // Media: only kinds the platform documents, images before video.
  const allowedMedia = post.media.filter((item) => {
    if (!isHttpUrl(item.url)) {
      issues.push({ code: 'media_url_invalid', detail: item.url });
      return false;
    }
    if (!spec.limits.mediaKinds.includes(item.kind)) {
      issues.push({ code: 'media_kind_not_supported', detail: item.kind });
      return false;
    }
    return true;
  });

  if (spec.limits.requiresMedia && allowedMedia.length === 0) {
    issues.push({ code: 'media_required' });
  }
  if (platform === 'google_business_profile' && allowedMedia.length > 1) {
    issues.push({ code: 'media_single_allowed' });
  }
  if (platform === 'instagram_business') {
    const nonJpeg = allowedMedia.filter(
      (item) => item.kind === 'image' && !/\.jpe?g($|\?)/i.test(item.url)
    );
    if (nonJpeg.length) {
      notes.push('instagram_requires_jpeg');
      issues.push({ code: 'media_must_be_jpeg' });
    }
  }

  const { block: tags, count: tagCount } = hashtagBlock(
    post.hashtags,
    spec.limits.hashtagsMax
  );
  if (spec.limits.hashtagsMax !== null && tagCount > spec.limits.hashtagsMax) {
    notes.push(`hashtags_trimmed_to_${spec.limits.hashtagsMax}`);
  }
  const withTags = platform === 'google_business_profile' ? baseBody.trim() : [baseBody.trim(), tags].filter(Boolean).join('\n\n');

  // Links: some platforms turn a bare URL into a preview, others (Instagram)
  // do not allow clickable links in the caption, so we state that plainly.
  let text = withTags;
  if (post.linkUrl && isHttpUrl(post.linkUrl)) {
    if (platform === 'instagram_business') {
      notes.push('instagram_link_not_clickable');
    } else {
      text = `${text}\n\n${post.linkUrl}`.trim();
    }
  } else if (post.linkUrl) {
    issues.push({ code: 'link_invalid' });
  }

  if (post.ctaLabel.trim() && platform === 'google_business_profile') {
    notes.push('gbp_cta_requires_supported_type');
  }

  if (text.length > spec.limits.textMax) {
    issues.push({
      code: 'text_too_long',
      detail: `${text.length}/${spec.limits.textMax}`,
    });
  }

  if (platform === 'whatsapp_cloud') {
    issues.push({ code: 'template_required' });
  }
  if (platform === 'google_business_profile') {
    issues.push({ code: 'gbp_access_requires_approval' });
  }

  return {
    status: issues.length ? 'blocked' : 'ready',
    text,
    subject: platform === 'email' ? post.title || null : null,
    media: allowedMedia,
    issues,
    notes,
  };
}

/** Summary used by the post list and the dashboard. */
export function summariseTargets(targets: Array<{ status: string }>) {
  const counts: Record<string, number> = {};
  for (const target of targets) counts[target.status] = (counts[target.status] ?? 0) + 1;
  return counts;
}
