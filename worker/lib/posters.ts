/**
 * Poster rendering.
 *
 * A poster is a text layout rendered as SVG by this Worker. No external image
 * service is called and no pixel is generated from a model: the client's words
 * and brand colour produce a deterministic file that can be attached to a post
 * through its public URL. Drafts are not public; only approved posters are.
 */
import type { PlatformKey } from './social/platforms';

export type PosterSize = { key: string; width: number; height: number; label: string };

/** The six social platforms with the size each one actually displays. */
export const POSTER_SIZES: Record<string, PosterSize> = {
  facebook_page: { key: 'facebook_page', width: 1200, height: 630, label: 'Facebook link post' },
  instagram_business: { key: 'instagram_business', width: 1080, height: 1080, label: 'Instagram square' },
  tiktok_business: { key: 'tiktok_business', width: 1080, height: 1920, label: 'TikTok vertical' },
  snapchat_business: { key: 'snapchat_business', width: 1080, height: 1920, label: 'Snapchat vertical' },
  linkedin_org: { key: 'linkedin_org', width: 1200, height: 627, label: 'LinkedIn link post' },
  x_twitter: { key: 'x_twitter', width: 1600, height: 900, label: 'X link card' },
};

export const POSTER_TEMPLATES = ['bold', 'minimal', 'offer'] as const;
export type PosterTemplate = (typeof POSTER_TEMPLATES)[number];

export const isPosterSize = (value: unknown): value is PlatformKey =>
  typeof value === 'string' && value in POSTER_SIZES;

export const isPosterTemplate = (value: unknown): value is PosterTemplate =>
  typeof value === 'string' && (POSTER_TEMPLATES as readonly string[]).includes(value);

const escapeXml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

/** Greedy wrap by word count fitted to an approximate glyph width. */
function wrap(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxChars && current) {
      lines.push(current);
      current = word;
      if (lines.length === maxLines) break;
    } else {
      current = candidate;
    }
  }
  if (lines.length < maxLines && current) lines.push(current);
  if (!lines.length) return [];
  const lastIndex = lines.length - 1;
  if (lines[lastIndex].length > maxChars) {
    lines[lastIndex] = `${lines[lastIndex].slice(0, Math.max(0, maxChars - 1))}…`;
  }
  return lines;
}

const isHexColor = (value: string) => /^#[0-9a-fA-F]{6}$/.test(value);

export type PosterInput = {
  headline: string;
  subhead: string;
  cta: string;
  template: PosterTemplate;
  size: PosterSize;
  brandColor: string;
  language: 'ar' | 'en';
};

/**
 * Renders the SVG. The layout is deliberately simple and readable: a headline,
 * an optional subhead, an optional call to action and a brand bar. Text is
 * escaped before it reaches the markup.
 */
export function renderPosterSvg(input: PosterInput): string {
  const { width, height } = input.size;
  const color = isHexColor(input.brandColor) ? input.brandColor : '#0f766e';
  const dark = input.template === 'bold';
  const background = dark ? '#0b1220' : input.template === 'offer' ? '#fff7ed' : '#ffffff';
  const foreground = dark ? '#f8fafc' : '#0f172a';
  const muted = dark ? '#cbd5e1' : '#475569';
  const rtl = input.language === 'ar';
  const anchor = rtl ? 'end' : 'start';
  const textX = rtl ? width - Math.round(width * 0.08) : Math.round(width * 0.08);

  const headlineSize = Math.round(Math.min(width, height) * 0.085);
  const subheadSize = Math.round(headlineSize * 0.5);
  const ctaSize = Math.round(headlineSize * 0.42);
  const headlineLines = wrap(
    input.headline,
    Math.max(12, Math.floor((width * 0.84) / (headlineSize * 0.52))),
    4
  );
  const subheadLines = input.subhead
    ? wrap(input.subhead, Math.max(16, Math.floor((width * 0.84) / (subheadSize * 0.5))), 3)
    : [];

  const blocks: string[] = [];
  let y = Math.round(height * 0.34);
  for (const line of headlineLines) {
    blocks.push(
      `<text x="${textX}" y="${y}" text-anchor="${anchor}" font-size="${headlineSize}" font-weight="700" fill="${foreground}">${escapeXml(line)}</text>`
    );
    y += Math.round(headlineSize * 1.18);
  }
  if (subheadLines.length) {
    y += Math.round(subheadSize * 0.4);
    for (const line of subheadLines) {
      blocks.push(
        `<text x="${textX}" y="${y}" text-anchor="${anchor}" font-size="${subheadSize}" fill="${muted}">${escapeXml(line)}</text>`
      );
      y += Math.round(subheadSize * 1.3);
    }
  }
  if (input.cta) {
    const buttonHeight = Math.round(ctaSize * 2.2);
    const buttonWidth = Math.min(width * 0.8, Math.max(width * 0.28, input.cta.length * ctaSize * 0.62));
    const buttonX = rtl ? width - Math.round(width * 0.08) - buttonWidth : Math.round(width * 0.08);
    const buttonY = height - Math.round(height * 0.16);
    blocks.push(
      `<rect x="${buttonX}" y="${buttonY}" width="${Math.round(buttonWidth)}" height="${buttonHeight}" rx="${Math.round(buttonHeight / 2)}" fill="${color}"/>`,
      `<text x="${buttonX + buttonWidth / 2}" y="${buttonY + buttonHeight * 0.66}" text-anchor="middle" font-size="${ctaSize}" font-weight="700" fill="#ffffff">${escapeXml(input.cta)}</text>`
    );
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img">`,
    `<title>${escapeXml(input.headline)}</title>`,
    `<rect width="${width}" height="${height}" fill="${background}"/>`,
    `<rect x="0" y="0" width="${Math.round(width * 0.012)}" height="${height}" fill="${color}"/>`,
    `<g font-family="${rtl ? 'Tahoma, Arial, sans-serif' : 'Arial, Helvetica, sans-serif'}" direction="${rtl ? 'rtl' : 'ltr'}">`,
    ...blocks,
    `</g>`,
    `</svg>`,
  ].join('');
}

export const posterSizes = Object.values(POSTER_SIZES);
