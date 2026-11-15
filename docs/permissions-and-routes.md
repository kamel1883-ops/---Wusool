# الصلاحيات والمسارات

## ١. مصفوفة الأدوار

`worker/lib/rbac.ts` هو المصدر الوحيد؛ الخادم يفرضها والواجهة تخفي ما لا يُسمح به فقط.

| الصلاحية | مالك | مدير تسويق | كاتب محتوى | مصمم | قراءة فقط |
| --- | :-: | :-: | :-: | :-: | :-: |
| `company.view` عرض مساحة الشركة | ✅ | ✅ | ✅ | ✅ | ✅ |
| `company.edit` تعديل بيانات الشركة | ✅ | ✅ | — | — | — |
| `team.view` عرض الفريق | ✅ | ✅ | ✅ | ✅ | — |
| `team.manage` إضافة/تعديل/إزالة الأعضاء | ✅ | — | — | — | — |
| `billing.manage` الفواتير وإثباتات التحويل | ✅ | — | — | — | — |
| `subscription.view` (ضمن الفوترة حاليًا) | ✅ | — | — | — | — |
| `content.create` إنشاء محتوى/تصاميم | ✅ | ✅ | ✅ | ✅ | — |
| `content.review` مراجعة وطلب تعديل | ✅ | ✅ | — | — | — |
| `content.approve` الاعتماد النهائي | ✅ | ✅ | — | — | — |
| `leads.manage` العملاء المحتملون | ✅ | ✅ | — | — | — |
| `reports.view` التقارير | ✅ | ✅ | ✅ | ✅ | ✅ |

ملاحظات:
- صلاحيات المحتوى وCRM والتقارير معرّفة الآن وتُفعّل مع وحداتها؛ كل مسار يستدعيها عند إنشائه.
- **Super Admin** ليس دور شركة: صلاحيته على مستوى المنصة (`platform_role = super_admin`) ولا
  يحصل تلقائيًا على عضوية أي شركة.
- إضافة الأعضاء تتطلب اشتراكًا فعّالًا (`402`).
- لا يمكن تعطيل/تخفيض **آخر مالك نشط** (`409 last_owner`)، ولا تعطيل حسابك أو تخفيض دورك كمدير منصة.

## ٢. الشاشات حسب المستخدم

### صفحات عامة
`/` تعريف مؤقت · `/login` · `/forgot` · `/setup` (لمرة واحدة) · `/terms` · `/privacy` · `/support`

### مساحة العميل — `/app/:companyId/*`
| المسار | من يراها |
| --- | --- |
| `/` لوحة التحكم | كل الأعضاء |
| `/company` بيانات الشركة | كل الأعضاء (تحرير: owner + marketing_manager) |
| `/team` الفريق | team.view (تحرير: owner) |
| `/subscription` الاشتراك والفواتير | owner فقط |
| `/activity` سجل النشاط | owner فقط |
| `/settings` اللغة وكلمة المرور | كل الأعضاء |

### لوحة Super Admin — `/admin/*`
`/` نظرة عامة · `/companies` · `/companies/:id` · `/invoices` · `/plans` · `/users` ·
`/usage` · `/audit` · `/settings`

## ٣. واجهة الـ API

جميع الطلبات: Cookie جلسة + ترويسة `x-wusool-client: web`. الطلبات المعدِّلة ترفض إن اختلف
`Origin` عن مضيف الطلب.

### عام
| METHOD | المسار | الوصف |
| --- | --- | --- |
| GET | `/api/public/branding` | الهوية + بيانات الدعم + هل تمت التهيئة |
| POST | `/api/setup` | إنشاء أول Super Admin (مرة واحدة فقط) |
| POST | `/api/auth/login` | دخول (حد ٨ محاولات/١٥ دقيقة) |
| POST | `/api/auth/logout` | خروج وإلغاء الجلسة |
| GET | `/api/auth/me` | المستخدم + شركاته + صلاحياته + الهوية |
| PATCH | `/api/auth/profile` | الاسم واللغة |
| POST | `/api/auth/password` | تغيير كلمة المرور (يُلغي بقية الجلسات) |
| POST | `/api/auth/forgot` | تسجيل طلب استعادة (بلا إرسال بريد في هذه المرحلة) |

### مساحة العميل (عضوية + صلاحية)
| METHOD | المسار | الصلاحية |
| --- | --- | --- |
| GET | `/api/company/:id` | `company.view` |
| PATCH | `/api/company/:id` | `company.edit` (الاسم: owner فقط) |
| GET | `/api/company/:id/members` | `team.view` |
| POST | `/api/company/:id/members` | `team.manage` + اشتراك فعّال |
| PATCH/DELETE | `/api/company/:id/members/:memberId` | `team.manage` |
| GET | `/api/company/:id/invoices` | `billing.manage` |
| POST | `/api/company/:id/invoices/:invoiceId/proofs` | `billing.manage` (multipart, ≤٥MB) |
| GET | `/api/company/:id/proofs/:proofId/file` | `billing.manage` |
| GET | `/api/company/:id/activity` | `team.manage` |

### لوحة الإدارة (Super Admin)
| METHOD | المسار | الوصف |
| --- | --- | --- |
| GET | `/api/admin/overview` | مؤشرات المنصة |
| GET/POST | `/api/admin/companies` | قائمة/إنشاء (مع مالك اختياري وفاتورة أولى) |
| GET/PATCH/DELETE | `/api/admin/companies/:id` | تفاصيل/تحديث الحالة والخطة/حذف |
| POST | `/api/admin/companies/:id/invoices` | إصدار فاتورة |
| GET | `/api/admin/invoices` | كل الفواتير |
| GET | `/api/admin/proofs?status=` | إثباتات التحويل |
| POST | `/api/admin/proofs/:id/review` | اعتماد/رفض (الاعتماد يفعّل الاشتراك) |
| GET | `/api/admin/proofs/:id/file` | ملف خاص |
| GET/POST | `/api/admin/plans` · PATCH `/api/admin/plans/:id` | الخطط والأسعار |
| GET/POST | `/api/admin/users` · PATCH `/api/admin/users/:id` | المستخدمون والأدوار |
| POST | `/api/admin/users/:id/reset-password` | كلمة مرور مؤقتة وإلغاء الجلسات |
| GET | `/api/admin/usage` | استهلاك الذكاء الاصطناعي لكل شركة |
| GET | `/api/admin/audit` | سجلات النظام |
| GET/PATCH | `/api/admin/settings` | إعدادات المنصة (مفاتيح مسموحة فقط) |

## ٤. أكواد الأخطاء المعروضة

كل رمز له ترجمة عربية وإنجليزية في `src/lib/i18n.ts` (`err.*`): `unauthorized`, `forbidden`,
`invalid_credentials`, `too_many_attempts`, `account_disabled`, `password_change_required`,
`subscription_inactive`, `last_owner`, `already_member`, `file_too_large`,
`file_type_not_allowed`, `proof_already_reviewed`, `subscription_end_required`,
`invalid_color`, `csrf_rejected` … وغيرها.

## ٥. سجل التدقيق — الإجراءات المسجّلة الآن

`setup.super_admin_created` · `auth.login` · `auth.login_failed` · `auth.logout` ·
`auth.password_changed` · `auth.password_reset_requested` · `company.created` ·
`company.updated` · `company.status.<status>` · `company.deleted` · `member.added` ·
`member.created` · `member.updated` · `member.removed` · `invoice.created` ·
`payment_proof.uploaded` · `payment_proof.approved` · `payment_proof.rejected` ·
`plan.created` · `plan.updated` · `user.created` · `user.updated` · `user.password_reset` ·
`settings.updated`

كل إجراء يُخزَّن مع: المستخدم (id + بريد)، الشركة إن وُجدت، الكيان، بيانات وصفية، IP، والوقت.

## ٦. المرحلة الثانية — الصلاحيات والمسارات

### مصفوفة إضافية

| الصلاحية | مالك | مدير تسويق | كاتب | مصمم | قراءة فقط |
| --- | :-: | :-: | :-: | :-: | :-: |
| `analysis.view` | ✅ | ✅ | — | — | — |
| `analysis.view_approved` (المعتمد فقط) | — | — | ✅ | ✅ | ✅ |
| `analysis.create` | ✅ | ✅ | — | — | — |
| `analysis.edit` (تعديل/نسخة جديدة) | ✅ | ✅ | — | — | — |
| `analysis.review` (قراءة المسودات وطلب تعديل) | ✅ | ✅ | — | — | — |
| `analysis.approve` | ✅ | — | — | — | — |

### مسارات الشركة (مضافة إلى `/api/company`)

`POST /:companyId/site-analyses` · `GET /:companyId/site-analyses` ·
`GET /:companyId/site-analyses/:analysisId` · `POST …/start` · `POST …/cancel` ·
`POST …/retry` · `PUT …/results` · `POST …/submit-review` · `POST …/approve` ·
`POST …/request-changes` · `GET …/pages` (للمراجعين فقط)

كل مسار: جلسة، عضوية الشركة، صلاحية، حالة الاشتراك (للإنشاء والتشغيل)، ربط `companyId`
من الخادم، وسجل تدقيق.

### مسارات الإدارة

`GET /api/admin/site-analyses` · `GET /api/admin/site-analyses/:id` ·
`POST …/retry` · `POST …/cancel` — بلا محتوى تقرير العميل، وكل اطلاع مُسجَّل.

### إجراءات التدقيق الجديدة

`site_analysis.created` · `site_analysis.started` · `site_analysis.completed` ·
`site_analysis.edited` · `site_analysis.submitted` · `site_analysis.approved` ·
`site_analysis.changes_requested` · `site_analysis.failed` · `site_analysis.retried` ·
`site_analysis.cancelled` · `site_analysis.mock_provider_used` ·
`admin.site_analysis.viewed` · `admin.site_analysis.retried` · `admin.site_analysis.cancelled`

### أكواد أخطاء جديدة

`invalid_url`, `url_not_allowed`, `consent_required`, `analysis_not_found`,
`analysis_in_progress`, `analysis_rate_limited`, `analysis_not_retryable`,
`analysis_not_cancellable`, `analysis_approved`, `analysis_has_no_result`,
`result_required`, `comment_required`, `crawl_no_content`, `crawl_failed`,
`crawler_not_configured`, `crawler_unreachable`, `crawler_failed`,
`ai_provider_not_configured`, `ai_provider_failed`, `ai_provider_unreachable`,
`ai_provider_unsupported`, `ai_invalid_response`
