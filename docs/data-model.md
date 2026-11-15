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
| `password_iterations` | INTEGER (210000) |
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
