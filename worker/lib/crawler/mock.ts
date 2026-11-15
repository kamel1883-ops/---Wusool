/**
 * Offline crawler used for development and automated tests.
 * It never touches the network: it returns deterministic fixtures whose URLs
 * are derived from the requested origin, and every analysis that uses it is
 * labelled `mock` in the UI.
 */
import {
  type CrawlInput,
  type CrawlResult,
  type CrawledPage,
  type SiteCrawlerProvider,
  CrawlerError,
  normalizeSiteUrl,
} from './types';

const FIXTURE = [
  {
    path: '',
    title: 'شركة النخبة للاستشارات | Elite Consulting',
    body: `# شركة النخبة للاستشارات

نقدم خدمات استشارات تسويقية وإدارة علامة تجارية للشركات في الرياض وجدة.

## من نحن
شركة النخبة للاستشارات شركة سعودية متخصصة في استشارات التسويق والنمو.

## خدماتنا
### استشارات تسويقية
### إدارة الحملات الإعلانية
### بناء الهوية التجارية
### تدريب فرق التسويق

## رسالتنا
رسالتنا هي تمكين الشركات السعودية من نمو مستدام عبر تسويق مبني على البيانات.

## رؤيتنا
رؤيتنا أن نكون الشريك الأول للتسويق في المنطقة.

## من نخدم
نخدم الشركات الصغيرة والمتوسطة والشركات الناشئة في قطاع الخدمات والتجزئة.

## تواصل معنا
تواصل معنا لطلب عرض سعر أو احجز جلسة استشارية. واتساب: عبر الموقع. انستقرام ولينكدإن.`,
  },
  {
    path: 'services',
    title: 'خدماتنا | شركة النخبة للاستشارات',
    body: `# خدماتنا

## استشارات تسويقية
دراسة السوق وتحليل المنافسين وبناء خطة تسويق سنوية.

## إدارة الحملات الإعلانية
إدارة حملات الأداء على القنوات الرقمية وقياس العائد.

## بناء الهوية التجارية
تطوير الهوية والرسائل التسويقية والتصاميم.

## تدريب فرق التسويق
برامج تدريب عملية لفرق التسويق الداخلي.

نخدم أيضاً الشركات الناشئة والأفراد من أصحاب المشاريع.`,
  },
  {
    path: 'about',
    title: 'من نحن | شركة النخبة للاستشارات',
    body: `# من نحن

شركة النخبة للاستشارات تأسست لخدمة السوق السعودي في مجال التسويق.

## قيمنا
الشفافية، الالتزام بالنتائج، العمل كفريق واحد مع العميل.

## فريق العمل
فريق من الاستشاريين والمصممين وكتّاب المحتوى.`,
  },
  {
    path: 'contact',
    title: 'تواصل معنا | شركة النخبة للاستشارات',
    body: `# تواصل معنا

تواصل معنا لتحديد اجتماع أو احجز جلسة استشارية مع فريقنا.

## الموقع
الرياض، المملكة العربية السعودية

## طلب عرض سعر
يرجى تعبئة النموذج وسنعاود التواصل خلال يوم عمل.`,
  },
];

export class MockCrawlerProvider implements SiteCrawlerProvider {
  readonly name = 'mock';

  async crawl(input: CrawlInput): Promise<CrawlResult> {
    const start = normalizeSiteUrl(input.url);
    const origin = `${start.protocol}//${start.host}`;
    const maxPages = Math.max(1, Math.min(input.maxPages || 10, FIXTURE.length));
    const pages: CrawledPage[] = [];

    for (const entry of FIXTURE.slice(0, maxPages)) {
      const url = entry.path ? `${origin}/${entry.path}` : `${origin}/`;
      pages.push({
        url,
        title: entry.title,
        contentMarkdown: entry.body,
        wordCount: entry.body.split(/\s+/).filter(Boolean).length,
        statusCode: 200,
        status: 'ok',
        depth: entry.path ? 1 : 0,
      });
    }

    if (!pages.length) throw new CrawlerError('crawl_failed');

    return {
      startUrl: `${origin}/`,
      robotsPolicy: 'missing',
      pages,
      pagesFound: pages.length,
      pagesAnalyzed: pages.length,
      pagesFailed: 0,
    };
  }
}
