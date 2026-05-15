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
import { messagesCreateWithRetry, model } from '../lib/anthropic.js';
import {
  renderFixGenPrompt,
  FIX_GEN_PROMPT_NAME,
  FIX_GEN_PROMPT_VERSION,
  type FixGenPromptInputs,
} from '../prompts/fix-generation.v1.js';
import { enrichContext } from './context-enrichment.js';
import { fetchInboundSummary } from './diagnose.js';
import type { InboundSummary } from '../prompts/diagnostic.v1.js';
import { pathOf } from '../lib/url.js';
import { ensurePromptVersion } from '../lib/prompt-versions.js';
import {
  fetchPageSnapshotExtras,
  fetchCtaBreakdown,
  type PageSnapshotExtras,
  type CtaBreakdownRow,
} from '../lib/cooked.js';

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
  // Sprint-11 v2 fix: preserve `placement` from Sprint-9+ snapshots. The
  // previous shape silently dropped it and `fmtCategorizedLinks` then fell
  // back to a regex anchor-heuristic that re-derived placement from anchor
  // text — same bug pattern as the diagnose pipeline before Sprint 11.
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

  // Same enrichment as diagnose: real volumes, catalog, category, consent.
  const enrichment = await enrichContext({
    pageUrl: row.page as string,
    topQueries,
  });

  // Sprint-11 v2: live inbound graph signal (same source as diagnose v5).
  // Lets the fix LLM mark a page as "orphaned editorially" and adjust the
  // internal_links rationale to mention seeding from source pages.
  const pagePath = pathOf(row.page as string);
  let inboundSummary: InboundSummary | null = null;
  try {
    inboundSummary = await fetchInboundSummary(pagePath);
  } catch (err) {
    process.stderr.write(`[generate-fixes] inbound fetch failed: ${(err as Error).message}\n`);
  }

  // Sprint-12 v3: Cooked extras + CTA breakdown for the fix-gen prompt.
  // Best-effort, same degradation strategy as diagnose. We do NOT fetch
  // outbound destinations or site context here — those informed the
  // diagnostic but don't change the fixes (which target the page itself).
  let cookedExtras: PageSnapshotExtras | null = null;
  let ctaBreakdown: CtaBreakdownRow[] = [];
  try {
    const rows = await fetchPageSnapshotExtras([pagePath]);
    cookedExtras = rows[0] ?? null;
  } catch (err) {
    process.stderr.write(`[generate-fixes] cooked snapshot failed: ${(err as Error).message}\n`);
  }
  try {
    ctaBreakdown = await fetchCtaBreakdown(pagePath, 28);
  } catch (err) {
    process.stderr.write(`[generate-fixes] cta breakdown failed: ${(err as Error).message}\n`);
  }
  const gscClicks28d = await fetchGscClicksLast28dForFix(row.page as string);

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
    enrichment,
    inbound_summary: inboundSummary,
    cooked_extras: cookedExtras,
    cta_breakdown: ctaBreakdown,
    gsc_clicks_28d: gscClicks28d,
  };

  const prompt = renderFixGenPrompt(inputs);
  // AMDEC M9 — retry exponentiel sur 429/5xx Anthropic (cf. anthropic.ts).
  const res = await messagesCreateWithRetry({
    model: model(),
    // Same reason as diagnose: 2500 was too tight once the prompt opened up
    // to all 7 fix types + schema fixes that include full JSON-LD strings.
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
  const fixes = FixesPayload.parse(parsed);

  // Insert one row per fix. Wipe prior drafts for this finding first so
  // re-running generate-fixes doesn't accumulate duplicates.
  const { error: delErr } = await supabase()
    .from('proposed_fixes')
    .delete()
    .eq('finding_id', findingId)
    .eq('status', 'draft');
  if (delErr) throw new Error(`clear prior drafts: ${delErr.message}`);

  // AMDEC M4 — traçabilité prompt version. Idempotent + module-cache.
  // Best-effort : si l'insert prompt_versions fail, on insert quand même
  // les fixes avec FK NULL (row legacy-style).
  let promptVersionId: string | null = null;
  try {
    promptVersionId = await ensurePromptVersion('fix_generation', FIX_GEN_PROMPT_VERSION);
  } catch (err) {
    process.stderr.write(`[fix-gen] ensurePromptVersion failed: ${(err as Error).message}\n`);
  }

  const rows = fixes.fixes.map((f) => ({
    finding_id: findingId,
    fix_type: f.fix_type,
    current_value: f.current_value ?? null,
    proposed_value: f.proposed_value,
    rationale: f.rationale,
    prompt_version_id: promptVersionId,
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

/**
 * Sprint-12: best-effort GSC clicks last-28d for the fix-gen prompt's
 * data quality check. Identical pattern to fetchGscClicksLast28d in
 * diagnose.ts — pro-rated to 28 days. Local copy to avoid circular
 * import (diagnose.ts already imports from this file would create one).
 */
async function fetchGscClicksLast28dForFix(page: string): Promise<number | null> {
  const cutoff = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const { data, error } = await supabase()
    .from('gsc_page_snapshots')
    .select('clicks, period_start, period_end')
    .eq('page', page)
    .gte('period_end', cutoff)
    .order('period_end', { ascending: false })
    .limit(1);
  if (error || !data || data.length === 0) return null;
  const r = data[0]!;
  const startMs = new Date(r.period_start as string).getTime();
  const endMs = new Date(r.period_end as string).getTime();
  const days = Math.max(1, Math.round((endMs - startMs) / (24 * 60 * 60 * 1000)));
  return Math.round(Number(r.clicks) * (28 / days));
}
