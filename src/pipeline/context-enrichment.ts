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
import { getSearchVolumes, type KeywordVolume } from '../lib/dataforseo.js';
import {
  WIX_CATEGORIES,
  catalogByRole,
  type CategoryInfo,
} from '../lib/site-catalog.js';

export type EnrichedTopQuery = {
  query: string;
  impressions: number;
  ctr: number;
  position: number;
  monthly_volume_fr: number | null;
  cpc: number | null;
  /** impressions / volume → what % of demand we already capture this month. */
  share_of_voice_pct: number | null;
};

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

  return {
    wix_post_id: meta?.postId,
    category,
    wix_metrics: wixMetrics,
    enriched_top_queries: enriched,
    total_monthly_demand_fr: totalDemand,
    internal_pages_catalog: catalogByRole(),
  };
}
