/**
 * Sprint 9 — Structural classifier for in-page <a> tags.
 *
 * Replaces the old anchor-text heuristic (`classifyLink()` in
 * diagnostic.v1.ts) with a DOM placement classifier driven by cheerio
 * selectors. Same input → consistent output across the crawler (powers
 * the internal_link_graph) and the existing pull-current-state path
 * (re-uses this so audit_findings.current_state.internal_links_outbound
 * stays in sync with what the LLM ends up reasoning over).
 *
 * Placement priority (a link can only have one):
 *   1. footer    — inside <footer> or [role="contentinfo"] or Wix "FOOTER"
 *   2. nav       — inside <nav>, <header>, [role="navigation"] or Wix "HEADER"
 *   3. related   — inside any element with class containing "related" or
 *                  "similar" (Wix's "Posts similaires" block)
 *   4. cta       — explicit class/role hint (button-like) inside body
 *   5. image     — wraps only an <img> with no text anchor
 *   6. editorial — anything else inside the body (default for unmatched
 *                  in-content <a>)
 *
 * Hostname comparison uses the page's URL host (not just startsWith) so
 * cross-host links (rare on Plouton but possible) drop out cleanly.
 */
import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import { pathOf } from './url.js';

export type Placement = 'editorial' | 'related' | 'nav' | 'footer' | 'cta' | 'image';

export type ClassifiedLink = {
  /** Page that contains the <a>; absolute URL passed in by the caller. */
  source_path: string;
  /** Target as a normalized path (uses pathOf so it joins with snapshot pages). */
  target_path: string;
  /** Visible text inside the <a>, with whitespace collapsed. */
  anchor_text: string;
  placement: Placement;
  /** rel attribute value (nofollow / sponsored / ugc / null). */
  rel: string | null;
};

/**
 * Wix Studio uses stable framework classes `wixui-header` and `wixui-footer`
 * on the section-container elements that wrap the global header / footer.
 * Verified empirically on Plouton 2026-05-07 across /, /notre-cabinet,
 * /post/*, /honoraires-rendez-vous (Sprint-9 tuning).
 *
 * Earlier Sprint-9 attempts used `[class*="HEADER"]` and `[class*="FOOTER"]`
 * but those over-captured because Wix uses words like "HeaderText" /
 * "headerImage" inside body components — leading to false-nav classification
 * for editorial body links. The compare-scrapers script caught the regression
 * before the merge; the pattern here is the corrected one.
 */
const WIX_NAV_CLASS_PATTERNS = [
  '.wixui-header',
  'nav',
  'header',
  '[role="navigation"]',
  '[role="banner"]',
];
const WIX_FOOTER_CLASS_PATTERNS = [
  '.wixui-footer',
  'footer',
  '[role="contentinfo"]',
];
const RELATED_CLASS_PATTERNS = [
  '[class*="related"]',
  '[class*="similar"]',
  '[class*="recommended"]',
];
const CTA_CLASS_PATTERNS = [
  '[class*="cta"]',
  '[class*="button"][class*="primary"]',
  '[role="button"]',
];

function determinePlacement(
  $a: cheerio.Cheerio<AnyNode>,
  anchorText: string,
): Placement {
  // Walk the ancestor chain. cheerio's .closest() takes a selector string.
  // We test in priority order so footer beats nav beats related, etc.
  const parents = (selectors: string[]): boolean =>
    selectors.some((s) => $a.closest(s).length > 0);

  if (parents(['footer', '[role="contentinfo"]', ...WIX_FOOTER_CLASS_PATTERNS])) {
    return 'footer';
  }
  if (parents(['nav', 'header', '[role="navigation"]', ...WIX_NAV_CLASS_PATTERNS])) {
    return 'nav';
  }
  if (parents(RELATED_CLASS_PATTERNS)) {
    return 'related';
  }
  if (parents(CTA_CLASS_PATTERNS)) {
    return 'cta';
  }
  // Image-only anchor (visible text empty after stripping img alt)
  if (anchorText.length === 0 && $a.find('img').length > 0) {
    return 'image';
  }
  return 'editorial';
}

/**
 * Classify every <a> in the rendered HTML of `pageUrl` against the same
 * host. External links and self-links are dropped. Returns one entry per
 * (target_path, anchor_text) pair — same target with different anchors
 * produces multiple rows (matches the unique constraint of
 * internal_link_graph).
 */
export function classifyLinks(opts: {
  pageUrl: string;
  html: string;
}): ClassifiedLink[] {
  const $ = cheerio.load(opts.html);
  let pageHost = '';
  let pagePath = '';
  try {
    const u = new URL(opts.pageUrl);
    pageHost = u.host.toLowerCase();
    pagePath = pathOf(opts.pageUrl);
  } catch {
    return [];
  }

  const seen = new Set<string>();
  const out: ClassifiedLink[] = [];

  $('a[href]').each((_i, el) => {
    const $a = $(el);
    const href = $a.attr('href');
    if (!href) return;

    let abs: URL;
    try {
      abs = new URL(href, opts.pageUrl);
    } catch {
      return;
    }
    // Skip non-http(s) (mailto:, tel:, javascript:)
    if (!abs.protocol.startsWith('http')) return;
    // Drop cross-host
    if (abs.host.toLowerCase() !== pageHost) return;
    const targetPath = pathOf(abs.toString());
    // Drop self-link / fragment-only
    if (targetPath === pagePath) return;

    const anchorRaw = ($a.text() || '').replace(/\s+/g, ' ').trim();
    // Image-only anchors: try to read alt text instead so we keep some signal
    let anchor = anchorRaw;
    if (anchor.length === 0) {
      const img = $a.find('img').first();
      if (img.length > 0) {
        anchor = (img.attr('alt') || '').trim();
      }
    }

    const placement = determinePlacement($a, anchor);
    const rel = ($a.attr('rel') || '').trim() || null;

    // Dedupe on (target, anchor) — same target/anchor inside both nav and
    // footer would still upsert under the same unique key in DB; keep the
    // first occurrence (which by HTML order is usually nav before footer).
    const key = `${targetPath}|${anchor.toLowerCase().slice(0, 80)}`;
    if (seen.has(key)) return;
    seen.add(key);

    out.push({
      source_path: pagePath,
      target_path: targetPath,
      anchor_text: anchor.slice(0, 200),
      placement,
      rel,
    });
  });

  return out;
}
