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
  type IssueProposedFix,
} from '../prompts/issue-template.js';
import { fetchPageSnapshotExtras, fetchCtaBreakdown } from '../lib/cooked.js';
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
      'id, audit_run_id, page, impressions, ctr_actual, ctr_expected, ctr_gap, avg_position, position_drift, priority_score, priority_tier, group_assignment, pages_per_session, avg_session_duration_seconds, scroll_depth_avg, current_state, diagnostic, github_issue_number, audit_runs(period_start, period_end, config_snapshot)',
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
    device_split: snap.device_split_28d,
    cooked_sessions_28d: cookedSessions28d,
    gsc_clicks_28d: gscClicks28d,
    capture_rate_pct: captureRatePct,
  };
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
