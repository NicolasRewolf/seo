import { google, type webmasters_v3 } from 'googleapis';
import { format, subDays } from 'date-fns';
import { googleOAuth } from './google-auth.js';
import { loadEnv } from '../config.js';

let cached: webmasters_v3.Webmasters | null = null;

export function gsc(): webmasters_v3.Webmasters {
  if (cached) return cached;
  cached = google.webmasters({ version: 'v3', auth: googleOAuth() });
  return cached;
}

export type SearchAnalyticsRow = {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
};

export async function querySearchAnalytics(params: {
  dimensions: Array<'page' | 'query' | 'date' | 'country' | 'device'>;
  startDate: string;
  endDate: string;
  rowLimit?: number;
  startRow?: number;
  dimensionFilterGroups?: webmasters_v3.Schema$ApiDimensionFilterGroup[];
}): Promise<SearchAnalyticsRow[]> {
  const env = loadEnv();
  const { data } = await gsc().searchanalytics.query({
    siteUrl: env.GSC_PROPERTY_URL,
    requestBody: {
      startDate: params.startDate,
      endDate: params.endDate,
      dimensions: params.dimensions,
      rowLimit: params.rowLimit ?? 1000,
      startRow: params.startRow ?? 0,
      dimensionFilterGroups: params.dimensionFilterGroups,
    },
  });
  return (data.rows ?? []) as SearchAnalyticsRow[];
}

/** Smoke test: list verified sites + a tiny 7-day query on the configured property. */
export async function smokeTest(): Promise<{ ok: boolean; detail: string }> {
  try {
    const env = loadEnv();
    const sites = await gsc().sites.list();
    const found = (sites.data.siteEntry ?? []).some((s) => s.siteUrl === env.GSC_PROPERTY_URL);
    if (!found) {
      const known = (sites.data.siteEntry ?? []).map((s) => s.siteUrl).join(', ');
      return {
        ok: false,
        detail: `GSC property ${env.GSC_PROPERTY_URL} not in account. Visible: ${known || '(none)'}`,
      };
    }
    const today = new Date();
    const rows = await querySearchAnalytics({
      dimensions: ['page'],
      startDate: format(subDays(today, 7), 'yyyy-MM-dd'),
      endDate: format(today, 'yyyy-MM-dd'),
      rowLimit: 1,
    });
    return { ok: true, detail: `property=${env.GSC_PROPERTY_URL}, last-7d sample rows=${rows.length}` };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}
