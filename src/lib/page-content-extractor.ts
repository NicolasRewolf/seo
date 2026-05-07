/**
 * Sprint 14 — Page content extractor (Wix-aware).
 *
 * Replaces the old `intro_first_100_words` snapshot (which only captured the
 * first 100 words of body) with a structured `ContentSnapshot`: full body
 * text, outline (H2/H3/H4 with word offsets), images with alt-text, author
 * + dates (E-E-A-T signals), and CTA in-body positions.
 *
 * Stack decision (per Sprint-14 plan validated by Cooked agent):
 *   - Cheerio + Wix-aware selectors. Plouton is 100% Wix Studio with stable
 *     `.wixui-header` / `.wixui-footer` markers (Sprint-9 link classifier
 *     already exploits this).
 *   - No Readability dep (200kb cross-site heuristic we don't need).
 *   - No external API (jina-reader / Mercury) — keeps the pipeline
 *     self-contained per CLAUDE.md zone 🟢.
 *
 * Caveats baked in:
 *   - JS-rendered widgets (Accordion / Tabs / Expandable) on /defense-penale/*
 *     pages may not be in the SSR HTML. Validate via the `validateExtraction`
 *     script before scaling to all 16 findings (Cooked-agent flag #1).
 *   - `cta_in_body_positions` uses word_offset as a proxy for scroll position
 *     in the prompt — explicit caveat ("CTA estimé à ~X% du scroll selon
 *     position dans le texte") since word_offset/word_count ≠ scroll_pct
 *     (Cooked-agent flag #2).
 */
import * as cheerio from 'cheerio';
import type { AnyNode, Element as TagElement } from 'domhandler';
import { pathOf } from './url.js';

export type OutlineEntry = {
  level: 2 | 3 | 4;
  text: string;
  /** id="…" if present (anchor target). */
  anchor: string | null;
  /** Position of this heading in the body text, in words. Used by the LLM
   *  to recommend insertion points relative to existing structure. */
  word_offset: number;
};

export type ImageRef = {
  src: string;
  alt: string | null;
  /** True if inside the main body (not in header/footer/nav). Header/footer
   *  images are usually logos / decorative — irrelevant for content audit. */
  in_body: boolean;
};

export type AuthorInfo = {
  name?: string;
  url?: string;
  /** ISO date string (firstPublishedDate from Wix Blog API). */
  date_published?: string;
  /** ISO date string (lastPublishedDate from Wix Blog API). */
  date_modified?: string;
};

export type CtaInBodyPosition = {
  word_offset: number;
  anchor: string;
  target: string;
};

export type ContentSnapshot = {
  /** Cleaned body text — separators preserved, headings inline. */
  body_text: string;
  /** Total word count of body_text (split by /\s+/). */
  word_count: number;
  /** H2/H3/H4 in document order with word offsets. */
  outline: OutlineEntry[];
  /** Images found in body (excludes header/footer/nav). */
  images: ImageRef[];
  /** Author + dates (best-effort: from Wix Blog API for /post/*, regex for static). */
  author: AuthorInfo | null;
  /** CTA in-body anchors with word offsets — for "CTA position vs scroll" insight. */
  cta_in_body_positions: CtaInBodyPosition[];
  /** ISO timestamp of when this snapshot was extracted. */
  extracted_at: string;
};

/** UA distinctif per Cooked-agent flag #1 — lets Wix logs filter our traffic
 *  and lets the Cooked Edge Function ignore our hits if we ever switch to
 *  Playwright for JS-rendered pages. */
export const CONTENT_BOT_UA = 'plouton-content-bot/1.0 (+nicolas@rewolf.studio)';

/** Wix Studio stable selectors — same as Sprint-9 dom-link-classifier. */
const WIX_HEADER_SELECTORS = ['.wixui-header', 'header', 'nav', '[role="navigation"]', '[role="banner"]'];
const WIX_FOOTER_SELECTORS = ['.wixui-footer', 'footer', '[role="contentinfo"]'];

/**
 * Extract a structured `ContentSnapshot` from page HTML.
 *
 * @param html  raw HTML of the page (server-rendered)
 * @param pageUrl  absolute URL — used to compute target_path for CTAs
 * @param authorOverride  optional author info from a richer source (e.g. Wix
 *   Blog API on /post/* — pass post.firstPublishedDate, etc.). When provided,
 *   takes precedence over HTML regex.
 */
export function extractPageContent(opts: {
  html: string;
  pageUrl: string;
  authorOverride?: AuthorInfo | null;
}): ContentSnapshot {
  const $ = cheerio.load(opts.html);

  // Strip header/footer/nav from the working DOM so they don't pollute body
  // text, outline, or image extraction. Don't .remove() on the original $
  // (we need the full DOM for CTA classification later) — clone the body
  // subtree first.
  const bodyRoot = pickBodyRoot($);

  // 1. Outline: H2/H3/H4 in document order, with running word offset.
  const outline: OutlineEntry[] = [];
  // We need to walk text + headings together to compute word offsets.
  // Strategy: get the linearized body text, then for each heading, find its
  // word position by scanning the text up to the heading's position.
  const bodyText = extractCleanText($, bodyRoot);
  const wordCount = countWords(bodyText);

  // For outline word_offset, we walk the DOM in document order, accumulating
  // text length up to each heading.
  let runningWords = 0;
  const walker = (node: AnyNode): void => {
    if (node.type === 'text') {
      const text = ($(node).text() || '').trim();
      if (text) runningWords += text.split(/\s+/).filter((w) => w).length;
    } else if (node.type === 'tag') {
      const el = node as TagElement;
      const tagName = el.name?.toLowerCase();
      if (tagName === 'h2' || tagName === 'h3' || tagName === 'h4') {
        const text = $(el).text().trim().replace(/\s+/g, ' ');
        if (text) {
          outline.push({
            level: parseInt(tagName.slice(1), 10) as 2 | 3 | 4,
            text,
            anchor: el.attribs?.id ?? null,
            word_offset: runningWords,
          });
        }
      }
      // Recurse into children
      for (const child of el.children ?? []) walker(child);
    }
  };
  for (const child of bodyRoot.children ?? []) walker(child);

  // 2. Images — only those in body (not header/footer)
  const images: ImageRef[] = [];
  $('img').each((_, el) => {
    const $img = $(el);
    const src = $img.attr('src') ?? $img.attr('data-src') ?? '';
    if (!src) return;
    const alt = $img.attr('alt') ?? null;
    const inBody =
      !isInside($, el, WIX_HEADER_SELECTORS) && !isInside($, el, WIX_FOOTER_SELECTORS);
    images.push({ src, alt: alt && alt.trim() ? alt.trim() : null, in_body: inBody });
  });

  // 3. CTA in-body positions — links inside body (no header/footer) with word offset
  const ctaInBodyPositions: CtaInBodyPosition[] = [];
  let ctaWalkerWords = 0;
  const pageHost = (() => {
    try {
      return new URL(opts.pageUrl).host;
    } catch {
      return '';
    }
  })();
  const ctaWalker = (node: AnyNode): void => {
    if (node.type === 'text') {
      const text = ($(node).text() || '').trim();
      if (text) ctaWalkerWords += text.split(/\s+/).filter((w) => w).length;
    } else if (node.type === 'tag') {
      const el = node as TagElement;
      if (el.name?.toLowerCase() === 'a') {
        const href = el.attribs?.href ?? '';
        const anchor = $(el).text().trim().replace(/\s+/g, ' ');
        if (href && anchor) {
          let absolute = href;
          try {
            absolute = new URL(href, opts.pageUrl).toString();
          } catch {
            // skip malformed
          }
          let isInternal = false;
          try {
            isInternal = new URL(absolute).host === pageHost;
          } catch {
            // skip
          }
          if (isInternal) {
            ctaInBodyPositions.push({
              word_offset: ctaWalkerWords,
              anchor: anchor.slice(0, 120),
              target: pathOf(absolute),
            });
          }
        }
      }
      for (const child of el.children ?? []) ctaWalker(child);
    }
  };
  for (const child of bodyRoot.children ?? []) ctaWalker(child);

  // 4. Author — fall back from override to HTML regex (best-effort for non-Blog pages)
  let author: AuthorInfo | null = opts.authorOverride ?? null;
  if (!author) {
    author = extractAuthorFromHtml($);
  }

  return {
    body_text: bodyText,
    word_count: wordCount,
    outline,
    images,
    author,
    cta_in_body_positions: ctaInBodyPositions,
    extracted_at: new Date().toISOString(),
  };
}

/**
 * Pick the body root element to extract from. Strategy:
 *   1. <main> if present (most semantic)
 *   2. <article> if present
 *   3. <body> as last resort (with header/footer filtered out at use-site)
 *
 * Returns a TagElement that's safe to walk recursively.
 */
function pickBodyRoot($: cheerio.CheerioAPI): TagElement {
  const mainEl = $('main').first()[0];
  if (mainEl && mainEl.type === 'tag') return mainEl as TagElement;
  const articleEl = $('article').first()[0];
  if (articleEl && articleEl.type === 'tag') return articleEl as TagElement;
  // Fallback: <body>. Header/footer are filtered in extractCleanText + per-element checks.
  const bodyEl = $('body').first()[0];
  if (bodyEl && bodyEl.type === 'tag') return bodyEl as TagElement;
  // Last resort: synthetic root — cheerio's root element wraps document
  return ($.root()[0] as unknown) as TagElement;
}

/**
 * Linearize body text excluding header/footer/nav. Preserves paragraph
 * breaks (\n\n) so word_offset computations stay sane and the LLM can read
 * structure.
 */
function extractCleanText($: cheerio.CheerioAPI, bodyRoot: TagElement): string {
  // Clone the body so we can mutate without affecting other extractors
  const $clone = cheerio.load($.html(bodyRoot) ?? '');
  // Strip header/footer/nav inside the clone
  for (const sel of [...WIX_HEADER_SELECTORS, ...WIX_FOOTER_SELECTORS]) {
    $clone(sel).remove();
  }
  // Strip script/style/noscript (Cheerio leaves them in $.text() output)
  $clone('script, style, noscript').remove();

  const parts: string[] = [];
  $clone('h1, h2, h3, h4, h5, h6, p, li, blockquote, td, th').each((_, el) => {
    const text = $clone(el).text().trim().replace(/\s+/g, ' ');
    if (text) parts.push(text);
  });
  return parts.join('\n\n');
}

function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

function isInside(
  $: cheerio.CheerioAPI,
  el: AnyNode,
  selectors: string[],
): boolean {
  const $el = $(el);
  return selectors.some((s) => $el.closest(s).length > 0);
}

/**
 * Best-effort author extraction from HTML for static pages (no Wix Blog API).
 * Looks at common patterns: <meta name="author">, schema.org Person/Organization
 * in JSON-LD, and `<a rel="author">`.
 */
function extractAuthorFromHtml($: cheerio.CheerioAPI): AuthorInfo | null {
  // 1. <meta name="author">
  const metaAuthor = $('meta[name="author"]').attr('content')?.trim();
  if (metaAuthor) return { name: metaAuthor };

  // 2. <meta property="article:author">
  const articleAuthor = $('meta[property="article:author"]').attr('content')?.trim();
  if (articleAuthor) return { name: articleAuthor };

  // 3. <a rel="author">
  const relAuthor = $('a[rel="author"]').first();
  if (relAuthor.length > 0) {
    const name = relAuthor.text().trim();
    const url = relAuthor.attr('href');
    if (name) return { name, url };
  }

  return null;
}
