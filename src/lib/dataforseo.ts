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
