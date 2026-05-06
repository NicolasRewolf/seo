import { google, type analyticsdata_v1beta } from 'googleapis';
import { format, subDays } from 'date-fns';
import { googleOAuth } from './google-auth.js';
import { env } from '../config.js';

let cached: analyticsdata_v1beta.Analyticsdata | null = null;

export function ga4(): analyticsdata_v1beta.Analyticsdata {
  if (cached) return cached;
  cached = google.analyticsdata({ version: 'v1beta', auth: googleOAuth() });
  return cached;
}

export type GA4Row = {
  dimensionValues: Array<{ value?: string | null }>;
  metricValues: Array<{ value?: string | null }>;
};

export async function runReport(params: {
  dimensions: string[];
  metrics: string[];
  startDate: string;
  endDate: string;
  limit?: number;
}): Promise<GA4Row[]> {
  const e = env.ga4();
  const { data } = await ga4().properties.runReport({
    property: `properties/${e.GA4_PROPERTY_ID}`,
    requestBody: {
      dimensions: params.dimensions.map((name) => ({ name })),
      metrics: params.metrics.map((name) => ({ name })),
      dateRanges: [{ startDate: params.startDate, endDate: params.endDate }],
      limit: String(params.limit ?? 1000),
    },
  });
  return (data.rows ?? []) as GA4Row[];
}

/** Smoke test: minimal runReport on the configured property. */
export async function smokeTest(): Promise<{ ok: boolean; detail: string }> {
  try {
    const e = env.ga4();
    const today = new Date();
    const rows = await runReport({
      dimensions: ['pagePath'],
      metrics: ['sessions'],
      startDate: format(subDays(today, 7), 'yyyy-MM-dd'),
      endDate: format(today, 'yyyy-MM-dd'),
      limit: 1,
    });
    return { ok: true, detail: `property=${e.GA4_PROPERTY_ID}, last-7d sample rows=${rows.length}` };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}
