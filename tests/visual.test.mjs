/**
 * Visual extraction unit tests (no server needed).
 *
 * Proves the crawler turns page HTML into an image inventory the analysis
 * can reason about: alt text kept, data-URI and duplicate images skipped,
 * dimensions captured, meta description attached.
 *
 * Run: node tests/visual.test.mjs
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The crawler source is TypeScript with extensionless imports, so bundle it
// once with esbuild and import the bundle (pure functions only, no network).
const OUT = join(mkdtempSync(join(tmpdir(), 'wusool-visual-')), 'crawler.mjs');
const bundled = spawnSync(
  'npx',
  ['esbuild', 'worker/lib/crawler/fetch.ts', '--bundle', '--format=esm', '--platform=neutral', `--outfile=${OUT}`],
  { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8' }
);
if (bundled.status !== 0) throw new Error(`esbuild failed: ${bundled.stderr}`);
const { extractImages, metaDescription, withVisualInventory } = await import(OUT);

let passed = 0;
const failures = [];
function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok  ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? ` → ${String(detail).slice(0, 300)}` : ''}`);
  }
}

const html = `
<html><head>
<meta name="description" content="خدمات تسويق في الرياض">
</head><body>
<img src="/img/team.jpg" alt="فريق العمل" width="800" height="600">
<img src='https://cdn.example.com/hero.png' alt='Hero banner'>
<img src="data:image/png;base64,AAAA" alt="inline">
<img src="/img/team.jpg" alt="duplicate">
<img src="product.webp">
</body></html>`;

const base = new URL('https://example.com/page');
const images = extractImages(html, base);
check('three unique remote images are kept (data-URI and duplicates skipped)', images.length === 3, images);
check('alt text is preserved', images[0]?.alt === 'فريق العمل', images[0]);
check('relative src resolves against the page URL', images[0]?.src === 'https://example.com/img/team.jpg', images[0]?.src);
check('dimensions are captured', images[0]?.width === 800 && images[0]?.height === 600, images[0]);
check('single-quoted attributes parse too', images[1]?.alt === 'Hero banner', images[1]);
check('an image without alt is kept with an empty alt', images[2]?.alt === '' && images[2]?.src.endsWith('product.webp'), images[2]);
check('meta description is extracted', metaDescription(html) === 'خدمات تسويق في الرياض', metaDescription(html));

const enriched = withVisualInventory('نص الصفحة', html, base);
check('the inventory is appended after the text', enriched.startsWith('نص الصفحة') && enriched.includes('Images:'), enriched.slice(0, 120));
check('inventory lines carry alt and dimensions', enriched.includes('alt="فريق العمل"') && enriched.includes('800x600'), enriched);
check('meta description line is included', enriched.includes('Meta description:'), enriched);

const plain = withVisualInventory('نص فقط', '<html><body>لا صور</body></html>', base);
check('a page without images or description is unchanged', plain === 'نص فقط', plain);

console.log(`\n${passed} checks passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
