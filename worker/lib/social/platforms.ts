/**
 * What each platform actually allows over its official API.
 *
 * This file is the single source of truth for the capability matrix shown to
 * clients. It is written from the providers' own documentation and is
 * deliberately conservative: a capability is `true` only when the official API
 * documents it for the account type we can obtain. Where Meta documents a
 * limitation (Instagram needs a public media URL and JPEG, publishing needs
 * Advanced Access for accounts you do not own) it is recorded here and the UI
 * quotes it instead of pretending the step will work.
 *
 * Two different questions are answered separately:
 *   `availability` — can this deployment even start an official connection?
 *   `connectionState` — what is true for this company's stored account?
 */

export type PlatformKey =
  | 'facebook_page'
  | 'instagram_business'
  | 'tiktok_business'
  | 'snapchat_business'
  | 'linkedin_org'
  | 'google_business_profile'
  | 'ga4'
  | 'search_console'
  | 'google_tag_manager'
  | 'email'
  | 'whatsapp_cloud';

export type Connector = 'meta' | 'google' | 'smtp' | 'none';

export type MediaKind = 'text' | 'image' | 'video' | 'link';

export type PlatformSpec = {
  key: PlatformKey;
  /** Two halves of the label; the UI renders the half matching its locale. */
  name: { ar: string; en: string };
  category: 'social' | 'search' | 'analytics' | 'messaging' | 'email';
  connector: Connector;
  /** What the account must be for the API to work at all. */
  accountRequirement: { ar: string; en: string };
  capabilities: {
    publishText: boolean;
    publishImage: boolean;
    publishVideo: boolean;
    /** Native scheduling. false means Wusool's own queue has to hold the post. */
    nativeScheduling: boolean;
    readComments: boolean;
    readAnalytics: boolean;
    /** Ads are a separate API/account and are not implemented in this build. */
    ads: boolean;
  };
  /** App review / allowlist reality for accounts the app does not own. */
  access: {
    reviewRequired: boolean;
    reviewNote: { ar: string; en: string };
    /** Additive permissions requested at connect time. */
    scopes: string[];
  };
  limits: {
    textMax: number;
    requiresMedia: boolean;
    mediaKinds: Array<'image' | 'video'>;
    hashtagsMax: number | null;
    /** Short, factual constraint shown in the per-platform preview. */
    mediaNote: { ar: string; en: string } | null;
  };
};

const META_REVIEW: { ar: string; en: string } = {
  ar: 'لحسابات لا تملكها: تحتاج Meta App Review وBusiness Verification للحصول على Advanced Access. حساباتك المضافة إلى التطبيق تعمل بـ Standard Access.',
  en: 'For accounts you do not own: Meta App Review and Business Verification are required for Advanced Access. Accounts added to the app work with Standard Access.',
};

const GOOGLE_REVIEW: { ar: string; en: string } = {
  ar: 'واجهات Google تحتاج مشروعًا في Google Cloud مع تفعيل الـAPI، وشاشة موافقة OAuth. بعض النطاقات (مثل Business Profile) تحتاج طلب وصول منفصلًا.',
  en: 'Google APIs require a Google Cloud project with the API enabled and an OAuth consent screen. Some scopes (Business Profile) need a separate access request.',
};

export const PLATFORMS: Record<PlatformKey, PlatformSpec> = {
  facebook_page: {
    key: 'facebook_page',
    name: { ar: 'صفحة Facebook', en: 'Facebook Page' },
    category: 'social',
    connector: 'meta',
    accountRequirement: {
      ar: 'صفحة Facebook تملك عليها مهمة CREATE_CONTENT',
      en: 'A Facebook Page where you hold the CREATE_CONTENT task',
    },
    capabilities: {
      publishText: true,
      publishImage: true,
      publishVideo: true,
      nativeScheduling: false,
      readComments: true,
      readAnalytics: true,
      ads: false,
    },
    access: {
      reviewRequired: true,
      reviewNote: META_REVIEW,
      scopes: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'read_insights'],
    },
    limits: {
      textMax: 63206,
      requiresMedia: false,
      mediaKinds: ['image', 'video'],
      hashtagsMax: null,
      mediaNote: null,
    },
  },
  instagram_business: {
    key: 'instagram_business',
    name: { ar: 'Instagram Business/Creator', en: 'Instagram Business/Creator' },
    category: 'social',
    connector: 'meta',
    accountRequirement: {
      ar: 'حساب Instagram احترافي مرتبط بصفحة Facebook تديرها',
      en: 'An Instagram professional account linked to a Page you manage',
    },
    capabilities: {
      publishText: false,
      publishImage: true,
      publishVideo: true,
      nativeScheduling: false,
      readComments: true,
      readAnalytics: true,
      ads: false,
    },
    access: {
      reviewRequired: true,
      reviewNote: META_REVIEW,
      scopes: [
        'instagram_basic',
        'instagram_content_publish',
        'instagram_manage_comments',
        'instagram_manage_insights',
        'pages_show_list',
        'pages_read_engagement',
      ],
    },
    limits: {
      textMax: 2200,
      requiresMedia: true,
      mediaKinds: ['image', 'video'],
      hashtagsMax: 30,
      mediaNote: {
        ar: 'الـAPI الرسمي ينشر بوسائط مستضافة على رابط عام (JPEG للصور)، ولا يقبل نصًا بلا صورة أو فيديو.',
        en: 'The official API publishes media hosted at a public URL (JPEG for images) and rejects text-only posts.',
      },
    },
  },
  tiktok_business: {
    key: 'tiktok_business',
    name: { ar: 'TikTok Business', en: 'TikTok Business' },
    category: 'social',
    connector: 'none',
    accountRequirement: {
      ar: 'حساب أعمال على TikTok مع تطبيق مطوّر معتمد للنشر',
      en: 'A TikTok business account with an approved developer app for publishing',
    },
    capabilities: {
      publishText: false,
      publishImage: false,
      publishVideo: true,
      nativeScheduling: false,
      readComments: true,
      readAnalytics: true,
      ads: true,
    },
    access: {
      reviewRequired: true,
      reviewNote: {
        ar: 'Content Posting API تحتاج مراجعة تطبيق وموافقة صريحة على النطاق video.publish. لا يوجد مسار تفويض مكتمل في هذه النسخة.',
        en: 'The Content Posting API requires app review and explicit approval for video.publish. This build has no completed authorization path for it.',
      },
      scopes: ['video.upload', 'video.publish'],
    },
    limits: {
      textMax: 2200,
      requiresMedia: true,
      mediaKinds: ['video'],
      hashtagsMax: null,
      mediaNote: {
        ar: 'النشر عبر الـAPI للفيديو، وبعض الحسابات تحتاج موافقة إضافية قبل الظهور للعامة.',
        en: 'API publishing is video-first, and some accounts need extra approval before posts are public.',
      },
    },
  },
  snapchat_business: {
    key: 'snapchat_business',
    name: { ar: 'Snapchat Business', en: 'Snapchat Business' },
    category: 'social',
    connector: 'none',
    accountRequirement: {
      ar: 'حساب أعمال وملف عام (Public Profile) مع وصول لـMarketing API',
      en: 'A business account and Public Profile with Marketing API access',
    },
    capabilities: {
      publishText: false,
      publishImage: false,
      publishVideo: true,
      nativeScheduling: false,
      readComments: false,
      readAnalytics: true,
      ads: true,
    },
    access: {
      reviewRequired: true,
      reviewNote: {
        ar: 'واجهة النشر للملف العام محدودة ومخصّصة للشركاء المعتمدين؛ المسار المكتمل في هذه النسخة غير متاح.',
        en: 'Public Profile publishing is limited and partner-scoped; no completed path exists in this build.',
      },
      scopes: ['snapchat-marketing-api'],
    },
    limits: {
      textMax: 250,
      requiresMedia: true,
      mediaKinds: ['video'],
      hashtagsMax: null,
      mediaNote: {
        ar: 'النشر عبر واجهة رسمية للفيديو/القصة فقط، وبعض الحسابات لا تملكها أصلًا.',
        en: 'Official publishing is video/story only, and some accounts do not have it at all.',
      },
    },
  },
  linkedin_org: {
    key: 'linkedin_org',
    name: { ar: 'صفحة LinkedIn للمؤسسة', en: 'LinkedIn Organization Page' },
    category: 'social',
    connector: 'none',
    accountRequirement: {
      ar: 'صفحة مؤسسة ودور مسؤول عليها',
      en: 'An organization page and an admin role on it',
    },
    capabilities: {
      publishText: true,
      publishImage: true,
      publishVideo: true,
      nativeScheduling: false,
      readComments: true,
      readAnalytics: true,
      ads: true,
    },
    access: {
      reviewRequired: true,
      reviewNote: {
        ar: 'Community Management API تحتاج موافقة وصول؛ النطاق w_organization_social لا يُمنح تلقائيًا. لم يُنفَّذ مسار OAuth لها في هذه النسخة.',
        en: 'The Community Management API requires access approval; w_organization_social is not granted automatically. No OAuth path is implemented in this build.',
      },
      scopes: ['w_organization_social', 'r_organization_social', 'rw_organization_admin'],
    },
    limits: {
      textMax: 3000,
      requiresMedia: false,
      mediaKinds: ['image', 'video'],
      hashtagsMax: null,
      mediaNote: null,
    },
  },
  google_business_profile: {
    key: 'google_business_profile',
    name: { ar: 'Google Business Profile', en: 'Google Business Profile' },
    category: 'search',
    connector: 'google',
    accountRequirement: {
      ar: 'منشأة مُتحقَّق منها في Google Business Profile',
      en: 'A verified location in Google Business Profile',
    },
    capabilities: {
      publishText: true,
      publishImage: true,
      publishVideo: false,
      nativeScheduling: false,
      readComments: false,
      readAnalytics: true,
      ads: false,
    },
    access: {
      reviewRequired: true,
      reviewNote: {
        ar: 'Business Profile APIs تحتاج طلب وصول منفصلًا من Google. حتى الموافقة، النشر عبر الـAPI يظهر «يتطلب وصولًا» ولا يُنفَّذ.',
        en: 'Business Profile APIs require a separate access request from Google. Until it is granted, API publishing is shown as "requires access" and is not attempted.',
      },
      scopes: ['https://www.googleapis.com/auth/business.manage'],
    },
    limits: {
      textMax: 1500,
      requiresMedia: false,
      mediaKinds: ['image'],
      hashtagsMax: null,
      mediaNote: {
        ar: 'منشورات المنشأة تدعم صورة واحدة بحد أقصى.',
        en: 'Location posts support a single image at most.',
      },
    },
  },
  ga4: {
    key: 'ga4',
    name: { ar: 'Google Analytics 4', en: 'Google Analytics 4' },
    category: 'analytics',
    connector: 'google',
    accountRequirement: {
      ar: 'خاصية GA4 مع صلاحية قراءة',
      en: 'A GA4 property with read access',
    },
    capabilities: {
      publishText: false,
      publishImage: false,
      publishVideo: false,
      nativeScheduling: false,
      readComments: false,
      readAnalytics: true,
      ads: false,
    },
    access: { reviewRequired: false, reviewNote: GOOGLE_REVIEW, scopes: ['https://www.googleapis.com/auth/analytics.readonly'] },
    limits: { textMax: 0, requiresMedia: false, mediaKinds: [], hashtagsMax: null, mediaNote: null },
  },
  search_console: {
    key: 'search_console',
    name: { ar: 'Google Search Console', en: 'Google Search Console' },
    category: 'search',
    connector: 'google',
    accountRequirement: {
      ar: 'موقع مُتحقَّق منه في Search Console',
      en: 'A site verified in Search Console',
    },
    capabilities: {
      publishText: false,
      publishImage: false,
      publishVideo: false,
      nativeScheduling: false,
      readComments: false,
      readAnalytics: true,
      ads: false,
    },
    access: { reviewRequired: false, reviewNote: GOOGLE_REVIEW, scopes: ['https://www.googleapis.com/auth/webmasters.readonly'] },
    limits: { textMax: 0, requiresMedia: false, mediaKinds: [], hashtagsMax: null, mediaNote: null },
  },
  google_tag_manager: {
    key: 'google_tag_manager',
    name: { ar: 'Google Tag Manager', en: 'Google Tag Manager' },
    category: 'analytics',
    connector: 'google',
    accountRequirement: {
      ar: 'حاوية GTM على موقعك',
      en: 'A GTM container on your site',
    },
    capabilities: {
      publishText: false,
      publishImage: false,
      publishVideo: false,
      nativeScheduling: false,
      readComments: false,
      readAnalytics: false,
      ads: false,
    },
    access: {
      reviewRequired: false,
      reviewNote: {
        ar: 'نقرأ حالة الحاويات والوسوم للتحقق من التتبع، ولا نعدّل الحاوية تلقائيًا.',
        en: 'Containers and tags are read to verify tracking; the container is never modified automatically.',
      },
      scopes: ['https://www.googleapis.com/auth/tagmanager.readonly'],
    },
    limits: { textMax: 0, requiresMedia: false, mediaKinds: [], hashtagsMax: null, mediaNote: null },
  },
  email: {
    key: 'email',
    name: { ar: 'البريد الإلكتروني', en: 'Email' },
    category: 'email',
    connector: 'smtp',
    accountRequirement: {
      ar: 'دومين مُتحقَّق منه عند مزوّد إرسال',
      en: 'A sender domain verified at a delivery provider',
    },
    capabilities: {
      publishText: true,
      publishImage: true,
      publishVideo: false,
      nativeScheduling: false,
      readComments: false,
      readAnalytics: true,
      ads: false,
    },
    access: {
      reviewRequired: false,
      reviewNote: {
        ar: 'الإرسال يحتاج EMAIL_PROVIDER وEMAIL_API_KEY وEMAIL_FROM، والموافقة المسبقة لكل مستلم.',
        en: 'Sending needs EMAIL_PROVIDER, EMAIL_API_KEY and EMAIL_FROM, plus prior consent per recipient.',
      },
      scopes: [],
    },
    limits: {
      textMax: 20000,
      requiresMedia: false,
      mediaKinds: ['image'],
      hashtagsMax: null,
      mediaNote: null,
    },
  },
  whatsapp_cloud: {
    key: 'whatsapp_cloud',
    name: { ar: 'WhatsApp Business Cloud API', en: 'WhatsApp Business Cloud API' },
    category: 'messaging',
    connector: 'none',
    accountRequirement: {
      ar: 'رقم أعمال وWhatsApp Business Account',
      en: 'A business number and a WhatsApp Business Account',
    },
    capabilities: {
      publishText: false,
      publishImage: false,
      publishVideo: false,
      nativeScheduling: false,
      readComments: false,
      readAnalytics: true,
      ads: false,
    },
    access: {
      reviewRequired: true,
      reviewNote: {
        ar: 'الإرسال عبر قوالب معتمدة فقط، ولكل مستلم موافقة موثّقة. الربط يحتاج توكن نظام ورقمًا.',
        en: 'Only approved templates can be sent, each recipient needs recorded opt-in, and connecting needs a system token and a phone number id.',
      },
      scopes: ['whatsapp_business_messaging', 'whatsapp_business_management'],
    },
    limits: {
      textMax: 1024,
      requiresMedia: false,
      mediaKinds: ['image', 'video'],
      hashtagsMax: null,
      mediaNote: {
        ar: 'لا تُرسل رسائل حرة خارج نافذة ٢٤ ساعة؛ القالب المعتمد إلزامي.',
        en: 'Free-form messages are not allowed outside the 24-hour window; an approved template is mandatory.',
      },
    },
  },
};

export const PLATFORM_ORDER: PlatformKey[] = [
  'facebook_page',
  'instagram_business',
  'tiktok_business',
  'snapchat_business',
  'linkedin_org',
  'google_business_profile',
  'ga4',
  'search_console',
  'google_tag_manager',
  'email',
  'whatsapp_cloud',
];

export const PLATFORMS_WITH_OAUTH: PlatformKey[] = [
  'facebook_page',
  'instagram_business',
  'google_business_profile',
  'ga4',
  'search_console',
  'google_tag_manager',
];

export const isPlatform = (value: unknown): value is PlatformKey =>
  typeof value === 'string' && value in PLATFORMS;

export const publishesAnything = (key: PlatformKey) => {
  const caps = PLATFORMS[key].capabilities;
  return caps.publishText || caps.publishImage || caps.publishVideo;
};

// ---------------------------------------------------------------------------
// Availability — what this deployment can do, independent of any company
// ---------------------------------------------------------------------------

export type Availability = 'available' | 'requires_credentials' | 'pending_review' | 'not_supported';

export type DeploymentEnv = {
  META_APP_ID?: string;
  META_APP_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  EMAIL_API_KEY?: string;
  EMAIL_FROM?: string;
};

/** Configured OAuth apps, without revealing the secret values. */
export function connectorConfig(env: DeploymentEnv) {
  const meta = Boolean(env.META_APP_ID && env.META_APP_SECRET);
  const google = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
  const email = Boolean(env.EMAIL_API_KEY && env.EMAIL_FROM);
  return {
    meta: {
      configured: meta,
      clientId: meta ? String(env.META_APP_ID) : null,
      requires: ['META_APP_ID', 'META_APP_SECRET', 'META_REDIRECT_URI'],
    },
    google: {
      configured: google,
      clientId: google ? String(env.GOOGLE_CLIENT_ID) : null,
      requires: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI'],
    },
    email: {
      configured: email,
      requires: ['EMAIL_PROVIDER', 'EMAIL_API_KEY', 'EMAIL_FROM'],
    },
  };
}

/**
 * Availability of a platform for this deployment.
 *
 * `pending_review` is used when the app exists but the platform's advanced
 * access/allowlist has not been recorded as approved for this deployment.
 */
export function availabilityOf(
  key: PlatformKey,
  env: DeploymentEnv,
  settings: Record<string, string>
): { state: Availability; reasons: string[]; accessApproved: boolean; reviewPending: boolean } {
  const spec = PLATFORMS[key];
  const accessApproved = settings[`social.access.${key}`] === 'approved';
  if (spec.connector === 'none') {
    return {
      state: 'not_supported',
      reasons: [
        'oauth_connector_not_implemented',
        ...(spec.access.reviewRequired ? ['app_review_required'] : []),
      ],
      accessApproved: false,
      reviewPending: spec.access.reviewRequired,
    };
  }
  if (spec.connector === 'smtp') {
    const config = connectorConfig(env);
    return config.email.configured
      ? { state: 'available', reasons: [], accessApproved: true, reviewPending: false }
      : {
          state: 'requires_credentials',
          reasons: config.email.requires,
          accessApproved: false,
          reviewPending: false,
        };
  }
  const config = connectorConfig(env);
  const app = spec.connector === 'meta' ? config.meta : config.google;
  if (!app.configured) {
    return {
      state: 'requires_credentials',
      reasons: app.requires,
      accessApproved: false,
      reviewPending: spec.access.reviewRequired,
    };
  }
  // The app exists, so an account you own can connect today. Advanced access is
  // a separate fact: without it, accounts you do not own cannot be served, and
  // the UI says exactly that instead of disabling the connector.
  return {
    state: 'available',
    reasons: [],
    accessApproved,
    reviewPending: spec.access.reviewRequired && !accessApproved,
  };
}

// ---------------------------------------------------------------------------
// Connection state — what is true for a stored account
// ---------------------------------------------------------------------------

export type TokenStatus =
  | 'connected'
  | 'expiring'
  | 'expired'
  | 'requires_reconnect';

export const EXPIRING_DAYS = 7;

export function tokenStatusOf(
  row: { token_status?: string | null; expires_at?: string | null },
  now = Date.now()
): TokenStatus {
  if (row.token_status === 'requires_reconnect') return 'requires_reconnect';
  if (!row.expires_at) return 'connected';
  const expires = Date.parse(row.expires_at);
  if (Number.isNaN(expires)) return 'connected';
  if (expires <= now) return 'expired';
  if (expires - now <= EXPIRING_DAYS * 86_400_000) return 'expiring';
  return 'connected';
}
