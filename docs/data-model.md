# نموذج البيانات

المخطط المنفَّذ الآن في `migrations/0001_init.sql`، ثم الجداول المخططة للمراحل التالية.

## ١. الجداول المنفَّذة (المرحلة الأولى)

### `platform_settings`
إعدادات المنصة كبيانات (لا كود): الهوية، الدعم، الحساب البنكي، بيانات الشركة المالكة، اللغة
الافتراضية، أيام التنبيه، ومفتاح إتمام التهيئة.

| العمود | النوع | ملاحظات |
| --- | --- | --- |
| `key` | TEXT PK | مثل `brand.primary_color`, `billing.iban` |
| `value` | TEXT | نص؛ القوائم كـ CSV |
| `updated_at` | TEXT | ISO |

المفاتيح الافتراضية: `brand.*`, `support.*`, `billing.*`, `owner.*`, `platform.*`,
`subscription.warning_days`. المسموح تعديله من الـ API مقيّد بهذه البادئات، و
`platform.setup_completed` محمي.

### `plans`
| العمود | النوع |
| --- | --- |
| `id` | TEXT PK (`plan_…`) |
| `name_ar`, `name_en` | TEXT |
| `price_sar` | INTEGER (٠ = حسب العرض) |
| `billing_period` | TEXT (`annual`) |
| `max_users` | INTEGER NULL |
| `features_ar`, `features_en` | TEXT (JSON array) |
| `is_active`, `sort_order` | INTEGER |
| `created_at` | TEXT |

### `companies` (المستأجر)
| العمود | النوع |
| --- | --- |
| `id` | TEXT PK (`co_…`) |
| `name`, `legal_name`, `domain`, `industry`, `city`, `country` | TEXT |
| `contact_name`, `contact_email`, `contact_phone` | TEXT |
| `plan_id` | FK → `plans.id` |
| `subscription_start`, `subscription_end` | TEXT (YYYY-MM-DD) |
| `status` | CHECK: `pending｜active｜suspended｜expired｜cancelled` |
| `notes` | TEXT (داخلية، لا تُعرض للعميل) |
| `created_at`, `updated_at` | TEXT |

### `users`
| العمود | النوع |
| --- | --- |
| `id` | TEXT PK (`usr_…`) |
| `email` | TEXT UNIQUE (lowercase) |
| `name` | TEXT |
| `password_hash`, `password_salt` | TEXT |
| `password_iterations` | INTEGER (100000) |
| `locale` | CHECK `ar｜en` |
| `platform_role` | CHECK `none｜super_admin` |
| `status` | CHECK `active｜disabled` |
| `must_change_password` | INTEGER 0/1 |
| `last_login_at`, `created_at`, `updated_at` | TEXT |

### `memberships` (الربط والأدوار)
| العمود | النوع |
| --- | --- |
| `id` | TEXT PK (`mem_…`) |
| `user_id` | FK → `users.id` ON DELETE CASCADE |
| `company_id` | FK → `companies.id` ON DELETE CASCADE |
| `role` | CHECK `owner｜marketing_manager｜content_writer｜designer｜viewer` |
| `status` | CHECK `active｜disabled` |
| `created_at` | TEXT |
| UNIQUE | `(user_id, company_id)` |

### `sessions`
`token_hash` PK، `user_id` FK، `created_at`, `expires_at`, `ip`, `user_agent`.
التوكن نفسه لا يُخزَّن أبدًا.

### `invoices`
| العمود | النوع |
| --- | --- |
| `id` | TEXT PK (`inv_…`) |
| `company_id` | FK |
| `number` | TEXT UNIQUE (`WS-2026-0001`) |
| `amount_sar` | INTEGER |
| `currency` | TEXT (`SAR`) |
| `period_start`, `period_end` | TEXT |
| `issued_at`, `due_at` | TEXT |
| `status` | CHECK `draft｜issued｜pending_review｜paid｜void` |
| `notes` | TEXT |

### `payment_proofs`
| العمود | النوع |
| --- | --- |
| `id` | TEXT PK (`proof_…`) |
| `invoice_id` | FK ON DELETE CASCADE |
| `company_id` | TEXT |
| `uploaded_by` | FK → users |
| `file_key` | TEXT (R2 private) |
| `file_name`, `mime_type`, `size_bytes` | TEXT/INTEGER |
| `reference`, `note` | TEXT |
| `status` | CHECK `pending_review｜approved｜rejected` |
| `reviewed_by`, `reviewed_at`, `review_note` | TEXT |
| `created_at` | TEXT |

### `usage_events`
`id`, `company_id`, `kind` (`site_analysis｜content_generation｜image_generation｜email_send｜whatsapp_send`),
`quantity`, `provider`, `model`, `cost_micros`, `meta`, `created_at`.
تُغذّى من وحدات الذكاء الاصطناعي في المراحل ٢–٥؛ فارغة الآن بشكل مقصود.

### `audit_logs`
`id`, `actor_user_id`, `actor_email`, `company_id`, `action`, `entity_type`, `entity_id`,
`meta` (JSON), `ip`, `created_at`. فهارس على الوقت والشركة و`(action, entity_id)`.

---

## ١-ب. الجداول المنفَّذة (المرحلة الثانية)

`migrations/0002_site_analysis.sql`:

| الجدول | الغرض | ملاحظات |
| --- | --- | --- |
| `site_analyses` | المهمة | `company_id`, `created_by`, `url`, `normalized_url`, الحالة (١٠ حالات), `provider`, `model`, `crawler_provider`, `locale`, `max_pages`, `max_depth`, `consent_confirmed`, `latest_version`, `approved_version`, `robots_policy`, أعداد الصفحات, `error_message`, التوقيتات |
| `site_pages` | الصفحات المقروءة | `analysis_id`, `company_id`, `url`, `title`, `status_code`, `content_markdown`, `content_hash`, `word_count`, `depth`, `crawl_status` (`ok｜blocked｜not_found｜error｜skipped`), `error_message` — فريد لكل `(analysis_id, url)` |
| `analysis_results` | النتيجة المنظمة | `version` فريدة لكل تحليل، `result_json` وفق Schema ثابت، `source_summary`, `confidence`, `created_by_ai`, `edited_by_user` |
| `analysis_approvals` | سجل الاعتماد | `version`, `action` (`submitted｜approved｜changes_requested｜reanalysis_requested`), `user_id`, `comment`, `created_at` |
| `ai_usage_events` | استهلاك المزوّدين | `provider`, `model`, `operation`, `input_tokens`, `output_tokens`, `estimated_cost_micros`, `status`, `error_message` |

مفاتيح إعدادات جديدة: `analysis.default_max_pages`, `analysis.default_max_depth`,
`analysis.max_pages_hard_limit`, `analysis.max_depth_hard_limit`,
`analysis.max_concurrent_jobs`, `analysis.rate_limit_per_hour`,
`analysis.ai_provider`, `analysis.ai_model`, `analysis.crawler_provider`,
`analysis.crawler_user_agent`, `analysis.show_cost_to_client`, `analysis.require_consent`.

## ١-ج. الجداول المنفَّذة (اكتساب العملاء) — `migrations/0006_growth.sql`

| الجدول | الغرض |
| --- | --- |
| `company_icp` | ملف العميل المثالي: خدمات، قطاعات، مدن، كلمات، مشكلات، جمهور، عرض، وأدلة كل بند + `analysis_id` |
| `lead_sources` | حالة مصادر الاكتشاف لكل شركة (لا تُستنتج من الواجهة) |
| `leads` | عميل محتمل بدليل: `source_url` إلزامي، `evidence_text` إلزامي، `interest_signal`، `score` + `score_reason_json`، مصدر البريد/الهاتف، `consent_state`، `do_not_contact`، `campaign_id`، `dedupe_key` فريد لكل شركة |
| `lead_activities` | سجل التواصل (note/email/call/whatsapp/meeting/proposal/stage_change/consent) |
| `suppressions` | قائمة عدم التواصل لكل قناة |
| `campaigns` | حملة: هدف، جمهور، قطاع، مدينة، قناة، محتوى معتمد، ميزانية، حالة محسوبة |
| `campaign_channels` | حالة القناة للحملة وأسباب الفشل |
| `outreach_messages` | كل محاولة إرسال ونتيجتها (sent/failed) — لا سجل بلا محاولة حقيقية |
| `campaign_metrics` | نتائج كل فترة (يدوية، `source='manual'`) |

> قيود مقصودة: لا `leads` بدون `source_url`/`evidence_text`، ولا بريد/هاتف بدون `email_source`/`phone_source`،
> ولا سجل `sent` إلا بعد استجابة مزوّد حقيقي.

## ٢. الجداول المخططة (لا تُنشأ قبل مرحلتها)

### المرحلة الثانية — تحليل الموقع
```sql
site_analyses(id, company_id, requested_by, url, status /* queued|crawling|extracting|
  analyzing|completed|failed */, robots_allowed, pages_found, pages_analyzed, pages_failed,
  error_code, started_at, finished_at, created_at)
site_pages(analysis_id, url, status /* ok|blocked|not_found|error */, http_status,
  title, lang, chars, fetched_at)
analysis_findings(id, analysis_id, section, field, value, source /* extracted|inferred|
  suggestion|unavailable */, evidence_url, confidence, reviewer_state /* pending|accepted|
  rejected|edited */, reviewer_id, reviewed_at, note)
analysis_versions(id, analysis_id, version, snapshot_json, approved_by, approved_at)
```

### المرحلة الثالثة — الاستراتيجية والمحتوى
```sql
strategies(id, company_id, analysis_id, goal, audience_json, channels_json, roadmap_json,
  kpis_json, status, approved_by, approved_at, version)
campaigns(id, company_id, name, objective, audience, channel, offer, starts_on, ends_on,
  budget_sar, status /* draft|planning|awaiting_approval|approved|active|paused|completed|
  archived */, created_by, approved_by, approved_at)
content_items(id, company_id, campaign_id, type /* post|email|whatsapp|landing|article|ad|
  video_idea|bio|offer */, channel, language /* ar|en|bilingual */, objective, audience,
  tone, length, body_ar, body_en, status /* draft|in_review|changes_requested|approved|
  scheduled|published|archived */, current_version, created_by, assigned_to,
  approved_by, approved_at, scheduled_at, published_at, external_ref)
content_versions(id, content_item_id, version, body_ar, body_en, model, provider,
  prompt_hash, created_by, created_at)
strategy_items? -- (اختياري: تفصيل الخارطة إلى مهام)
```

### المرحلة الرابعة — التصاميم
```sql
designs(id, company_id, campaign_id, kind /* post|portrait|story|banner|linkedin|whatsapp|pdf */,
  width, height, headline, subline, cta, brand_snapshot_json, render_json /* layers */,
  image_key, status, version, created_by, approved_by, approved_at)
design_variants(id, design_id, variant_no, image_key, model, prompt, created_at)
```

### المرحلة الخامسة — CRM والمراسلة
```sql
leads(id, company_id, name, company_name, email, phone, country, city, sector, source,
  campaign_id, score, stage /* new|qualified|contacted|replied|meeting|proposal|won|lost|
  do_not_contact */, consent_state /* unknown|granted|withdrawn */, consent_at, owner_user_id,
  last_contact_at, next_follow_up_at, notes, created_at, updated_at)
lead_activities(id, lead_id, kind, note, actor_user_id, created_at)
message_templates(id, company_id, channel /* email|whatsapp */, language, name, subject,
  body, provider_template_id, approval_state)
messages(id, company_id, campaign_id, lead_id, template_id, channel, to_address,
  rendered_body, status /* draft|queued|sending|sent|delivered|failed|bounced|unsubscribed */,
  provider, provider_message_id, scheduled_at, sent_at, error_code, created_by, approved_by,
  approved_at)
suppression_list(id, company_id, channel, address, reason, created_at)
webhook_events(id, provider, event_type, payload, received_at, processed_at)
```

### المرحلة السادسة — التقارير والدفع الإلكتروني
```sql
payments(id, invoice_id, provider, provider_payment_id, amount_sar, status, raw_json, paid_at)
report_snapshots(id, company_id, period, metrics_json, generated_at)
```

**ملاحظات تصميمية:**
- كل جدول خاص بعميل يحمل `company_id` غير قابل للتفاوض، ومفهرس عليه.
- كل جدول محتوى يحمل `status` + `approved_by` + `approved_at` + `version` لتطبيق الاعتماد البشري.
- `analysis_findings.source` يمنع عرض الاستنتاج كحقيقة مستخرجة.
- لا مفاتيح API في الجداول؛ فقط إشارة إلى اسم السر (`secret_ref`) في `ai_providers`.

### جداول منفّذة إضافية (0007–0010)

```sql
-- 0007/0008: الحسابات الاجتماعية والنشر
social_connections(id, company_id, platform, account_id, page_id, profile_id, account_name,
  account_type, token_status, scopes_json, granted_scopes_json, connected_by, connected_at,
  expires_at, last_sync_at, last_error, metadata_json)
social_tokens(connection_id, access_token_enc, refresh_token_enc, key_version)  -- مشفّر فقط
oauth_states(state, company_id, platform, user_id, code_verifier, redirect_uri, created_at,
  expires_at, consumed_at, pending_token_enc, pending_accounts_json)
social_posts(id, company_id, title, body_ar, body_en, link_url, cta_label, hashtags, media_json,
  language, status, version, scheduled_at, submitted_by/at, approved_by/at, review_note,
  reviewed_by, reviewed_at, published_at)
social_post_targets(id, post_id, company_id, connection_id, platform, account_name,
  adapted_text, adapted_json, status, external_id, external_url, error_code, error_message,
  attempts, last_attempt_at, published_at)  -- UNIQUE(connection_id, post_id)
social_post_versions(id, post_id, company_id, version, snapshot_json, created_by, reason)
social_jobs(id, company_id, target_id, state, run_at, attempts, max_attempts, last_error)  -- UNIQUE(target_id)
social_events(id, company_id, post_id, target_id, connection_id, kind, detail, actor_user_id)

-- 0009: القياس الداخلي
tracking_links(id, company_id, campaign_id, post_id, platform, code UNIQUE, label,
  destination_url, utm_*, status, created_by)
tracking_events(id, company_id, link_id, lead_id, post_id, campaign_id, kind, platform,
  occurred_at, period_date, visitor_hash, country, device, referrer_host, metadata_json)
-- leads.tracking_link_id يربط العميل المحتمل بالرابط الذي أنتجه

-- 0010: البوسترات
poster_drafts(id, company_id, title, headline, subhead, cta, template, size_key, width, height,
  brand_color, language, status /* draft|approved|archived */, version, created_by,
  approved_by, approved_at)
```

`tracking_events` لا يحمل عنوان IP ولا User-Agent؛ يحمل `visitor_hash` مملّحًا لعدّ الزوار فقط.
