/**
 * Deterministic provider used for development, demos and automated tests.
 *
 * It performs transparent, rule-based extraction from the pages that were
 * actually crawled: values found on the site are marked `website`, everything
 * else stays `inference`/`missing`. It never invents facts and never calls the
 * network, so tests can assert exact output.
 */
import {
  type AiAnalysis,
  type AIProvider,
  type AnalyzeInput,
  type StructuredAnalysisResult,
  emptyResult,
  item,
  LIST_FIELDS,
  missingFields,
} from './types';

const STOPWORDS = new Set([
  'the','and','for','with','that','this','from','your','you','our','are','was','have','has','not','all','can','will',
  'من','في','على','إلى','الى','عن','مع','هذا','هذه','ذلك','التي','الذي','هو','هي','تم','كما','كل','أو','او','أن','ان',
  'الشركة','نحن','خدمات','خدمة','المزيد','اقرأ','صفحة','الرئيسية','جميع','بين','بعد','قبل','حول','عبر','لدينا',
]);

const normalizeText = (value: string) =>
  value
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const lines = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

function firstMatchingLine(text: string, patterns: RegExp[]): string | null {
  for (const line of lines(text)) {
    for (const pattern of patterns) {
      if (pattern.test(line)) {
        const cleaned = line.replace(/^#+\s*/, '').replace(/^[-*•]\s*/, '').trim();
        if (cleaned.length >= 3 && cleaned.length <= 600) return cleaned;
      }
    }
  }
  return null;
}

function collectHeadings(text: string): string[] {
  const out: string[] = [];
  for (const line of lines(text)) {
    const match = /^(#{1,3})\s+(.{3,120})$/.exec(line);
    if (match) out.push(match[2].trim());
  }
  return out;
}

function keywordCandidates(text: string): string[] {
  const words = text
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 4 && word.length <= 24 && !STOPWORDS.has(word));
  const counts = new Map<string, number>();
  for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([word]) => word);
}

function companyNameFromTitle(title: string | undefined, url: string): string | null {
  if (!title) return null;
  const cleaned = title.split(/[|–—·:]/)[0]?.trim();
  if (cleaned && cleaned.length >= 2 && cleaned.length <= 120) return cleaned;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

export class MockAIProvider implements AIProvider {
  readonly name = 'mock';

  constructor(readonly model = 'mock-structured-v1') {}

  async analyzeSite(input: AnalyzeInput): Promise<AiAnalysis> {
    const result = this.build(input);
    const inputChars = input.pages.reduce((total, page) => total + page.contentMarkdown.length, 0);
    return {
      result,
      usage: {
        provider: 'mock',
        model: this.model,
        operation: 'site_analysis',
        inputTokens: Math.ceil(inputChars / 4),
        outputTokens: 900,
        estimatedCostMicros: 0,
      },
    };
  }

  private build(input: AnalyzeInput): StructuredAnalysisResult {
    const result = emptyResult();
    if (!input.pages.length) {
      result.missing_information.push(item('لا توجد صفحات مقروءة من الموقع.', 'website', 1));
      return result;
    }

    const first = input.pages[0];
    const corpus = normalizeText(input.pages.map((page) => page.contentMarkdown).join('\n\n'));
    const headings = collectHeadings(corpus);
    const isArabic = input.locale !== 'en';

    const name = companyNameFromTitle(first.title, first.url);
    if (name) result.company_profile.company_name = item(name, 'website', 0.7, first.url);

    const industryLine = firstMatchingLine(corpus, [
      /قطاع|مجال|نعمل في|متخصصون في|industry|we focus on|speciali[sz]ed in/i,
    ]);
    if (industryLine) {
      result.company_profile.industry = item(industryLine, 'website', 0.5, first.url);
    } else if (headings[0]) {
      result.company_profile.industry = item(headings[0], 'inference', 0.3, first.url);
      result.assumptions_requiring_review.push(
        item(
          isArabic ? `القطاع مستنتج من عنوان صفحة: «${headings[0]}» — يحتاج تأكيدًا.` : `Industry inferred from the page heading "${headings[0]}" — needs confirmation.`,
          'inference',
          0.3,
          first.url
        )
      );
    }

    const summaryLine = firstMatchingLine(corpus, [
      /نقدم|نساعد|نوفر|حلول|منصة|شركة|we help|we provide|platform|company|solutions/i,
    ]);
    if (summaryLine) result.company_profile.summary = item(summaryLine, 'website', 0.55, first.url);

    const missionLine = firstMatchingLine(corpus, [/رسالتنا|رسالة|mission/i]);
    if (missionLine) result.mission = item(missionLine, 'website', 0.6, first.url);
    const visionLine = firstMatchingLine(corpus, [/رؤيتنا|رؤية|vision/i]);
    if (visionLine) result.vision = item(visionLine, 'website', 0.6, first.url);

    for (const heading of headings.slice(0, 12)) {
      result.products_and_services.push(item(heading, 'website', 0.45, first.url));
    }

    const audienceLine = firstMatchingLine(corpus, [/للشركات|للأفراد|للعملاء|نخدم|for companies|for teams|for businesses/i]);
    if (audienceLine) result.audiences.push(item(audienceLine, 'website', 0.45, first.url));

    const ctaLine = firstMatchingLine(corpus, [/تواصل|احجز|اطلب|اشترك|سجل|contact|book|get started|request a demo|subscribe/i]);
    if (ctaLine) result.calls_to_action.push(item(ctaLine, 'website', 0.5, first.url));

    for (const word of keywordCandidates(corpus)) {
      result.keywords.push(item(word, 'inference', 0.35, first.url));
    }

    const channelHints: Array<[RegExp, string]> = [
      [/انستقرام|instagram/i, 'Instagram'],
      [/تويتر|إكس|x\.com|twitter/i, 'X (Twitter)'],
      [/لينكدإن|linkedin/i, 'LinkedIn'],
      [/واتساب|whatsapp/i, 'WhatsApp'],
      [/سناب|snapchat/i, 'Snapchat'],
      [/يوتيوب|youtube/i, 'YouTube'],
    ];
    for (const [pattern, label] of channelHints) {
      if (pattern.test(corpus)) result.marketing_channels.push(item(label, 'website', 0.5, first.url));
    }

    // Inferences are always labelled as such and flagged for human review.
    if (result.products_and_services.length) {
      result.content_pillars.push(
        item(
          isArabic ? 'شرح الخدمات الأساسية المذكورة في الموقع' : 'Explain the core services listed on the site',
          'inference',
          0.4
        )
      );
      result.recommended_campaigns.push(
        item(
          isArabic ? 'حملة تعريفية بالخدمات الرئيسية تستهدف الزوار الجدد' : 'Awareness campaign introducing the main services to new visitors',
          'inference',
          0.35
        )
      );
    }
    result.value_proposition.push(
      item(
        isArabic
          ? 'غير متوفر بوضوح في الموقع — يحتاج صياغة مع العميل.'
          : 'Not clearly stated on the site — needs to be written with the client.',
        'missing',
        0
      )
    );
    result.opportunities.push(
      item(
        isArabic ? 'إضافة صفحة تعريفية واضحة لكل خدمة مع دعوة لاتخاذ إجراء.' : 'Add a clear page per service with a single call to action.',
        'inference',
        0.4
      )
    );
    result.risks.push(
      item(
        isArabic ? 'اعتماد التقرير على محتوى الموقع فقط دون بيانات السوق.' : 'This report relies on site content only, with no market data.',
        'inference',
        0.5
      )
    );
    result.roadmap.push(item(isArabic ? 'الأسبوع ١–٢: تثبيت الرسالة والقيمة المقترحة.' : 'Weeks 1–2: lock the message and value proposition.', 'inference', 0.4));
    result.roadmap.push(item(isArabic ? 'الأسبوع ٣–٦: تحسين صفحات الخدمات وقياس التحويل.' : 'Weeks 3–6: improve service pages and measure conversion.', 'inference', 0.35));
    result.recommended_kpis.push(item(isArabic ? 'عدد الطلبات الواردة شهريًا' : 'Inbound requests per month', 'inference', 0.4));
    result.recommended_kpis.push(item(isArabic ? 'نسبة الزوار الذين يصلون إلى صفحة تواصل' : 'Share of visitors reaching the contact page', 'inference', 0.35));

    // Anything the site did not state is surfaced as a question for the
    // client — never filled in with a plausible-looking guess.
    const addMissing = (label: string) => {
      if (result.missing_information.some((entry) => entry.value.includes(label))) return;
      result.missing_information.push(
        item(isArabic ? `معلومة ناقصة: ${label}` : `Missing information: ${label}`, 'website', 1)
      );
    };
    for (const field of missingFields(result)) addMissing(field);
    for (const key of LIST_FIELDS) {
      if (key === 'missing_information' || key === 'assumptions_requiring_review') continue;
      for (const entry of result[key]) {
        if (entry.source === 'missing') addMissing(key);
      }
    }

    return result;
  }
}
