/**
 * Sprint-7+8 — context enrichment for the diagnostic LLM.
 *
 * For each finding we gather, on top of the GSC/Cooked numbers already in DB:
 *   - Wix blog post metadata (categoryIds → labels → funnel role + funnelTo)
 *   - Wix Blog Post first-party metrics (views, likes, comments)
 *   - DataForSEO real monthly search volume (France) for the top queries +
 *     share-of-voice (impressions captured / monthly search volume)
 *   - Catalog of REAL Plouton URLs by funnel role so the LLM stops
 *     hallucinating link targets
 *
 * NOTE: a previous version of this module computed a `consent_calibration`
 * (Wix sessions vs GA4 sessions → consent_rate) so the LLM could weight the
 * cookie-biased GA4 signals properly. Sprint 8 swapped GA4 for Cooked, which
 * is itself first-party and unbiased — calibration is no longer meaningful
 * and was dropped along with the GA4 import.
 */
import { getBlogPostBySlug, getPostMetrics, type WixPostMetrics } from '../lib/wix.js';
import {
  getSearchVolumes,
  getSerpOrganicTop10,
  type KeywordVolume,
  type SerpSnapshot,
} from '../lib/dataforseo.js';
import {
  WIX_CATEGORIES,
  catalogByRole,
  type CategoryInfo,
} from '../lib/site-catalog.js';
import { fetchGoogleGuidance, type GoogleSearchGuidance } from '../lib/google-search-central.js';

export type EnrichedTopQuery = {
  query: string;
  impressions: number;
  ctr: number;
  position: number;
  monthly_volume_fr: number | null;
  cpc: number | null;
  /** impressions / volume → what % of demand we already capture this month. */
  share_of_voice_pct: number | null;
  /** Sprint 18 — Top 10 SERP Google FR (organic) + features observées.
   *  Optionnel : null si DataForSEO SERP a échoué pour cette query (best-effort). */
  serp?: SerpSnapshot | null;
};

/** Sprint 18 — top-N queries pour lesquelles on fetch un SERP (cap coût). */
const SERP_TOP_N_QUERIES = 5;

export type EnrichedContext = {
  /** Wix post id, undefined if URL is a static page. */
  wix_post_id: string | undefined;

  /** Article category as Wix sees it. */
  category: CategoryInfo | null;

  /** First-party post metrics (cumulative since publish). */
  wix_metrics: WixPostMetrics | null;

  /** Real demand from DataForSEO. */
  enriched_top_queries: EnrichedTopQuery[];
  /** Sum of monthly volumes for the top queries (rough TAM proxy). */
  total_monthly_demand_fr: number | null;

  /** Categorized list of internal URLs the LLM is allowed to recommend. */
  internal_pages_catalog: ReturnType<typeof catalogByRole>;

  /** Sprint 19 — fresh guidance straight from Google (Search Central blog
   *  + Status Dashboard). Cached 1h at module level so a batch of findings
   *  pays only one fetch. Optional : null on fetch failure (best-effort). */
  google_guidance: GoogleSearchGuidance | null;
};

function slugFromUrl(pageUrl: string): string | null {
  try {
    const u = new URL(pageUrl);
    const m = u.pathname.match(/^\/post\/(.+)$/);
    return m ? decodeURIComponent(m[1]!) : null;
  } catch {
    return null;
  }
}

async function fetchPostMeta(
  pageUrl: string,
): Promise<{ postId: string; categoryIds: string[] } | null> {
  const slug = slugFromUrl(pageUrl);
  if (!slug) return null;
  const post = await getBlogPostBySlug(slug);
  if (!post) return null;
  const categoryIds = (post as { categoryIds?: string[] }).categoryIds ?? [];
  return { postId: post.id, categoryIds };
}

function pickPrimaryCategory(categoryIds: string[]): CategoryInfo | null {
  // Prefer a topic_expertise category if present, else fall back to the first.
  const infos = categoryIds.map((id) => WIX_CATEGORIES[id]).filter(Boolean) as CategoryInfo[];
  if (infos.length === 0) return null;
  const topic = infos.find((i) => i.role === 'topic_expertise');
  return topic ?? infos[0]!;
}

async function enrichTopQueries(
  topQueries: Array<{ query: string; impressions: number; ctr: number; position: number }>,
): Promise<{ enriched: EnrichedTopQuery[]; totalDemand: number | null }> {
  if (topQueries.length === 0) return { enriched: [], totalDemand: null };
  let volumes: KeywordVolume[] = [];
  try {
    volumes = await getSearchVolumes({
      keywords: topQueries.map((q) => q.query),
      locationName: 'France',
      languageCode: 'fr',
    });
  } catch (err) {
    // Non-fatal — diagnose without DataForSEO if it errors.
    process.stderr.write(`[enrich] DataForSEO failed: ${(err as Error).message}\n`);
  }
  const byKw = new Map<string, KeywordVolume>();
  for (const v of volumes) byKw.set(v.keyword.toLowerCase(), v);

  let totalDemand = 0;
  let anyDemand = false;
  const enriched: EnrichedTopQuery[] = topQueries.map((q) => {
    const v = byKw.get(q.query.toLowerCase());
    const vol = v?.search_volume ?? null;
    if (vol != null) {
      anyDemand = true;
      totalDemand += vol;
    }
    const monthlyImpressions = q.impressions / 3; // GSC window is 3 months
    const sov = vol && vol > 0 ? Math.round((monthlyImpressions / vol) * 1000) / 10 : null;
    return {
      query: q.query,
      impressions: q.impressions,
      ctr: q.ctr,
      position: q.position,
      monthly_volume_fr: vol,
      cpc: v?.cpc ?? null,
      share_of_voice_pct: sov,
    };
  });

  // Sprint 18 — fetch SERP top 10 for the top N queries (cap cost). Parallel
  // via Promise.all: at N=5 the natural concurrency is fine (no rate limit
  // pressure on DataForSEO live endpoint). Best-effort per query: 1 failure
  // = serp:null on that query, the diag still runs with all other signals.
  const topSerpQueries = enriched.slice(0, SERP_TOP_N_QUERIES);
  const serpResults = await Promise.all(
    topSerpQueries.map(async (q) => {
      try {
        return await getSerpOrganicTop10({
          keyword: q.query,
          locationName: 'France',
          languageCode: 'fr',
        });
      } catch (err) {
        process.stderr.write(
          `[enrich] DataForSEO SERP failed on "${q.query}": ${(err as Error).message}\n`,
        );
        return null;
      }
    }),
  );
  // Attach SERP back onto enriched (top N only — beyond N, leave undefined).
  for (let i = 0; i < topSerpQueries.length; i++) {
    enriched[i]!.serp = serpResults[i]!;
  }

  return { enriched, totalDemand: anyDemand ? totalDemand : null };
}

export async function enrichContext(opts: {
  pageUrl: string;
  topQueries: Array<{ query: string; impressions: number; ctr: number; position: number }>;
}): Promise<EnrichedContext> {
  const meta = await fetchPostMeta(opts.pageUrl);
  const category = meta ? pickPrimaryCategory(meta.categoryIds) : null;

  let wixMetrics: WixPostMetrics | null = null;
  if (meta) {
    try {
      wixMetrics = await getPostMetrics(meta.postId);
    } catch (err) {
      process.stderr.write(`[enrich] Wix metrics failed: ${(err as Error).message}\n`);
    }
  }

  const { enriched, totalDemand } = await enrichTopQueries(opts.topQueries);

  // Sprint 19 — pull fresh Google Search Central guidance. Cached 1h at
  // module level so a 17-finding batch pays exactly 1 fetch. Best-effort :
  // on network failure the diag continues without this signal.
  let googleGuidance: GoogleSearchGuidance | null = null;
  try {
    googleGuidance = await fetchGoogleGuidance();
  } catch (err) {
    process.stderr.write(`[enrich] Google Search Central guidance failed: ${(err as Error).message}\n`);
  }

  return {
    wix_post_id: meta?.postId,
    category,
    wix_metrics: wixMetrics,
    enriched_top_queries: enriched,
    total_monthly_demand_fr: totalDemand,
    internal_pages_catalog: catalogByRole(),
    google_guidance: googleGuidance,
  };
}
