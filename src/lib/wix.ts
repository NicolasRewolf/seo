import { env } from '../config.js';
import { classifyLinks } from './dom-link-classifier.js';
import {
  extractPageContent,
  CONTENT_BOT_UA,
  type ContentSnapshot,
  type AuthorInfo,
} from './page-content-extractor.js';

const WIX_BASE = 'https://www.wixapis.com';

function headers(): Record<string, string> {
  const e = env.wix();
  return {
    Authorization: e.WIX_API_KEY,
    'wix-site-id': e.WIX_SITE_ID,
    'wix-account-id': e.WIX_ACCOUNT_ID,
    'Content-Type': 'application/json',
  };
}

export async function wixGet<T>(path: string, query?: Record<string, string>): Promise<T> {
  const url = new URL(`${WIX_BASE}${path}`);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), { method: 'GET', headers: headers() });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Wix GET ${path} → ${res.status}: ${body.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

export async function wixPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${WIX_BASE}${path}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Wix POST ${path} → ${res.status}: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

export async function wixPatch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${WIX_BASE}${path}`, {
    method: 'PATCH',
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Wix PATCH ${path} → ${res.status}: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

/**
 * Smoke test: query Wix Site Properties (low-impact endpoint available on most sites).
 * On 401/403, the API key/site/account IDs are wrong.
 */
export async function smokeTest(): Promise<{ ok: boolean; detail: string }> {
  try {
    const data = await wixGet<{ properties?: { siteDisplayName?: string } }>(
      '/site-properties/v4/properties',
    );
    const name = data?.properties?.siteDisplayName ?? '<unknown>';
    return { ok: true, detail: `connected to Wix site "${name}"` };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}

// ---------- Blog posts ---------------------------------------------------

export type WixSeoTag = {
  type: 'meta' | 'title' | 'link' | 'script';
  props?: { name?: string; content?: string; type?: string; rel?: string; href?: string };
  meta?: { schemaType?: string; displayName?: string };
  children?: string;
  custom?: boolean;
  disabled?: boolean;
};

export type WixBlogPost = {
  id: string;
  slug: string;
  title: string;
  excerpt?: string;
  customExcerpt?: string;
  contentText?: string;
  url?: { base?: string; path?: string };
  seoData?: { tags?: WixSeoTag[]; settings?: { keywords?: string[] } };
  firstPublishedDate?: string;
  lastPublishedDate?: string;
  language?: string;
};

/** GET a blog post by URL slug, including the SEO + content fieldsets. */
export async function getBlogPostBySlug(slug: string): Promise<WixBlogPost | null> {
  const path = `/blog/v3/posts/slugs/${encodeURIComponent(slug)}`;
  const query = ['URL', 'SEO', 'CONTENT_TEXT', 'RICH_CONTENT']
    .map((f) => `fieldsets=${f}`)
    .join('&');
  try {
    const data = await wixGet<{ post: WixBlogPost & { categoryIds?: string[] } }>(
      `${path}?${query}` as never,
    );
    return data.post ?? null;
  } catch (err) {
    const msg = (err as Error).message;
    // 404 surfaces as "Wix GET ... → 404: ..." — translate to null instead of throwing.
    if (msg.includes('→ 404')) return null;
    throw err;
  }
}

/** Per-post first-party metrics (cumulative since post creation). */
export type WixPostMetrics = {
  views: number;
  likes: number;
  comments: number;
};

export async function getPostMetrics(postId: string): Promise<WixPostMetrics | null> {
  try {
    const data = await wixGet<{
      metrics: { views?: number; likes?: number; comments?: number };
    }>(`/v3/posts/${postId}/metrics`);
    return {
      views: Number(data.metrics.views ?? 0),
      likes: Number(data.metrics.likes ?? 0),
      comments: Number(data.metrics.comments ?? 0),
    };
  } catch (err) {
    if ((err as Error).message.includes('→ 404')) return null;
    throw err;
  }
}

/**
 * Site-wide first-party totals from the Wix Analytics Data API. Used as a
 * calibration baseline against GA4 (which only tracks consent-accepting
 * users). The ratio Wix/GA4 ≈ true visitor count / consenting visitor count.
 *
 * NOTE: this endpoint is site-wide ONLY — there's no per-page breakdown
 * despite various filter/dimension/groupBy probes. Confirmed empirically.
 * 62-day retention.
 */
export type WixSiteAnalyticsTotal = { type: string; total: number };

export async function getSiteAnalyticsTotals(opts: {
  startDate: string; // yyyy-MM-dd
  endDate: string; // yyyy-MM-dd
  measurementTypes: string[]; // e.g. ['TOTAL_SESSIONS','TOTAL_UNIQUE_VISITORS']
}): Promise<WixSiteAnalyticsTotal[]> {
  const params = new URLSearchParams();
  params.append('dateRange.startDate', opts.startDate);
  params.append('dateRange.endDate', opts.endDate);
  for (const m of opts.measurementTypes) params.append('measurementTypes', m);
  const data = await wixGet<{
    data?: Array<{ type: string; total: number }>;
  }>(`/analytics/v2/site-analytics/data?${params.toString()}` as never);
  return data.data ?? [];
}

/**
 * Pull "what the page looks like to a search engine" for a given URL.
 *
 * For Wix blog posts (path starting with /post/), we use the Blog API and read
 * `seoData.tags` (custom SEO when present) + `post.title` / `post.excerpt`
 * (Wix's defaults). For static pages, we fall back to fetching the live HTML
 * and regex-parsing `<title>` + `<meta name="description">` + `<h1>` — less
 * reliable than the API, but works for any page type without extra deps.
 */
export type CurrentState = {
  title: string;
  meta_description: string;
  h1: string;
  intro_first_100_words: string;
  schema_jsonld: unknown[] | null;
  /**
   * Internal outbound links AT THE TIME OF THIS SNAPSHOT.
   *
   * Includes structural placement (Sprint 9) so the diagnostic prompt can
   * group editorial vs nav vs footer without re-classifying via heuristics.
   * This stays a snapshot here (audit_findings.current_state must remain
   * immutable for T+30/T+60 attribution); inbound counts come from the
   * live `internal_link_graph` table at diagnose time.
   */
  internal_links_outbound: Array<{
    anchor: string;
    target: string;
    placement?: 'editorial' | 'related' | 'nav' | 'footer' | 'cta' | 'image';
  }>;
  source: 'wix_blog_api' | 'html_scrape';
  fetched_at: string;
};

function pickSeoTitle(post: WixBlogPost): string {
  const titleTag = post.seoData?.tags?.find((t) => t.type === 'title');
  return titleTag?.children?.trim() || post.title;
}

function pickSeoMeta(post: WixBlogPost): string {
  const metaTag = post.seoData?.tags?.find(
    (t) => t.type === 'meta' && t.props?.name === 'description',
  );
  return metaTag?.props?.content?.trim() || post.customExcerpt || post.excerpt || '';
}

function pickJsonLd(post: WixBlogPost): unknown[] | null {
  const scripts = (post.seoData?.tags ?? []).filter(
    (t) => t.type === 'script' && t.props?.type === 'application/ld+json' && t.children,
  );
  if (scripts.length === 0) return null;
  const out: unknown[] = [];
  for (const s of scripts) {
    try {
      out.push(JSON.parse(s.children!));
    } catch {
      // skip malformed
    }
  }
  return out.length > 0 ? out : null;
}

function first100Words(text: string): string {
  return text.trim().split(/\s+/).slice(0, 100).join(' ');
}

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'",
  eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë',
  agrave: 'à', acirc: 'â', auml: 'ä', aring: 'å',
  ocirc: 'ô', ouml: 'ö', oslash: 'ø',
  ucirc: 'û', uuml: 'ü',
  icirc: 'î', iuml: 'ï',
  ccedil: 'ç', ntilde: 'ñ',
  Eacute: 'É', Egrave: 'È', Ecirc: 'Ê',
  Agrave: 'À', Acirc: 'Â',
  Ocirc: 'Ô',
  Ucirc: 'Û',
  Icirc: 'Î',
  Ccedil: 'Ç',
  laquo: '«', raquo: '»',
  rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”',
  hellip: '…', ndash: '–', mdash: '—', copy: '©', reg: '®', trade: '™',
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-zA-Z][a-zA-Z0-9]+);/g, (full, name: string) => NAMED_ENTITIES[name] ?? full);
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * Best-effort HTML scrape — for static (non-blog) pages where we don't have
 * structured API access. Regex-based extraction; deliberately permissive
 * because we don't ship a heavy DOM parser for this single use.
 */
async function scrapeHtml(url: string): Promise<CurrentState> {
  // Sprint-14: switched to CONTENT_BOT_UA for consistency across all
  // page-content fetches (Cooked-agent flag #1 — lets Wix logs filter
  // our traffic, lets Cooked Edge Function ignore our hits if we ever
  // switch to Playwright).
  const res = await fetch(url, { headers: { 'User-Agent': CONTENT_BOT_UA } });
  const html = await res.text();

  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const metaMatch = html.match(
    /<meta\s+[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i,
  );
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);

  // For the intro, scan the first ~30 <p> blocks and pick the one with the
  // most words. This skips nav/menu paragraphs and lands on body copy.
  const paragraphs = Array.from(html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi))
    .slice(0, 30)
    .map((m) => stripTags(m[1] ?? ''))
    .filter((p) => p.length > 0);
  const bestParagraph = paragraphs.sort((a, b) => b.split(/\s+/).length - a.split(/\s+/).length)[0] ?? '';

  const ldScripts = Array.from(
    html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi),
  );
  const jsonLd: unknown[] = [];
  for (const m of ldScripts) {
    try {
      jsonLd.push(JSON.parse(m[1]!));
    } catch {
      // skip
    }
  }

  // Sprint-9: link extraction goes through the same DOM classifier as the
  // crawler so the two data flows agree on placement labels. The body
  // extraction (title/meta/h1/intro/schema_jsonld) stays regex-based here —
  // the Sprint-10 backlog item is to swap it for Readability when the cost
  // is justified (only ~10-15 static pages benefit).
  let host = '';
  try {
    host = new URL(url).host;
  } catch {
    host = '';
  }
  const internal: CurrentState['internal_links_outbound'] = host
    ? classifyLinks({ pageUrl: url, html }).map((l) => ({
        anchor: l.anchor_text,
        target: `https://${host}${l.target_path}`,
        placement: l.placement,
      }))
    : [];

  return {
    title: stripTags(titleMatch?.[1] ?? ''),
    meta_description: decodeEntities(metaMatch?.[1]?.trim() ?? ''),
    h1: stripTags(h1Match?.[1] ?? ''),
    intro_first_100_words: first100Words(bestParagraph),
    schema_jsonld: jsonLd.length > 0 ? jsonLd : null,
    internal_links_outbound: internal,
    source: 'html_scrape',
    fetched_at: new Date().toISOString(),
  };
}

/**
 * Extract internal outbound links from the rendered HTML of a page,
 * already classified by DOM placement (editorial / nav / footer / related
 * / cta / image).
 *
 * Sprint 9 swap: the v1 regex implementation lived here with a hardcoded
 * denylist (`/categories/`, `/blog`, `/mentions-legales`,
 * `/comprendre-le-droit`). That denylist conflated extraction with
 * fix-generation policy — we now SEE all links in the data (graph
 * observability) and the "don't suggest as fix" rule is enforced
 * separately via `isForbiddenLinkTarget()` from site-catalog.ts.
 */
export async function scrapeInternalLinks(
  url: string,
): Promise<CurrentState['internal_links_outbound']> {
  const res = await fetch(url, { headers: { 'User-Agent': CONTENT_BOT_UA } });
  if (!res.ok) return [];
  const html = await res.text();
  const classified = classifyLinks({ pageUrl: url, html });
  // Translate the path-based ClassifiedLink to the URL-based
  // CurrentState shape we already persist (target as absolute URL, anchor,
  // placement). Reconstruct the absolute URL from the page host + target_path.
  let host = '';
  try {
    host = new URL(url).host;
  } catch {
    return [];
  }
  return classified.map((l) => ({
    anchor: l.anchor_text,
    target: `https://${host}${l.target_path}`,
    placement: l.placement,
  }));
}

/**
 * Resolve the current SEO state for a given page URL. Tries the Wix Blog API
 * first if the path is a blog post slug, falls back to scraping the live HTML.
 * Throws only on unrecoverable fetch errors; returns a partially-populated
 * CurrentState if some fields can't be extracted.
 */
export async function getCurrentStateForUrl(pageUrl: string): Promise<CurrentState> {
  let parsed: URL;
  try {
    parsed = new URL(pageUrl);
  } catch {
    throw new Error(`invalid page URL: ${pageUrl}`);
  }

  // Blog post path: /post/<slug>
  const blogMatch = parsed.pathname.match(/^\/post\/(.+)$/);
  if (blogMatch) {
    const slug = decodeURIComponent(blogMatch[1]!);
    const post = await getBlogPostBySlug(slug);
    if (post) {
      const intro = first100Words(post.contentText ?? '');
      // The Blog API doesn't expose the rendered in-body links. Do a parallel
      // HTML fetch to extract them — without this the LLM was diagnosing
      // 'aucun maillage interne' on pages that actually link to expertise +
      // CTA pages, leading to a wrong 'cul-de-sac funnel' conclusion.
      const links = await scrapeInternalLinks(pageUrl).catch(() => []);
      return {
        title: pickSeoTitle(post),
        meta_description: pickSeoMeta(post),
        h1: post.title, // Wix renders the post.title as H1 by default
        intro_first_100_words: intro,
        schema_jsonld: pickJsonLd(post),
        internal_links_outbound: links,
        source: 'wix_blog_api',
        fetched_at: new Date().toISOString(),
      };
    }
    // If no post matches, fall through to HTML scrape.
  }

  return scrapeHtml(pageUrl);
}

/**
 * Sprint-14: extract a structured ContentSnapshot for a given page URL.
 *
 * Strategy:
 *   1. Fetch the live HTML once (with CONTENT_BOT_UA per Cooked-agent flag #1)
 *   2. For /post/* paths, also pull the Wix Blog API to enrich the author
 *      override with firstPublishedDate, lastPublishedDate, member fullName
 *      (Cooked-agent flag #3 — don't regex HTML for author when the API has it)
 *   3. Pass HTML + authorOverride into extractPageContent to get the snapshot
 *
 * Best-effort everywhere: returns a partially-populated snapshot if either
 * fetch fails, never throws on a single missing field.
 */
export async function extractContentForFinding(pageUrl: string): Promise<ContentSnapshot> {
  // 1. Fetch HTML
  const res = await fetch(pageUrl, { headers: { 'User-Agent': CONTENT_BOT_UA } });
  if (!res.ok) {
    throw new Error(`extractContentForFinding fetch ${pageUrl} → ${res.status}`);
  }
  const html = await res.text();

  // 2. For /post/* paths, enrich author from the Blog API
  let authorOverride: AuthorInfo | null = null;
  let parsed: URL;
  try {
    parsed = new URL(pageUrl);
  } catch {
    // unparseable URL — skip blog enrichment, fall back to HTML extraction only
    return extractPageContent({ html, pageUrl });
  }
  const blogMatch = parsed.pathname.match(/^\/post\/(.+)$/);
  if (blogMatch) {
    const slug = decodeURIComponent(blogMatch[1]!);
    try {
      const post = await getBlogPostBySlug(slug);
      if (post) {
        authorOverride = {
          // member.profile.fullName is not on the WixBlogPost type yet —
          // would require a raw call to /v3/members/{id} + extending the Zod
          // shape. Deferred : on Plouton the byline is extracted from
          // <a rel="author"> in the HTML in 100% of observed cases, so the
          // Blog API author name has not been needed in practice.
          date_published: post.firstPublishedDate,
          date_modified: post.lastPublishedDate,
        };
      }
    } catch {
      // Blog API miss — fall back to HTML regex extraction in extractPageContent
    }
  }

  // 3. Extract
  return extractPageContent({ html, pageUrl, authorOverride });
}
