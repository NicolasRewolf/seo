/**
 * Sprint 4 — Pull current state.
 *
 * For each finding with status='pending' and current_state IS NULL, fetch
 * the page's SEO + content state via Wix Blog API (for /post/* paths) or
 * live HTML scrape (for static pages), and store it on the finding.
 *
 * Per ROADMAP §6 step 3, status stays 'pending' until the diagnostic step
 * fills `diagnostic` and bumps to 'diagnosed'.
 */
import { supabase } from '../lib/supabase.js';
import { getCurrentStateForUrl, extractContentForFinding } from '../lib/wix.js';

export type PullSummary = {
  attempted: number;
  succeeded: number;
  failed: number;
  errors: Array<{ findingId: string; page: string; error: string }>;
  durationMs: number;
};

export async function pullCurrentStateForPending(opts: {
  /** Limit how many pending findings to process this run (default: all). */
  limit?: number;
  /** Optional finding-id filter (test mode). */
  onlyFindingIds?: string[];
} = {}): Promise<PullSummary> {
  const t0 = Date.now();
  let query = supabase()
    .from('audit_findings')
    .select('id, page')
    .eq('status', 'pending')
    .is('current_state', null)
    .order('priority_score', { ascending: false });
  if (opts.onlyFindingIds && opts.onlyFindingIds.length > 0) {
    query = query.in('id', opts.onlyFindingIds);
  }
  if (opts.limit && opts.limit > 0) query = query.limit(opts.limit);
  const { data, error } = await query;
  if (error) throw new Error(`fetch pending findings: ${error.message}`);
  const findings = (data ?? []) as Array<{ id: string; page: string }>;

  let succeeded = 0;
  let failed = 0;
  const errors: PullSummary['errors'] = [];

  // Sequential to stay polite on Wix Blog API + the site's own HTML server.
  for (const f of findings) {
    try {
      const state = await getCurrentStateForUrl(f.page);
      // Sprint-14: structured content snapshot for the diagnostic v7 LLM
      // (full body / outline / images / author / CTA positions). Best-effort
      // — failure here doesn't abort the current_state write, the LLM just
      // gets the legacy intro_first_100_words from current_state.
      let contentSnapshot = null;
      try {
        contentSnapshot = await extractContentForFinding(f.page);
      } catch (err) {
        process.stderr.write(
          `[pull-current-state] content snapshot failed for ${f.page}: ${(err as Error).message}\n`,
        );
      }
      const { error: updErr } = await supabase()
        .from('audit_findings')
        .update({
          current_state: state,
          content_snapshot: contentSnapshot,
          updated_at: new Date().toISOString(),
        })
        .eq('id', f.id);
      if (updErr) throw new Error(`update finding: ${updErr.message}`);
      succeeded++;
    } catch (err) {
      failed++;
      errors.push({ findingId: f.id, page: f.page, error: (err as Error).message });
    }
  }

  return {
    attempted: findings.length,
    succeeded,
    failed,
    errors,
    durationMs: Date.now() - t0,
  };
}
