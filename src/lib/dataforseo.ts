/**
 * DataForSEO client — minimal wrapper around the keywords_data Live endpoint.
 *
 * Used by the diagnose step to enrich each finding's top GSC queries with
 * the *real* monthly search volume in France. Without this, the LLM only
 * sees the page's own impressions and can't tell whether the page is
 * already capturing a large share of the addressable demand or sitting at
 * 2 % of it.
 */
import { z } from 'zod';

const Env = z.object({ DATAFORSEO_AUTH: z.string().min(1) });

export type KeywordVolume = {
  keyword: string;
  search_volume: number | null;
  cpc: number | null;
  competition: string | null;
};

/**
 * Pull monthly search volume for up to 1000 keywords in one shot. Returns
 * the items in input order; missing data → null fields. Cost: ~$0.075 per
 * keyword (DataForSEO standard pricing for the live endpoint).
 */
export async function getSearchVolumes(opts: {
  keywords: string[];
  locationName?: string; // e.g. "France"
  languageCode?: string; // e.g. "fr"
}): Promise<KeywordVolume[]> {
  const { DATAFORSEO_AUTH } = Env.parse(process.env);
  if (opts.keywords.length === 0) return [];

  const res = await fetch(
    'https://api.dataforseo.com/v3/keywords_data/google/search_volume/live',
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${DATAFORSEO_AUTH}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([
        {
          keywords: opts.keywords,
          location_name: opts.locationName ?? 'France',
          language_code: opts.languageCode ?? 'fr',
        },
      ]),
    },
  );
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`DataForSEO ${res.status}: ${txt.slice(0, 300)}`);
  }
  const json = (await res.json()) as {
    tasks?: Array<{
      result?: Array<{
        keyword: string;
        search_volume: number | null;
        cpc: number | null;
        competition_level?: string | null;
      }>;
      status_message?: string;
    }>;
  };
  const result = json.tasks?.[0]?.result ?? [];

  // Map back to input order so callers can zip with their query list.
  const byKeyword = new Map<string, (typeof result)[number]>();
  for (const r of result) byKeyword.set(r.keyword.toLowerCase(), r);

  return opts.keywords.map((kw) => {
    const r = byKeyword.get(kw.toLowerCase());
    return {
      keyword: kw,
      search_volume: r?.search_volume ?? null,
      cpc: r?.cpc ?? null,
      competition: r?.competition_level ?? null,
    };
  });
}

// ============================================================================
// Sprint 18 — SERP organic results.
//
// Pull the top 10 Google FR SERP for a query so the diagnose LLM can see WHO
// ranks above us (Wikipedia, service-public.fr, concurrent law firms, ...) +
// what SERP features are present (AI Overview, featured snippet, PAA box).
// Without this the LLM diagnoses the snippet weakness blind.
//
// Endpoint cost ≈ $0.002 per query (DataForSEO live advanced standard pricing).
// ============================================================================

export type SerpItemType =
  | 'organic'
  | 'featured_snippet'
  | 'ai_overview'
  | 'people_also_ask'
  | 'knowledge_graph'
  | 'local_pack'
  | 'video'
  | 'images'
  | 'related_searches'
  | 'discussions_and_forums'
  | 'answer_box'
  | 'other';

export type SerpItem = {
  type: SerpItemType;
  /** Position within same-type elements (organic_position = rank_group on type='organic'). */
  rank_group: number | null;
  /** Overall SERP position across ALL block types. */
  rank_absolute: number | null;
  title: string | null;
  url: string | null;
  domain: string | null;
  description: string | null;
};

export type SerpSnapshot = {
  keyword: string;
  /** Top 10 organic items only (filtered from the full SERP). */
  organic: SerpItem[];
  /** SERP features observed on the page (booleans for the most actionable ones). */
  features: {
    has_ai_overview: boolean;
    has_featured_snippet: boolean;
    has_people_also_ask: boolean;
    has_knowledge_graph: boolean;
    has_local_pack: boolean;
    has_video: boolean;
  };
  fetched_at: string; // ISO timestamp
};

const SERP_DOMAIN_NORMALIZER = /^www\./;
function normalizeDomain(d: string | null | undefined): string | null {
  if (!d) return null;
  return d.replace(SERP_DOMAIN_NORMALIZER, '');
}

function classifyItemType(raw: string | null | undefined): SerpItemType {
  if (!raw) return 'other';
  switch (raw) {
    case 'organic':
    case 'featured_snippet':
    case 'ai_overview':
    case 'people_also_ask':
    case 'knowledge_graph':
    case 'local_pack':
    case 'video':
    case 'images':
    case 'related_searches':
    case 'discussions_and_forums':
    case 'answer_box':
      return raw;
    default:
      return 'other';
  }
}

/**
 * Fetch the top 10 organic results + key SERP features for a single keyword.
 *
 * Throws on HTTP error (caller is expected to catch and degrade gracefully —
 * see `enrichTopQueries` for the best-effort pattern).
 *
 * `device='desktop'` chosen for v1 because (a) less personalization than
 * mobile, (b) law-firm SEO competitors are content-heavy desktop-leaning.
 * Could add a `device` param later if we want per-finding mobile checks.
 */
export async function getSerpOrganicTop10(opts: {
  keyword: string;
  locationName?: string;
  languageCode?: string;
}): Promise<SerpSnapshot> {
  const { DATAFORSEO_AUTH } = Env.parse(process.env);
  const res = await fetch(
    'https://api.dataforseo.com/v3/serp/google/organic/live/advanced',
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${DATAFORSEO_AUTH}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([
        {
          keyword: opts.keyword,
          location_name: opts.locationName ?? 'France',
          language_code: opts.languageCode ?? 'fr',
          device: 'desktop',
          depth: 10,
        },
      ]),
    },
  );
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`DataForSEO SERP ${res.status}: ${txt.slice(0, 300)}`);
  }
  const json = (await res.json()) as {
    tasks?: Array<{
      result?: Array<{
        keyword: string;
        items?: Array<{
          type: string;
          rank_group?: number | null;
          rank_absolute?: number | null;
          title?: string | null;
          url?: string | null;
          domain?: string | null;
          description?: string | null;
        }>;
        item_types?: string[];
      }>;
      status_message?: string;
    }>;
  };
  const result = json.tasks?.[0]?.result?.[0];
  const rawItems = result?.items ?? [];
  const itemTypesPresent = new Set((result?.item_types ?? []).map(String));

  // Keep only the top 10 organic items (filtered + truncated, since item types
  // are interleaved with SERP features in the response).
  const organic: SerpItem[] = [];
  for (const it of rawItems) {
    if (organic.length >= 10) break;
    if (it.type !== 'organic') continue;
    organic.push({
      type: 'organic',
      rank_group: it.rank_group ?? null,
      rank_absolute: it.rank_absolute ?? null,
      title: it.title ?? null,
      url: it.url ?? null,
      domain: normalizeDomain(it.domain),
      description: it.description ?? null,
    });
  }

  return {
    keyword: opts.keyword,
    organic,
    features: {
      has_ai_overview: itemTypesPresent.has('ai_overview'),
      has_featured_snippet: itemTypesPresent.has('featured_snippet'),
      has_people_also_ask: itemTypesPresent.has('people_also_ask'),
      has_knowledge_graph: itemTypesPresent.has('knowledge_graph'),
      has_local_pack: itemTypesPresent.has('local_pack'),
      has_video: itemTypesPresent.has('video'),
    },
    fetched_at: new Date().toISOString(),
  };
}

/**
 * Smoke test — uses a stable mainstream FR query to verify auth + endpoint
 * shape without depending on Plouton-specific data.
 */
export async function smokeTest(): Promise<{ ok: boolean; detail: string }> {
  try {
    const r = await getSerpOrganicTop10({ keyword: 'avocat pénaliste bordeaux' });
    if (r.organic.length === 0) {
      return { ok: false, detail: 'SERP returned 0 organic results (suspicious)' };
    }
    const top = r.organic[0]!;
    return {
      ok: true,
      detail: `top1=${top.domain ?? '?'} (rank_abs=${top.rank_absolute ?? '?'}) · ${r.organic.length} organic · features={ai:${r.features.has_ai_overview ? 1 : 0},fs:${r.features.has_featured_snippet ? 1 : 0},paa:${r.features.has_people_also_ask ? 1 : 0}}`,
    };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}
