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
  getCookedFirstSeen,
  type DiagnosticPromptInputs,
  type InboundSummary,
} from '../prompts/diagnostic.v1.js';
import { enrichContext } from './context-enrichment.js';
import { pathOf } from '../lib/url.js';
import {
  fetchPageSnapshotExtras,
  fetchSiteContext,
  fetchOutboundDestinations,
  fetchCtaBreakdown,
  type PageSnapshotExtras,
  type SiteContext,
  type OutboundDestination,
  type CtaBreakdownRow,
} from '../lib/cooked.js';
import { factCheckDiagnostic, type FactCheckResult } from '../lib/diagnostic-fact-check.js';
import type { ContentSnapshot } from '../lib/page-content-extractor.js';

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
  // Sprint-12 v6: Cooked full-menu fields. All optional for v1-v5 backcompat.
  conversion_assessment: z.string().optional().default(''),
  traffic_strategy_note: z.string().optional().default(''),
  device_optimization_note: z.string().optional().default(''),
  outbound_leak_note: z.string().optional().default(''),
  // Sprint-15 v8: pogo-sticking / NavBoost negative signal. Optional for
  // v1-v7 backcompat (older diagnostics in DB don't have this field).
  pogo_navboost_assessment: z.string().optional().default(''),
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
export async function fetchInboundSummary(targetPath: string): Promise<InboundSummary> {
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
      'id, page, impressions, ctr_actual, ctr_expected, ctr_gap, avg_position, position_drift, pages_per_session, avg_session_duration_seconds, scroll_depth_avg, scroll_complete_pct, lcp_p75_ms, inp_p75_ms, cls_p75, ttfb_p75_ms, outbound_clicks, current_state, content_snapshot, audit_run_id, audit_runs(period_start, period_end)',
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

  // Sprint-12: Cooked full-menu fetch. All 4 calls are best-effort — if any
  // fails (RPC not yet deployed, network blip, freshly-seeded DB with no
  // rows yet), we degrade gracefully and the prompt surfaces the absence
  // explicitly rather than crashing the diagnostic.
  const pagePath = pathOf(row.page as string);
  let cookedExtras: PageSnapshotExtras | null = null;
  let cookedSiteContext: SiteContext | null = null;
  let outboundDestinations: OutboundDestination[] = [];
  let ctaBreakdown: CtaBreakdownRow[] = [];
  try {
    const rows = await fetchPageSnapshotExtras([pagePath]);
    cookedExtras = rows[0] ?? null;
  } catch (err) {
    process.stderr.write(`[diagnose] cooked snapshot extras failed: ${(err as Error).message}\n`);
  }
  try {
    cookedSiteContext = await fetchSiteContext();
  } catch (err) {
    process.stderr.write(`[diagnose] cooked site context failed: ${(err as Error).message}\n`);
  }
  try {
    outboundDestinations = await fetchOutboundDestinations(pagePath, 28);
  } catch (err) {
    process.stderr.write(`[diagnose] cooked outbound destinations failed: ${(err as Error).message}\n`);
  }
  try {
    ctaBreakdown = await fetchCtaBreakdown(pagePath, 28);
  } catch (err) {
    process.stderr.write(`[diagnose] cooked cta breakdown failed: ${(err as Error).message}\n`);
  }

  // Sprint-12 data quality check: GSC clicks last 28d (NOT the audit period
  // — capture rate is calibrated to the same window as Cooked extras).
  // Falls back to null if the page has no recent gsc_page_snapshots row.
  const gscClicks28d = await fetchGscClicksLast28d(row.page as string);

  // Sprint-13bis: fetch Cooked tracker first-seen date once per finding via
  // the cached helper (1h cache shared across all findings of this audit run).
  // Used by fmtDataQualityCheck to pro-rate the capture rate during bootstrap.
  // Best-effort: getCookedFirstSeen falls back to a hardcoded baseline if the
  // RPC errors, so this never throws.
  const cookedFirstSeen = await getCookedFirstSeen();

  return {
    url: row.page as string,
    avg_position: Number(row.avg_position),
    position_drift: row.position_drift != null ? Number(row.position_drift) : null,
    impressions_monthly: Math.round(Number(row.impressions) / 3),
    ctr_actual: Number(row.ctr_actual),
    ctr_expected: Number(row.ctr_expected),
    ctr_gap_pct: Number(row.ctr_gap) * 100,
    // Sprint-12 hotfix: same fallback to cooked_extras for behavior signals.
    // Same root cause as CWV — forged findings or stale behavior_page_snapshots
    // mean the audit_findings columns can be null while Cooked has fresh data.
    pages_per_session:
      row.pages_per_session != null
        ? Number(row.pages_per_session)
        : cookedExtras
        ? cookedExtras.windows['28d'].sessions > 0
          ? cookedExtras.windows['28d'].views / cookedExtras.windows['28d'].sessions
          : null
        : null,
    avg_duration_seconds:
      row.avg_session_duration_seconds != null
        ? Number(row.avg_session_duration_seconds)
        : cookedExtras?.windows['28d'].avg_dwell_seconds ?? null,
    scroll_depth:
      row.scroll_depth_avg != null
        ? Number(row.scroll_depth_avg)
        : cookedExtras?.windows['28d'].scroll_avg ?? null,
    scroll_complete_pct:
      row.scroll_complete_pct != null
        ? Number(row.scroll_complete_pct)
        : cookedExtras?.windows['28d'].scroll_complete_pct ?? null,
    outbound_clicks:
      row.outbound_clicks != null
        ? Number(row.outbound_clicks)
        : cookedExtras?.windows['28d'].outbound_clicks ?? null,
    // Sprint-12 hotfix: CWV from audit_findings columns can be null (forged
    // findings, or findings older than the latest behavior_page_snapshots
    // refresh). Fallback to the live Cooked extras so the LLM gets the
    // freshest CWV signal — same source the issue box already uses.
    lcp_p75_ms:
      row.lcp_p75_ms != null
        ? Number(row.lcp_p75_ms)
        : cookedExtras?.cwv_28d.lcp_p75_ms ?? null,
    inp_p75_ms:
      row.inp_p75_ms != null
        ? Number(row.inp_p75_ms)
        : cookedExtras?.cwv_28d.inp_p75_ms ?? null,
    cls_p75:
      row.cls_p75 != null ? Number(row.cls_p75) : cookedExtras?.cwv_28d.cls_p75 ?? null,
    ttfb_p75_ms:
      row.ttfb_p75_ms != null
        ? Number(row.ttfb_p75_ms)
        : cookedExtras?.cwv_28d.ttfb_p75_ms ?? null,
    current_title: cs.title,
    current_meta: cs.meta_description,
    current_h1: cs.h1,
    current_intro: cs.intro_first_100_words,
    current_schema_jsonld: cs.schema_jsonld,
    current_internal_links: cs.internal_links_outbound,
    top_queries: topQueries,
    enrichment,
    inbound_summary: inboundSummary,
    // Sprint-12 v6
    cooked_extras: cookedExtras,
    cooked_site_context: cookedSiteContext,
    outbound_destinations: outboundDestinations,
    cta_breakdown: ctaBreakdown,
    gsc_clicks_28d: gscClicks28d,
    cooked_first_seen: cookedFirstSeen,
    // Sprint-14: full content extracted at pull-current-state time
    content_snapshot: (row.content_snapshot as DiagnosticPromptInputs['content_snapshot']) ?? null,
  };
}

/**
 * Sprint-12: best-effort GSC clicks count for the LAST 28 days specifically
 * (NOT the audit period — used for the data_quality_check capture rate
 * sanity, which compares apples-to-apples against Cooked's 28d window).
 *
 * Implementation: sum `clicks` from gsc_page_snapshots rows where this page
 * is the target AND the period overlaps the last 28d. Returns null if no
 * snapshot row covers that window.
 */
async function fetchGscClicksLast28d(page: string): Promise<number | null> {
  const cutoff = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const { data, error } = await supabase()
    .from('gsc_page_snapshots')
    .select('clicks, period_start, period_end')
    .eq('page', page)
    .gte('period_end', cutoff)
    .order('period_end', { ascending: false })
    .limit(1);
  if (error || !data || data.length === 0) return null;
  // We don't have a daily breakdown — use the latest snapshot's clicks
  // pro-rated to 28d. Acceptable approximation for the capture-rate verdict
  // (we need order-of-magnitude precision, not exactness).
  const r = data[0]!;
  const startMs = new Date(r.period_start as string).getTime();
  const endMs = new Date(r.period_end as string).getTime();
  const days = Math.max(1, Math.round((endMs - startMs) / (24 * 60 * 60 * 1000)));
  return Math.round(Number(r.clicks) * (28 / days));
}

async function callDiagnosticLLM(prompt: string, extraMessages: Array<{ role: 'user' | 'assistant'; content: string }> = []): Promise<DiagnosticPayload> {
  const res = await anthropic().messages.create({
    model: model(),
    // Sprint-14: bumped from 4000 → 8000 tokens. The v7 prompt feeds the
    // full <page_body> (up to 8000 words) + 4 new XML blocks, so the LLM
    // produces a richer output that frequently exceeded 4000 tokens
    // mid-JSON — observed on first qspa run. 8000 covers all observed
    // cases with margin (~6-9k chars output typical, max ~14k).
    max_tokens: 8000,
    messages: [{ role: 'user', content: prompt }, ...extraMessages],
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
  return DiagnosticSchema.parse(parsed);
}

/**
 * Sprint-14bis — build a corrective user message that lists the unverified
 * claims and asks the LLM to redo the diagnostic without the hallucinated
 * numbers. The retry message is concise on purpose : we don't repeat the
 * full prompt context, the LLM still has the original `prompt` in its turn.
 */
function buildRetryMessage(unverified: FactCheckResult['unverified']): string {
  const lines = unverified.map(
    (u, i) =>
      `${i + 1}. Champ \`${u.field}\` — claim "${u.claim}" — ${u.note ?? 'introuvable dans les blocs sources'}`,
  );
  return [
    'Ton diagnostic précédent contient des chiffres qui ne tracent pas vers les blocs sources fournis (<page_body>, <page_outline>, <images>, <cta_in_body_positions>, <pogo_navboost>).',
    '',
    'Claims à corriger :',
    ...lines,
    '',
    'Refais le diagnostic complet, en JSON strict, en n\'utilisant QUE les chiffres exacts présents dans les blocs sources. ATTENTION particulièrement aux chiffres pogo (n=, google_sessions, pogo_sticks, pogo_rate, hard_pogo) : recopie-les VERBATIM depuis le bloc <pogo_navboost>. Si tu n\'es pas sûr d\'un nombre, retire-le ou écris-le qualitatif (ex: "court", "long", "plusieurs").',
  ].join('\n');
}

export async function diagnoseFinding(findingId: string): Promise<DiagnosticPayload> {
  const inputs = await buildDiagnosticInputs(findingId);
  const prompt = renderDiagnosticPrompt(inputs);
  const cs = inputs.content_snapshot ?? null;

  // First pass.
  let diagnostic = await callDiagnosticLLM(prompt);

  // Sprint-14bis: fact-check the numeric claims against content_snapshot.
  // Sprint-15: also fact-check pogo claims against pogo_28d facts.
  // If any claim doesn't trace, retry ONCE with a corrective message
  // listing the unverified claims. We retry at most once to bound cost.
  const pogoFacts = inputs.cooked_extras
    ? {
        google_sessions: inputs.cooked_extras.pogo_28d.google_sessions,
        pogo_sticks: inputs.cooked_extras.pogo_28d.pogo_sticks,
        hard_pogo: inputs.cooked_extras.pogo_28d.hard_pogo,
        pogo_rate_pct: inputs.cooked_extras.pogo_28d.pogo_rate_pct,
      }
    : null;
  let factCheck: FactCheckResult & { retry_attempted: boolean } = {
    ...factCheckDiagnostic({
      diagnostic,
      content_snapshot: cs as ContentSnapshot | null,
      pogo: pogoFacts,
    }),
    retry_attempted: false,
  };

  // Retry triggers when ANY claim is unverified (content_snapshot OR pogo).
  // We allow retry even when cs is null but pogo facts are present (Sprint-15
  // hallucinations don't need cs to be detected).
  if (!factCheck.passed && (cs || pogoFacts)) {
    const retryMsg = buildRetryMessage(factCheck.unverified);
    process.stderr.write(
      `[diagnose] ${findingId} — fact-check failed (${factCheck.unverified.length} unverified), retrying once\n`,
    );
    try {
      const retried = await callDiagnosticLLM(prompt, [
        { role: 'assistant', content: JSON.stringify(diagnostic) },
        { role: 'user', content: retryMsg },
      ]);
      const retryFc = factCheckDiagnostic({
        diagnostic: retried,
        content_snapshot: cs as ContentSnapshot | null,
        pogo: pogoFacts,
      });
      // Keep the retried diagnostic even if it still has issues — at worst
      // it's no worse than the first pass, and usually strictly better.
      diagnostic = retried;
      factCheck = { ...retryFc, retry_attempted: true };
    } catch (err) {
      process.stderr.write(
        `[diagnose] ${findingId} — retry failed: ${(err as Error).message} — keeping first-pass diagnostic\n`,
      );
      factCheck.retry_attempted = true;
    }
  }

  const { error: updErr } = await supabase()
    .from('audit_findings')
    .update({
      diagnostic,
      diagnostic_fact_check: factCheck,
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
