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

// ============================================================================
// Sprint 12 — Cooked full-menu integration (4 new RPCs published Cooked-side).
//
// Contract agreed with the Cooked agent (see /tmp/seo-cooked-integration-
// proposal.md and the response in this branch's commit history). All 4 are
// granted to service_role only. Stubs below are call-sites; signatures will
// validate at first call once the RPCs are deployed Cooked-side.
//
// Each wrapper returns a plain JS object shape that the prompt renderers
// in src/prompts/diagnostic.v1.ts and src/prompts/fix-generation.v1.ts can
// consume directly (no Supabase types leak upward).
// ============================================================================

/** Multi-window snapshot for one or many paths. Pulls the full
 *  `seo_url_snapshot` row (66 cols) via RPC — no direct table read. */
export type PageSnapshotExtras = {
  path: string;
  // 4-window behavior matrix (raw counts and rates — LLM does the comparison)
  windows: {
    [K in '7d' | '28d' | '90d' | '365d']: {
      views: number;
      unique_visitors: number;
      sessions: number;
      bounce_rate: number;          // 0..1 (already converted from Cooked's 0..100)
      avg_dwell_seconds: number;
      scroll_avg: number;           // %
      scroll_median: number;        // %
      scroll_complete_pct: number;  // %
      entry_count: number;
      exit_count: number;
      outbound_clicks: number;
    };
  };
  // CWV — p75 over 28d (the Google ranking window)
  cwv_28d: {
    lcp_p75_ms: number | null;
    inp_p75_ms: number | null;
    cls_p75: number | null;
    ttfb_p75_ms: number | null;
  };
  // Provenance — top sources/medium/referrer over 28d
  provenance_28d: {
    top_referrer: string | null;
    top_source: string | null;
    top_medium: string | null;
  };
  // Device split — desktop/mobile/tablet percentages
  device_split_28d: { desktop: number; mobile: number; tablet: number } | null;
  // Conversion CTAs — phone / email / booking_cta clicks per window
  conversion: {
    phone_clicks: { '7d': number; '28d': number; '90d': number; '365d': number };
    email_clicks: { '7d': number; '28d': number; '90d': number; '365d': number };
    booking_cta_clicks: { '7d': number; '28d': number; '90d': number; '365d': number };
  };
  // Sprint 15 — Pogo-sticking from Google (NavBoost negative signal). A pogo
  // is a Google-origin session with 1 page view and dwell <10s; hard_pogo also
  // requires scroll <5%. `pogo_rate_28d` = pogo_sticks_28d / google_sessions_28d * 100,
  // already computed by Cooked. All 4 fields are nullable: a page with zero
  // Google traffic in 28d gets nulls (cannot divide by zero, no signal to read).
  pogo_28d: {
    google_sessions: number | null;
    pogo_sticks: number | null;
    hard_pogo: number | null;
    pogo_rate_pct: number | null;
  };
  // Sprint 16 — CTA conversion rate split by device. Cooked computes
  // (phone_clicks + booking_clicks) / sessions * 100 per device over 28d.
  // The session counts (denominators) are exposed too so we can apply a
  // reliability gate (n>=30) before firing a mobile-first CAUTION banner.
  cta_per_device_28d: {
    mobile_sessions: number | null;
    desktop_sessions: number | null;
    cta_rate_mobile_pct: number | null;
    cta_rate_desktop_pct: number | null;
  };
  refreshed_at: string;
};

export async function fetchPageSnapshotExtras(paths?: string[]): Promise<PageSnapshotExtras[]> {
  const { data, error } = await cookedSupabase().rpc('snapshot_pages_export', {
    paths: paths && paths.length > 0 ? paths : null,
  });
  if (error) throw new Error(`cooked.snapshot_pages_export: ${error.message}`);
  const rows = (data ?? []) as Array<Record<string, Numeric>>;
  return rows.map(parsePageSnapshotRow);
}

function parsePageSnapshotRow(r: Record<string, Numeric>): PageSnapshotExtras {
  const win = (suffix: '7d' | '28d' | '90d' | '365d'): PageSnapshotExtras['windows']['7d'] => ({
    views: num(r[`views_${suffix}`]),
    unique_visitors: num(r[`unique_visitors_${suffix}`]),
    sessions: num(r[`sessions_${suffix}`]),
    bounce_rate: num(r[`bounce_rate_${suffix}`]) / 100, // Cooked stores 0..100
    avg_dwell_seconds: num(r[`avg_dwell_seconds_${suffix}`]),
    scroll_avg: num(r[`scroll_avg_${suffix}`]),
    scroll_median: num(r[`scroll_median_${suffix}`]),
    scroll_complete_pct: num(r[`scroll_complete_pct_${suffix}`]),
    entry_count: num(r[`entry_count_${suffix}`]),
    exit_count: num(r[`exit_count_${suffix}`]),
    outbound_clicks: num(r[`outbound_clicks_${suffix}`]),
  });
  // device_split_28d arrives as jsonb — Supabase returns it as a parsed object.
  const ds = r.device_split_28d as unknown;
  let device: PageSnapshotExtras['device_split_28d'] = null;
  if (ds && typeof ds === 'object') {
    const o = ds as Record<string, unknown>;
    device = {
      desktop: num(o.desktop as Numeric),
      mobile: num(o.mobile as Numeric),
      tablet: num(o.tablet as Numeric),
    };
  }
  return {
    path: String(r.path ?? ''),
    windows: { '7d': win('7d'), '28d': win('28d'), '90d': win('90d'), '365d': win('365d') },
    cwv_28d: {
      lcp_p75_ms: numOrNull(r.lcp_p75_28d_ms),
      inp_p75_ms: numOrNull(r.inp_p75_28d_ms),
      cls_p75: numOrNull(r.cls_p75_28d),
      ttfb_p75_ms: numOrNull(r.ttfb_p75_28d_ms),
    },
    provenance_28d: {
      top_referrer: (r.top_referrer_28d as string | null) ?? null,
      top_source: (r.top_source_28d as string | null) ?? null,
      top_medium: (r.top_medium_28d as string | null) ?? null,
    },
    device_split_28d: device,
    conversion: {
      phone_clicks: {
        '7d': num(r.phone_clicks_7d), '28d': num(r.phone_clicks_28d),
        '90d': num(r.phone_clicks_90d), '365d': num(r.phone_clicks_365d),
      },
      email_clicks: {
        '7d': num(r.email_clicks_7d), '28d': num(r.email_clicks_28d),
        '90d': num(r.email_clicks_90d), '365d': num(r.email_clicks_365d),
      },
      booking_cta_clicks: {
        '7d': num(r.booking_cta_clicks_7d), '28d': num(r.booking_cta_clicks_28d),
        '90d': num(r.booking_cta_clicks_90d), '365d': num(r.booking_cta_clicks_365d),
      },
    },
    pogo_28d: {
      google_sessions: numOrNull(r.google_sessions_28d),
      pogo_sticks: numOrNull(r.pogo_sticks_28d),
      hard_pogo: numOrNull(r.hard_pogo_28d),
      pogo_rate_pct: numOrNull(r.pogo_rate_28d),
    },
    cta_per_device_28d: {
      mobile_sessions: numOrNull(r.mobile_sessions_28d),
      desktop_sessions: numOrNull(r.desktop_sessions_28d),
      cta_rate_mobile_pct: numOrNull(r.cta_rate_mobile_28d),
      cta_rate_desktop_pct: numOrNull(r.cta_rate_desktop_28d),
    },
    refreshed_at: String(r.refreshed_at ?? ''),
  };
}

/** Sprint 16 — Engagement density per page. Returned by Cooked's
 *  `engagement_density_for_path(path, days)` RPC. The `evenness_score` =
 *  `dwell_p25 / dwell_p75` ; close to 1 = lecture régulière, close to 0 =
 *  distribution bimodale (lots of pogos + a long tail of engaged readers).
 *  All fields nullable when no data (page not yet captured). */
export type EngagementDensity = {
  sessions: number;
  dwell_p25_seconds: number | null;
  dwell_median_seconds: number | null;
  dwell_p75_seconds: number | null;
  evenness_score: number | null; // 0..1
};

export async function fetchEngagementDensity(
  path: string,
  days = 28,
): Promise<EngagementDensity | null> {
  const { data, error } = await cookedSupabase().rpc('engagement_density_for_path', {
    target_path: path,
    days,
  });
  if (error) throw new Error(`cooked.engagement_density_for_path: ${error.message}`);
  const rows = (data ?? []) as Array<Record<string, Numeric>>;
  const r = rows[0];
  if (!r) return null;
  return {
    sessions: num(r.sessions),
    dwell_p25_seconds: numOrNull(r.dwell_p25),
    dwell_median_seconds: numOrNull(r.dwell_median),
    dwell_p75_seconds: numOrNull(r.dwell_p75),
    evenness_score: numOrNull(r.evenness_score),
  };
}

/** Site-wide context — global mix + median volume + 7d-vs-28d trend. */
export type SiteContext = {
  global_sessions_28d: number;
  global_bounce_rate_28d: number;       // 0..1
  sessions_per_day_median_28d: number;
  sessions_trend_pct_7d_vs_28d: number;  // signed % delta
  top_sources_28d: Array<{ source: string; medium: string; sessions: number }>;
};

export async function fetchSiteContext(): Promise<SiteContext> {
  const { data, error } = await cookedSupabase().rpc('site_context_export');
  if (error) throw new Error(`cooked.site_context_export: ${error.message}`);
  const r = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  if (!r) {
    // Cooked may return empty when DB is freshly seeded — degrade gracefully.
    return {
      global_sessions_28d: 0,
      global_bounce_rate_28d: 0,
      sessions_per_day_median_28d: 0,
      sessions_trend_pct_7d_vs_28d: 0,
      top_sources_28d: [],
    };
  }
  const tops = (r.top_sources_28d as unknown) ?? [];
  const topArr = Array.isArray(tops)
    ? tops.map((t) => {
        const o = t as Record<string, unknown>;
        return {
          source: String(o.source ?? ''),
          medium: String(o.medium ?? ''),
          sessions: num(o.sessions as Numeric),
        };
      })
    : [];
  return {
    global_sessions_28d: num(r.global_sessions_28d as Numeric),
    // Sprint-17 bug fix : site_context_export() returns global_bounce_rate_28d
    // already in 0..1 format (verified 2026-05-09 : returns 0.2253 = 22.53%).
    // Note the per-page bounce_rate_28d in snapshot_pages_export() is still
    // 0..100 (returns 22.53), so the /100 conversion stays at parsePageSnapshotRow.
    // Inconsistency lives on Cooked's side but is documented; we conform.
    global_bounce_rate_28d: num(r.global_bounce_rate_28d as Numeric),
    sessions_per_day_median_28d: num(r.sessions_per_day_median_28d as Numeric),
    sessions_trend_pct_7d_vs_28d: num(r.sessions_trend_pct_7d_vs_28d as Numeric),
    top_sources_28d: topArr.slice(0, 5),
  };
}

/** Where users go when they leave a specific page. Top-N hostnames. */
export type OutboundDestination = { hostname: string; clicks: number };

export async function fetchOutboundDestinations(
  path: string,
  daysBack = 28,
): Promise<OutboundDestination[]> {
  const { data, error } = await cookedSupabase().rpc('outbound_destinations_for_path', {
    path,
    days_back: daysBack,
  });
  if (error) throw new Error(`cooked.outbound_destinations_for_path: ${error.message}`);
  const rows = (data ?? []) as Array<Record<string, Numeric>>;
  return rows.map((r) => ({
    hostname: String(r.hostname ?? ''),
    clicks: num(r.clicks),
  }));
}

/** CTA clicks broken down by placement (header / footer / body) per cta_type.
 *  Critical signal — distinguishes intent-qualified body clicks from
 *  ambient footer clicks. */
export type CtaPlacement = 'header' | 'footer' | 'body';
export type CtaType = 'phone' | 'email' | 'booking';
export type CtaBreakdownRow = {
  cta_type: CtaType;
  placement: CtaPlacement;
  anchor_sample: string;
  clicks: number;
};

export async function fetchCtaBreakdown(
  path: string,
  daysBack = 28,
): Promise<CtaBreakdownRow[]> {
  const { data, error } = await cookedSupabase().rpc('cta_breakdown_for_path', {
    path,
    days_back: daysBack,
  });
  if (error) throw new Error(`cooked.cta_breakdown_for_path: ${error.message}`);
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    cta_type: r.cta_type as CtaType,
    placement: r.placement as CtaPlacement,
    anchor_sample: String(r.anchor_sample ?? ''),
    clicks: num(r.clicks as Numeric),
  }));
}

/**
 * Sprint-13bis: Cooked-side `tracker_first_seen_global()` RPC. Returns the
 * earliest `occurred_at` ever observed in `events`. Used SEO-side to
 * pro-rate the data_quality_check capture rate during the bootstrap window
 * (first 28 days post-deploy) — without it, every page would have a
 * "🚫 tracker quasi-cassé" verdict for 28 days regardless of actual tracker
 * health.
 *
 * Returns null on RPC error (network blip etc.) — the caller falls back to
 * a hardcoded deploy date for safety.
 */
export async function fetchTrackerFirstSeen(): Promise<Date | null> {
  const { data, error } = await cookedSupabase().rpc('tracker_first_seen_global');
  if (error || data == null) return null;
  const d = new Date(data as string);
  return Number.isFinite(d.getTime()) ? d : null;
}

// ============================================================================

/** Smoke test: ping every Cooked RPC the SEO tool depends on.
 *
 * Sprint-12: covers the 4 new RPCs (snapshot_pages_export, site_context_export,
 * outbound_destinations_for_path, cta_breakdown_for_path) in addition to the
 * legacy behavior_pages_for_period. Fast-fails if any RPC errors OR if the
 * cta_breakdown enums diverge from the agreed contract — that's the silent
 * regression class we most want to catch (a typo in `placement` would
 * silently route every breakdown into "unknown" downstream).
 */
export async function smokeTest(): Promise<{ ok: boolean; detail: string }> {
  try {
    const today = new Date();
    const e = env.cooked();
    const host = (() => {
      try {
        return new URL(e.COOKED_SUPABASE_URL).host;
      } catch {
        return e.COOKED_SUPABASE_URL;
      }
    })();

    // Legacy RPC — still consumed by snapshot.ts
    const legacyRows = await fetchBehaviorPages(
      format(subDays(today, 7), 'yyyy-MM-dd'),
      format(today, 'yyyy-MM-dd'),
    );

    // Sprint-12 RPCs — call each once, validate the parsed shape on the
    // happy path. A failure here means the wrapper / Cooked contract has
    // drifted; the diagnostic prompt would then degrade to "indisponible"
    // blocks silently.
    const snaps = await fetchPageSnapshotExtras(['/']);
    const ctx = await fetchSiteContext();
    await fetchOutboundDestinations('/', 28);
    const ctaRows = await fetchCtaBreakdown('/', 28);

    // Validate the cta enum contract — this is the central signal, a
    // mismatch here would silently route every breakdown into "unknown".
    for (const c of ctaRows) {
      if (!['phone', 'email', 'booking'].includes(c.cta_type)) {
        return { ok: false, detail: `cta_type contract mismatch: got "${c.cta_type}"` };
      }
      if (!['header', 'footer', 'body'].includes(c.placement)) {
        return { ok: false, detail: `placement contract mismatch: got "${c.placement}"` };
      }
    }

    return {
      ok: true,
      detail:
        `host=${host}, ` +
        `legacy_rpc=${legacyRows.length}_rows, ` +
        `snapshot_export=${snaps.length}_rows, ` +
        `site_context_sessions_28d=${ctx.global_sessions_28d}, ` +
        `cta_breakdown=${ctaRows.length}_rows ` +
        `(enums OK)`,
    };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}
