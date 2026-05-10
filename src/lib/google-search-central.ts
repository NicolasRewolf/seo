/**
 * Sprint 19 — Google Search Central guidance fetcher.
 *
 * Pulls fresh guidance straight from Google so the diagnostic LLM has a
 * SILO of "what Google is currently saying" to defer to when its training-
 * data beliefs might be stale or contradicted.
 *
 * Two sources :
 *   1. Google Search Central Blog (RSS 2.0) — official posts about core
 *      updates, spam policies, ranking systems, EEAT, page experience, etc.
 *      URL : https://developers.google.com/search/blog/feed.xml
 *   2. Google Search Status Dashboard (JSON) — currently active OR recently
 *      ended ranking-system updates (core update, spam update, helpful
 *      content, etc.) + transient indexing/crawling incidents.
 *      URL : https://status.search.google.com/incidents.json
 *
 * Both sources are public, gratuit, and stable enough to poll. We cache
 * 1h at module level to avoid hammering them on every diag of a batch.
 *
 * The output is consumed input-only by the diagnostic prompt — the LLM
 * reads it as an external authority signal, distinct from the page-data
 * analysis it does on the other blocks.
 */

// ============================================================================
// Types
// ============================================================================

export type BlogPost = {
  title: string;
  link: string;
  /** Short summary extracted from the RSS description (HTML stripped, ~200 chars). */
  summary: string;
  /** ISO 8601 (e.g. "2026-04-13"). */
  published_date: string;
  /** Days since published (snapshot at fetch time). */
  age_days: number;
};

export type StatusIncident = {
  id: string;
  /** Human-readable label (e.g. "March 2026 core update"). */
  title: string;
  begin: string; // ISO 8601
  end: string | null; // null when still in progress
  is_active: boolean;
  /** Categorization of the incident type — derived from title. */
  category: 'core_update' | 'spam_update' | 'helpful_content_update' | 'other';
};

export type GoogleSearchGuidance = {
  blog_posts: BlogPost[];
  incidents: StatusIncident[];
  fetched_at: string; // ISO 8601
};

// ============================================================================
// Cache (module-level, 1h TTL)
// ============================================================================

let cached: { value: GoogleSearchGuidance; expiresAt: number } | null = null;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1h

export function _resetCacheForTests(): void {
  cached = null;
}

// ============================================================================
// Filtering — what's a "pivot" post worth surfacing to the LLM
// ============================================================================

/**
 * Pivot keywords : the LLM benefits from these in the diag. We exclude
 * pure event/PR posts ("Search Central Live Shanghai") and highly local
 * announcements that don't change SEO advice.
 *
 * If a post title or summary matches AT LEAST ONE of these patterns, it's
 * kept. Otherwise filtered out.
 */
const PIVOT_PATTERNS = [
  // Algorithm updates
  /\bcore update\b/i,
  /\bspam update\b/i,
  /\bspam polic(?:y|ies)\b/i,
  /\bhelpful content\b/i,
  /\bproduct review(?:s)? update\b/i,
  /\breview(?:s)? update\b/i,
  /\branking system/i,
  // Quality framework
  /\bEEAT\b|E-?E-?A-?T/i,
  /\bYMYL\b/i,
  /\bquality (?:guidelines?|rater)/i,
  // AI content
  /\bAI(?:-| )(?:generated|content|overview)\b/i,
  /\bgenerative (?:AI|search)\b/i,
  /\bSGE\b/i,
  // Page experience / CWV
  /\bcore web vital/i,
  /\bpage experience\b/i,
  /\bINP\b|interaction to next paint/i,
  /\bLCP\b|largest contentful paint/i,
  /\bCLS\b|cumulative layout shift/i,
  // Mobile
  /\bmobile-first\b/i,
  // Schema / structured data
  /\bschema(?:\.org)?\b/i,
  /\bstructured data\b/i,
  /\brich (?:result|snippet)/i,
  // Crawling / indexing
  /\bcrawl(?:ing|er|ed)?\b/i,
  /\bindex(?:ing|er|ed|ation)?\b/i,
  /\bnoindex\b/i,
  /\brobots(?:\.txt)?\b/i,
  /\bsitemap/i,
  // SERP features
  /\bfeatured snippet/i,
  /\bAI overview/i,
  // Architecture
  /\bcanonical/i,
  /\bhreflang\b/i,
  /\bduplicate content\b/i,
];

function isPivotPost(post: { title: string; summary: string }): boolean {
  const haystack = `${post.title} ${post.summary}`;
  return PIVOT_PATTERNS.some((re) => re.test(haystack));
}

// ============================================================================
// RSS parser — minimal hand-rolled (avoids a heavy XML dep just for 5 fields)
// ============================================================================

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'");
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse a minimal RSS 2.0 feed. Extracts only what we need : title, link,
 * description (stripped + truncated), pubDate.
 *
 * Inline regex on purpose — RSS is shallow enough that adding fast-xml-parser
 * for 4 fields is overkill, and the format is stable (Google maintains it).
 */
export function parseRssFeed(xml: string): BlogPost[] {
  const items: BlogPost[] = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let match: RegExpExecArray | null;
  while ((match = itemRe.exec(xml)) !== null) {
    const block = match[1]!;
    const title = block.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim() ?? '';
    const link = block.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim() ?? '';
    const descRaw = block.match(/<description>([\s\S]*?)<\/description>/)?.[1] ?? '';
    // Strip CDATA wrapper if present
    const descUnwrapped = descRaw.replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '').trim();
    const summary = stripHtml(decodeEntities(descUnwrapped)).slice(0, 220);
    const pubDateRaw = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]?.trim() ?? '';
    const date = pubDateRaw ? new Date(pubDateRaw) : null;
    const isoDate = date && !isNaN(date.getTime()) ? date.toISOString().slice(0, 10) : '';
    const ageDays =
      date && !isNaN(date.getTime())
        ? Math.max(0, Math.floor((Date.now() - date.getTime()) / (24 * 60 * 60 * 1000)))
        : 9999;
    if (title && isoDate) {
      items.push({
        title: decodeEntities(title),
        link,
        summary,
        published_date: isoDate,
        age_days: ageDays,
      });
    }
  }
  return items;
}

// ============================================================================
// Status incident classifier
// ============================================================================

function classifyIncident(title: string): StatusIncident['category'] {
  const t = title.toLowerCase();
  if (/\bspam update\b/.test(t)) return 'spam_update';
  if (/\bcore update\b/.test(t)) return 'core_update';
  if (/\bhelpful content\b/.test(t)) return 'helpful_content_update';
  return 'other';
}

// ============================================================================
// Public fetchers
// ============================================================================

/**
 * Fetch + filter the recent Search Central blog posts. Returns up to
 * `maxResults` (default 8) entries that :
 *   - match at least one pivot pattern (core update, EEAT, schema, ...)
 *   - are <= `maxAgeDays` (default 90) old
 * Sorted by recency (newest first).
 */
export async function fetchRecentBlogPosts(opts?: {
  maxAgeDays?: number;
  maxResults?: number;
}): Promise<BlogPost[]> {
  const maxAgeDays = opts?.maxAgeDays ?? 90;
  const maxResults = opts?.maxResults ?? 8;
  const res = await fetch('https://developers.google.com/search/blog/feed.xml', {
    headers: { 'User-Agent': 'plouton-seo-bot/1.0 (+nicolas@rewolf.studio)' },
  });
  if (!res.ok) throw new Error(`Search Central blog feed ${res.status}`);
  const xml = await res.text();
  const allPosts = parseRssFeed(xml);
  const fresh = allPosts.filter((p) => p.age_days <= maxAgeDays);
  const pivot = fresh.filter(isPivotPost);
  // Sort by recency desc (parseRssFeed should already be in feed order, but be defensive)
  pivot.sort((a, b) => a.age_days - b.age_days);
  return pivot.slice(0, maxResults);
}

/**
 * Fetch the Search Status Dashboard incidents. Returns :
 *   - incidents currently in progress (no end date)
 *   - + ranking-system updates (core/spam/helpful) ended in the last
 *     `recentDays` (default 60) — historical context for "did Google
 *     just shake the SERP recently?"
 * Other/transient incidents are filtered out.
 */
export async function fetchActiveAndRecentIncidents(opts?: {
  recentDays?: number;
}): Promise<StatusIncident[]> {
  const recentDays = opts?.recentDays ?? 60;
  const res = await fetch('https://status.search.google.com/incidents.json', {
    headers: { 'User-Agent': 'plouton-seo-bot/1.0 (+nicolas@rewolf.studio)' },
  });
  if (!res.ok) throw new Error(`Search Status Dashboard ${res.status}`);
  const data = (await res.json()) as Array<{
    id: string;
    external_desc?: string;
    name?: string;
    begin?: string;
    end?: string;
  }>;
  const cutoff = Date.now() - recentDays * 24 * 60 * 60 * 1000;
  const incidents: StatusIncident[] = [];
  for (const raw of data) {
    const title = raw.external_desc || raw.name || '';
    if (!title) continue;
    const category = classifyIncident(title);
    const begin = raw.begin ?? '';
    const end = raw.end ?? null;
    const isActive = !end;
    // Keep if : actively in progress, OR a ranking system update ended within recent window
    if (isActive) {
      incidents.push({ id: raw.id, title, begin, end, is_active: true, category });
    } else if (category !== 'other') {
      const endDate = end ? new Date(end).getTime() : 0;
      if (endDate >= cutoff) {
        incidents.push({ id: raw.id, title, begin, end, is_active: false, category });
      }
    }
  }
  // Sort : active first, then most recent end date
  incidents.sort((a, b) => {
    if (a.is_active !== b.is_active) return a.is_active ? -1 : 1;
    const aT = a.end ? new Date(a.end).getTime() : Date.now();
    const bT = b.end ? new Date(b.end).getTime() : Date.now();
    return bT - aT;
  });
  return incidents;
}

/**
 * Combined fetcher with module-level cache (1h TTL). All consumers go
 * through this — the per-source fetchers above are exported for testing.
 */
export async function fetchGoogleGuidance(): Promise<GoogleSearchGuidance> {
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const [posts, incidents] = await Promise.all([
    fetchRecentBlogPosts().catch((err) => {
      process.stderr.write(`[google-guidance] blog feed failed: ${(err as Error).message}\n`);
      return [] as BlogPost[];
    }),
    fetchActiveAndRecentIncidents().catch((err) => {
      process.stderr.write(`[google-guidance] status dashboard failed: ${(err as Error).message}\n`);
      return [] as StatusIncident[];
    }),
  ]);
  const value: GoogleSearchGuidance = {
    blog_posts: posts,
    incidents,
    fetched_at: new Date().toISOString(),
  };
  cached = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}

// ============================================================================
// Smoke test
// ============================================================================

export async function smokeTest(): Promise<{ ok: boolean; detail: string }> {
  try {
    const g = await fetchGoogleGuidance();
    const activeUpdates = g.incidents.filter((i) => i.is_active);
    return {
      ok: true,
      detail: `${g.blog_posts.length} pivot posts (90d) · ${g.incidents.length} incidents (${activeUpdates.length} active) · cache 1h`,
    };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}
