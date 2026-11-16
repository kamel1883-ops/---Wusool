/**
 * Legal and support documents.
 *
 * These describe what the platform actually does: the crawl, the report, the
 * approval step, the plan limits enforced by the API, manual bank transfer
 * billing, and the processors the deployment runs on. `{email}` is replaced at
 * render time with the support address configured in the admin settings.
 */

export type LegalBlock = {
  heading: string;
  paragraphs?: string[];
  bullets?: string[];
};

export type LegalDoc = {
  title: string;
  subtitle: string;
  updated: string;
  intro: string;
  blocks: LegalBlock[];
};

type LegalSet = { terms: LegalDoc; privacy: LegalDoc; support: LegalDoc };

const UPDATED_AR = '١٦ نوفمبر ٢٠٢٦';
const UPDATED_EN = '16 November 2026';

export const LEGAL: Record<'ar' | 'en', LegalSet> = {
  ar: {
    terms: {
      title: 'الشروط والأحكام',
      subtitle: 'اتفاقية استخدام منصة «وصول»',
      updated: UPDATED_AR,
      intro:
        'تنظّم هذه الشروط علاقتك بمنصة «وصول» (Wusool) عند زيارتك للموقع أو تجربة التحليل أو الاشتراك في إحدى الباقات. باستخدامك الخدمة فإنك تقرّ بقراءتها والموافقة عليها. إن لم توافق عليها، فيرجى التوقف عن استخدام المنصة.',
      blocks: [
        {
          heading: '١. تعريف الخدمة',
          paragraphs: [
            '«وصول» منصة برمجية قائمة على السحابة تساعد فرق التسويق في الشركات على قراءة موقعها، وتحويل صفحاته إلى تقرير استراتيجي منظّم، ثم بناء شرائح الجمهور ومقترحات الحملات، ومراجعة المحتوى واعتماده قبل النشر أو الإرسال.',
            'تعمل المنصة بنموذج «خدمة كخدمة» (SaaS) عبر المتصفح، ولا تتطلب تثبيتًا على أجهزتك. تحتفظ المنصة بحق إضافة مراحل ومزايا جديدة، ويُوضّح في الصفحة الرئيسية وباقي الشاشات ما هو متاح فعليًا وما هو قيد التطوير.',
          ],
        },
        {
          heading: '٢. الحساب والصلاحيات',
          bullets: [
            'يُنشأ الحساب على مستوى الشركة، ويُدار من مالك الحساب الذي يضيف أعضاء الفريق ويحدد أدوارهم.',
            'أنت مسؤول عن سرية بيانات الدخول وعن كل نشاط يجري عبر حسابات شركتك، وعن إبلاغنا فورًا عند أي استخدام غير مصرّح به.',
            'يجب أن يكون المستخدم ممثّلًا مفوَّضًا عن الشركة المشتركة، وأن تكون بيانات الشركة المقدَّمة صحيحة ومحدَّثة.',
            'قد نطلب تحققًا إضافيًا من ملكية النطاق أو الشركة قبل تفعيل بعض المزايا.',
          ],
        },
        {
          heading: '٣. الاستخدام المسموح',
          bullets: [
            'تحليل المواقع التي تملكها أو التي لديك تفويض صريح بتحليلها فقط.',
            'الالتزام بشروط استخدام المواقع التي تحلّلها وبملف robots.txt الخاص بها، وعدم محاولة الوصول إلى مناطق محمية أو تجاوز أي حماية تقنية.',
            'عدم استخدام المنصة لإرسال بريد مزعج، أو محتوى مضلّل، أو ما يخالف الأنظمة السعودية أو حقوق الغير.',
            'عدم إجراء هندسة عكسية، أو إعادة بيع الخدمة، أو إتاحة الوصول لأطراف خارج نطاق شركتك، أو استخراج البيانات آليًا لإعادة نشرها.',
            'عدم استخدام المنصة لاختبار أحمال أو هجمات، أو لأي غرض يضرّ بالمنصة أو بمزوّدي الخدمة.',
          ],
        },
        {
          heading: '٤. محتوى العميل ومسؤوليته',
          paragraphs: [
            'تبقى ملكية موقعك وبياناتك ومحتواك لك. أنت تقرّ بأن لديك الحق في تحليل الموقع وبأن المحتوى الذي ترفعه لا ينتهك حقوق ملكية فكرية أو حقوق خصوصية لأحد.',
            'أنت المسؤول عن مراجعة أي نص أو تصميم قبل نشره، وعن مطابقته لهوية شركتك ولمتطلبات القطاع الذي تعمل فيه.',
          ],
        },
        {
          heading: '٥. مخرجات الذكاء الاصطناعي',
          paragraphs: [
            'يُستخدم نموذج لغوي لتحويل محتوى موقعك إلى مسودة تقرير ومقترحات. المخرجات مساعدة تحريرية وليست استشارة قانونية أو مالية أو ضمانًا لنتائج تسويقية، وقد تحتوي أخطاء أو افتراضات غير دقيقة.',
            'لهذا صُمّمت المنصة على قاعدة «اعتماد بشري قبل التنفيذ»: لا يُنشر محتوى ولا يُرسل شيء إلى جمهورك دون اعتماد صريح من مستخدم مفوَّض في شركتك، ويظل القرار التجاري مسؤوليتك.',
          ],
        },
        {
          heading: '٦. الباقات والحدود',
          paragraphs: [
            'تحدد كل باقة عدد المقاعد، وعدد التحاليل الشهرية، وعدد التحاليل المتزامنة، وبعض المزايا. تُطبَّق هذه الحدود تقنيًا على مستوى الواجهة البرمجية، ويظهر استهلاكك في شاشة الاشتراك.',
            'عند تجاوز الحد الشهري يتوقف إنشاء تحليلات جديدة حتى بداية الدورة التالية أو ترقية الباقة، ولا تُحذف تحليلاتك السابقة.',
          ],
        },
        {
          heading: '٧. الأسعار والدفع',
          bullets: [
            'الأسعار بالريال السعودي وتظهر في صفحة الباقات وفي شاشة الاشتراك قبل تأكيد الطلب.',
            'الدفع حاليًا عبر تحويل بنكي يدوي إلى الحساب المعتمد، ثم رفع إثبات التحويل داخل المنصة. لا تُحصَّل أي بيانات بطاقة في المنصة.',
            'يُراجع فريقنا الطلب والإثبات قبل التفعيل، وقد يُطلب إثبات هوية الشركة أو الفاتورة الضريبية.',
            'لا يبدأ احتساب مدة الاشتراك إلا بعد تفعيل الطلب، ويصلك إشعار بذلك داخل المنصة.',
          ],
        },
        {
          heading: '٨. التجديد والإلغاء والاسترداد',
          paragraphs: [
            'الاشتراك محدد المدة ولا يتجدّد تلقائيًا بخصم من بطاقة؛ يصلك تنبيه قبل الانتهاء لتجديده. عند عدم التجديد يتحول الحساب إلى وضع القراءة فقط ثم يُغلق الوصول بعد انتهاء مهلة السماح.',
            'يمكنك طلب الإلغاء في أي وقت. تُقيَّم طلبات استرداد المبالغ المدفوعة مقدَّمًا بحسب ما استُهلك من مدة وخدمات، وبحدود ما تسمح به الأنظمة، ولا تُسترد المبالغ مقابل فترات استُخدمت فعليًا.',
          ],
        },
        {
          heading: '٩. التوفر والتعديلات',
          paragraphs: [
            'نسعى لتوفر الخدمة على مدار الساعة، وقد تتوقف مؤقتًا لأعمال صيانة أو تحديث تُعلَن مسبقًا عند الإمكان. لا نضمن عمل أي مزوّد خارجي (مثل مزوّد الذكاء الاصطناعي) بشكل متواصل.',
            'قد نعدّل ميزة أو نوقفها، وإن كان التعديل جوهريًا ومؤثرًا على اشتراك مدفوع فسنُشعرك مسبقًا ونمنحك خيار إنهاء المدة المتبقية وفق سياسة الاسترداد.',
          ],
        },
        {
          heading: '١٠. الملكية الفكرية',
          paragraphs: [
            'المنصة وعلامتها وشيفرتها وتصاميمها مملوكة لمزوّد الخدمة. لا يمنحك هذا الاتفاق أي حق في حقوق الملكية الفكرية عدا حق استخدام محدود وغير قابل للتحويل لاستخدام الخدمة داخل شركتك.',
            'التقارير والمخرجات المولَّدة من محتوى موقعك متاحة لك لاستخدامها في أعمال شركتك.',
          ],
        },
        {
          heading: '١١. إنهاء الخدمة',
          paragraphs: [
            'يمكننا تعليق أو إنهاء الوصول عند مخالفة هذه الشروط أو محاولة الإضرار بالمنصة أو عدم سداد المستحقات، مع إشعارك عند الإمكان.',
            'عند إنهاء الحساب يمكنك طلب تصدير بياناتك خلال ٣٠ يومًا من الإنهاء، وبعدها تُحذف أو تُخفى هويتها وفق سياسة الخصوصية.',
          ],
        },
        {
          heading: '١٢. حدود المسؤولية',
          paragraphs: [
            'تُقدَّم الخدمة «كما هي». وفي الحدود التي تسمح بها الأنظمة، لا نتحمّل مسؤولية الأضرار غير المباشرة أو فقدان الأرباح أو السمعة أو البيانات الناتجة عن استخدام المخرجات دون مراجعة بشرية.',
            'وباستثناء حالات الغش أو الإهمال الجسيم أو ما لا يجوز استبعاده نظامًا، فإن مجموع مسؤوليتنا عن أي مطالبة لا يتجاوز ما دفعته فعليًا خلال الاثني عشر شهرًا السابقة للمطالبة.',
          ],
        },
        {
          heading: '١٣. التعديلات والقانون الواجب التطبيق',
          paragraphs: [
            'قد نحدّث هذه الشروط، وننشر النسخة السارية هنا مع تاريخ التحديث، ونُشعرك داخل المنصة عند التغيير الجوهري. استمرار استخدامك بعد التحديث يعني موافقتك عليه.',
            'تخضع هذه الشروط لأنظمة المملكة العربية السعودية، ونسعى أولًا لتسوية أي خلاف وديًا عبر {email}، فإن تعذّر ذلك فتختص الجهات القضائية المختصة في المملكة بالنظر فيه.',
          ],
        },
      ],
    },
    privacy: {
      title: 'سياسة الخصوصية',
      subtitle: 'كيف نجمع بياناتك ونستخدمها ونحميها',
      updated: UPDATED_AR,
      intro:
        'نأخذ خصوصيتك على محمل الجد. توضّح هذه السياسة ما نجمعه عند إنشاء حساب في «وصول» أو تحليل موقع أو طلب اشتراك، ولماذا نجمعه، ومع من نشاركه، وكم نحتفظ به، وكيف تطلب الوصول إليه أو حذفه.',
      blocks: [
        {
          heading: '١. نطاق هذه السياسة',
          paragraphs: [
            'تغطي هذه السياسة بيانات حسابات الشركات وأعضاء الفريق وطلبات الاشتراك والتحليلات المولَّدة عبر المنصة. وهي لا تغطي مواقع أطراف ثالثة قد تنتقل إليها من روابط خارجية.',
          ],
        },
        {
          heading: '٢. البيانات التي نجمعها',
          bullets: [
            'بيانات الحساب: الاسم، البريد الإلكتروني، الدور داخل الشركة، وكلمة مرور مخزَّنة بصيغة مشفّرة غير قابلة للاسترجاع.',
            'بيانات الشركة: الاسم، النطاق، القطاع، وبيانات الفوترة اللازمة لإصدار الفاتورة.',
            'بيانات الاشتراك: الباقة، المدة، المبلغ، حالة الطلب، وإثبات التحويل البنكي الذي ترفعه (يُخزَّن في مساحة تخزين خاصة غير عامة).',
            'بيانات الموقع المحلَّل: الرابط العام، والصفحات التي زحفها النظام، والتقرير الناتج، والملاحظات والمحادثات المرتبطة بالتحليل.',
            'بيانات الاستخدام: عدد التحاليل، والتحاليل المتزامنة، وسجل مختصر للعمليات (مثل من اعتمد محتوى ومتى) لأغراض الأمان والدعم.',
            'بيانات تقنية: عنوان IP في سجلات الأمان، ونوع المتصفح، ووقت الطلب، لحماية الخدمة من الإساءة.',
          ],
        },
        {
          heading: '٣. كيف نحصل على البيانات',
          paragraphs: [
            'معظم البيانات تقدّمها أنت مباشرة عند التسجيل أو طلب العرض أو رفع إثبات التحويل. وبعضها يُنشأ تلقائيًا أثناء استخدام المنصة (سجلات، تحاليل، استهلاك). وبيانات الموقع المحلَّل نحصل عليها من صفحات موقعك المتاحة للعموم فقط.',
          ],
        },
        {
          heading: '٤. الغرض من المعالجة',
          bullets: [
            'تقديم الخدمة: إنشاء التحليل، وإعداد التقرير، وإدارة الاشتراك والصلاحيات.',
            'الفوترة والمحاسبة: مطابقة التحويل البنكي وإصدار الفواتير.',
            'الأمان ومنع الإساءة: كشف محاولات الدخول غير المصرّح بها وتحديد الاستخدام الشاذ.',
            'الدعم والتحسين: فهم الأعطال وتطوير المزايا بناءً على الاستخدام المجمَّع.',
            'الالتزام النظامي: حفظ السجلات المطلوبة نظامًا والرد على الجهات المختصة.',
          ],
        },
        {
          heading: '٥. ملفات تعريف الارتباط',
          paragraphs: [
            'نستخدم ملف جلسة واحدًا ضروريًا لتسجيل الدخول، بخصائص HttpOnly وSameSite، ولا يُستخدم للتتبّع الإعلاني. لا نستخدم أدوات تحليلات سلوكية أو بكسلات إعلانية. إغلاق الجلسة أو تسجيل الخروج ينهي صلاحيته.',
          ],
        },
        {
          heading: '٦. المشاركة مع مزوّدي الخدمة',
          paragraphs: [
            'لا نبيع بياناتك. نشاركها فقط مع مزوّدين يعالجونها نيابةً عنّا وبالقدر اللازم لتشغيل الخدمة:',
          ],
          bullets: [
            'مزوّد الاستضافة وقاعدة البيانات والتخزين السحابي (Cloudflare) لاستضافة الموقع وتشغيل قاعدة البيانات والنسخ الاحتياطية.',
            'مزوّد نموذج لغوي لتحليل محتوى الصفحات المزحوفة وصياغة مسودة التقرير.',
            'مزوّد بريد معاملاتي لإرسال رسائل الحساب والتفعيل — عند تفعيله.',
            'الجهات الرسمية عند وجود طلب نظامي واجب النفاذ.',
          ],
        },
        {
          heading: '٧. نقل البيانات خارج المملكة',
          paragraphs: [
            'قد يعالج مزوّدو الاستضافة والذكاء الاصطناعي البيانات خارج المملكة العربية السعودية. نتعاقد معهم على ضوابط حماية مناسبة وننقل الحد الأدنى اللازم فقط، ولا ننقل بيانات الفوترة إلى مزوّد الذكاء الاصطناعي.',
          ],
        },
        {
          heading: '٨. زحف موقعك واحترام خصوصيته',
          bullets: [
            'نقرأ الصفحات العامة فقط، ونحترم ملف robots.txt وسياسة الموقع، ولا نتجاوز أي حماية أو جدار دخول.',
            'لا نحلّل صفحات تتطلب تسجيل دخول، ولا نستخدم بيانات اعتماد خاصة بك للوصول إلى لوحات إدارة.',
            'يمكنك في أي وقت طلب حذف تحليل معيّن وبياناته المرتبطة.',
          ],
        },
        {
          heading: '٩. مدة الحفظ',
          paragraphs: [
            'نحتفظ ببيانات الحساب والتحاليل مدة سريان الاشتراك، ثم لمدة أقصاها ٩٠ يومًا بعد الإنهاء لأغراض النسخ الاحتياطي والاسترداد، وبعدها تُحذف أو تُخفى هويتها.',
            'تُحفظ سجلات الفوترة للمدة التي تفرضها الأنظمة المحاسبية والضريبية، وسجلات الأمان مدة أقصاها ١٢ شهرًا.',
          ],
        },
        {
          heading: '١٠. حقوقك',
          bullets: [
            'الوصول إلى بياناتك والحصول على نسخة منها.',
            'تصحيح بيانات غير دقيقة أو تحديثها.',
            'طلب حذف بياناتك أو تقييد معالجتها (مع مراعاة ما يُلزمنا به النظام).',
            'الاعتراض على معالجة معيّنة وسحب موافقتك حيث تستند المعالجة إلى الموافقة.',
            'تقديم شكوى إلينا عبر {email}، ولك الحق في اللجوء إلى الجهة المختصة بحماية البيانات في المملكة.',
          ],
        },
        {
          heading: '١١. الأمان',
          paragraphs: [
            'كلمات المرور تُخزَّن بصيغة مشفّرة (PBKDF2) ولا يمكن استرجاعها. الاتصال مشفّر عبر TLS، وبيانات كل شركة معزولة عن غيرها على مستوى الاستعلام والصلاحيات، والوصول إلى بيانات الشركة محدود بأعضائها المصرّح لهم.',
            'ورغم ذلك لا يمكن ضمان أمان مطلق لأي نظام. عند وقوع حادث يؤثر على بياناتك نُبلغك ونُبلغ الجهات المختصة وفق ما يقتضيه النظام.',
          ],
        },
        {
          heading: '١٢. الأطفال والتحديثات',
          paragraphs: [
            'الخدمة موجَّهة للاستخدام المهني ولا تُقدَّم لمن هم دون ١٨ عامًا. وقد نحدّث هذه السياسة وننشر النسخة السارية مع تاريخ التحديث، ونُشعرك داخل المنصة عند التغيير الجوهري.',
            'لأي استفسار أو طلب متعلق بالخصوصية راسلنا على {email}.',
          ],
        },
      ],
    },
    support: {
      title: 'الدعم والشكاوى',
      subtitle: 'قناة واحدة واضحة، ومتابعة بشرية',
      updated: UPDATED_AR,
      intro:
        'كل رسالة تصلنا يقرأها شخص من فريق «وصول»، لا نظام آلي. استخدم البريد أدناه لأي استفسار قبل الاشتراك، أو مشكلة تقنية، أو شكوى، أو طلب متعلق ببياناتك.',
      blocks: [
        {
          heading: '١. كيف تتواصل معنا',
          bullets: [
            'البريد الإلكتروني: {email}',
            'أوقات المتابعة: الأحد إلى الخميس، ٩ صباحًا – ٦ مساءً بتوقيت الرياض.',
            'مدة الرد المعتادة: يوم عمل واحد، وقد تصل إلى يومين في المواسم.',
            'لأسرع معالجة، اذكر في الرسالة اسم الشركة والبريد المسجَّل ورقم الفاتورة إن وُجد.',
          ],
        },
        {
          heading: '٢. الاستفسارات قبل الاشتراك',
          paragraphs: [
            'إن أردت معرفة ما إذا كانت المنصة تناسب قطاعك أو حجم فريقك، أرسل لنا رابط موقعك وعدد الأشخاص الذين سيستخدمون النظام، وسنوضّح لك ما هو متاح فعليًا وما هو قيد التطوير قبل أي التزام مالي.',
          ],
        },
        {
          heading: '٣. الشكاوى',
          bullets: [
            'أرسل رسالة بعنوان يبدأ بكلمة «شكوى» إلى {email}.',
            'نُرسل إقرار استلام خلال يوم عمل، ونعود إليك بنتيجة أو خطة معالجة خلال ٥ أيام عمل.',
            'إن لم تُحل الشكوى بما يرضيك، يمكنك طلب تصعيدها إلى مسؤول الخدمة عبر نفس البريد، وسنوضّح لك خطوات التصعيد.',
          ],
        },
        {
          heading: '٤. طلبات الخصوصية والبيانات',
          paragraphs: [
            'لطلب نسخة من بياناتك أو تصحيحها أو حذفها، راسلنا على {email} من البريد المسجَّل في الحساب. قد نطلب ما يثبت أنك صاحب الحساب قبل التنفيذ، ونستجيب خلال ٣٠ يومًا كحد أقصى.',
          ],
        },
        {
          heading: '٥. الدعم الفني',
          bullets: [
            'اذكر ما الذي كنت تحاول فعله، وما ظهر لك بدقة، ووقت المشكلة بتوقيت الرياض.',
            'أرفق لقطة شاشة إن أمكن، ومعرّف التحليل أو اسم الشركة.',
            'لا ترسل كلمة المرور أو رمز الدخول في أي رسالة؛ لن نطلبها منك أبدًا.',
          ],
        },
        {
          heading: '٦. الفواتير والدفع',
          paragraphs: [
            'الدفع حاليًا بتحويل بنكي يدوي مع رفع إثبات التحويل داخل المنصة. لتعديل فاتورة أو تصحيح مبلغ أو الاستفسار عن تأخر التفعيل، راسلنا على {email} مع رقم الطلب.',
          ],
        },
        {
          heading: '٧. الإبلاغ عن محتوى أو إساءة استخدام',
          paragraphs: [
            'إن لاحظت محتوى مضلِّلًا أو استخدامًا مخالفًا للشروط، أو تعرّض موقعك لتحليل دون تفويض، أبلغنا على {email} وسنتحقق ونوقف الوصول عند ثبوت المخالفة.',
          ],
        },
      ],
    },
  },
  en: {
    terms: {
      title: 'Terms of Service',
      subtitle: 'Agreement for using the Wusool platform',
      updated: UPDATED_EN,
      intro:
        'These terms govern your relationship with Wusool when you visit the site, run a trial analysis or subscribe to a plan. By using the service you confirm that you have read and accepted them. If you do not agree, please stop using the platform.',
      blocks: [
        {
          heading: '1. The service',
          paragraphs: [
            'Wusool is a cloud software platform that helps marketing teams read their website, turn its pages into a sourced strategy report, then build audience segments and campaign suggestions, and review and approve content before anything is published or sent.',
            'The platform is delivered as a browser-based service. We may add stages and features over time, and the landing page and in-app screens always state what is live today and what is still in development.',
          ],
        },
        {
          heading: '2. Accounts and permissions',
          bullets: [
            'An account belongs to a company and is administered by its owner, who invites team members and assigns their roles.',
            'You are responsible for keeping credentials confidential and for all activity under your company’s accounts, and for reporting unauthorised use immediately.',
            'Users must be authorised representatives of the subscribing company, and company details you provide must be accurate and current.',
            'We may request additional proof of domain or company ownership before enabling certain capabilities.',
          ],
        },
        {
          heading: '3. Acceptable use',
          bullets: [
            'Analyse only websites you own or are explicitly authorised to analyse.',
            'Respect the terms and robots.txt of the sites you analyse, and never attempt to reach protected areas or bypass technical protection.',
            'Do not use the platform for spam, misleading content, or anything that violates Saudi law or third-party rights.',
            'Do not reverse engineer, resell, share access outside your company, or scrape the platform to republish its data.',
            'Do not use the platform for load testing, attacks, or any purpose that harms the service or its providers.',
          ],
        },
        {
          heading: '4. Your content and your responsibility',
          paragraphs: [
            'Your website, data and content remain yours. You confirm that you have the right to analyse the site and that content you upload does not infringe anyone’s intellectual property or privacy.',
            'You are responsible for reviewing every text and design before publishing it, and for its fit with your brand and your sector’s requirements.',
          ],
        },
        {
          heading: '5. AI output',
          paragraphs: [
            'A language model turns your site content into a draft report and suggestions. That output is editorial assistance: it is not legal or financial advice, not a guarantee of marketing results, and may contain errors or inaccurate assumptions.',
            'The platform is therefore built around human approval: nothing is published and nothing is sent to your audience without explicit approval by an authorised user in your company, and the commercial decision remains yours.',
          ],
        },
        {
          heading: '6. Plans and limits',
          paragraphs: [
            'Each plan sets seats, monthly analyses, concurrent analyses and certain capabilities. These limits are enforced by the API, and your usage is shown on the subscription screen.',
            'When the monthly limit is reached, new analyses pause until the next cycle or an upgrade; existing analyses are never deleted.',
          ],
        },
        {
          heading: '7. Prices and payment',
          bullets: [
            'Prices are in Saudi Riyal and are shown on the plans page and the subscription screen before you confirm an order.',
            'Payment is currently by manual bank transfer to the approved account, followed by uploading proof of transfer in the platform. No card details are collected.',
            'Our team reviews the order and its proof before activation, and may request company verification or a tax invoice.',
            'The subscription period starts only after activation, and you are notified in the platform.',
          ],
        },
        {
          heading: '8. Renewal, cancellation and refunds',
          paragraphs: [
            'Subscriptions run for a fixed term and do not auto-renew by card charge; you receive a reminder before expiry. Without renewal the account becomes read-only and access closes after a grace period.',
            'You may request cancellation at any time. Refunds of prepaid amounts are assessed against the term and services already consumed, within the limits of applicable law, and periods already used are not refunded.',
          ],
        },
        {
          heading: '9. Availability and changes',
          paragraphs: [
            'We aim for continuous availability, but maintenance or upgrades may pause the service, announced in advance where possible. We do not guarantee uninterrupted operation of external providers such as the AI model.',
            'We may change or retire a feature. If a change materially affects a paid subscription we will give advance notice and offer to end the remaining term under the refund policy.',
          ],
        },
        {
          heading: '10. Intellectual property',
          paragraphs: [
            'The platform, its mark, code and designs belong to the provider. This agreement grants you only a limited, non-transferable right to use the service within your company.',
            'Reports and outputs generated from your site content are available to you for your company’s work.',
          ],
        },
        {
          heading: '11. Termination',
          paragraphs: [
            'We may suspend or terminate access for breach of these terms, attempts to harm the platform, or non-payment, with notice where possible.',
            'After termination you may request an export of your data within 30 days, after which it is deleted or anonymised as described in the privacy policy.',
          ],
        },
        {
          heading: '12. Limitation of liability',
          paragraphs: [
            'The service is provided “as is”. To the extent permitted by law, we are not liable for indirect damages, lost profits, reputation or data arising from using outputs without human review.',
            'Except for fraud, gross negligence or matters that cannot be excluded by law, our total liability for any claim is limited to what you actually paid in the twelve months preceding the claim.',
          ],
        },
        {
          heading: '13. Changes and governing law',
          paragraphs: [
            'We may update these terms, publish the effective version here with its update date, and notify you in the platform of material changes. Continued use after an update means acceptance.',
            'These terms are governed by the laws of the Kingdom of Saudi Arabia. We will first seek an amicable resolution via {email}; otherwise the competent courts in the Kingdom have jurisdiction.',
          ],
        },
      ],
    },
    privacy: {
      title: 'Privacy Policy',
      subtitle: 'What we collect, why, and how we protect it',
      updated: UPDATED_EN,
      intro:
        'We take privacy seriously. This policy explains what we collect when you create a Wusool account, analyse a site or request a subscription, why we collect it, who we share it with, how long we keep it, and how you can access or delete it.',
      blocks: [
        {
          heading: '1. Scope',
          paragraphs: [
            'This policy covers company accounts, team members, subscription requests and analyses produced through the platform. It does not cover third-party sites you may reach through external links.',
          ],
        },
        {
          heading: '2. Data we collect',
          bullets: [
            'Account data: name, email, role in the company, and a password stored only as a one-way hash.',
            'Company data: name, domain, sector, and the billing details needed to issue an invoice.',
            'Subscription data: plan, term, amount, order status, and the bank transfer proof you upload (stored in private, non-public storage).',
            'Analysed site data: the public URL, the pages our crawler fetched, the resulting report, and notes or conversations attached to the analysis.',
            'Usage data: analysis counts, concurrency, and a short activity log (for example who approved content and when) for security and support.',
            'Technical data: IP address in security logs, browser type and request time, to protect the service from abuse.',
          ],
        },
        {
          heading: '3. How we obtain it',
          paragraphs: [
            'Most data is provided directly by you when registering, requesting a quote or uploading proof of transfer. Some is generated automatically as you use the platform (logs, analyses, usage). Analysed site data comes only from pages of your site that are publicly reachable.',
          ],
        },
        {
          heading: '4. Why we process it',
          bullets: [
            'Deliver the service: run the analysis, build the report, manage the subscription and permissions.',
            'Billing and accounting: match the bank transfer and issue invoices.',
            'Security and abuse prevention: detect unauthorised access and abnormal usage.',
            'Support and improvement: diagnose failures and improve features from aggregated usage.',
            'Legal compliance: keep records required by law and respond to competent authorities.',
          ],
        },
        {
          heading: '5. Cookies',
          paragraphs: [
            'We use a single essential session cookie to keep you signed in, with HttpOnly and SameSite attributes. It is not used for advertising. We run no behavioural analytics or ad pixels. Signing out ends its validity.',
          ],
        },
        {
          heading: '6. Sharing with processors',
          paragraphs: [
            'We do not sell your data. We share it only with processors acting on our behalf, and only as far as needed to run the service:',
          ],
          bullets: [
            'Our cloud hosting, database and storage provider (Cloudflare), to serve the site and run the database and backups.',
            'A language model provider, to analyse crawled page content and draft the report.',
            'A transactional email provider, to send account and activation messages — when enabled.',
            'Authorities where a binding legal request applies.',
          ],
        },
        {
          heading: '7. International transfers',
          paragraphs: [
            'Hosting and AI providers may process data outside the Kingdom of Saudi Arabia. We contract appropriate safeguards with them, transfer only the minimum necessary, and never send billing data to the AI provider.',
          ],
        },
        {
          heading: '8. Crawling your site',
          bullets: [
            'We read public pages only, respect robots.txt and the site’s terms, and never bypass protection or a login wall.',
            'We do not analyse pages behind a sign-in and never use your credentials to reach admin areas.',
            'You can request deletion of a specific analysis and its related data at any time.',
          ],
        },
        {
          heading: '9. Retention',
          paragraphs: [
            'Account data and analyses are kept for the life of the subscription, then for at most 90 days after termination for backup and recovery, after which they are deleted or anonymised.',
            'Billing records are kept for the period required by accounting and tax rules, and security logs for at most 12 months.',
          ],
        },
        {
          heading: '10. Your rights',
          bullets: [
            'Access your data and obtain a copy.',
            'Correct or update inaccurate data.',
            'Request deletion or restriction of processing, subject to legal obligations.',
            'Object to certain processing and withdraw consent where processing relies on it.',
            'Complain to us at {email}; you may also contact the competent data protection authority in the Kingdom.',
          ],
        },
        {
          heading: '11. Security',
          paragraphs: [
            'Passwords are hashed with PBKDF2 and cannot be recovered. Traffic is encrypted with TLS, each company’s data is isolated at query and permission level, and access to company data is limited to its authorised members.',
            'No system can be perfectly secure. If an incident affects your data we will notify you and the competent authority as required.',
          ],
        },
        {
          heading: '12. Children and updates',
          paragraphs: [
            'The service is intended for professional use and is not offered to anyone under 18. We may update this policy and publish the effective version with its update date, notifying you in the platform of material changes.',
            'For any privacy question or request, write to {email}.',
          ],
        },
      ],
    },
    support: {
      title: 'Support and complaints',
      subtitle: 'One clear channel, handled by people',
      updated: UPDATED_EN,
      intro:
        'Every message reaches a person on the Wusool team, not an automated system. Use the address below for pre-sales questions, technical issues, complaints, or any request about your data.',
      blocks: [
        {
          heading: '1. How to reach us',
          bullets: [
            'Email: {email}',
            'Team hours: Sunday to Thursday, 9:00–18:00 Riyadh time.',
            'Typical reply: one business day, up to two during peak periods.',
            'For the fastest handling, include your company name, registered email and invoice number if any.',
          ],
        },
        {
          heading: '2. Pre-sales questions',
          paragraphs: [
            'If you want to know whether the platform fits your sector or team size, send your site URL and how many people would use the system. We will explain what is live today and what is still in development before any financial commitment.',
          ],
        },
        {
          heading: '3. Complaints',
          bullets: [
            'Send a message starting with “Complaint” to {email}.',
            'We acknowledge within one business day and return with a resolution or plan within five business days.',
            'If the outcome does not satisfy you, ask for escalation to the service manager at the same address and we will share the escalation steps.',
          ],
        },
        {
          heading: '4. Privacy and data requests',
          paragraphs: [
            'To request a copy of your data, correct it or delete it, write from the email registered on the account to {email}. We may verify account ownership first, and respond within 30 days.',
          ],
        },
        {
          heading: '5. Technical support',
          bullets: [
            'Describe what you were doing, what you saw, and when it happened (Riyadh time).',
            'Attach a screenshot if possible, plus the analysis ID or company name.',
            'Never send your password or sign-in token; we will never ask for them.',
          ],
        },
        {
          heading: '6. Billing',
          paragraphs: [
            'Payment is currently by manual bank transfer with proof uploaded in the platform. To change an invoice, correct an amount or ask about a delayed activation, write to {email} with your order number.',
          ],
        },
        {
          heading: '7. Reporting content or abuse',
          paragraphs: [
            'If you find misleading content, use that breaches the terms, or a site analysed without authorisation, report it to {email}. We will investigate and suspend access where a breach is confirmed.',
          ],
        },
      ],
    },
  },
};
