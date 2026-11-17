# الحسابات والقنوات الاجتماعية — ما يعمل وما ينتظر اعتمادًا خارجيًا

هذا المستند هو المرجع لحالة تكامل كل منصة. الحالة مشتقة من الخادم
(`worker/lib/social/platforms.ts`) ومن أسرار النشر، وليست مفتاحًا في الواجهة.

## ١. الحالات

لكل قناة حالتان تُعرضان معًا:

| الحقل | المعنى |
| --- | --- |
| `availability` | هل يمكن بدء تفويض رسمي الآن؟ (`available` / `requires_credentials` / `pending_review` / `not_supported`) |
| `state` | ما تفعله هذه النسخة فعلًا بالقناة: `working_test` / `requires_credentials` / `requires_app_review` / `not_implemented` / `not_supported` / `blocked_by_hosting` / `live_verified` |
| `capabilityStates` | حالة كل قدرة على حدة (نشر نص/صورة/فيديو، جدولة أصلية، تعليقات، تحليلات، إعلانات) |

`live_verified` لا تُضبط من هذا البناء؛ تحتاج تشغيلًا ناجحًا على حساب حقيقي.

ولكل حساب مرتبط: `connected` / `expiring` (أقل من ٧ أيام) / `expired` / `requires_reconnect`.

## ٢. مصفوفة القدرات (ما تفعله هذه النسخة)

| المنصة | موصل OAuth | نشر | ملاحظة | مراجعة تطبيق |
| --- | --- | --- | --- | --- |
| Facebook Page | Meta (منفّذ) | نص + رابط فقط | الصور/الفيديو **محجوبة قبل الاعتماد** (`facebook_media_not_supported`) | نعم |
| Instagram Business/Creator | Meta (منفّذ) | صورة/فيديو واحد | نص بلا وسيط مرفوض، وCarousel محجوب (`instagram_carousel_not_supported`)، JPEG فقط | نعم |
| LinkedIn Organization | LinkedIn (منفّذ) | غير منفّذ | الربط واكتشاف الصفحات يعملان؛ النشر `not_implemented` | Community Management API |
| X / Twitter | X (منفّذ، PKCE) | غير منفّذ | الربط يعمل؛ النشر يحتاج وصول API مدفوعًا وهو `not_implemented` | وصول مدفوع |
| TikTok Business | TikTok (منفّذ) | غير منفّذ | الربط يعمل؛ النشر يحتاج مراجعة `video.publish` | Content Posting API |
| Snapchat Business | Snapchat (منفّذ) | غير منفّذ | الربط يعمل؛ النشر يحتاج وصول شركاء | Marketing API |
| Google Business Profile | Google (منفّذ) | غير منفّذ | الاكتشاف يشترط وجود Location؛ النشر `not_implemented` | وصول منفصل |
| GA4 / Search Console / GTM | Google (منفّذ) | — | **خارج واجهة المنتج**؛ القدرات `not_implemented` | لا |
| البريد الإلكتروني | مزوّد إرسال | نص/صورة | يحتاج مزوّدًا موثّقًا وموافقة مستلم | SPF/DKIM |
| WhatsApp Cloud | لا OAuth | غير منفّذ | قوالب معتمدة فقط | قوالب |

ملاحظات مثبتة من وثائق Meta:

- نشر Instagram يحتاج وسائط على رابط عام (JPEG للصور) ولا يقبل نصًا بلا وسيط.
- `instagram_content_publish` و`pages_manage_posts` لحسابات لا تملكها تحتاج App Review
  وBusiness Verification؛ حساباتك المضافة إلى التطبيق تعمل بـ Standard Access.
- نشر الصفحة يتم برمز الصفحة لا برمز المستخدم.

## ٣. المنفّذ

- **OAuth رسمي**: Meta، Google، LinkedIn (`organizationAcls`)، X (OAuth 2.0 + PKCE، `users/me`)،
  TikTok (`user/info`)، Snapchat (`/v1/me/organizations`). `state` عشوائي أحادي الاستخدام،
  مربوط بالمستخدم والشركة، وصلاحيته ١٠ دقائق.
- **تخزين الرموز**: AES-256-GCM بمفتاح `SOCIAL_TOKEN_KEY` في جدول منفصل؛ لا مسار يعيد الرمز.
- **عزل الشركات**: كل صف ربط يحمل `company_id`، والشركة تُشتق من العضوية لا من الطلب.
- **مكتبة منشورات**: نسخة غير قابلة للاستبدال عند كل تعديل، تكييف لكل منصة، أخطاء صريحة،
  ومعاينة من الخادم.
- **مراجعة**: `draft → awaiting_approval → approved / changes_requested / rejected` مع سبب إلزامي،
  و`reviewNote` و`reviewedBy/At` محفوظة. الاسترجاع ينشئ **مسودة جديدة** من نسخة قديمة.
- **طابور دائم**: مهمة واحدة لكل هدف، Backoff تصاعدي، ومنع النشر المكرر.
- **حاجز الاشتراك**: كل مسار social يعيد `402 subscription_inactive` لشركة منتهية/معلقة
  (عدا `super_admin`)، وتعليق الشركة يبطل جلسات أعضائها فورًا.
- **اختبارات**: `tests/social.test.mjs` — ١٠٢ فحص على خادم مزوّد محلي يحاكي نقاط Meta وGoogle
  وLinkedIn وX (تبادل الرمز، الاكتشاف، النشر، الفشل الجزئي، إبطال الرمز، الطابور، المراجعة،
  الاسترجاع، حاجز الاشتراك، موافقات الوصول، وحالات القدرات).

## ٤. المتطلبات قبل التشغيل على حساب حقيقي

| المتطلب | الاسم على الخادم | ملاحظات |
| --- | --- | --- |
| تشفير الرموز | `SOCIAL_TOKEN_KEY` | إلزامي؛ بدونه يُرفض الربط. |
| Meta | `META_APP_ID`, `META_APP_SECRET` | Redirect واحد لكل المنصة: `/api/social/oauth/callback`. |
| وصول متقدم Meta | `social.access.facebook_page=approved` و`social.access.instagram_business=approved` | يُسجَّل من لوحة المالك بعد المراجعة، مع Audit. |
| Google | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | نفس الـredirect الواحد؛ تفعيل Analytics Admin / Search Console / Tag Manager. |
| LinkedIn | `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` | نفس الـredirect الواحد؛ تطبيق LinkedIn + نطاق Community Management. |
| X | `X_CLIENT_ID`, `X_CLIENT_SECRET` | نفس الـredirect الواحد؛ OAuth 2.0 مع PKCE. |
| TikTok | `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` | نفس الـredirect الواحد؛ مراجعة Content Posting API. |
| Snapchat | `SNAPCHAT_CLIENT_ID`, `SNAPCHAT_CLIENT_SECRET` | نفس الـredirect الواحد؛ قبول في Marketing API. |
| مُشغّل المهام | `JOBS_SECRET` | بدونه الجدولة تُحفظ ولا تُنفّذ تلقائيًا. |
| رابط عودة مخصّص (اختياري) | `SOCIAL_OAUTH_REDIRECT_URI` | يلزم فقط لنطاق مخصّص أو لتثبيت نطاق واحد؛ وإلا يُشتق من أصل الطلب. |

## ٥. قيود صريحة

1. **لا جدولة تلقائية على Sites**: الطابور دائم، والاستدعاء عبر
   `POST /api/internal/social/tick` بـ`x-wusool-jobs-secret` أو يدويًا. لا Cron هنا.
2. **Publishing for LinkedIn/X/TikTok/Snapchat/GBP غير منفّذ**: الربط يعمل، والنشر محجوب
   باسمه (`publish_not_implemented`) قبل الاعتماد.
3. **Facebook media غير منفّذ**: الصورة تُحجب قبل الاعتماد بدل نشر النص وحده.
4. **WhatsApp**: لا إرسال حر؛ يحتاج قالبًا معتمدًا ورقم أعمال.
5. **الإعلانات المدفوعة**: غير منفّذة، وتظهر كوحدة مستقبلية فقط.
6. **تحليلات المنصات**: قراءة insights غير منفّذة؛ تُعرض `not_implemented` لا صفرًا.

## ٦. ما تم اختباره

- ٣٢٧ فحصًا في `npm test` (منها ١٠٦ لهذا القسم) على Worker حقيقي وD1 محلي.
- لا رمز يظهر في أي استجابة؛ رمز الصفحة يُستخدم للنشر.
- منع الاعتماد قبل الإرسال، ومنع النشر قبل الاعتماد، ومنع التعديل بعد النشر.
- نجاح هدف لا يُعاد عند فشل آخر، وإبطال الرمز يعلّم الحساب `requires_reconnect`.
- **لم يُختبر** على حساب حقيقي: يلزم حساب أعمال ومفاتيح ومراجعة تطبيق.
