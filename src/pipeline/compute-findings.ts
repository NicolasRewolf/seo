/**
 * Sprint 3 — Compute findings.
 *
 * Reads the latest GSC + GA4 snapshots, computes per-page metrics
 * (ctr_expected, ctr_gap, priority_score, priority_tier, engagement penalty),
 * applies the audit thresholds, alternately assigns treatment/control,
 * and writes everything to audit_runs + audit_findings.
 *
 * Idempotent at the audit_runs level: each call creates a NEW audit_runs row.
 * Re-running on the same period therefore creates a second run; that's
 * intentional so we can A/B test threshold/scoring changes without losing
 * history. The dashboard surfaces "latest by audit_run".
 */
import { supabase } from '../lib/supabase.js';
import { env } from '../config.js';

// ---------- Pure scoring helpers (also exported for tests) ---------------

export type Benchmarks = Record<string, number>; // key = integer position as string

export function getCtrExpected(position: number, benchmarks: Benchmarks): number {
  if (Number.isNaN(position)) return 0;
  const positions = Object.keys(benchmarks).map((k) => Number(k)).sort((a, b) => a - b);
  if (positions.length === 0) return 0;
  const minPos = positions[0]!;
  const maxPos = positions[positions.length - 1]!;
  if (position <= minPos) return benchmarks[String(minPos)] ?? 0;
  if (position >= maxPos) return benchmarks[String(maxPos)] ?? 0;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return benchmarks[String(lower)] ?? 0;
  const lowerCtr = benchmarks[String(lower)] ?? 0;
  const upperCtr = benchmarks[String(upper)] ?? 0;
  const fraction = position - lower;
  return lowerCtr + (upperCtr - lowerCtr) * fraction;
}

export function computeCtrGap(actual: number, expected: number): number {
  if (expected <= 0) return 0;
  return Math.max(0, (expected - actual) / expected);
}

export function computeEngagementPenalty(signals: {
  pagesPerSession?: number | null;
  avgSessionDurationSeconds?: number | null;
  scrollDepthAvg?: number | null;
}): number {
  let penalty = 0;
  if (signals.pagesPerSession != null && signals.pagesPerSession < 1.3) penalty += 0.15;
  if (signals.avgSessionDurationSeconds != null && signals.avgSessionDurationSeconds < 30) {
    penalty += 0.2;
  }
  if (signals.scrollDepthAvg != null && signals.scrollDepthAvg < 50) penalty += 0.15;
  return Math.min(penalty, 0.5);
}

export function computePriorityScore(opts: {
  impressions: number;
  ctrGap: number;
  position: number;
  positionDrift: number | null;
  engagementPenalty: number;
  positionRangeMin: number;
  positionRangeMax: number;
}): number {
  const inRange =
    opts.position >= opts.positionRangeMin && opts.position <= opts.positionRangeMax;
  const positionWeight = inRange ? 1.0 : 0.3;
  const driftBonus = opts.positionDrift != null && opts.positionDrift > 3 ? 1.5 : 1.0;
  const baseScore =
    Math.log10(Math.max(opts.impressions, 1)) *
    opts.ctrGap *
    100 *
    positionWeight *
    driftBonus;
  return Math.round(baseScore * (1 + opts.engagementPenalty) * 100) / 100;
}

export function computePriorityTier(score: number): 1 | 2 | 3 {
  if (score >= 30) return 1;
  if (score >= 15) return 2;
  return 3;
}

export function assignGroup(rankByScore: number): 'treatment' | 'control' {
  return rankByScore % 2 === 0 ? 'treatment' : 'control';
}

// ---------- Benchmarks: site-specific from query snapshots ---------------

/**
 * Compute site-specific CTR benchmarks for positions 1..maxPos.
 *
 * IMPORTANT: benchmarks must be at the SAME aggregation level as what we
 * compare against. We compare per-page CTR (gsc_page_snapshots.ctr), so the
 * benchmark must come from page-level rows too. Computing it from query-level
 * rows badly under-estimates expected CTR (long-tail 0% queries drag the
 * median down) and produces almost no findings.
 *
 * Each position's benchmark is the IMPRESSIONS-WEIGHTED CTR of all pages
 * whose rounded average position falls in that bucket. Positions with fewer
 * than minSamples pages fall back to the generic industry benchmarks.
 */
async function computeSiteBenchmarks(
  periodStart: string,
  periodEnd: string,
  fallback: Benchmarks,
  opts: { maxPos: number; minSamples: number; minImpressionsPerRow: number },
): Promise<Benchmarks> {
  const all: Array<{ avg_position: number; ctr: number; impressions: number }> = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabase()
      .from('gsc_page_snapshots')
      .select('avg_position, ctr, impressions')
      .eq('period_start', periodStart)
      .eq('period_end', periodEnd)
      .gte('impressions', opts.minImpressionsPerRow)
      .gte('avg_position', 1)
      .lte('avg_position', opts.maxPos + 1)
      .range(from, from + 999);
    if (error) throw new Error(`fetch page snapshots for benchmarks: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const r of data) {
      all.push({
        avg_position: Number(r.avg_position),
        ctr: Number(r.ctr),
        impressions: Number(r.impressions),
      });
    }
    if (data.length < 1000) break;
    from += data.length;
  }

  const buckets = new Map<number, { sumCtrWeighted: number; sumImpressions: number; n: number }>();
  for (const r of all) {
    const pos = Math.round(r.avg_position);
    if (pos < 1 || pos > opts.maxPos) continue;
    const cur = buckets.get(pos);
    if (!cur) {
      buckets.set(pos, {
        sumCtrWeighted: r.ctr * r.impressions,
        sumImpressions: r.impressions,
        n: 1,
      });
    } else {
      cur.sumCtrWeighted += r.ctr * r.impressions;
      cur.sumImpressions += r.impressions;
      cur.n += 1;
    }
  }

  const out: Benchmarks = { ...fallback };
  for (let p = 1; p <= opts.maxPos; p++) {
    const b = buckets.get(p);
    if (b && b.n >= opts.minSamples && b.sumImpressions > 0) {
      out[String(p)] = b.sumCtrWeighted / b.sumImpressions;
    }
  }
  return out;
}

// ---------- Pipeline orchestration ---------------------------------------

export type AuditOptions = {
  /** If omitted, use the most recent (period_start, period_end) found in gsc_page_snapshots. */
  periodStart?: string;
  periodEnd?: string;
  /** Override Supabase audit_config thresholds for this run. */
  thresholdsOverride?: Partial<{
    min_impressions_monthly: number;
    ctr_gap_threshold: number;
    position_min: number;
    position_max: number;
    drift_threshold: number;
  }>;
};

export type AuditSummary = {
  auditRunId: string;
  periodStart: string;
  periodEnd: string;
  pagesAnalyzed: number;
  findingsCount: number;
  findingsByTier: { 1: number; 2: number; 3: number };
  findingsByGroup: { treatment: number; control: number };
  benchmarksUsed: Benchmarks;
  durationMs: number;
};

type AuditConfigRow = { key: string; value: unknown };

async function loadAuditConfig(): Promise<{
  ctrBenchmarksByPosition: Benchmarks;
  thresholds: {
    min_impressions_monthly: number;
    ctr_gap_threshold: number;
    position_min: number;
    position_max: number;
    drift_threshold: number;
  };
}> {
  const { data, error } = await supabase()
    .from('audit_config')
    .select('key, value')
    .in('key', ['ctr_benchmarks_by_position', 'thresholds']);
  if (error) throw new Error(`load audit_config: ${error.message}`);
  const map = new Map<string, unknown>();
  for (const r of (data ?? []) as AuditConfigRow[]) map.set(r.key, r.value);

  const benchRaw = map.get('ctr_benchmarks_by_position') as Record<string, number> | undefined;
  const thresholdsRaw = map.get('thresholds') as
    | {
        min_impressions_monthly: number;
        ctr_gap_threshold: number;
        position_min: number;
        position_max: number;
        drift_threshold: number;
      }
    | undefined;
  if (!benchRaw || !thresholdsRaw) {
    throw new Error('audit_config missing ctr_benchmarks_by_position or thresholds');
  }
  return { ctrBenchmarksByPosition: benchRaw, thresholds: thresholdsRaw };
}

async function getLatestSnapshotPeriod(): Promise<{ periodStart: string; periodEnd: string }> {
  const { data, error } = await supabase()
    .from('gsc_page_snapshots')
    .select('period_start, period_end')
    .order('period_end', { ascending: false })
    .limit(1);
  if (error) throw new Error(`latest period lookup: ${error.message}`);
  if (!data || data.length === 0) {
    throw new Error('no gsc_page_snapshots present — run snapshot first');
  }
  const row = data[0] as { period_start: string; period_end: string };
  return { periodStart: row.period_start, periodEnd: row.period_end };
}

async function fetchAllPages(
  periodStart: string,
  periodEnd: string,
): Promise<
  Array<{
    page: string;
    impressions: number;
    clicks: number;
    ctr: number;
    avg_position: number;
  }>
> {
  const out: Array<{
    page: string;
    impressions: number;
    clicks: number;
    ctr: number;
    avg_position: number;
  }> = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabase()
      .from('gsc_page_snapshots')
      .select('page, impressions, clicks, ctr, avg_position')
      .eq('period_start', periodStart)
      .eq('period_end', periodEnd)
      .range(from, from + 999);
    if (error) throw new Error(`fetch page snapshots: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const r of data) {
      out.push({
        page: r.page as string,
        impressions: Number(r.impressions),
        clicks: Number(r.clicks),
        ctr: Number(r.ctr),
        avg_position: Number(r.avg_position),
      });
    }
    if (data.length < 1000) break;
    from += data.length;
  }
  return out;
}

async function fetchEngagementMap(
  periodStart: string,
  periodEnd: string,
): Promise<
  Map<
    string,
    {
      pages_per_session: number | null;
      avg_session_duration_seconds: number | null;
      scroll_depth_avg: number | null;
    }
  >
> {
  const map = new Map<
    string,
    {
      pages_per_session: number | null;
      avg_session_duration_seconds: number | null;
      scroll_depth_avg: number | null;
    }
  >();
  let from = 0;
  for (;;) {
    const { data, error } = await supabase()
      .from('ga4_page_snapshots')
      .select('page, pages_per_session, avg_session_duration_seconds, scroll_depth_avg')
      .eq('period_start', periodStart)
      .eq('period_end', periodEnd)
      .range(from, from + 999);
    if (error) throw new Error(`fetch ga4 snapshots: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const r of data) {
      map.set(r.page as string, {
        pages_per_session: r.pages_per_session != null ? Number(r.pages_per_session) : null,
        avg_session_duration_seconds:
          r.avg_session_duration_seconds != null ? Number(r.avg_session_duration_seconds) : null,
        scroll_depth_avg: r.scroll_depth_avg != null ? Number(r.scroll_depth_avg) : null,
      });
    }
    if (data.length < 1000) break;
    from += data.length;
  }
  return map;
}

export async function runAudit(opts: AuditOptions = {}): Promise<AuditSummary> {
  const t0 = Date.now();
  const auditConf = env.audit();

  const period = opts.periodStart && opts.periodEnd
    ? { periodStart: opts.periodStart, periodEnd: opts.periodEnd }
    : await getLatestSnapshotPeriod();

  const { ctrBenchmarksByPosition: genericBench, thresholds: dbThresholds } =
    await loadAuditConfig();

  const thresholds = {
    min_impressions_monthly:
      opts.thresholdsOverride?.min_impressions_monthly ??
      auditConf.MIN_IMPRESSIONS_THRESHOLD ??
      dbThresholds.min_impressions_monthly,
    ctr_gap_threshold:
      opts.thresholdsOverride?.ctr_gap_threshold ??
      auditConf.CTR_GAP_THRESHOLD ??
      dbThresholds.ctr_gap_threshold,
    position_min:
      opts.thresholdsOverride?.position_min ??
      auditConf.POSITION_RANGE_MIN ??
      dbThresholds.position_min,
    position_max:
      opts.thresholdsOverride?.position_max ??
      auditConf.POSITION_RANGE_MAX ??
      dbThresholds.position_max,
    drift_threshold: opts.thresholdsOverride?.drift_threshold ?? dbThresholds.drift_threshold,
  };

  // Compute site-specific benchmarks from this snapshot's query data.
  // Generic benchmarks are the fallback for positions with too few samples.
  const benchmarks = await computeSiteBenchmarks(
    period.periodStart,
    period.periodEnd,
    genericBench,
    { maxPos: 20, minSamples: 8, minImpressionsPerRow: 100 },
  );

  // Convert min_impressions_monthly to total over the analysis window.
  // The threshold is "per month"; the snapshot covers AUDIT_PERIOD_MONTHS.
  const minImpressionsTotal = thresholds.min_impressions_monthly * auditConf.AUDIT_PERIOD_MONTHS;

  // Create audit_runs row — status starts as 'running' so a crash leaves a trace.
  const configSnapshot = {
    benchmarks_used: benchmarks,
    benchmarks_source: 'site_specific_with_generic_fallback',
    thresholds,
    period_months: auditConf.AUDIT_PERIOD_MONTHS,
  };
  const { data: runRow, error: runErr } = await supabase()
    .from('audit_runs')
    .insert({
      period_start: period.periodStart,
      period_end: period.periodEnd,
      config_snapshot: configSnapshot,
      status: 'running',
    })
    .select('id')
    .single();
  if (runErr || !runRow) throw new Error(`create audit_run: ${runErr?.message ?? 'no row'}`);
  const auditRunId = runRow.id as string;

  try {
    const pages = await fetchAllPages(period.periodStart, period.periodEnd);
    const engagement = await fetchEngagementMap(period.periodStart, period.periodEnd);

    // Score every page that clears the impressions floor + position range +
    // ctr_gap threshold. position_drift stays null — first audit, no history.
    const candidates: Array<{
      page: string;
      impressions: number;
      ctr_actual: number;
      ctr_expected: number;
      ctr_gap: number;
      avg_position: number;
      position_drift: number | null;
      engagement: ReturnType<typeof engagement.get>;
      priority_score: number;
    }> = [];

    for (const p of pages) {
      if (p.impressions < minImpressionsTotal) continue;
      if (p.avg_position < thresholds.position_min || p.avg_position > thresholds.position_max) {
        continue;
      }
      const ctrExpected = getCtrExpected(p.avg_position, benchmarks);
      const ctrGap = computeCtrGap(p.ctr, ctrExpected);
      if (ctrGap < thresholds.ctr_gap_threshold) continue;

      const eng = engagement.get(p.page);
      const engagementPenalty = computeEngagementPenalty({
        pagesPerSession: eng?.pages_per_session ?? null,
        avgSessionDurationSeconds: eng?.avg_session_duration_seconds ?? null,
        scrollDepthAvg: eng?.scroll_depth_avg ?? null,
      });

      const priorityScore = computePriorityScore({
        impressions: p.impressions,
        ctrGap,
        position: p.avg_position,
        positionDrift: null,
        engagementPenalty,
        positionRangeMin: thresholds.position_min,
        positionRangeMax: thresholds.position_max,
      });

      candidates.push({
        page: p.page,
        impressions: p.impressions,
        ctr_actual: p.ctr,
        ctr_expected: ctrExpected,
        ctr_gap: ctrGap,
        avg_position: p.avg_position,
        position_drift: null,
        engagement: eng,
        priority_score: priorityScore,
      });
    }

    candidates.sort((a, b) => b.priority_score - a.priority_score);

    const findings = candidates.map((c, i) => ({
      audit_run_id: auditRunId,
      page: c.page,
      impressions: c.impressions,
      ctr_actual: c.ctr_actual,
      ctr_expected: c.ctr_expected,
      ctr_gap: c.ctr_gap,
      avg_position: c.avg_position,
      position_drift: c.position_drift,
      priority_score: c.priority_score,
      priority_tier: computePriorityTier(c.priority_score),
      pages_per_session: c.engagement?.pages_per_session ?? null,
      avg_session_duration_seconds: c.engagement?.avg_session_duration_seconds ?? null,
      scroll_depth_avg: c.engagement?.scroll_depth_avg ?? null,
      group_assignment: assignGroup(i),
      status: 'pending' as const,
    }));

    if (findings.length > 0) {
      // Insert in chunks (Supabase has a default request size limit)
      const CHUNK = 500;
      for (let i = 0; i < findings.length; i += CHUNK) {
        const { error } = await supabase()
          .from('audit_findings')
          .insert(findings.slice(i, i + CHUNK));
        if (error) throw new Error(`insert findings (chunk ${i}): ${error.message}`);
      }
    }

    const tierCount = { 1: 0, 2: 0, 3: 0 } as { 1: number; 2: number; 3: number };
    const groupCount = { treatment: 0, control: 0 };
    for (const f of findings) {
      tierCount[f.priority_tier as 1 | 2 | 3] += 1;
      groupCount[f.group_assignment] += 1;
    }

    await supabase()
      .from('audit_runs')
      .update({
        completed_at: new Date().toISOString(),
        pages_analyzed: pages.length,
        findings_count: findings.length,
        status: 'completed',
      })
      .eq('id', auditRunId);

    return {
      auditRunId,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      pagesAnalyzed: pages.length,
      findingsCount: findings.length,
      findingsByTier: tierCount,
      findingsByGroup: groupCount,
      benchmarksUsed: benchmarks,
      durationMs: Date.now() - t0,
    };
  } catch (err) {
    await supabase()
      .from('audit_runs')
      .update({
        completed_at: new Date().toISOString(),
        status: 'failed',
        error_log: (err as Error).stack ?? String(err),
      })
      .eq('id', auditRunId);
    throw err;
  }
}
