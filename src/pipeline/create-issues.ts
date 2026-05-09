/**
 * Sprint 5 — Create one GitHub issue per `proposed` finding.
 *
 * Idempotent: skips findings that already have github_issue_number set.
 * Failures don't abort the batch.
 */
import { z } from 'zod';
import { supabase } from '../lib/supabase.js';
import { github, repoCoords } from '../lib/github.js';
import { env } from '../config.js';
import {
  renderIssue,
  type IssueCookedExtras,
  type IssueDiagnostic,
  type IssueFactCheck,
  type IssueMeasurement,
  type IssueProposedFix,
} from '../prompts/issue-template.js';
import { fetchPageSnapshotExtras, fetchCtaBreakdown, fetchEngagementDensity } from '../lib/cooked.js';
import { pathOf } from '../lib/url.js';

const DiagnosticShape = z.object({
  // Sprint-11/12: keep v5/v6 fields optional so persisted diagnostics from
  // any version flow through to renderIssue without Zod stripping them.
  tldr: z.string().optional(),
  intent_mismatch: z.string(),
  snippet_weakness: z.string(),
  hypothesis: z.string(),
  engagement_diagnosis: z.string(),
  performance_diagnosis: z.string().optional(),
  structural_gaps: z.string().optional(),
  funnel_assessment: z.string().optional(),
  internal_authority_assessment: z.string().optional(),
  conversion_assessment: z.string().optional(),
  traffic_strategy_note: z.string().optional(),
  device_optimization_note: z.string().optional(),
  outbound_leak_note: z.string().optional(),
  pogo_navboost_assessment: z.string().optional(),
  engagement_pattern_assessment: z.string().optional(),
  top_queries_analysis: z
    .array(
      z.object({
        query: z.string(),
        impressions: z.number(),
        ctr: z.number(),
        position: z.number(),
        intent_match: z.enum(['yes', 'partial', 'no']),
        note: z.string().optional(),
      }),
    )
    .default([]),
});

const CurrentStateShape = z.object({
  title: z.string().default(''),
  meta_description: z.string().default(''),
  intro_first_100_words: z.string().default(''),
});

const FactCheckShape = z.object({
  total_numeric_claims: z.number(),
  verified: z.number(),
  unverified: z.array(
    z.object({
      claim: z.string(),
      field: z.string(),
      expected_in: z.string().optional(),
      note: z.string().optional(),
    }),
  ),
  passed: z.boolean(),
  retry_attempted: z.boolean().optional().default(false),
});

function parseFactCheck(raw: unknown): IssueFactCheck | undefined {
  if (raw == null) return undefined;
  const r = FactCheckShape.safeParse(raw);
  if (!r.success) return undefined;
  return {
    total_numeric_claims: r.data.total_numeric_claims,
    verified: r.data.verified,
    unverified: r.data.unverified.map((u) => ({ claim: u.claim, field: u.field, note: u.note })),
    passed: r.data.passed,
    retry_attempted: r.data.retry_attempted,
  };
}

export type CreateIssuesSummary = {
  attempted: number;
  succeeded: number;
  skipped: number;
  failed: number;
  errors: Array<{ findingId: string; error: string }>;
  durationMs: number;
};

export async function createIssueForFinding(findingId: string): Promise<{
  issueNumber: number;
  issueUrl: string;
}> {
  const { data: row, error } = await supabase()
    .from('audit_findings')
    .select(
      'id, audit_run_id, page, impressions, ctr_actual, ctr_expected, ctr_gap, avg_position, position_drift, priority_score, priority_tier, group_assignment, pages_per_session, avg_session_duration_seconds, scroll_depth_avg, current_state, diagnostic, diagnostic_fact_check, github_issue_number, audit_runs(period_start, period_end, config_snapshot)',
    )
    .eq('id', findingId)
    .single();
  if (error || !row) throw new Error(`load finding: ${error?.message ?? 'not found'}`);

  if (row.github_issue_number) {
    throw new Error(`finding already has issue #${row.github_issue_number}`);
  }
  if (!row.diagnostic) throw new Error('no diagnostic — run diagnose first');
  if (!row.current_state) throw new Error('no current_state');

  const diagnostic: IssueDiagnostic = DiagnosticShape.parse(row.diagnostic);
  const cs = CurrentStateShape.parse(row.current_state);
  const factCheck = parseFactCheck(row.diagnostic_fact_check);

  const auditRun = Array.isArray(row.audit_runs)
    ? (row.audit_runs[0] as
        | { period_start: string; period_end: string; config_snapshot: { period_months?: number } }
        | undefined)
    : (row.audit_runs as
        | { period_start: string; period_end: string; config_snapshot: { period_months?: number } }
        | undefined);
  if (!auditRun) throw new Error('no audit_runs join');

  const { data: fixesRows, error: fixesErr } = await supabase()
    .from('proposed_fixes')
    .select('fix_type, current_value, proposed_value, rationale')
    .eq('finding_id', findingId)
    .order('created_at');
  if (fixesErr) throw new Error(`load fixes: ${fixesErr.message}`);
  const fixes: IssueProposedFix[] = (fixesRows ?? []).map((f) => ({
    fix_type: f.fix_type as IssueProposedFix['fix_type'],
    current_value: (f.current_value as string | null) ?? null,
    proposed_value: f.proposed_value as string,
    rationale: (f.rationale as string | null) ?? '',
  }));

  const auditConf = env.audit();
  const periodMonths =
    auditRun.config_snapshot?.period_months ?? auditConf.AUDIT_PERIOD_MONTHS;

  const supabaseUrl = env.supabase().SUPABASE_URL.replace(/\/$/, '');
  const supabaseFindingUrl = `${supabaseUrl}/project/_/editor?schema=public&table=audit_findings&filter=id=${findingId}`;

  // Sprint-12: fetch Cooked extras for the issue box (CWV / conversion /
  // provenance / device / capture rate). All best-effort — if Cooked is
  // unreachable or the page has no snapshot yet, we render with `—` cells
  // and skip the data-quality banner.
  const cookedExtras = await fetchCookedExtrasForIssue(row.page as string);

  const rendered = renderIssue({
    finding_id: row.id as string,
    audit_run_id: row.audit_run_id as string,
    page: row.page as string,
    avg_position: Number(row.avg_position),
    position_drift: row.position_drift != null ? Number(row.position_drift) : null,
    impressions: Number(row.impressions),
    audit_period_months: periodMonths,
    ctr_actual: Number(row.ctr_actual),
    ctr_expected: Number(row.ctr_expected),
    ctr_gap: Number(row.ctr_gap),
    priority_score: Number(row.priority_score),
    priority_tier: row.priority_tier as 1 | 2 | 3,
    group_assignment: row.group_assignment as 'treatment' | 'control',
    pages_per_session: row.pages_per_session != null ? Number(row.pages_per_session) : null,
    avg_session_duration_seconds:
      row.avg_session_duration_seconds != null ? Number(row.avg_session_duration_seconds) : null,
    scroll_depth_avg: row.scroll_depth_avg != null ? Number(row.scroll_depth_avg) : null,
    current_title: cs.title,
    current_meta: cs.meta_description,
    current_intro: cs.intro_first_100_words,
    diagnostic,
    fixes,
    baseline_date: auditRun.period_end,
    supabase_finding_url: supabaseFindingUrl,
    cooked_extras: cookedExtras,
    fact_check: factCheck,
  });

  const { owner, repo } = repoCoords();
  const created = await github().rest.issues.create({
    owner,
    repo,
    title: rendered.title,
    body: rendered.body,
    labels: rendered.labels,
  });

  const issueNumber = created.data.number;
  const issueUrl = created.data.html_url;

  const { error: updErr } = await supabase()
    .from('audit_findings')
    .update({
      github_issue_number: issueNumber,
      github_issue_url: issueUrl,
      updated_at: new Date().toISOString(),
    })
    .eq('id', findingId);
  if (updErr) throw new Error(`update finding with issue ref: ${updErr.message}`);

  return { issueNumber, issueUrl };
}

/**
 * Sprint-12: pull Cooked extras for the issue box. Returns a fully-flat
 * shape (no nesting beyond what `IssueCookedExtras` declares). Best-effort
 * — any single Cooked failure produces a clean undefined cell rather than
 * crashing the whole issue create.
 */
async function fetchCookedExtrasForIssue(pageUrl: string): Promise<IssueCookedExtras | undefined> {
  const path = pathOf(pageUrl);
  let snap: Awaited<ReturnType<typeof fetchPageSnapshotExtras>>[number] | undefined;
  try {
    const rows = await fetchPageSnapshotExtras([path]);
    snap = rows[0];
  } catch (err) {
    process.stderr.write(`[create-issues] cooked snapshot failed: ${(err as Error).message}\n`);
  }
  let ctaRows: Awaited<ReturnType<typeof fetchCtaBreakdown>> = [];
  try {
    ctaRows = await fetchCtaBreakdown(path, 28);
  } catch (err) {
    process.stderr.write(`[create-issues] cta breakdown failed: ${(err as Error).message}\n`);
  }
  // Sprint-16 — engagement density (intra-session dwell distribution).
  // Best-effort: leaves nullish fields if RPC errors, banner doesn't fire.
  let density: Awaited<ReturnType<typeof fetchEngagementDensity>> = null;
  try {
    density = await fetchEngagementDensity(path, 28);
  } catch (err) {
    process.stderr.write(`[create-issues] engagement density failed: ${(err as Error).message}\n`);
  }

  if (!snap) return undefined;

  // Compute body-share % for the CTA breakdown banner.
  let bodyPct: number | null = null;
  if (ctaRows.length > 0) {
    const totals = { header: 0, footer: 0, body: 0 };
    for (const r of ctaRows) totals[r.placement] = (totals[r.placement] ?? 0) + r.clicks;
    const total = totals.header + totals.footer + totals.body;
    if (total > 0) bodyPct = (totals.body / total) * 100;
  }

  // Compute capture rate. Pull the latest gsc_page_snapshots row pro-rated to 28d.
  let gscClicks28d: number | null = null;
  try {
    const cutoff = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const { data } = await supabase()
      .from('gsc_page_snapshots')
      .select('clicks, period_start, period_end')
      .eq('page', pageUrl)
      .gte('period_end', cutoff)
      .order('period_end', { ascending: false })
      .limit(1);
    if (data && data.length > 0) {
      const r = data[0]!;
      const startMs = new Date(r.period_start as string).getTime();
      const endMs = new Date(r.period_end as string).getTime();
      const days = Math.max(1, Math.round((endMs - startMs) / (24 * 60 * 60 * 1000)));
      gscClicks28d = Math.round(Number(r.clicks) * (28 / days));
    }
  } catch {
    // best-effort — leave gscClicks28d = null
  }

  const cookedSessions28d = snap.windows['28d'].sessions;
  const captureRatePct =
    gscClicks28d != null && gscClicks28d > 0
      ? (cookedSessions28d / gscClicks28d) * 100
      : null;

  return {
    lcp_p75_ms: snap.cwv_28d.lcp_p75_ms,
    inp_p75_ms: snap.cwv_28d.inp_p75_ms,
    cls_p75: snap.cwv_28d.cls_p75,
    ttfb_p75_ms: snap.cwv_28d.ttfb_p75_ms,
    phone_clicks_28d: snap.conversion.phone_clicks['28d'],
    email_clicks_28d: snap.conversion.email_clicks['28d'],
    booking_cta_clicks_28d: snap.conversion.booking_cta_clicks['28d'],
    cta_body_pct: bodyPct,
    top_source: snap.provenance_28d.top_source,
    top_medium: snap.provenance_28d.top_medium,
    top_referrer: snap.provenance_28d.top_referrer,
    device_split: snap.device_split_28d,
    // Sprint-12 hotfix: 28d behavior signals for box-cell fallback.
    pages_per_session_28d:
      snap.windows['28d'].sessions > 0
        ? snap.windows['28d'].views / snap.windows['28d'].sessions
        : null,
    avg_session_duration_28d: snap.windows['28d'].avg_dwell_seconds,
    scroll_avg_28d: snap.windows['28d'].scroll_avg,
    cooked_sessions_28d: cookedSessions28d,
    gsc_clicks_28d: gscClicks28d,
    capture_rate_pct: captureRatePct,
    // Sprint-15 — pogo / NavBoost signal
    google_sessions_28d: snap.pogo_28d.google_sessions,
    pogo_sticks_28d: snap.pogo_28d.pogo_sticks,
    hard_pogo_28d: snap.pogo_28d.hard_pogo,
    pogo_rate_pct: snap.pogo_28d.pogo_rate_pct,
    // Sprint-16 — CTA per device (snapshot) + engagement density (RPC)
    mobile_sessions_28d: snap.cta_per_device_28d.mobile_sessions,
    desktop_sessions_28d: snap.cta_per_device_28d.desktop_sessions,
    cta_rate_mobile_pct: snap.cta_per_device_28d.cta_rate_mobile_pct,
    cta_rate_desktop_pct: snap.cta_per_device_28d.cta_rate_desktop_pct,
    density_sessions_28d: density?.sessions ?? null,
    density_dwell_p25_seconds: density?.dwell_p25_seconds ?? null,
    density_dwell_median_seconds: density?.dwell_median_seconds ?? null,
    density_dwell_p75_seconds: density?.dwell_p75_seconds ?? null,
    density_evenness_score: density?.evenness_score ?? null,
  };
}

/**
 * Sprint-14: re-render the existing GitHub issue body with the freshly-
 * landed measurement (T+30 or T+60) AND post a timestamped comment on
 * the issue with the deltas.
 *
 * Called by measure.ts AFTER `fix_outcomes` has been inserted for a new
 * milestone. Idempotent — re-running is safe (the body is just re-rendered
 * with the same data, and the comment posting is best-effort).
 *
 * Failures are non-fatal: measure.ts still returns success even if this
 * fails, because the canonical state (fix_outcomes row) is already
 * persisted. Only the GitHub UI lags.
 */
export async function updateIssueAfterMeasurement(findingId: string): Promise<{
  issueNumber: number;
  issueUrl: string;
  measurementsCount: number;
  commentPosted: boolean;
}> {
  // 1. Load finding + audit run + cs + fixes — same shape as create-issues
  const { data: row, error } = await supabase()
    .from('audit_findings')
    .select(
      'id, audit_run_id, page, impressions, ctr_actual, ctr_expected, ctr_gap, avg_position, position_drift, priority_score, priority_tier, group_assignment, pages_per_session, avg_session_duration_seconds, scroll_depth_avg, current_state, diagnostic, diagnostic_fact_check, github_issue_number, github_issue_url, audit_runs(period_start, period_end, config_snapshot)',
    )
    .eq('id', findingId)
    .single();
  if (error || !row) throw new Error(`load finding: ${error?.message ?? 'not found'}`);
  if (!row.github_issue_number) {
    throw new Error(`finding has no github_issue_number — can't update`);
  }
  if (!row.diagnostic || !row.current_state) {
    throw new Error(`finding missing diagnostic or current_state`);
  }

  const diagnostic: IssueDiagnostic = DiagnosticShape.parse(row.diagnostic);
  const cs = CurrentStateShape.parse(row.current_state);
  const factCheck = parseFactCheck(row.diagnostic_fact_check);
  const auditRun = Array.isArray(row.audit_runs)
    ? (row.audit_runs[0] as
        | { period_start: string; period_end: string; config_snapshot: { period_months?: number } }
        | undefined)
    : (row.audit_runs as
        | { period_start: string; period_end: string; config_snapshot: { period_months?: number } }
        | undefined);
  if (!auditRun) throw new Error('no audit_runs join');

  const { data: fixesRows } = await supabase()
    .from('proposed_fixes')
    .select('fix_type, current_value, proposed_value, rationale')
    .eq('finding_id', findingId)
    .order('created_at');
  const fixes: IssueProposedFix[] = (fixesRows ?? []).map((f) => ({
    fix_type: f.fix_type as IssueProposedFix['fix_type'],
    current_value: (f.current_value as string | null) ?? null,
    proposed_value: f.proposed_value as string,
    rationale: (f.rationale as string | null) ?? '',
  }));

  // 2. Load measurements (the part that's new for this flow)
  const measurements = await fetchMeasurementsForFinding(findingId);
  if (measurements.length === 0) {
    throw new Error('no measurements yet — nothing to render');
  }

  // 3. Build inputs + render — same as create-issues with measurements added
  const auditConf = env.audit();
  const periodMonths = auditRun.config_snapshot?.period_months ?? auditConf.AUDIT_PERIOD_MONTHS;
  const supabaseUrl = env.supabase().SUPABASE_URL.replace(/\/$/, '');
  const cookedExtras = await fetchCookedExtrasForIssue(row.page as string);

  const rendered = renderIssue({
    finding_id: row.id as string,
    audit_run_id: row.audit_run_id as string,
    page: row.page as string,
    avg_position: Number(row.avg_position),
    position_drift: row.position_drift != null ? Number(row.position_drift) : null,
    impressions: Number(row.impressions),
    audit_period_months: periodMonths,
    ctr_actual: Number(row.ctr_actual),
    ctr_expected: Number(row.ctr_expected),
    ctr_gap: Number(row.ctr_gap),
    priority_score: Number(row.priority_score),
    priority_tier: row.priority_tier as 1 | 2 | 3,
    group_assignment: row.group_assignment as 'treatment' | 'control',
    pages_per_session: row.pages_per_session != null ? Number(row.pages_per_session) : null,
    avg_session_duration_seconds:
      row.avg_session_duration_seconds != null ? Number(row.avg_session_duration_seconds) : null,
    scroll_depth_avg: row.scroll_depth_avg != null ? Number(row.scroll_depth_avg) : null,
    current_title: cs.title,
    current_meta: cs.meta_description,
    current_intro: cs.intro_first_100_words,
    diagnostic,
    fixes,
    baseline_date: auditRun.period_end,
    supabase_finding_url: `${supabaseUrl}/project/_/editor?schema=public&table=audit_findings&filter=id=${findingId}`,
    cooked_extras: cookedExtras,
    measurements,
    fact_check: factCheck,
  });

  // 4. PATCH issue body
  const { owner, repo } = repoCoords();
  const issueNumber = row.github_issue_number as number;
  await github().rest.issues.update({
    owner,
    repo,
    issue_number: issueNumber,
    body: rendered.body,
  });

  // 5. POST a timestamped comment with the latest measurement summary
  const latest = [...measurements].sort((a, b) => a.days_after_fix - b.days_after_fix)[
    measurements.length - 1
  ]!;
  let commentPosted = false;
  try {
    await github().rest.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body: buildMeasurementComment(latest),
    });
    commentPosted = true;
  } catch (err) {
    process.stderr.write(`[update-issue] comment post failed: ${(err as Error).message}\n`);
  }

  return {
    issueNumber,
    issueUrl: row.github_issue_url as string,
    measurementsCount: measurements.length,
    commentPosted,
  };
}

/**
 * Pull all `fix_outcomes` rows for this finding + the earliest `applied_at`
 * from `applied_fixes` (= T0). Returns sorted ascending by `days_after_fix`.
 */
async function fetchMeasurementsForFinding(findingId: string): Promise<IssueMeasurement[]> {
  // Earliest applied_at — same logic as measure.ts.fetchAppliedFindings
  const { data: fixesRows } = await supabase()
    .from('proposed_fixes')
    .select('id')
    .eq('finding_id', findingId);
  const fixIds = ((fixesRows ?? []) as Array<{ id: string }>).map((r) => r.id);
  if (fixIds.length === 0) return [];

  const { data: applied } = await supabase()
    .from('applied_fixes')
    .select('applied_at')
    .in('proposed_fix_id', fixIds)
    .order('applied_at', { ascending: true })
    .limit(1);
  const earliestApplied = ((applied ?? []) as Array<{ applied_at: string }>)[0]?.applied_at;
  if (!earliestApplied) return [];

  const { data: outcomes } = await supabase()
    .from('fix_outcomes')
    .select(
      'measured_at, days_after_fix, baseline_ctr, current_ctr, ctr_delta_pct, baseline_position, current_position, position_delta, baseline_impressions, current_impressions, significance_note',
    )
    .eq('finding_id', findingId)
    .order('days_after_fix', { ascending: true });

  return ((outcomes ?? []) as Array<Record<string, unknown>>).map((o) => ({
    days_after_fix: Number(o.days_after_fix),
    measured_at: String(o.measured_at),
    applied_at: earliestApplied,
    baseline_ctr: Number(o.baseline_ctr ?? 0),
    current_ctr: Number(o.current_ctr ?? 0),
    ctr_delta_pct: Number(o.ctr_delta_pct ?? 0),
    baseline_position: Number(o.baseline_position ?? 0),
    current_position: Number(o.current_position ?? 0),
    position_delta: Number(o.position_delta ?? 0),
    baseline_impressions: Number(o.baseline_impressions ?? 0),
    current_impressions: Number(o.current_impressions ?? 0),
    significance_note: (o.significance_note as string | null) ?? null,
  }));
}

/**
 * Build the markdown body of the GitHub comment posted to the issue at
 * each new measurement. Brief, scannable, dated — surfaces the verdict
 * and the key deltas. The issue body itself has the full delta table;
 * this comment is the timestamped record in the GH timeline.
 */
function buildMeasurementComment(m: IssueMeasurement): string {
  const ctrPct = (n: number): string => `${(n * 100).toFixed(2)}%`;
  const sign = (n: number, decimals = 1, suffix = ''): string =>
    `${n > 0 ? '+' : ''}${n.toFixed(decimals)}${suffix}`;
  const impDelta =
    m.baseline_impressions > 0
      ? sign(((m.current_impressions - m.baseline_impressions) / m.baseline_impressions) * 100, 1, '%')
      : '—';

  const ctrSignal = m.ctr_delta_pct;
  const posSignal = m.position_delta;
  const verdict =
    ctrSignal >= 5 && posSignal <= 0
      ? '✅ **Fix qui marche** — garder.'
      : ctrSignal <= -5
      ? '🚫 **Régression** — envisager rollback.'
      : 'ℹ️ **Mouvement neutre** — observer T+60 avant conclusion.';

  return [
    `**📈 Mesure automatique T+${m.days_after_fix}** — ${m.measured_at.slice(0, 10)}`,
    ``,
    `Fix appliqué le ${m.applied_at.slice(0, 10)}.`,
    ``,
    `| Métrique | T0 → T+${m.days_after_fix} | Δ |`,
    `|---|---|---|`,
    `| CTR | ${ctrPct(m.baseline_ctr)} → ${ctrPct(m.current_ctr)} | ${sign(ctrSignal, 1, '%')} |`,
    `| Position moyenne | ${m.baseline_position.toFixed(1)} → ${m.current_position.toFixed(1)} | ${sign(posSignal, 2)} |`,
    `| Impressions | ${m.baseline_impressions.toLocaleString('fr-FR')} → ${m.current_impressions.toLocaleString('fr-FR')} | ${impDelta} |`,
    ``,
    verdict,
    ``,
    m.significance_note ? `_${m.significance_note}_` : '',
    `_Source : SEO calc · GSC fix_outcomes · auto-posted by measure.ts_`,
  ]
    .filter((s) => s !== '')
    .join('\n');
}

export async function createIssuesForProposed(opts: {
  limit?: number;
  onlyFindingIds?: string[];
} = {}): Promise<CreateIssuesSummary> {
  const t0 = Date.now();
  let q = supabase()
    .from('audit_findings')
    .select('id, github_issue_number')
    .eq('status', 'proposed')
    .order('priority_score', { ascending: false });
  if (opts.onlyFindingIds && opts.onlyFindingIds.length > 0) q = q.in('id', opts.onlyFindingIds);
  if (opts.limit && opts.limit > 0) q = q.limit(opts.limit);
  const { data, error } = await q;
  if (error) throw new Error(`load proposed findings: ${error.message}`);
  const rows = (data ?? []) as Array<{ id: string; github_issue_number: number | null }>;

  let succeeded = 0;
  let skipped = 0;
  let failed = 0;
  const errors: CreateIssuesSummary['errors'] = [];
  for (const r of rows) {
    if (r.github_issue_number != null) {
      skipped++;
      continue;
    }
    try {
      await createIssueForFinding(r.id);
      succeeded++;
    } catch (err) {
      failed++;
      errors.push({ findingId: r.id, error: (err as Error).message });
    }
  }
  return {
    attempted: rows.length,
    succeeded,
    skipped,
    failed,
    errors,
    durationMs: Date.now() - t0,
  };
}
