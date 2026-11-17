# حالة التنفيذ — المراحل ٠ إلى ١٥

آخر تحديث: ٢٠٢٦-١١-١٧. هذا المستند يصف **ما نُفّذ فعلًا في الكود** وما بقي خارجيًا،
ولا يعتبر أي مرحلة مكتملة إذا كانت واجهتها شكلية أو تحتاج مزوّدًا لم يُفعّل.

## ١. جدول المراحل

| المرحلة | الحالة | ما نُفّذ | ما ينقص |
| --- | --- | --- | --- |
| ٠ — تنظيف الاتجاه | منفّذ | GA4/Search Console/GTM خارج واجهة المنتج (تبقى جداولها)، وتصحيح كل شارات القدرات إلى الحالات السبع | — |
| ١ — ربط الحسابات | منفّذ برمجيًا | ٦ منصات: Meta (Facebook+Instagram)، TikTok، Snapchat، LinkedIn، X — OAuth رسمي، اكتشاف حسابات، ربط/فصل/فحص، رموز مشفّرة، صلاحيات وانتهاء | Publishing لغير Meta/Instagram؛ مفاتيح كل مزوّد ومراجعته |
| ٢ — ملف الشركة والعميل المثالي | منفّذ سابقًا | `company_icp` + derivation من التحليل + شاشة تحرير + تصنيف المصدر | — |
| ٣ — محرر المنشورات | منفّذ | نص/رابط/CTA/هاشتاقات/وسائط، تكييف لكل منصة، منع الاعتماد عند هدف محجوب، حالات كاملة | فيديو/بوستر كوسيط مرفوع يحتاج تخزين R2 مفعّلًا |
| ٤ — المكتبة والنسخ | منفّذ | نسخة لكل تعديل، رفض/طلب تعديلات بسبب، استرجاع ينشئ مسودة جديدة، منع تعديل المنشور المنشور | — |
| ٥ — النشر الفوري | منفّذ لـ Meta | نشر فوري متعدد الأهداف، `partially_published`، إعادة المحاولة للفاشل فقط، منع التكرار | TikTok/Snapchat/LinkedIn/X/GBP = `publish_not_implemented` |
| ٦ — الجدولة والطابور | منفّذ جزئيًا | جدول دائم، مهمة واحدة لكل هدف، Backoff، إلغاء، سجل محاولات، `POST /api/internal/social/tick` بـ`JOBS_SECRET` | لا Cron على Sites → `blocked_by_hosting` معلنة |
| ٧ — اكتشاف العملاء | منفّذ | إدخال يدوي موثّق، مزوّد مرخّص كطبقة إعداد، **OpenStreetMap كمصدر مفتوح مجاني** (`LEAD_DATA_PROVIDER=openstreetmap`، Overpass، استعلام واحد محدّد بنطاق مدينة سعودية، محاولة واحدة على نسخة بديلة عند انشغال الخدمة العامة، فاصل زمني ١٥ ثانية لكل شركة، إسناد ODbL)، **كل ناتج يُحفظ `classification=potential`** بدرجة تطابق مفسّرة مع نشاط العميل، ولا يصبح `confirmed` إلا بفعل بشري، منع Lead بلا مصدر، قائمة عدم التواصل | مزوّد تجاري مرخّص (يحتاج عقدًا ومفاتيح)؛ Instances العامة قد تكون مشغولة (يظهر `lead_source_busy`) |
| ٨ — CRM | منفّذ سابقًا | مراحل، أنشطة، موافقة، منع التواصل، ملكية، حملات وقياس يدوي | إرسال فعلي يحتاج قناة مفعّلة وموافقة |
| ٩ — القياس الداخلي | منفّذ | روابط UTM، Redirect `/t/:code`، بيكين أحداث، نقرات WhatsApp/اتصال/نماذج، ربط الحملة والمنشور، تجزئة زائر مملّحة | مشاهدات/وصول المنصات = `not_implemented` |
| ١٠ — لوحة النتائج | منفّذ | لوحة أداء بمصدر لكل رقم، و`Unavailable` لما لا مصدر له، CPL/ROI عند توفر spend فقط | أفضل منشور/جمهور يحتاج insights |
| ١١ — الديموغرافيا | منفّذ كحالة صريحة | `demographics: unavailable` مع السبب | لا API مجمّعة مفعّلة |
| ١٢ — البوسترات | منفّذ | قوالب + ٦ مقاسات + SVG على الخادم + Draft→Approved→Public + منع تعديل المعتمد | لا رفع صور/خطوط مخصّصة |
| ١٣ — الإعلانات المدفوعة | منفّذ كعنصر نائب | صفحة `Paid Advertising — Future Module` بحالة `not_implemented`، بلا أي زر دفع | وحدة كاملة تحتاج حسابات إعلانية وميزانية وموافقة |
| ١٤ — الأمان والعزل | منفّذ | عزل بالعضوية، CSRF + Origin، رموز AES-GCM، OAuth state أحادي، Rate limit للدخول والبيكين، Audit، إبطال جلسات التعليق، 402 للاشتراك | مراجعة اختراق خارجية غير مُنفّذة |
| ١٥ — الاختبارات | منفّذ | ٤٣٣ فحصًا: ٦٧ + ٤٢ + ٢٨ + ٤٢ + ١١٥ + ٧٢ + ٣١ + ١٩ + ١٧ | لا اختبار متصفح/E2E آلي |

## ٢. الجداول الجديدة

| الملف | الجداول/الأعمدة |
| --- | --- |
| `0008_social_review.sql` | `social_posts.review_note`, `reviewed_by`, `reviewed_at` |
| `0009_tracking.sql` | `tracking_links`, `tracking_events`, `leads.tracking_link_id` |
| `0010_posters.sql` | `poster_drafts` |

كل الجداول تحمل `company_id` مع `ON DELETE CASCADE` وتُقرأ عبر الشركة المشتقة من العضوية.

## ٣. الـAPI الجديدة

| المسار | الوصف |
| --- | --- |
| `GET /api/company/:id/social` | حالة كل قناة (`state` + `capabilityStates`)، الاشتراك، حالة المُشغّل، والتحليلات `not_implemented` |
| `POST /api/company/:id/social/posts/:postId/reject` | رفض بسبب إلزامي |
| `POST /api/company/:id/social/posts/:postId/request-changes` | طلب تعديلات بسبب إلزامي |
| `GET /api/company/:id/social/posts/:postId/versions/:version` | محتوى نسخة محفوظة |
| `POST /api/company/:id/social/posts/:postId/versions/:version/restore` | استرجاع ينشئ مسودة جديدة |
| `GET/POST/PATCH/DELETE /api/company/:id/tracking/links…` | بناء روابط UTM وإدارتها |
| `GET /api/company/:id/tracking` | إجماليات النقرات والأحداث والزوار والنسب |
| `GET /t/:code` | تحويل عام (302) مع UTMs وتسجيل نقرة |
| `POST /api/tracking/events` | بيكين عام (page_view/whatsapp_click/call_click/form_submit) بحدّ لكل زائر |
| `GET /api/company/:id/dashboard` | لوحة الأداء بمصدر لكل رقم و`Unavailable` لغير المتوفر |
| `GET/POST/PATCH /api/company/:id/posters…` | إنشاء/تحرير بوسترات |
| `POST /api/company/:id/posters/:id/approve\|archive` | اعتماد/أرشفة |
| `GET /api/company/:id/posters/:id/preview.svg` | معاينة مصادق عليها للمسودة |
| `GET /api/public/posters/:id.svg` | البوستر المعتمد فقط |
| `PATCH /api/admin/settings` | تسجيل `social.access.*` مع رفض أي مفتاح غير مدعوم وAudit |

## ٤. ما يعمل بالمحاكاة وما يحتاج خارجيًا

- **يعمل بالمحاكاة (local provider server)**: Meta OAuth + النشر، Google/‏LinkedIn/X/TikTok/Snapchat
  discovery، فشل المزوّد، إبطال الرمز، الطابور، الفشل الجزئي.
- **يحتاج Credentials**: أي مزوّد بلا مفاتيحه يظهر `requires_credentials` بأسماء المتغيرات.
- **يحتاج App Review / وصولًا**: Meta Advanced Access، LinkedIn Community Management،
  TikTok Content Posting، Snapchat Marketing API، X paid tier، Google Business Profile access.
- **يحتاج Scheduler**: التنفيذ التلقائي للجدولة (`blocked_by_hosting` على Sites)؛ الاستدعاء
  الخارجي بـ`JOBS_SECRET` متاح ومُختبَر.
- **غير مدعوم رسميًا**: نشر وسائط Facebook، Carousel على Instagram، إرسال WhatsApp حر،
  قراءة insights، إعلانات مدفوعة، تجاوز حماية المنصات أو كشطها.

## ٥. المفاتيح المطلوبة لاحقًا

`SOCIAL_TOKEN_KEY`, `JOBS_SECRET`, `TRACKING_SALT`,
`META_APP_ID/SECRET`, `GOOGLE_CLIENT_ID/SECRET`, `LINKEDIN_CLIENT_ID/SECRET`,
`X_CLIENT_ID/SECRET`, `TIKTOK_CLIENT_KEY/SECRET`, `SNAPCHAT_CLIENT_ID/SECRET`,
`EMAIL_PROVIDER/API_KEY/FROM`, `LEAD_DATA_PROVIDER/API_URL/API_KEY`
(أو `LEAD_DATA_PROVIDER=openstreetmap` بلا أي مفتاح، و`LEAD_DATA_API_URL` اختياري لتوجيه Overpass
إلى مرآة أو نسخة داخلية),
`OWNER_RESET_SECRET` (اختياري: يفعّل `/reset-owner` لمرة واحدة عند نسيان كلمة مرور المالك).

رابط العودة في كل مزوّد هو **رابط واحد للمنصة**: `/api/social/oauth/callback`
(يُسجَّل مرة واحدة لكل تطبيق مزوّد، والشركة تُستخرج من `state` وتُطابق العضوية).
`SOCIAL_OAUTH_REDIRECT_URI` اختياري لتثبيت نطاق مخصّص.

لا يوضع أي مفتاح في الكود أو Git؛ تُضبط كأسرار نشر.

## ٦. ما لم يُختبر

- أي حساب حقيقي على المنصات الست (يلزم مفاتيح ومراجعة).
- تفاعل المتصفح يدويًا (لم تُجرَ جولة نقر على الواجهة في هذه الجولة).
- Cron فعلي على استضافة Sites.
- اختبار اختراق خارجي.

## ٧. الفحوص

```
npm ci
npm run check      # tsc للواجهة والـWorker
npm run build      # vite build
npm test           # ٤٣٣ فحصًا على Worker حقيقي وD1 محلي (بعد npm run build)
```
