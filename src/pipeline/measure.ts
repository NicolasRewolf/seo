/**
 * Sprint 6 — Measure outcomes (T+30 / T+60).
 *
 * Reads each finding with status='applied' (or already 'measured') and
 * compares its current GSC + GA4 metrics to the baseline captured at apply
 * time. Inserts one fix_outcomes row per due cycle. Bumps the finding to
 * 'measured' once the T+60 measurement has landed.
 *
 * Baseline = the gsc_page_snapshots row whose period contains the apply
 * date (or the most recent before it). Current = the latest snapshot.
 *
 * Intended to be invoked by a daily cron — only findings whose elapsed days
 * cross the next milestone (30 or 60) are measured this run.
 */
import { differenceInCalendarDays } from 'date-fns';
import { supabase } from '../lib/supabase.js';

export type MeasureSummary = {
  attempted: number;
  measured: number;
  skipped: number;
  errors: Array<{ findingId: string; error: string }>;
  durationMs: number;
};

type FindingRow = {
  id: string;
  page: string;
  status: string;
  ctr_actual: number;
  avg_position: number;
  impressions: number;
};

type ProposedFixRow = { id: string };
type AppliedFixRow = { applied_at: string; proposed_fix_id: string };

async function fetchAppliedFindings(): Promise<
  Array<{ finding: FindingRow; appliedAt: string }>
> {
  // Findings already-applied or already-measured (so we can layer T+60 on
  // top of an earlier T+30).
  const { data: findings, error } = await supabase()
    .from('audit_findings')
    .select('id, page, status, ctr_actual, avg_position, impressions')
    .in('status', ['applied', 'measured'])
    .order('updated_at', { ascending: false });
  if (error) throw new Error(`load applied findings: ${error.message}`);

  const out: Array<{ finding: FindingRow; appliedAt: string }> = [];
  for (const f of (findings ?? []) as FindingRow[]) {
    // Earliest applied_at across this finding's fixes = the T0
    const { data: fixes } = await supabase()
      .from('proposed_fixes')
      .select('id')
      .eq('finding_id', f.id);
    const fixIds = ((fixes ?? []) as ProposedFixRow[]).map((r) => r.id);
    if (fixIds.length === 0) continue;

    const { data: applied } = await supabase()
      .from('applied_fixes')
      .select('applied_at, proposed_fix_id')
      .in('proposed_fix_id', fixIds)
      .order('applied_at', { ascending: true })
      .limit(1);
    const earliest = ((applied ?? []) as AppliedFixRow[])[0];
    if (!earliest?.applied_at) continue;
    out.push({ finding: f, appliedAt: earliest.applied_at });
  }
  return out;
}

type SnapshotRow = {
  page: string;
  period_start: string;
  period_end: string;
  impressions: number;
  ctr: number;
  avg_position: number;
};

async function latestSnapshot(page: string): Promise<SnapshotRow | null> {
  const { data, error } = await supabase()
    .from('gsc_page_snapshots')
    .select('page, period_start, period_end, impressions, ctr, avg_position')
    .eq('page', page)
    .order('period_end', { ascending: false })
    .limit(1);
  if (error) throw new Error(`latest snapshot for ${page}: ${error.message}`);
  return ((data ?? []) as SnapshotRow[])[0] ?? null;
}

async function snapshotAsOf(
  page: string,
  asOf: string,
): Promise<SnapshotRow | null> {
  // Most recent snapshot whose period_end is on or before `asOf`.
  const { data, error } = await supabase()
    .from('gsc_page_snapshots')
    .select('page, period_start, period_end, impressions, ctr, avg_position')
    .eq('page', page)
    .lte('period_end', asOf)
    .order('period_end', { ascending: false })
    .limit(1);
  if (error) throw new Error(`baseline snapshot for ${page}: ${error.message}`);
  return ((data ?? []) as SnapshotRow[])[0] ?? null;
}

async function existingOutcomeAtDay(
  findingId: string,
  daysAfterFix: number,
): Promise<boolean> {
  const { data, error } = await supabase()
    .from('fix_outcomes')
    .select('id')
    .eq('finding_id', findingId)
    .eq('days_after_fix', daysAfterFix)
    .limit(1);
  if (error) throw new Error(`check outcome existence: ${error.message}`);
  return (data ?? []).length > 0;
}

const MILESTONES = [30, 60] as const;

function pickDueMilestones(
  appliedAt: string,
  now: Date,
): number[] {
  const days = differenceInCalendarDays(now, new Date(appliedAt));
  return MILESTONES.filter((m) => days >= m);
}

function pctDelta(baseline: number | null | undefined, current: number): number {
  if (!baseline || baseline === 0) return 0;
  return Math.round(((current - baseline) / baseline) * 10000) / 100; // 2-decimal %
}

async function controlAverage(
  daysAfterFix: number,
): Promise<{ avgCtrDelta: number; avgPosDelta: number; n: number } | null> {
  // Outcomes that have already landed for control-group findings at the same
  // milestone — used to surface the treatment-vs-control gap on the new row.
  const { data, error } = await supabase()
    .from('fix_outcomes')
    .select('finding_id, ctr_delta_pct, position_delta, audit_findings(group_assignment)')
    .eq('days_after_fix', daysAfterFix);
  if (error) throw new Error(`load control outcomes: ${error.message}`);
  const rows = ((data ?? []) as Array<{
    ctr_delta_pct: number;
    position_delta: number;
    audit_findings: { group_assignment: string } | { group_assignment: string }[];
  }>).filter((r) => {
    const rel = Array.isArray(r.audit_findings) ? r.audit_findings[0] : r.audit_findings;
    return rel?.group_assignment === 'control';
  });
  if (rows.length === 0) return null;
  const ctr = rows.reduce((s, r) => s + Number(r.ctr_delta_pct ?? 0), 0) / rows.length;
  const pos = rows.reduce((s, r) => s + Number(r.position_delta ?? 0), 0) / rows.length;
  return { avgCtrDelta: ctr, avgPosDelta: pos, n: rows.length };
}

async function measureFindingAtDay(
  findingId: string,
  appliedAt: string,
  page: string,
  daysAfterFix: number,
): Promise<boolean> {
  if (await existingOutcomeAtDay(findingId, daysAfterFix)) return false;

  const baseline = await snapshotAsOf(page, appliedAt.slice(0, 10));
  const current = await latestSnapshot(page);
  if (!baseline || !current) return false;

  const ctrDeltaPct = pctDelta(Number(baseline.ctr), Number(current.ctr));
  const posDelta =
    Math.round((Number(current.avg_position) - Number(baseline.avg_position)) * 100) / 100;

  // Treatment-vs-control gap (best-effort)
  let significanceNote = '';
  const ctrl = await controlAverage(daysAfterFix);
  if (ctrl) {
    significanceNote = `treatment vs control gap (n=${ctrl.n}) :: ctr ${(
      ctrDeltaPct - ctrl.avgCtrDelta
    ).toFixed(1)}% / position ${(posDelta - ctrl.avgPosDelta).toFixed(2)}`;
  }

  const { error } = await supabase().from('fix_outcomes').insert({
    finding_id: findingId,
    days_after_fix: daysAfterFix,
    baseline_ctr: baseline.ctr,
    current_ctr: current.ctr,
    ctr_delta_pct: ctrDeltaPct,
    baseline_position: baseline.avg_position,
    current_position: current.avg_position,
    position_delta: posDelta,
    baseline_impressions: baseline.impressions,
    current_impressions: current.impressions,
    significance_note: significanceNote || null,
  });
  if (error) throw new Error(`insert outcome ${daysAfterFix}d: ${error.message}`);
  return true;
}

export async function runMeasure(): Promise<MeasureSummary> {
  const t0 = Date.now();
  const now = new Date();
  const findings = await fetchAppliedFindings();

  let measured = 0;
  let skipped = 0;
  const errors: MeasureSummary['errors'] = [];

  for (const { finding, appliedAt } of findings) {
    try {
      const due = pickDueMilestones(appliedAt, now);
      let madeProgress = false;
      let landedAt60 = false;
      for (const day of due) {
        const did = await measureFindingAtDay(finding.id, appliedAt, finding.page, day);
        if (did) {
          measured++;
          madeProgress = true;
          if (day >= 60) landedAt60 = true;
        }
      }
      if (!madeProgress) skipped++;

      // Once T+60 is in, we consider the finding "measured" for status purposes.
      if (landedAt60 && finding.status !== 'measured') {
        await supabase()
          .from('audit_findings')
          .update({ status: 'measured', updated_at: now.toISOString() })
          .eq('id', finding.id);
      }
    } catch (err) {
      errors.push({ findingId: finding.id, error: (err as Error).message });
    }
  }

  return {
    attempted: findings.length,
    measured,
    skipped,
    errors,
    durationMs: Date.now() - t0,
  };
}
