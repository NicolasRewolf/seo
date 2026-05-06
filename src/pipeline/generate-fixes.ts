/**
 * Sprint 4 — Generate fixes.
 *
 * For each finding with status='diagnosed', builds the fix-generation prompt
 * from diagnostic + current_state + top queries, calls Claude Sonnet 4.6,
 * validates the response with Zod, inserts one row per fix into proposed_fixes
 * (status='draft'), and bumps the finding to status='proposed'.
 */
import { z } from 'zod';
import { supabase } from '../lib/supabase.js';
import { anthropic, model } from '../lib/anthropic.js';
import {
  renderFixGenPrompt,
  FIX_GEN_PROMPT_NAME,
  FIX_GEN_PROMPT_VERSION,
  type FixGenPromptInputs,
} from '../prompts/fix-generation.v1.js';

const FIX_TYPES = [
  'title',
  'meta_description',
  'h1',
  'intro',
  'schema',
  'internal_links',
  'content_addition',
] as const;

const FixSchema = z.object({
  fix_type: z.enum(FIX_TYPES),
  current_value: z.union([z.string(), z.null()]).optional(),
  proposed_value: z.string(),
  rationale: z.string().optional().default(''),
});
const FixesPayload = z.object({ fixes: z.array(FixSchema) });

export type FixesPayloadType = z.infer<typeof FixesPayload>;

const CurrentStateShape = z.object({
  title: z.string().default(''),
  meta_description: z.string().default(''),
  h1: z.string().default(''),
  intro_first_100_words: z.string().default(''),
  schema_jsonld: z.array(z.unknown()).nullable().default(null),
  internal_links_outbound: z
    .array(z.object({ anchor: z.string(), target: z.string() }))
    .default([]),
});

function unfenceJson(s: string): string {
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return (fenced?.[1] ?? s).trim();
}

async function fetchTopQueries(
  page: string,
  periodStart: string,
  periodEnd: string,
  limit = 5,
): Promise<FixGenPromptInputs['top_queries']> {
  const { data, error } = await supabase()
    .from('gsc_query_snapshots')
    .select('query, impressions, ctr, avg_position')
    .eq('page', page)
    .eq('period_start', periodStart)
    .eq('period_end', periodEnd)
    .order('impressions', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`top queries fetch: ${error.message}`);
  return (data ?? []).map((r) => ({
    query: r.query as string,
    impressions: Number(r.impressions),
    ctr: Number(r.ctr),
    position: Number(r.avg_position),
  }));
}

export async function generateFixesForFinding(findingId: string): Promise<FixesPayloadType> {
  const { data: row, error } = await supabase()
    .from('audit_findings')
    .select(
      'id, page, avg_position, current_state, diagnostic, audit_run_id, audit_runs(period_start, period_end)',
    )
    .eq('id', findingId)
    .single();
  if (error || !row) throw new Error(`load finding: ${error?.message ?? 'not found'}`);

  if (!row.current_state) throw new Error('finding has no current_state');
  if (!row.diagnostic) throw new Error('finding has no diagnostic — run diagnose first');
  const auditRun = Array.isArray(row.audit_runs)
    ? (row.audit_runs[0] as { period_start: string; period_end: string } | undefined)
    : (row.audit_runs as { period_start: string; period_end: string } | undefined);
  if (!auditRun) throw new Error('finding missing audit_runs join');

  const cs = CurrentStateShape.parse(row.current_state);
  const topQueries = await fetchTopQueries(
    row.page as string,
    auditRun.period_start,
    auditRun.period_end,
  );

  const inputs: FixGenPromptInputs = {
    url: row.page as string,
    position: Number(row.avg_position),
    current_title: cs.title,
    current_meta: cs.meta_description,
    current_h1: cs.h1,
    current_intro: cs.intro_first_100_words,
    current_schema_jsonld: cs.schema_jsonld,
    current_internal_links: cs.internal_links_outbound,
    top_queries: topQueries,
    diagnostic: row.diagnostic,
  };

  const prompt = renderFixGenPrompt(inputs);
  const res = await anthropic().messages.create({
    model: model(),
    max_tokens: 2500,
    messages: [{ role: 'user', content: prompt }],
  });
  const first = res.content[0];
  const raw = first?.type === 'text' ? first.text : '';
  if (!raw) throw new Error('LLM returned empty content');

  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenceJson(raw));
  } catch (err) {
    throw new Error(`LLM response is not valid JSON: ${(err as Error).message}\n${raw.slice(0, 500)}`);
  }
  const fixes = FixesPayload.parse(parsed);

  // Insert one row per fix. Wipe prior drafts for this finding first so
  // re-running generate-fixes doesn't accumulate duplicates.
  const { error: delErr } = await supabase()
    .from('proposed_fixes')
    .delete()
    .eq('finding_id', findingId)
    .eq('status', 'draft');
  if (delErr) throw new Error(`clear prior drafts: ${delErr.message}`);

  const rows = fixes.fixes.map((f) => ({
    finding_id: findingId,
    fix_type: f.fix_type,
    current_value: f.current_value ?? null,
    proposed_value: f.proposed_value,
    rationale: f.rationale,
    status: 'draft' as const,
  }));
  if (rows.length > 0) {
    const { error: insErr } = await supabase().from('proposed_fixes').insert(rows);
    if (insErr) throw new Error(`insert proposed_fixes: ${insErr.message}`);
  }

  const { error: updErr } = await supabase()
    .from('audit_findings')
    .update({ status: 'proposed', updated_at: new Date().toISOString() })
    .eq('id', findingId);
  if (updErr) throw new Error(`update finding to proposed: ${updErr.message}`);

  return fixes;
}

export type GenerateFixesSummary = {
  attempted: number;
  succeeded: number;
  failed: number;
  totalFixes: number;
  errors: Array<{ findingId: string; error: string }>;
  durationMs: number;
};

export async function generateFixesForDiagnosed(opts: {
  limit?: number;
  onlyFindingIds?: string[];
} = {}): Promise<GenerateFixesSummary> {
  const t0 = Date.now();
  let q = supabase()
    .from('audit_findings')
    .select('id')
    .eq('status', 'diagnosed')
    .order('priority_score', { ascending: false });
  if (opts.onlyFindingIds && opts.onlyFindingIds.length > 0) q = q.in('id', opts.onlyFindingIds);
  if (opts.limit && opts.limit > 0) q = q.limit(opts.limit);
  const { data, error } = await q;
  if (error) throw new Error(`load diagnosed findings: ${error.message}`);
  const ids = ((data ?? []) as Array<{ id: string }>).map((r) => r.id);

  let succeeded = 0;
  let failed = 0;
  let totalFixes = 0;
  const errors: GenerateFixesSummary['errors'] = [];
  for (const id of ids) {
    try {
      const r = await generateFixesForFinding(id);
      succeeded++;
      totalFixes += r.fixes.length;
    } catch (err) {
      failed++;
      errors.push({ findingId: id, error: (err as Error).message });
    }
  }
  return {
    attempted: ids.length,
    succeeded,
    failed,
    totalFixes,
    errors,
    durationMs: Date.now() - t0,
  };
}

export const PROMPT_INFO = {
  name: FIX_GEN_PROMPT_NAME,
  version: FIX_GEN_PROMPT_VERSION,
};
