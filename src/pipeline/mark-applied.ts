/**
 * Sprint 6 — Mark a finding as applied (manual signal).
 *
 * Per the user's workflow choice, fixes are applied by hand in the Wix editor
 * (no auto-push to Wix). After editing, the operator runs this to:
 *   1. write one applied_fixes row per proposed_fix that was actually applied
 *   2. flip those proposed_fixes to status='applied'
 *   3. flip the finding to status='applied' so measure.ts can pick it up
 *   4. (optionally) add a `status:applied` label on the linked GitHub issue
 *
 * The applied_at timestamp is the T0 used by measure.ts for T+30/T+60.
 */
import { z } from 'zod';
import { supabase } from '../lib/supabase.js';
import { github, repoCoords } from '../lib/github.js';

export type MarkAppliedSummary = {
  findingId: string;
  page: string;
  fixesApplied: number;
  fixesSkipped: number;
  appliedAt: string;
  issueLabeledApplied: boolean;
};

const ProposedFixRow = z.object({
  id: z.string(),
  fix_type: z.string(),
  status: z.string(),
});

export async function markFindingApplied(opts: {
  findingId: string;
  /** Restrict which fix_types count as applied (default: all). */
  onlyFixTypes?: string[];
  /** Override the application timestamp (e.g., backfill). */
  appliedAt?: string;
  /** Identify who applied the fix (free text — usually email or name). */
  appliedBy?: string;
  /** Skip the GitHub label change (default false). */
  skipGithubLabel?: boolean;
}): Promise<MarkAppliedSummary> {
  const appliedAt = opts.appliedAt ?? new Date().toISOString();

  const { data: f, error: fErr } = await supabase()
    .from('audit_findings')
    .select('id, page, status, github_issue_number')
    .eq('id', opts.findingId)
    .single();
  if (fErr || !f) throw new Error(`load finding: ${fErr?.message ?? 'not found'}`);

  // Pull all draft fixes for this finding
  const { data: fixesData, error: fxErr } = await supabase()
    .from('proposed_fixes')
    .select('id, fix_type, status')
    .eq('finding_id', opts.findingId)
    .order('created_at');
  if (fxErr) throw new Error(`load proposed_fixes: ${fxErr.message}`);
  const fixes = ((fixesData ?? []) as unknown[]).map((r) => ProposedFixRow.parse(r));
  if (fixes.length === 0) throw new Error('no proposed_fixes for this finding');

  let applied = 0;
  let skipped = 0;
  for (const fix of fixes) {
    if (fix.status !== 'draft') {
      skipped++;
      continue;
    }
    if (opts.onlyFixTypes && !opts.onlyFixTypes.includes(fix.fix_type)) {
      skipped++;
      continue;
    }
    const { error: insErr } = await supabase().from('applied_fixes').insert({
      proposed_fix_id: fix.id,
      applied_at: appliedAt,
      applied_by: opts.appliedBy ?? null,
    });
    if (insErr) throw new Error(`insert applied_fixes for ${fix.id}: ${insErr.message}`);
    const { error: updFxErr } = await supabase()
      .from('proposed_fixes')
      .update({ status: 'applied', updated_at: new Date().toISOString() })
      .eq('id', fix.id);
    if (updFxErr) throw new Error(`update proposed_fix ${fix.id}: ${updFxErr.message}`);
    applied++;
  }

  if (applied === 0) {
    throw new Error('nothing to apply (no draft fixes matched)');
  }

  // Bump finding to 'applied' so measure.ts picks it up.
  const { error: updFErr } = await supabase()
    .from('audit_findings')
    .update({ status: 'applied', updated_at: new Date().toISOString() })
    .eq('id', opts.findingId);
  if (updFErr) throw new Error(`update finding to applied: ${updFErr.message}`);

  // Best-effort: add status:applied label on the GitHub issue (and remove
  // status:proposed). Don't abort if labeling fails — the DB state is what
  // measure.ts cares about.
  let labeled = false;
  if (!opts.skipGithubLabel && f.github_issue_number) {
    try {
      const { owner, repo } = repoCoords();
      await github().rest.issues.addLabels({
        owner,
        repo,
        issue_number: f.github_issue_number as number,
        labels: ['status:applied'],
      });
      // Remove status:proposed if present
      try {
        await github().rest.issues.removeLabel({
          owner,
          repo,
          issue_number: f.github_issue_number as number,
          name: 'status:proposed',
        });
      } catch {
        // Already absent, ignore
      }
      labeled = true;
    } catch {
      // Best-effort, swallow
    }
  }

  return {
    findingId: opts.findingId,
    page: f.page as string,
    fixesApplied: applied,
    fixesSkipped: skipped,
    appliedAt,
    issueLabeledApplied: labeled,
  };
}
