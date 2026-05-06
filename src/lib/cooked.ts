/**
 * Cooked — first-party behavioral data source.
 *
 * Replaces the previous GA4 connector. Cooked is a separate Supabase project
 * (see https://github.com/NicolasRewolf/cooked) that captures cookieless,
 * non-sampled, RGPD-exempt page-behavior events for jplouton-avocat.fr.
 *
 * This lib is the read-side: a single RPC `behavior_pages_for_period(from, to)`
 * exposes a per-URL roll-up identical in shape to what GA4 used to feed into
 * `behavior_page_snapshots` (renamed from `ga4_page_snapshots`), plus Core
 * Web Vitals (LCP/INP/CLS/TTFB at p75) which GA4 didn't surface.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { format, subDays } from 'date-fns';
import { env } from '../config.js';

let cachedClient: SupabaseClient | null = null;

export function cookedSupabase(): SupabaseClient {
  if (cachedClient) return cachedClient;
  const e = env.cooked();
  cachedClient = createClient(e.COOKED_SUPABASE_URL, e.COOKED_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cachedClient;
}

export type BehaviorRow = {
  /** Path like "/contact" — caller is responsible for prepending site URL. */
  path: string;
  sessions: number;
  pages_per_session: number;
  avg_session_duration_s: number;
  /** 0..1 (already converted from Cooked's 0..100). */
  bounce_rate: number;
  scroll_depth_avg: number;
  scroll_complete_pct: number;
  lcp_p75_ms: number | null;
  inp_p75_ms: number | null;
  cls_p75: number | null;
  ttfb_p75_ms: number | null;
  outbound_clicks: number;
};

type Numeric = number | string | null | undefined;

function num(v: Numeric): number {
  if (v == null) return 0;
  const n = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(n) ? n : 0;
}

function numOrNull(v: Numeric): number | null {
  if (v == null) return null;
  const n = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(n) ? n : null;
}

/**
 * Fetch one row per URL aggregating sessions / engagement / CWV / outbound
 * over the [dateFrom, dateTo) window.
 *
 * Date strings should be ISO-8601 (date-only is fine — Postgres extends to
 * `00:00:00+00`). Cooked stores `occurred_at` in UTC.
 */
export async function fetchBehaviorPages(
  dateFrom: string,
  dateTo: string,
): Promise<BehaviorRow[]> {
  const { data, error } = await cookedSupabase().rpc('behavior_pages_for_period', {
    date_from: dateFrom,
    date_to: dateTo,
  });
  if (error) throw new Error(`cooked.behavior_pages_for_period: ${error.message}`);
  const rows = (data ?? []) as Array<Record<string, Numeric>>;
  return rows.map((r) => ({
    path: String(r.path ?? ''),
    sessions: num(r.sessions),
    pages_per_session: num(r.pages_per_session),
    avg_session_duration_s: num(r.avg_session_duration_s),
    bounce_rate: num(r.bounce_rate),
    scroll_depth_avg: num(r.scroll_depth_avg),
    scroll_complete_pct: num(r.scroll_complete_pct),
    lcp_p75_ms: numOrNull(r.lcp_p75_ms),
    inp_p75_ms: numOrNull(r.inp_p75_ms),
    cls_p75: numOrNull(r.cls_p75),
    ttfb_p75_ms: numOrNull(r.ttfb_p75_ms),
    outbound_clicks: num(r.outbound_clicks),
  }));
}

/** Smoke test: minimal RPC ping over the last 7 days. */
export async function smokeTest(): Promise<{ ok: boolean; detail: string }> {
  try {
    const today = new Date();
    const rows = await fetchBehaviorPages(
      format(subDays(today, 7), 'yyyy-MM-dd'),
      format(today, 'yyyy-MM-dd'),
    );
    const e = env.cooked();
    const host = (() => {
      try {
        return new URL(e.COOKED_SUPABASE_URL).host;
      } catch {
        return e.COOKED_SUPABASE_URL;
      }
    })();
    return { ok: true, detail: `host=${host}, last-7d sample rows=${rows.length}` };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}
