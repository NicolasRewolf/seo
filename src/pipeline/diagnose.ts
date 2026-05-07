/**
 * Sprint 4 — LLM diagnostic.
 *
 * For each finding with status='pending' and current_state IS NOT NULL,
 * builds the diagnostic prompt with top-10 query data + Cooked first-party
 * behavior + Core Web Vitals, calls Claude Sonnet 4.6, validates the JSON
 * shape with Zod, writes the structured diagnostic to
 * audit_findings.diagnostic, and bumps the finding to status='diagnosed'.
 */
import { z } from 'zod';
import { supabase } from '../lib/supabase.js';
import { anthropic, model } from '../lib/anthropic.js';
import {
  renderDiagnosticPrompt,
  DIAGNOSTIC_PROMPT_NAME,
  DIAGNOSTIC_PROMPT_VERSION,
  type DiagnosticPromptInputs,
  type InboundSummary,
} from '../prompts/diagnostic.v1.js';
import { enrichContext } from './context-enrichment.js';
import { pathOf } from '../lib/url.js';

const DiagnosticSchema = z.object({
  // Sprint-11 v5: synthesis-first field. Optional so older v1-v4 diagnostics
  // (persisted before this migration) keep validating when re-loaded.
  tldr: z.string().optional().default(''),
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
  performance_diagnosis: z.string().optional().default(''),
  structural_gaps: z.string().optional().default(''),
  funnel_assessment: z.string().optional().default(''),
  internal_authority_assessment: z.string().optional().default(''),
});

export type DiagnosticPayload = z.infer<typeof DiagnosticSchema>;

const CurrentStateShape = z.object({
  title: z.string().default(''),
  meta_description: z.string().default(''),
  h1: z.string().default(''),
  intro_first_100_words: z.string().default(''),
  schema_jsonld: z.array(z.unknown()).nullable().default(null),
  // Sprint-11 fix: preserve `placement` from Sprint-9+ snapshots. The previous
  // shape silently dropped it (Zod strips unknown keys by default), pushing
  // every link into the "unclassified" bucket downstream — even on snapshots
  // that DID have DOM-classified placements. `placement` stays optional so
  // pre-Sprint-9 snapshots still validate.
  internal_links_outbound: z
    .array(
      z.object({
        anchor: z.string(),
        target: z.string(),
        placement: z
          .enum(['editorial', 'related', 'nav', 'footer', 'cta', 'image'])
          .optional(),
      }),
    )
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

/**
 * Sprint 9 — Query the live internal_link_graph for a finding's inbound
 * authority signal. Returns aggregated counts plus the top editorial
 * sources (most semantically meaningful for the LLM to reason about).
 *
 * If the graph hasn't been crawled yet (empty table), we return zeroed
 * counts and an empty top_sources list — the prompt will surface this
 * as "graph not available yet" so the LLM doesn't fabricate authority.
 */
async function fetchInboundSummary(targetPath: string): Promise<InboundSummary> {
  const sb = supabase();

  // Aggregated counts via the view
  const { data: summary, error: sErr } = await sb
    .from('v_internal_link_summary')
    .select('outbound_total, inbound_total, inbound_distinct_sources, inbound_editorial, inbound_nav_footer')
    .eq('page', targetPath)
    .maybeSingle();
  if (sErr) throw new Error(`inbound summary fetch: ${sErr.message}`);

  // Top 15 editorial sources (most useful for the LLM — reveals who
  // actually links to this page in the body, not just nav/footer).
  const { data: editorial, error: eErr } = await sb
    .from('internal_link_graph')
    .select('source_path, anchor_text')
    .eq('target_path', targetPath)
    .eq('placement', 'editorial')
    .order('source_path', { ascending: true })
    .limit(15);
  if (eErr) throw new Error(`inbound editorial sources fetch: ${eErr.message}`);

  return {
    outbound_total: Number(summary?.outbound_total ?? 0),
    inbound_total: Number(summary?.inbound_total ?? 0),
    inbound_distinct_sources: Number(summary?.inbound_distinct_sources ?? 0),
    inbound_editorial: Number(summary?.inbound_editorial ?? 0),
    inbound_nav_footer: Number(summary?.inbound_nav_footer ?? 0),
    top_editorial_sources: (editorial ?? []).map((r) => ({
      source_path: r.source_path as string,
      anchor_text: (r.anchor_text as string | null) ?? '',
    })),
  };
}

/**
 * Sprint 11 — Build the full DiagnosticPromptInputs for a finding without
 * calling the LLM. Used both by diagnoseFinding (then sent to Anthropic)
 * and by the `--print-prompt` driver flag (then printed to stdout for
 * debugging prompt-clarity issues).
 */
export async function buildDiagnosticInputs(findingId: string): Promise<DiagnosticPromptInputs> {
  // NOTE: keep this select string a single literal — Supabase's PostgREST
  // type inference falls back to `GenericStringError` when the string is
  // built via `+` concatenation, which breaks downstream `.data` typing.
  const { data: row, error } = await supabase()
    .from('audit_findings')
    .select(
      'id, page, impressions, ctr_actual, ctr_expected, ctr_gap, avg_position, position_drift, pages_per_session, avg_session_duration_seconds, scroll_depth_avg, scroll_complete_pct, lcp_p75_ms, inp_p75_ms, cls_p75, ttfb_p75_ms, outbound_clicks, current_state, audit_run_id, audit_runs(period_start, period_end)',
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

  // Sprint-7 enrichment: Wix category + post metrics, DataForSEO volumes per
  // top query, real internal-pages catalog. Failures inside enrichContext
  // degrade gracefully (warn-and-skip) so the diagnostic still runs even if
  // e.g. DataForSEO is briefly down.
  const enrichment = await enrichContext({
    pageUrl: row.page as string,
    topQueries,
  });

  // Sprint-9: live inbound authority signal from the link graph.
  // The `current_state.internal_links_outbound` snapshot stays immutable for
  // the audit timeline; inbound is queried fresh because it's an emergent
  // property of the *whole site* and a single page audit shouldn't freeze it.
  let inboundSummary: InboundSummary | null = null;
  try {
    inboundSummary = await fetchInboundSummary(pathOf(row.page as string));
  } catch (err) {
    process.stderr.write(`[diagnose] inbound fetch failed: ${(err as Error).message}\n`);
  }

  return {
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
    scroll_complete_pct:
      row.scroll_complete_pct != null ? Number(row.scroll_complete_pct) : null,
    outbound_clicks: row.outbound_clicks != null ? Number(row.outbound_clicks) : null,
    lcp_p75_ms: row.lcp_p75_ms != null ? Number(row.lcp_p75_ms) : null,
    inp_p75_ms: row.inp_p75_ms != null ? Number(row.inp_p75_ms) : null,
    cls_p75: row.cls_p75 != null ? Number(row.cls_p75) : null,
    ttfb_p75_ms: row.ttfb_p75_ms != null ? Number(row.ttfb_p75_ms) : null,
    current_title: cs.title,
    current_meta: cs.meta_description,
    current_h1: cs.h1,
    current_intro: cs.intro_first_100_words,
    current_schema_jsonld: cs.schema_jsonld,
    current_internal_links: cs.internal_links_outbound,
    top_queries: topQueries,
    enrichment,
    inbound_summary: inboundSummary,
  };
}

export async function diagnoseFinding(findingId: string): Promise<DiagnosticPayload> {
  const inputs = await buildDiagnosticInputs(findingId);

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
