/**
 * Sprint 4 — LLM diagnostic.
 *
 * For each finding with status='pending' and current_state IS NOT NULL,
 * builds the diagnostic prompt with top-10 query data + GA4 engagement,
 * calls Claude Sonnet 4.6, validates the JSON shape with Zod, writes the
 * structured diagnostic to audit_findings.diagnostic, and bumps the finding
 * to status='diagnosed'.
 */
import { z } from 'zod';
import { supabase } from '../lib/supabase.js';
import { anthropic, model } from '../lib/anthropic.js';
import {
  renderDiagnosticPrompt,
  DIAGNOSTIC_PROMPT_NAME,
  DIAGNOSTIC_PROMPT_VERSION,
  type DiagnosticPromptInputs,
} from '../prompts/diagnostic.v1.js';

const DiagnosticSchema = z.object({
  intent_mismatch: z.string(),
  snippet_weakness: z.string(),
  hypothesis: z.string(),
  top_queries_analysis: z
    .array(
      z.object({
        query: z.string(),
        impressions: z.number(),
        ctr: z.number(),
        position: z.number(),
        intent_match: z.enum(['yes', 'partial', 'no']),
        note: z.string().optional().default(''),
      }),
    )
    .default([]),
  engagement_diagnosis: z.string(),
  structural_gaps: z.string().optional().default(''),
});

export type DiagnosticPayload = z.infer<typeof DiagnosticSchema>;

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

export type DiagnoseSummary = {
  attempted: number;
  succeeded: number;
  failed: number;
  errors: Array<{ findingId: string; error: string }>;
  durationMs: number;
};

async function fetchTopQueries(
  page: string,
  periodStart: string,
  periodEnd: string,
  limit = 10,
): Promise<DiagnosticPromptInputs['top_queries']> {
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

/**
 * Strip a possible ```json fence around a model response. We ask for raw
 * JSON in the prompt but Sonnet sometimes wraps it anyway; tolerate both.
 */
function unfenceJson(s: string): string {
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return (fenced?.[1] ?? s).trim();
}

export async function diagnoseFinding(findingId: string): Promise<DiagnosticPayload> {
  const { data: row, error } = await supabase()
    .from('audit_findings')
    .select(
      'id, page, impressions, ctr_actual, ctr_expected, ctr_gap, avg_position, position_drift, pages_per_session, avg_session_duration_seconds, scroll_depth_avg, current_state, audit_run_id, audit_runs(period_start, period_end)',
    )
    .eq('id', findingId)
    .single();
  if (error || !row) throw new Error(`load finding: ${error?.message ?? 'not found'}`);

  if (!row.current_state) throw new Error('finding has no current_state — run pull-current-state first');
  // Supabase returns the joined audit_runs as either an object or an array
  // depending on relationship cardinality detection; normalize.
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

  const inputs: DiagnosticPromptInputs = {
    url: row.page as string,
    avg_position: Number(row.avg_position),
    position_drift: row.position_drift != null ? Number(row.position_drift) : null,
    impressions_monthly: Math.round(Number(row.impressions) / 3),
    ctr_actual: Number(row.ctr_actual),
    ctr_expected: Number(row.ctr_expected),
    ctr_gap_pct: Number(row.ctr_gap) * 100,
    pages_per_session: row.pages_per_session != null ? Number(row.pages_per_session) : null,
    avg_duration_seconds:
      row.avg_session_duration_seconds != null ? Number(row.avg_session_duration_seconds) : null,
    scroll_depth: row.scroll_depth_avg != null ? Number(row.scroll_depth_avg) : null,
    current_title: cs.title,
    current_meta: cs.meta_description,
    current_h1: cs.h1,
    current_intro: cs.intro_first_100_words,
    current_schema_jsonld: cs.schema_jsonld,
    current_internal_links: cs.internal_links_outbound,
    top_queries: topQueries,
  };

  const prompt = renderDiagnosticPrompt(inputs);
  const res = await anthropic().messages.create({
    model: model(),
    // 2000 tokens proved too tight once we added structural_gaps + the wider
    // current_state context — Sonnet was truncating the JSON mid-string on
    // ~1/3 of findings ("Unterminated string in JSON at position …").
    // 4000 covers the worst case observed (~6.5k chars output) with margin.
    max_tokens: 4000,
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
  const diagnostic = DiagnosticSchema.parse(parsed);

  const { error: updErr } = await supabase()
    .from('audit_findings')
    .update({
      diagnostic,
      status: 'diagnosed',
      updated_at: new Date().toISOString(),
    })
    .eq('id', findingId);
  if (updErr) throw new Error(`update finding diagnostic: ${updErr.message}`);

  return diagnostic;
}

export async function diagnosePending(opts: {
  limit?: number;
  onlyFindingIds?: string[];
} = {}): Promise<DiagnoseSummary> {
  const t0 = Date.now();
  let q = supabase()
    .from('audit_findings')
    .select('id')
    .eq('status', 'pending')
    .not('current_state', 'is', null)
    .order('priority_score', { ascending: false });
  if (opts.onlyFindingIds && opts.onlyFindingIds.length > 0) {
    q = q.in('id', opts.onlyFindingIds);
  }
  if (opts.limit && opts.limit > 0) q = q.limit(opts.limit);
  const { data, error } = await q;
  if (error) throw new Error(`load pending+ready findings: ${error.message}`);
  const ids = ((data ?? []) as Array<{ id: string }>).map((r) => r.id);

  let succeeded = 0;
  let failed = 0;
  const errors: DiagnoseSummary['errors'] = [];
  for (const id of ids) {
    try {
      await diagnoseFinding(id);
      succeeded++;
    } catch (err) {
      failed++;
      errors.push({ findingId: id, error: (err as Error).message });
    }
  }
  return { attempted: ids.length, succeeded, failed, errors, durationMs: Date.now() - t0 };
}

export const PROMPT_INFO = {
  name: DIAGNOSTIC_PROMPT_NAME,
  version: DIAGNOSTIC_PROMPT_VERSION,
};
