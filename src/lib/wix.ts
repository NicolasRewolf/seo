import { env } from '../config.js';

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
  internal_links_outbound: Array<{ anchor: string; target: string }>;
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
  const res = await fetch(url, { headers: { 'User-Agent': 'plouton-seo-audit/0.0.1' } });
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

  const linkMatches = Array.from(
    html.matchAll(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi),
  );
  const sameSite = new URL(url).host;
  const internal: Array<{ anchor: string; target: string }> = [];
  for (const m of linkMatches.slice(0, 200)) {
    const href = m[1]!;
    const anchor = stripTags(m[2]!);
    if (!anchor) continue;
    let absolute: string;
    try {
      absolute = new URL(href, url).toString();
    } catch {
      continue;
    }
    try {
      if (new URL(absolute).host !== sameSite) continue;
    } catch {
      continue;
    }
    internal.push({ anchor: anchor.slice(0, 120), target: absolute });
    if (internal.length >= 30) break;
  }

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
 * Extract just the internal-links list from the rendered HTML of a page.
 * Used as a complement to the Wix Blog API (which gives us clean SEO + intro
 * but not the in-body links — the v1 implementation hardcoded `[]` and the
 * LLM concluded false 'maillage inexistant' diagnoses).
 *
 * Returns links to the same host. Drops the boilerplate "Posts similaires"
 * recommendations which are auto-generated by Wix and don't reflect the
 * editorial maillage.
 */
export async function scrapeInternalLinks(
  url: string,
): Promise<Array<{ anchor: string; target: string }>> {
  const res = await fetch(url, { headers: { 'User-Agent': 'plouton-seo-audit/0.0.1' } });
  if (!res.ok) return [];
  const html = await res.text();
  const sameSite = new URL(url).host;

  const matches = Array.from(
    html.matchAll(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi),
  );
  const seen = new Set<string>();
  const links: Array<{ anchor: string; target: string }> = [];
  for (const m of matches) {
    const href = m[1]!;
    const anchorText = stripTags(m[2]!);
    if (!anchorText) continue;
    let absolute: string;
    try {
      absolute = new URL(href, url).toString();
    } catch {
      continue;
    }
    try {
      if (new URL(absolute).host !== sameSite) continue;
    } catch {
      continue;
    }
    // Self-link / fragment-only? Skip.
    if (absolute === url || absolute.split('#')[0] === url) continue;
    // Skip Wix navigation noise: blog/category index pages and the
    // boilerplate "categories" submenu present in the header on every
    // post. These are not editorial maillage and would mislead the LLM.
    const path = (() => {
      try {
        return new URL(absolute).pathname;
      } catch {
        return absolute;
      }
    })();
    if (path.includes('/categories/')) continue;
    if (path === '/blog' || path === '/blog/') continue;
    if (path === '/mentions-legales') continue;
    if (path === '/comprendre-le-droit') continue;
    // Dedupe on (target, anchor) — same URL with different anchors is
    // useful signal (e.g. "Accueil" in nav vs "cabinet Plouton" in body
    // both point to /, but the second is editorial maillage).
    const key = absolute + '|' + anchorText.toLowerCase().slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ anchor: anchorText.slice(0, 120), target: absolute });
    if (links.length >= 60) break;
  }
  return links;
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
